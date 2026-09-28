import Foundation

/// Decides whether a bounded retry should follow a failed attempt to claim shared
/// `AVAudioSession` ownership for CarPlay voice-search recording.
///
/// `AVAudioSession.setCategory`/`setActive` can transiently throw "session busy" errors
/// immediately after a prior owner releases the session while the system settles a route change.
/// A single failed attempt does not mean the microphone is permanently unavailable, but retrying
/// forever would leave the driver staring at a silent "Listening…" prompt with no feedback. This
/// type makes the bounded backoff decision as pure data so it can be exercised deterministically
/// without a real audio session, engine, or timer.
public struct NavOSSVoiceAudioSessionRetryPolicy: Equatable {
  public let maximumAttempts: Int
  public let initialDelay: TimeInterval
  public let maximumDelay: TimeInterval

  public init(maximumAttempts: Int, initialDelay: TimeInterval, maximumDelay: TimeInterval) {
    precondition(maximumAttempts > 0)
    precondition(initialDelay > 0)
    precondition(maximumDelay >= initialDelay)
    self.maximumAttempts = maximumAttempts
    self.initialDelay = initialDelay
    self.maximumDelay = maximumDelay
  }

  /// Claiming the session to record a CarPlay voice search: short and few retries before
  /// surfacing a real, accurate failure to the driver.
  public static let carPlayRecordingClaim = NavOSSVoiceAudioSessionRetryPolicy(
    maximumAttempts: 3,
    initialDelay: 0.15,
    maximumDelay: 0.6
  )

  /// Returns the delay before retrying attempt `attempt + 1`, or `nil` once the budget is spent
  /// and the caller must stop and report the final, accurate failure.
  public func delay(afterFailedAttempt attempt: Int) -> TimeInterval? {
    precondition(attempt >= 0)
    guard attempt + 1 < maximumAttempts else {
      return nil
    }
    let scaled = initialDelay * pow(2, Double(attempt))
    return min(scaled, maximumDelay)
  }
}
