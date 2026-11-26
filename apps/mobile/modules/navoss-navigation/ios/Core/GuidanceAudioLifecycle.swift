import Foundation

/// Pure lifecycle of the shared audio session for spoken guidance and CarPlay voice capture.
///
/// The session is live only between `activate`, issued when a prompt's audio is ready to play,
/// and the `deactivate` that follows the last prompt of a batch. `NavOSSNavigationService` feeds
/// events in and carries out the returned effects in order on the main queue; nothing else
/// activates or deactivates the session for guidance.
///
/// The rules come from what the system was observed to do (docs/architecture/carplay.md,
/// "Guidance audio"):
/// - Audio is always stopped before the session is deactivated. `AVSpeechSynthesizer.speak` keeps
///   its own audio queue running for about a second after `didFinish` and restarts it for every
///   buffer, so deactivating at `didFinish` was followed by the queue bringing the session back
///   with nobody left to release it. Prompts are therefore rendered to audio first and played by
///   a player this app stops itself.
/// - Every batch owes a release, whether or not activation succeeded: the synthesizer also
///   activates the app's session on its own when it starts a prompt, even one it only renders.
///   Before a render that the session is not already held for, the session is therefore put in
///   a category whose activation changes nothing for other audio (`idleCategory`).
/// - A successful deactivation is confirmed once more after `confirmationDelaySeconds`, because
///   that activation by the synthesizer is asynchronous and can land after a prompt was cancelled.
public struct NavOSSGuidanceAudioLifecycle: Equatable {
  /// How long rendering a prompt may take before it is spoken directly instead. On an iOS 26.5
  /// simulator a render took 11 to 58 ms once the voice was loaded and 385 to 649 ms for the
  /// first one after launch, which the warm-up at the start of a trip pays. One second is 17
  /// times the slowest warm render and still a tolerable delay for the one prompt that misses.
  public static let renderTimeoutSeconds = 1.0
  /// How long the warm-up render may take. Nothing waits on it, so it gets the cold voice load
  /// with room to spare.
  public static let warmUpTimeoutSeconds = 4.0
  /// Renders in a row that must fail before the rest of the trip is spoken directly. One slow
  /// render costs that prompt only.
  public static let renderFailuresBeforeDirect = 2
  /// Slack after a prompt's audio length before its player is treated as lost.
  public static let playbackGraceSeconds = 2.0
  /// Generous speaking rate for a directly spoken prompt whose length is unknown.
  public static let directSecondsPerCharacter = 0.1
  /// Slack for a directly spoken prompt: route setup before it starts plus the end of speech.
  public static let directGraceSeconds = 9.0
  /// A directly spoken prompt keeps its audio queue running after `didFinish` (0.6 to 0.95 s on
  /// an iOS 26.5 simulator); wait this long before stopping it and letting the session go.
  public static let directTailSeconds = 1.5
  /// Delay before the confirming deactivation.
  public static let confirmationDelaySeconds = 1.0
  private static let retryInitialDelay = 0.2
  private static let retryMaximumDelay = 3.0

  public typealias PromptID = UInt64

  public enum Effect: Equatable {
    /// Put the inactive session in a category that neither ducks nor interrupts other audio,
    /// because the synthesizer activates it when a render starts.
    case idleCategory
    /// Configure the session for a voice prompt and activate it.
    case activate
    /// Render the prompt to audio; answer with `rendered(_:audioSeconds:now:)`.
    case render(PromptID)
    /// Render a short utterance and discard it, so the voice is loaded before a prompt needs it;
    /// answer with `rendered(_:audioSeconds:now:)`.
    case renderWarmUp(PromptID)
    /// Play the rendered prompt; answer with `finished(_:now:)` when it ends or cannot start.
    case play(PromptID)
    /// Speak the prompt through the synthesizer itself (rendering is unavailable); answer with
    /// `finished(_:now:)` on `didFinish`/`didCancel`.
    case speakDirectly(PromptID)
    /// Stop the player and the synthesizer now, synchronously.
    case stopAudio
    /// Deactivate the session, notifying other audio; answer with `deactivated(succeeded:now:)`.
    case deactivate(DeactivationReason)
  }

  public enum DeactivationReason: String, Equatable, Sendable {
    case promptsFinished = "prompts-finished"
    case cancelled
    case voiceSearchEnded = "voice-search-ended"
    case warmUp = "warm-up"
    case retry
    case confirmation
  }

  private enum Stage: Equatable {
    case rendering(deadline: TimeInterval)
    case playing(deadline: TimeInterval)
    case speakingDirectly(deadline: TimeInterval)
    /// A directly spoken prompt has reported finished; its audio queue is given time to drain.
    case directTail(until: TimeInterval)
  }

