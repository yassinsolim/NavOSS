import Foundation

public enum NavOSSSpeedingState: String, Sendable {
  /// No current speed or no known posted limit here.
  case unknown
  case withinLimit = "within-limit"
  case overLimit = "over-limit"
}

/// Speeding state with hysteresis, so a speed hovering at the threshold does not flicker the
/// indicator or repeat the warning.
struct NavigationSpeedingMonitor {
  /// Consecutive fixes at or over the threshold before the state turns on.
  static let confirmationSampleCount = 2
  /// Drop below the threshold by this much before the state turns off.
  static let releaseMarginKph = 3.0
  /// One spoken reminder per episode, and never more often than this.
  static let minimumWarningIntervalSeconds = 60.0

  private(set) var state = NavOSSSpeedingState.unknown
  private var episodeWarned = false
  private var lastWarningTime: TimeInterval?
  private var overSampleCount = 0

  /// Returns `true` when the audible warning should be spoken now.
  mutating func update(
    speedMetersPerSecond: Double?,
    speedLimitKph: Int?,
    preferences: NavOSSNavigationPreferences,
    now: TimeInterval
  ) -> Bool {
    guard let speedMetersPerSecond, speedMetersPerSecond.isFinite, speedMetersPerSecond >= 0,
      let speedLimitKph, speedLimitKph > 0
    else {
      state = .unknown
      overSampleCount = 0
      episodeWarned = false
      return false
    }
    let speedKph = speedMetersPerSecond * 3.6
    let thresholdKph = Double(speedLimitKph + preferences.speedingToleranceKph)
    if state == .overLimit {
      if speedKph < thresholdKph - Self.releaseMarginKph {
        state = .withinLimit
        overSampleCount = 0
        episodeWarned = false
      }
    } else {
      overSampleCount = speedKph >= thresholdKph ? overSampleCount + 1 : 0
      state = overSampleCount >= Self.confirmationSampleCount ? .overLimit : .withinLimit
    }
    guard preferences.speedingAudibleWarning, state == .overLimit, !episodeWarned,
      lastWarningTime.map({ now - $0 >= Self.minimumWarningIntervalSeconds }) ?? true
    else {
      return false
    }
    episodeWarned = true
    lastWarningTime = now
    return true
  }

  mutating func reset() {
    state = .unknown
    overSampleCount = 0
    episodeWarned = false
  }
}

func navigationSpeedingWarningText(speedLimitKph: Int) -> String {
  "Speed limit \(speedLimitKph)."
}
