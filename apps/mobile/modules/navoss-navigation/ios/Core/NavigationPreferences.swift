import Foundation

extension Notification.Name {
  public static let navOSSNavigationPreferencesDidChange = Notification.Name(
    "org.navoss.mobile.navigation-preferences-did-change"
  )
}

/// How the navigation service handles a replacement route once the driver leaves the selected
/// one. NavOSS never switches routes merely to save time; every mode is about recovery.
public enum NavOSSRerouteMode: String, CaseIterable, Sendable {
  /// Install the fastest route from the current position automatically.
  case adaptive
  /// Calculate a replacement and show its time and distance impact; switch only on
  /// confirmation, unless the driver stays off the selected route (see
  /// `NavigationRerouteConsent`).
  case askFirst = "ask-first"
  /// Route back onto the selected route ahead of the vehicle, never behind it, and continue it.
  case keepRoute = "keep-route"

  public var label: String {
    switch self {
    case .adaptive: "Automatic"
    case .askFirst: "Ask first"
    case .keepRoute: "Keep my route"
    }
  }
}

public struct NavOSSNavigationPreferences: Equatable, Sendable {
  public static let speedingToleranceRangeKph = 0...20
  public static let defaultSpeedingToleranceKph = 5

  public let rerouteMode: NavOSSRerouteMode
  /// Kilometres per hour over the posted limit before the speeding state turns on.
  public let speedingToleranceKph: Int
  /// Speak a short limit reminder when speeding starts. Off by default.
  public let speedingAudibleWarning: Bool

  public init(
    rerouteMode: NavOSSRerouteMode = .adaptive,
    speedingToleranceKph: Int = NavOSSNavigationPreferences.defaultSpeedingToleranceKph,
    speedingAudibleWarning: Bool = false
  ) {
    self.rerouteMode = rerouteMode
    self.speedingToleranceKph = min(
      Self.speedingToleranceRangeKph.upperBound,
      max(Self.speedingToleranceRangeKph.lowerBound, speedingToleranceKph)
    )
    self.speedingAudibleWarning = speedingAudibleWarning
  }
}

/// Navigation preferences shared by the phone and CarPlay, persisted natively so a trip started
/// from either surface (or resumed with only CarPlay alive) uses the same choices.
public final class NavOSSNavigationPreferencesStore: @unchecked Sendable {
  public static let shared = NavOSSNavigationPreferencesStore()

  private let rerouteModeKey = "org.navoss.mobile.navigation.reroute-mode"
  private let speedingToleranceKey = "org.navoss.mobile.navigation.speeding-tolerance-kph"
  private let speedingAudibleWarningKey = "org.navoss.mobile.navigation.speeding-audible-warning"
  private let defaults: UserDefaults
  private let lock = NSLock()
  private let notificationCenter: NotificationCenter

  public init(
    defaults: UserDefaults = .standard,
    notificationCenter: NotificationCenter = .default
  ) {
    self.defaults = defaults
    self.notificationCenter = notificationCenter
  }

  public func load() -> NavOSSNavigationPreferences {
    lock.lock()
    defer { lock.unlock() }
    return NavOSSNavigationPreferences(
      rerouteMode: defaults.string(forKey: rerouteModeKey)
        .flatMap(NavOSSRerouteMode.init(rawValue:)) ?? .adaptive,
      speedingToleranceKph: defaults.object(forKey: speedingToleranceKey) == nil
        ? NavOSSNavigationPreferences.defaultSpeedingToleranceKph
        : defaults.integer(forKey: speedingToleranceKey),
      speedingAudibleWarning: defaults.bool(forKey: speedingAudibleWarningKey)
    )
  }

  public func setRerouteMode(_ mode: NavOSSRerouteMode) {
    lock.lock()
    defaults.set(mode.rawValue, forKey: rerouteModeKey)
    lock.unlock()
    notificationCenter.post(name: .navOSSNavigationPreferencesDidChange, object: self)
  }

  public func setSpeedingWarning(toleranceKph: Int, audible: Bool) {
    let normalized = NavOSSNavigationPreferences(
      speedingToleranceKph: toleranceKph,
      speedingAudibleWarning: audible
    )
    lock.lock()
    defaults.set(normalized.speedingToleranceKph, forKey: speedingToleranceKey)
    defaults.set(normalized.speedingAudibleWarning, forKey: speedingAudibleWarningKey)
    lock.unlock()
    notificationCenter.post(name: .navOSSNavigationPreferencesDidChange, object: self)
  }
}