  private enum Session: Equatable {
    case idle
    /// Prompts or voice capture hold the session; a release is owed.
    case claimed
    /// Deactivation failed; try again at `at`.
    case retrying(attempt: Int, at: TimeInterval)
    /// Deactivation succeeded; deactivate once more at `at`.
    case confirming(at: TimeInterval)
  }

  private struct Prompt: Equatable {
    let id: PromptID
    let characterCount: Int
    var isWarmUp = false
  }

  private var queue: [Prompt] = []
  private var stage: Stage?
  private var session = Session.idle
  private var nextID: PromptID = 0
  private var voiceInputActive = false
  /// Whether `.activate` has been issued for the batch in hand.
  private var holdsSession = false
  private var consecutiveRenderFailures = 0
  private var speaksDirectlyThisTrip = false
  private let alwaysSpeaksDirectly: Bool

  /// `rendersPrompts: false` speaks every prompt directly (simulator harness).
  public init(rendersPrompts: Bool = true) {
    alwaysSpeaksDirectly = !rendersPrompts
  }

  /// Whether the next prompt will be rendered and played, as opposed to spoken directly.
  public var rendersPrompts: Bool { !alwaysSpeaksDirectly && !speaksDirectlyThisTrip }

  /// Whether the session is held, or a release of it is still being retried.
  public var owesRelease: Bool {
    switch session {
    case .claimed, .retrying: true
    case .idle, .confirming: false
    }
  }

  public var hasPrompts: Bool { !queue.isEmpty }
  public var isVoiceInputActive: Bool { voiceInputActive }

  /// When `timerFired(now:)` next has work to do.
  public var nextDeadline: TimeInterval? {
    switch stage {
    case .rendering(let deadline), .playing(let deadline), .speakingDirectly(let deadline):
      return deadline
    case .directTail(let until):
      return until
    case nil:
      break
    }
    switch session {
    case .retrying(_, let at), .confirming(let at):
      return at
    case .idle, .claimed:
      return nil
    }
  }

  // MARK: Prompts

  /// A trip is starting or being restored. Rendering gets a fresh chance whether or not
  /// guidance is muted, since it can be switched on later in the trip. `warmUp` is false while
  /// it is muted: nothing will be spoken, so the session is left alone.
  public mutating func beginTrip(now: TimeInterval, warmUp: Bool) -> [Effect] {
    consecutiveRenderFailures = 0
    speaksDirectlyThisTrip = false
    return warmUp ? self.warmUp(now: now) : []
  }

  /// Loads the voice now, silently, so the next prompt does not wait for it: at the start of a
  /// trip, and when guidance is switched on during one.
  public mutating func warmUp(now: TimeInterval) -> [Effect] {
    guard rendersPrompts, queue.isEmpty, !voiceInputActive else { return [] }
    nextID &+= 1
    queue = [Prompt(id: nextID, characterCount: 0, isWarmUp: true)]
    // The synthesizer activates the session for the render, so a release is owed.
    session = .claimed
    stage = .rendering(deadline: now + Self.warmUpTimeoutSeconds)
    return [.idleCategory, .renderWarmUp(nextID)]
  }

  /// A prompt is ready to be spoken. Returns `nil` while voice capture holds the session; the
  /// caller keeps the prompt and offers it again when capture ends.
  public mutating func enqueue(characterCount: Int, now: TimeInterval) -> (
    id: PromptID, effects: [Effect]
  )? {
    guard !voiceInputActive else { return nil }
    var effects: [Effect] = []
    if queue.first?.isWarmUp == true {
      // A prompt does not wait behind the warm-up.
      queue.removeAll()
      stage = nil
      effects.append(.stopAudio)
    }
    nextID &+= 1
    let prompt = Prompt(id: nextID, characterCount: characterCount)
    queue.append(prompt)
    guard queue.count == 1 else { return (prompt.id, effects) }
    session = .claimed
    return (prompt.id, effects + present(prompt, now: now))
  }

  /// Rendering `id` ended. `audioSeconds` is `nil` when it produced nothing playable.
  public mutating func rendered(
    _ id: PromptID, audioSeconds: TimeInterval?, now: TimeInterval
  ) -> [Effect] {
    guard let head = queue.first, head.id == id, case .rendering = stage else { return [] }
    let succeeded = (audioSeconds ?? 0) > 0
    noteRender(succeeded: succeeded)
    if head.isWarmUp {
      queue.removeAll()
      return release(.warmUp)
    }
    guard succeeded, let audioSeconds else {
      return speakDirectly(head, now: now)
    }
    stage = .playing(deadline: now + audioSeconds + Self.playbackGraceSeconds)
    return activateIfNeeded() + [.play(id)]
  }

  /// The player finished `id` (or could not start it), or the synthesizer reported a directly
  /// spoken `id` finished or cancelled.
  public mutating func finished(_ id: PromptID, now: TimeInterval) -> [Effect] {
    guard queue.first?.id == id else { return [] }
    switch stage {
    case .playing:
      return advance(now: now)
    case .speakingDirectly:
      stage = .directTail(until: now + Self.directTailSeconds)
      return []
    case .rendering, .directTail, nil:
      return []
    }
  }

