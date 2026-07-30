import Foundation

public enum NavOSSCarPlayAppearance: String, CaseIterable, Sendable {
  case automatic
  case light
  case dark

  public var label: String {
    switch self {
    case .automatic: "Automatic"
    case .dark: "Dark"
    case .light: "Light"
    }
  }
}

public enum NavOSSCarPlayAudioMode: String, CaseIterable, Sendable {
  case allGuidance = "all-guidance"
  case alertsOnly = "alerts-only"
  case muted

  public var label: String {
    switch self {
    case .alertsOnly: "Alerts only"
    case .allGuidance: "All guidance"
    case .muted: "Muted"
    }
  }
}

public enum NavOSSCarPlayVehicleMarker: String, CaseIterable, Sendable {
  case arrow
  case car

  public var label: String {
    switch self {
    case .arrow: "Arrow"
    case .car: "Car"
    }
  }
}

public struct NavOSSCarPlayPreferences: Equatable, Sendable {
  public let appearance: NavOSSCarPlayAppearance
  public let audioMode: NavOSSCarPlayAudioMode
  public let showsPointsOfInterest: Bool
  public let vehicleMarker: NavOSSCarPlayVehicleMarker

  public init(
    appearance: NavOSSCarPlayAppearance = .automatic,
    audioMode: NavOSSCarPlayAudioMode = .allGuidance,
    showsPointsOfInterest: Bool = true,
    vehicleMarker: NavOSSCarPlayVehicleMarker = .arrow
  ) {
    self.appearance = appearance
    self.audioMode = audioMode
    self.showsPointsOfInterest = showsPointsOfInterest
    self.vehicleMarker = vehicleMarker
  }
}

public final class NavOSSCarPlayPreferencesStore: @unchecked Sendable {
  public static let shared = NavOSSCarPlayPreferencesStore()

  private let appearanceKey = "org.navoss.mobile.carplay.appearance"
  private let audioModeKey = "org.navoss.mobile.carplay.audio-mode"
  private let showsPointsOfInterestKey = "org.navoss.mobile.carplay.shows-points-of-interest"
  private let vehicleMarkerKey = "org.navoss.mobile.carplay.vehicle-marker"
  private let defaults: UserDefaults
  private let lock = NSLock()

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  public func load() -> NavOSSCarPlayPreferences {
    lock.lock()
    defer { lock.unlock() }
    return NavOSSCarPlayPreferences(
      appearance: defaults.string(forKey: appearanceKey)
        .flatMap(NavOSSCarPlayAppearance.init(rawValue:)) ?? .automatic,
      audioMode: defaults.string(forKey: audioModeKey)
        .flatMap(NavOSSCarPlayAudioMode.init(rawValue:)) ?? .allGuidance,
      showsPointsOfInterest: defaults.object(forKey: showsPointsOfInterestKey) == nil
        ? true
        : defaults.bool(forKey: showsPointsOfInterestKey),
      vehicleMarker: defaults.string(forKey: vehicleMarkerKey)
        .flatMap(NavOSSCarPlayVehicleMarker.init(rawValue:)) ?? .arrow
    )
  }

  public func setAppearance(_ appearance: NavOSSCarPlayAppearance) {
    lock.lock()
    defaults.set(appearance.rawValue, forKey: appearanceKey)
    lock.unlock()
  }

  public func setAudioMode(_ audioMode: NavOSSCarPlayAudioMode) {
    lock.lock()
    defaults.set(audioMode.rawValue, forKey: audioModeKey)
    lock.unlock()
  }

  public func setShowsPointsOfInterest(_ showsPointsOfInterest: Bool) {
    lock.lock()
    defaults.set(showsPointsOfInterest, forKey: showsPointsOfInterestKey)
    lock.unlock()
  }

  public func setVehicleMarker(_ vehicleMarker: NavOSSCarPlayVehicleMarker) {
    lock.lock()
    defaults.set(vehicleMarker.rawValue, forKey: vehicleMarkerKey)
    lock.unlock()
  }
}
