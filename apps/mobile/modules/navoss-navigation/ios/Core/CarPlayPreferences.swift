import Foundation

extension Notification.Name {
  public static let navOSSCarPlayPreferencesDidChange = Notification.Name(
    "org.navoss.mobile.carplay-preferences-did-change"
  )
}

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

public enum NavOSSCarPlayMapOrientation: String, CaseIterable, Sendable {
  case headingUp = "heading-up"
  case northUp = "north-up"

  public var label: String {
    switch self {
    case .headingUp: "Heading up"
    case .northUp: "North up"
    }
  }
}

public struct NavOSSCarPlayPreferences: Equatable, Sendable {
  public let appearance: NavOSSCarPlayAppearance
  public let audioMode: NavOSSCarPlayAudioMode
  public let routePreferences: NavOSSRoutePreferences
  public let mapOrientation: NavOSSCarPlayMapOrientation
  public let showsPointsOfInterest: Bool
  public let vehicleMarker: NavOSSCarPlayVehicleMarker

  public init(
    appearance: NavOSSCarPlayAppearance = .automatic,
    audioMode: NavOSSCarPlayAudioMode = .allGuidance,
    routePreferences: NavOSSRoutePreferences = NavOSSRoutePreferences(),
    mapOrientation: NavOSSCarPlayMapOrientation = .headingUp,
    showsPointsOfInterest: Bool = true,
    vehicleMarker: NavOSSCarPlayVehicleMarker = .arrow
  ) {
    self.appearance = appearance
    self.audioMode = audioMode
    self.routePreferences = routePreferences
    self.mapOrientation = mapOrientation
    self.showsPointsOfInterest = showsPointsOfInterest
    self.vehicleMarker = vehicleMarker
  }
}

public final class NavOSSCarPlayPreferencesStore: @unchecked Sendable {
  public static let shared = NavOSSCarPlayPreferencesStore()

  private let appearanceKey = "org.navoss.mobile.carplay.appearance"
  private let audioModeKey = "org.navoss.mobile.carplay.audio-mode"
  private let avoidFerriesKey = "org.navoss.mobile.carplay.avoid-ferries"
  private let avoidHighwaysKey = "org.navoss.mobile.carplay.avoid-highways"
  private let avoidTollsKey = "org.navoss.mobile.carplay.avoid-tolls"
  private let avoidUnpavedKey = "org.navoss.mobile.carplay.avoid-unpaved"
  private let mapOrientationKey = "org.navoss.mobile.carplay.map-orientation"
  private let showsPointsOfInterestKey = "org.navoss.mobile.carplay.shows-points-of-interest"
  private let vehicleMarkerKey = "org.navoss.mobile.carplay.vehicle-marker"
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

  public func load() -> NavOSSCarPlayPreferences {
    lock.lock()
    defer { lock.unlock() }
    return NavOSSCarPlayPreferences(
      appearance: defaults.string(forKey: appearanceKey)
        .flatMap(NavOSSCarPlayAppearance.init(rawValue:)) ?? .automatic,
      audioMode: defaults.string(forKey: audioModeKey)
        .flatMap(NavOSSCarPlayAudioMode.init(rawValue:)) ?? .allGuidance,
      routePreferences: NavOSSRoutePreferences(
        avoidFerries: defaults.bool(forKey: avoidFerriesKey),
        avoidHighways: defaults.bool(forKey: avoidHighwaysKey),
        avoidTolls: defaults.bool(forKey: avoidTollsKey),
        avoidUnpaved: defaults.bool(forKey: avoidUnpavedKey)
      ),
      mapOrientation: defaults.string(forKey: mapOrientationKey)
        .flatMap(NavOSSCarPlayMapOrientation.init(rawValue:)) ?? .headingUp,
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
    notificationCenter.post(name: .navOSSCarPlayPreferencesDidChange, object: self)
  }

  public func setAudioMode(_ audioMode: NavOSSCarPlayAudioMode) {
    lock.lock()
    defaults.set(audioMode.rawValue, forKey: audioModeKey)
    lock.unlock()
    notificationCenter.post(name: .navOSSCarPlayPreferencesDidChange, object: self)
  }

  public func setRoutePreferences(_ routePreferences: NavOSSRoutePreferences) {
    lock.lock()
    defaults.set(routePreferences.avoidFerries, forKey: avoidFerriesKey)
    defaults.set(routePreferences.avoidHighways, forKey: avoidHighwaysKey)
    defaults.set(routePreferences.avoidTolls, forKey: avoidTollsKey)
    defaults.set(routePreferences.avoidUnpaved, forKey: avoidUnpavedKey)
    lock.unlock()
    notificationCenter.post(name: .navOSSCarPlayPreferencesDidChange, object: self)
  }

  public func setMapOrientation(_ mapOrientation: NavOSSCarPlayMapOrientation) {
    lock.lock()
    defaults.set(mapOrientation.rawValue, forKey: mapOrientationKey)
    lock.unlock()
    notificationCenter.post(name: .navOSSCarPlayPreferencesDidChange, object: self)
  }

  public func setShowsPointsOfInterest(_ showsPointsOfInterest: Bool) {
    lock.lock()
    defaults.set(showsPointsOfInterest, forKey: showsPointsOfInterestKey)
    lock.unlock()
    notificationCenter.post(name: .navOSSCarPlayPreferencesDidChange, object: self)
  }

  public func setVehicleMarker(_ vehicleMarker: NavOSSCarPlayVehicleMarker) {
    lock.lock()
    defaults.set(vehicleMarker.rawValue, forKey: vehicleMarkerKey)
    lock.unlock()
    notificationCenter.post(name: .navOSSCarPlayPreferencesDidChange, object: self)
  }
}

public func navOSSInitialCarPlayAudioState(
  preferencesStore: NavOSSCarPlayPreferencesStore
) -> NavOSSCarPlayAudioState {
  NavOSSCarPlayAudioState(mode: preferencesStore.load().audioMode)
}