  /// Drops every prompt and lets the session go: the trip ended, announcements were stopped, or
  /// the system interrupted this app's audio (a call, Siri).
  public mutating func cancelAll(now: TimeInterval) -> [Effect] {
    guard !queue.isEmpty else { return [] }
    queue.removeAll()
    return release(.cancelled)
  }

  // MARK: Voice capture

  /// CarPlay voice search is about to record. It activates the session for recording itself; the
  /// release is owed here from now on.
  public mutating func beginVoiceInput() -> [Effect] {
    voiceInputActive = true
    queue.removeAll()
    stage = nil
    holdsSession = false
    session = .claimed
    return [.stopAudio]
  }

  /// CarPlay voice search stopped recording.
  public mutating func endVoiceInput() -> [Effect] {
    guard voiceInputActive else { return [] }
    voiceInputActive = false
    return [.deactivate(.voiceSearchEnded)]
  }

  // MARK: Session

  /// Result of carrying out `.deactivate`.
  public mutating func deactivated(succeeded: Bool, now: TimeInterval) {
    // A prompt or voice capture that claimed the session since then keeps it.
    guard queue.isEmpty, !voiceInputActive else { return }
    if succeeded {
      // The confirmation itself is not confirmed again.
      if case .confirming(let at) = session, at <= now {
        session = .idle
      } else {
        session = .confirming(at: now + Self.confirmationDelaySeconds)
      }
      return
    }
    let attempt: Int
    if case .retrying(let previous, _) = session { attempt = previous + 1 } else { attempt = 0 }
    // Never gives up: the delay grows, then holds, until a deactivation succeeds or a new prompt
    // or capture claims the session.
    let delay = min(Self.retryInitialDelay * pow(2, Double(attempt)), Self.retryMaximumDelay)
    session = .retrying(attempt: attempt, at: now + delay)
  }

  /// Call at `nextDeadline`.
  public mutating func timerFired(now: TimeInterval) -> [Effect] {
    if let head = queue.first, let stage {
      switch stage {
      case .rendering(let deadline) where deadline <= now:
        // The synthesizer did not deliver the audio in time.
        noteRender(succeeded: false)
        if head.isWarmUp {
          queue.removeAll()
          return release(.warmUp)
        }
        return speakDirectly(head, now: now)
      case .playing(let deadline) where deadline <= now,
        .speakingDirectly(let deadline) where deadline <= now:
        // Nothing reported this prompt over, so it may still be sounding: stop it before the
        // next one starts, or the two overlap or the next queues behind it.
        return [.stopAudio] + advance(now: now)
      case .directTail(let deadline) where deadline <= now:
        return advance(now: now)
      default:
        return []
      }
    }
    switch session {
    case .retrying(_, let at) where at <= now:
      return [.stopAudio, .deactivate(.retry)]
    case .confirming(let at) where at <= now:
      return [.stopAudio, .deactivate(.confirmation)]
    default:
      return []
    }
  }

  private mutating func noteRender(succeeded: Bool) {
    if succeeded {
      consecutiveRenderFailures = 0
      return
    }
    consecutiveRenderFailures += 1
    if consecutiveRenderFailures >= Self.renderFailuresBeforeDirect {
      speaksDirectlyThisTrip = true
    }
  }

  private mutating func activateIfNeeded() -> [Effect] {
    guard !holdsSession else { return [] }
    holdsSession = true
    return [.activate]
  }

  private mutating func present(_ prompt: Prompt, now: TimeInterval) -> [Effect] {
    guard rendersPrompts else { return speakDirectly(prompt, now: now) }
    stage = .rendering(deadline: now + Self.renderTimeoutSeconds)
    // Within a batch the session is already held for playback and stays as it is.
    return (holdsSession ? [] : [.idleCategory]) + [.render(prompt.id)]
  }

  private mutating func speakDirectly(_ prompt: Prompt, now: TimeInterval) -> [Effect] {
    stage = .speakingDirectly(
      deadline: now + Double(max(0, prompt.characterCount)) * Self.directSecondsPerCharacter
        + Self.directGraceSeconds)
    return activateIfNeeded() + [.speakDirectly(prompt.id)]
  }

  /// The head prompt is over: present the next one, or stop audio and release the session.
  private mutating func advance(now: TimeInterval) -> [Effect] {
    queue.removeFirst()
    if let next = queue.first {
      return present(next, now: now)
    }
    return release(.promptsFinished)
  }

  /// Audio first, then the session.
  private mutating func release(_ reason: DeactivationReason) -> [Effect] {
    stage = nil
    holdsSession = false
    return [.stopAudio, .deactivate(reason)]
  }
}
