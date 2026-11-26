import Foundation

/// Pure lifecycle of the shared audio session for spoken guidance and CarPlay voice capture.
///
/// The session is live only between `activate` and the `deactivate` that follows the last prompt
/// of a batch. `NavOSSNavigationService` feeds events in and carries out the returned effects in
/// order on the main queue; nothing else activates or deactivates the session for guidance.
///
/// Three rules come from what the system was observed to do (docs/architecture/carplay.md,
/// "Guidance audio"):
/// - Audio is always stopped before the session is deactivated. `AVSpeechSynthesizer.speak` keeps
///   its own audio queue running for about a second after `didFinish` and restarts it for every
///   buffer, so deactivating at `didFinish` was followed by the queue bringing the session back
///   with nobody left to release it. Prompts are therefore rendered to audio first and played by
///   a player this app stops itself.
/// - Every batch owes a release, whether or not activation succeeded: the synthesizer also
///   activates the app's session on its own when it starts a prompt.
/// - A successful deactivation is confirmed once more after `confirmationDelaySeconds`, because
///   that activation by the synthesizer is asynchronous and can land after a prompt was cancelled.
public struct NavOSSGuidanceAudioLifecycle: Equatable {
  /// How long rendering a prompt may take before it is spoken directly instead.
  public static let renderTimeoutSeconds = 3.0
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
    /// Configure the session for a voice prompt and activate it.
    case activate
    /// Render the prompt to audio; answer with `rendered(_:audioSeconds:now:)`.
    case render(PromptID)
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
  }

  private var queue: [Prompt] = []
  private var stage: Stage?
  private var session = Session.idle
  private var nextID: PromptID = 0
  private var voiceInputActive = false
  /// Set once rendering produced no audio; later prompts are spoken directly.
  public private(set) var rendersPrompts: Bool

  public init(rendersPrompts: Bool = true) {
    self.rendersPrompts = rendersPrompts
  }

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

  /// A prompt is ready to be spoken. Returns `nil` while voice capture holds the session; the
  /// caller keeps the prompt and offers it again when capture ends.
  public mutating func enqueue(characterCount: Int, now: TimeInterval) -> (
    id: PromptID, effects: [Effect]
  )? {
    guard !voiceInputActive else { return nil }
    nextID &+= 1
    let prompt = Prompt(id: nextID, characterCount: characterCount)
    queue.append(prompt)
    guard queue.count == 1 else { return (prompt.id, []) }
    session = .claimed
    return (prompt.id, [.activate] + present(prompt, now: now))
  }

  /// Rendering `id` ended. `audioSeconds` is `nil` when it produced nothing playable.
  public mutating func rendered(
    _ id: PromptID, audioSeconds: TimeInterval?, now: TimeInterval
  ) -> [Effect] {
    guard let head = queue.first, head.id == id, case .rendering = stage else { return [] }
    guard let audioSeconds, audioSeconds > 0 else {
      rendersPrompts = false
      return present(head, now: now)
    }
    stage = .playing(deadline: now + audioSeconds + Self.playbackGraceSeconds)
    return [.play(id)]
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
    stage = nil
    return [.stopAudio, .deactivate(.cancelled)]
  }

  // MARK: Voice capture

  /// CarPlay voice search is about to record. It activates the session for recording itself; the
  /// release is owed here from now on.
  public mutating func beginVoiceInput() -> [Effect] {
    voiceInputActive = true
    queue.removeAll()
    stage = nil
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
        // The synthesizer never delivered the audio. Speak this prompt and later ones directly.
        rendersPrompts = false
        return present(head, now: now)
      case .playing(let deadline) where deadline <= now,
        .speakingDirectly(let deadline) where deadline <= now,
        .directTail(let deadline) where deadline <= now:
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

  private mutating func present(_ prompt: Prompt, now: TimeInterval) -> [Effect] {
    if rendersPrompts {
      stage = .rendering(deadline: now + Self.renderTimeoutSeconds)
      return [.render(prompt.id)]
    }
    stage = .speakingDirectly(
      deadline: now + Double(max(0, prompt.characterCount)) * Self.directSecondsPerCharacter
        + Self.directGraceSeconds)
    return [.speakDirectly(prompt.id)]
  }

  /// The head prompt is over: present the next one, or stop audio and release the session.
  private mutating func advance(now: TimeInterval) -> [Effect] {
    queue.removeFirst()
    if let next = queue.first {
      return present(next, now: now)
    }
    stage = nil
    return [.stopAudio, .deactivate(.promptsFinished)]
  }
}
