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

public struct NavOSSCarPlayPreferences: Equatable, Sendable {
  public let appearance: NavOSSCarPlayAppearance
  public let audioMode: NavOSSCarPlayAudioMode

  public init(
    appearance: NavOSSCarPlayAppearance = .automatic,
    audioMode: NavOSSCarPlayAudioMode = .allGuidance
  ) {
    self.appearance = appearance
    self.audioMode = audioMode
  }
}

public final class NavOSSCarPlayPreferencesStore: @unchecked Sendable {
  public static let shared = NavOSSCarPlayPreferencesStore()

  private let appearanceKey = "org.navoss.mobile.carplay.appearance"
  private let audioModeKey = "org.navoss.mobile.carplay.audio-mode"
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
        .flatMap(NavOSSCarPlayAudioMode.init(rawValue:)) ?? .allGuidance
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
}
