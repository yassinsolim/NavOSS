import Foundation

/// Pure lifecycle model for *deactivating* the shared `AVAudioSession` once guidance speech or
/// CarPlay voice capture no longer needs it. `NavOSSNavigationService` is the sole owner of
/// deactivation (`setActive(false)`); callers (guidance speech, CarPlay's recording lease) still
/// activate the session themselves for their own purpose, then report the claim here via
/// `claim()` so a release can eventually be attempted and retried on their behalf.
///
/// Two real bugs this removes structurally:
/// - A release can only be considered done via a proven `releaseSucceeded(epoch:)` call, or
///   superseded by a genuinely new `claim()`. Nothing can "blindly" flip a flag to pretend a
///   release happened, and a busy/failing session is never abandoned — retries keep going,
///   capped at `maximumDelay`, until one actually succeeds or a new owner takes over.
/// - A release attempt can only touch the real session while `isCurrentClaim(epoch:)` is true,
///   so a retry scheduled against an old claim can never act against a session a new owner holds.
public struct NavOSSAudioSessionOwnership: Equatable {
  private static let initialDelay: TimeInterval = 0.2
  private static let maximumDelay: TimeInterval = 3.0

  /// Identifies one claim on the shared session.
  public struct Epoch: Equatable, Sendable {
    fileprivate let rawValue: UInt64
  }

  public enum ReleaseAttemptOutcome: Equatable {
    /// Try the real deactivation call again after this delay.
    case retryAfter(TimeInterval)
    /// A new claim has started since this attempt was scheduled — do not touch the session.
    case stale
  }

  public private(set) var epoch = Epoch(rawValue: 0)
  private var attempt = 0
  private var isClaimed = false

  public init() {}

  /// Whether the session is currently claimed and therefore still owes a release.
  public var needsRelease: Bool { isClaimed }

  /// Whether `epoch` is still the current, claimed owner. A caller must check this before
  /// touching the real `AVAudioSession` or any cancellable retry bookkeeping for that epoch.
  public func isCurrentClaim(_ epoch: Epoch) -> Bool {
    isClaimed && epoch == self.epoch
  }

  /// A new owner (guidance speech activating, or a CarPlay recording lease starting) has taken
  /// the shared session. Invalidates any release attempt still in flight for the previous claim.
  @discardableResult
  public mutating func claim() -> Epoch {
    epoch = Epoch(rawValue: epoch.rawValue &+ 1)
    isClaimed = true
    attempt = 0
    return epoch
  }

  /// The real `AVAudioSession.setActive(false)` call succeeded for `epoch`.
  public mutating func releaseSucceeded(epoch: Epoch) {
    guard epoch == self.epoch else {
      return
    }
    isClaimed = false
    attempt = 0
  }

  /// The real `AVAudioSession.setActive(false)` call failed (busy, or still speaking) for
  /// `epoch`. Never gives up on its own: backoff grows exponentially and then holds at
  /// `maximumDelay` until a real release succeeds or a new claim makes this attempt stale.
  public mutating func releaseFailed(epoch: Epoch) -> ReleaseAttemptOutcome {
    guard isCurrentClaim(epoch) else {
      return .stale
    }
    let delay = min(Self.initialDelay * pow(2, Double(attempt)), Self.maximumDelay)
    attempt += 1
    return .retryAfter(delay)
  }
}

/// Guidance utterances that still owe the synthesizer's didFinish/didCancel callback.
///
/// The audio session (and the ducking of the driver's music) is released only once this is
/// empty. If AVSpeechSynthesizer never reports an utterance (seen when synthesis fails to start,
/// or for utterances queued behind an interrupted one), waiting on the callback alone leaves
/// music ducked indefinitely, so outstanding utterances also have deadlines.
///
/// The synthesizer speaks its queue in order, so only the utterance at the head of the queue
/// can be overdue. Its deadline is measured from when it began speaking (`didStart`), bounded
/// by its length; before it starts it gets `startTimeoutSeconds` from the moment it reached
/// the head. A prompt queued behind a long one therefore never expires before its turn.
public struct NavOSSSpeechUtteranceLedger: Equatable {
  /// Generous speaking rate: real guidance at 0.92× the default rate is faster than this.
  public static let secondsPerCharacter = 0.1
  /// Slack after the estimated speaking time.
  public static let speakingGraceSeconds = 3.0
  /// How long the head of the queue may take to start speaking (audio route setup over
  /// Bluetooth/CarPlay) before it is treated as lost.
  public static let startTimeoutSeconds = 6.0

  private struct Entry: Equatable {
    let id: ObjectIdentifier
    let characterCount: Int
    var startedAt: TimeInterval?
  }

  private var queue: [Entry] = []
  /// When the current head reached the head of the queue.
  private var headSince: TimeInterval?

  public init() {}

  public var isEmpty: Bool { queue.isEmpty }
  public var count: Int { queue.count }

  /// The moment the head of the queue becomes overdue, if anything is outstanding.
  public var nextDeadline: TimeInterval? {
    guard let head = queue.first else { return nil }
    if let startedAt = head.startedAt {
      return startedAt + Double(max(0, head.characterCount)) * Self.secondsPerCharacter
        + Self.speakingGraceSeconds
    }
    return (headSince ?? 0) + Self.startTimeoutSeconds
  }

  public mutating func begin(_ utterance: ObjectIdentifier, characterCount: Int, now: TimeInterval) {
    if queue.isEmpty {
      headSince = now
    }
    queue.append(Entry(id: utterance, characterCount: characterCount, startedAt: nil))
  }

  /// The synthesizer reported `didStart` for `utterance`.
  public mutating func start(_ utterance: ObjectIdentifier, now: TimeInterval) {
    guard let index = queue.firstIndex(where: { $0.id == utterance }) else { return }
    // Anything queued ahead of an utterance that is now speaking was dropped by the synthesizer.
    queue.removeFirst(index)
    queue[0].startedAt = now
    headSince = now
  }

  /// Returns `true` when this completion emptied the ledger.
  @discardableResult
  public mutating func complete(_ utterance: ObjectIdentifier, now: TimeInterval) -> Bool {
    guard let index = queue.firstIndex(where: { $0.id == utterance }) else { return false }
    queue.remove(at: index)
    if index == 0 {
      headSince = now
    }
    return queue.isEmpty
  }

  public mutating func removeAll() {
    queue.removeAll()
    headSince = nil
  }

  /// Drops overdue utterances from the head of the queue. Returns `true` when that emptied the
  /// ledger, i.e. the caller should now attempt the session release it was waiting for.
  public mutating func expireOverdue(now: TimeInterval) -> Bool {
    var expired = false
    while let deadline = nextDeadline, deadline <= now {
      queue.removeFirst()
      // The next utterance's turn starts now, not when the lost one was queued.
      headSince = now
      expired = true
    }
    return expired && queue.isEmpty
  }
}
