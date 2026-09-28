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
