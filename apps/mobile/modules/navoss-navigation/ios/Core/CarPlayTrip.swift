import Foundation

extension Notification.Name {
  public static let navOSSCarPlayNavigationDidEnd = Notification.Name(
    "org.navoss.mobile.carplay-navigation-did-end"
  )
  public static let navOSSCarPlayStateDidChange = Notification.Name(
    "org.navoss.mobile.carplay-state-did-change"
  )
}

public struct NavOSSCarPlayCoordinate: Codable, Equatable, Sendable {
  public let latitude: Double
  public let longitude: Double

  public init(latitude: Double, longitude: Double) {
    self.latitude = latitude
    self.longitude = longitude
  }

  var isValid: Bool {
    latitude.isFinite && longitude.isFinite && (-90...90).contains(latitude)
      && (-180...180).contains(longitude)
  }
}

public struct NavOSSRoutePreferences: Codable, Equatable, Sendable {
  public let avoidFerries: Bool
  public let avoidHighways: Bool
  public let avoidTolls: Bool
  public let avoidUnpaved: Bool

  public init(
    avoidFerries: Bool = false,
    avoidHighways: Bool = false,
    avoidTolls: Bool = false,
    avoidUnpaved: Bool = false
  ) {
    self.avoidFerries = avoidFerries
    self.avoidHighways = avoidHighways
    self.avoidTolls = avoidTolls
    self.avoidUnpaved = avoidUnpaved
  }
}

public struct NavOSSCarPlayRouteStep: Codable, Equatable, Sendable {
  public let distanceMeters: Double
  public let durationSeconds: Double
  public let geometry: [NavOSSCarPlayCoordinate]
  public let instruction: String
  public let maneuverType: String
  public let roadName: String
  public let spokenInstruction: String?

  public init(
    distanceMeters: Double,
    durationSeconds: Double,
    geometry: [NavOSSCarPlayCoordinate],
    instruction: String,
    maneuverType: String,
    roadName: String,
    spokenInstruction: String? = nil
  ) {
    self.distanceMeters = distanceMeters
    self.durationSeconds = durationSeconds
    self.geometry = geometry
    self.instruction = instruction
    self.maneuverType = maneuverType
    self.roadName = roadName
    self.spokenInstruction = spokenInstruction
  }

  var isValid: Bool {
    distanceMeters.isFinite && distanceMeters >= 0 && durationSeconds.isFinite
      && durationSeconds >= 0 && geometry.count >= 2 && geometry.allSatisfy(\.isValid)
      && !instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && !maneuverType.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && (spokenInstruction?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        || spokenInstruction == nil)
  }
}

public struct NavOSSCarPlayTrip: Codable, Equatable, Sendable {
  public let destination: NavOSSCarPlayDestination
  public let distanceMeters: Double
  public let durationSeconds: Double
  public let geometry: [NavOSSCarPlayCoordinate]
  public let id: String
  public let preferences: NavOSSRoutePreferences
  public let steps: [NavOSSCarPlayRouteStep]

  public init(
    destination: NavOSSCarPlayDestination,
    distanceMeters: Double,
    durationSeconds: Double,
    geometry: [NavOSSCarPlayCoordinate],
    id: String,
    preferences: NavOSSRoutePreferences = NavOSSRoutePreferences(),
    steps: [NavOSSCarPlayRouteStep]
  ) {
    self.destination = destination
    self.distanceMeters = distanceMeters
    self.durationSeconds = durationSeconds
    self.geometry = geometry
    self.id = id
    self.preferences = preferences
    self.steps = steps
  }

  var isValid: Bool {
    destination.isValid && !id.isEmpty && distanceMeters.isFinite && distanceMeters > 0
      && durationSeconds.isFinite && durationSeconds > 0 && geometry.count >= 2
      && geometry.allSatisfy(\.isValid) && geometry.contains { $0 != geometry[0] }
      && !steps.isEmpty && steps.allSatisfy(\.isValid)
  }
}

public final class NavOSSActiveTripStore: @unchecked Sendable {
  private struct StoredTrip: Codable {
    let expiresAt: Date
    let trip: NavOSSCarPlayTrip
  }

  private let clock: () -> Date
  private let defaults: UserDefaults
  private let expirationInterval: TimeInterval
  private let key: String
  private let lock = NSLock()

  public init(
    defaults: UserDefaults = .standard,
    key: String = "org.navoss.mobile.active-navigation-trip",
    expirationInterval: TimeInterval = 12 * 60 * 60,
    clock: @escaping () -> Date = Date.init
  ) {
    self.clock = clock
    self.defaults = defaults
    self.expirationInterval = expirationInterval
    self.key = key
  }

  public func clear() {
    lock.lock()
    defaults.removeObject(forKey: key)
    lock.unlock()
  }

  public func load() -> NavOSSCarPlayTrip? {
    lock.lock()
    defer { lock.unlock() }
    guard let data = defaults.data(forKey: key),
      let stored = try? JSONDecoder().decode(StoredTrip.self, from: data),
      stored.expiresAt > clock()
    else {
      defaults.removeObject(forKey: key)
      return nil
    }
    return stored.trip
  }

  public func save(_ trip: NavOSSCarPlayTrip) {
    let stored = StoredTrip(
      expiresAt: clock().addingTimeInterval(expirationInterval),
      trip: trip
    )
    guard trip.isValid, let data = try? JSONEncoder().encode(stored) else {
      return
    }
    lock.lock()
    defaults.set(data, forKey: key)
    lock.unlock()
  }
}

public enum NavOSSCarPlayGuidancePhase: String, Codable, Equatable, Sendable {
  case arrived
  case navigating
  case preview
}

public struct NavOSSCarPlayGuidance: Codable, Equatable, Sendable {
  public let distanceToManeuverMeters: Double
  public let durationToManeuverSeconds: Double
  public let instruction: String
  public let maneuverType: String
  public let phase: NavOSSCarPlayGuidancePhase
  public let remainingDistanceMeters: Double
  public let remainingDurationSeconds: Double
  public let roadName: String
  public let stepIndex: Int

  public init(
    distanceToManeuverMeters: Double,
    durationToManeuverSeconds: Double,
    instruction: String,
    maneuverType: String,
    phase: NavOSSCarPlayGuidancePhase,
    remainingDistanceMeters: Double,
    remainingDurationSeconds: Double,
    roadName: String,
    stepIndex: Int
  ) {
    self.distanceToManeuverMeters = distanceToManeuverMeters
    self.durationToManeuverSeconds = durationToManeuverSeconds
    self.instruction = instruction
    self.maneuverType = maneuverType
    self.phase = phase
    self.remainingDistanceMeters = remainingDistanceMeters
    self.remainingDurationSeconds = remainingDurationSeconds
    self.roadName = roadName
    self.stepIndex = stepIndex
  }

  var isValid: Bool {
    distanceToManeuverMeters.isFinite && distanceToManeuverMeters >= 0
      && durationToManeuverSeconds.isFinite && durationToManeuverSeconds >= 0
      && remainingDistanceMeters.isFinite && remainingDistanceMeters >= 0
      && remainingDurationSeconds.isFinite && remainingDurationSeconds >= 0 && stepIndex >= 0
      && !instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && !maneuverType.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }
}

public struct NavOSSCarPlayState: Equatable, Sendable {
  public let connected: Bool
  public let guidance: NavOSSCarPlayGuidance?
  public let trip: NavOSSCarPlayTrip?

  public init(
    connected: Bool,
    guidance: NavOSSCarPlayGuidance?,
    trip: NavOSSCarPlayTrip?
  ) {
    self.connected = connected
    self.guidance = guidance
    self.trip = trip
  }
}

public final class NavOSSCarPlayTripStore: @unchecked Sendable {
  public static let shared = NavOSSCarPlayTripStore()

  private let lock = NSLock()
  private let notificationCenter: NotificationCenter
  private var state = NavOSSCarPlayState(connected: false, guidance: nil, trip: nil)
  private var stateGeneration: UInt64 = 0
  private var stateSequence = 0

  public init(notificationCenter: NotificationCenter = .default) {
    self.notificationCenter = notificationCenter
  }

  public func clearTrip() {
    update { current in
      NavOSSCarPlayState(connected: current.connected, guidance: nil, trip: nil)
    }
  }

  public func clearTrip(generation: UInt64, sequence: Int) {
    update(generation: generation, sequence: sequence) { current in
      NavOSSCarPlayState(connected: current.connected, guidance: nil, trip: nil)
    }
  }

  public func endTripFromCarPlay() {
    clearTrip()
    notificationCenter.post(name: .navOSSCarPlayNavigationDidEnd, object: self)
  }

  public func publishGuidance(_ guidance: NavOSSCarPlayGuidance) {
    guard guidance.isValid else {
      return
    }
    update { current in
      guard current.trip != nil else {
        return current
      }
      return NavOSSCarPlayState(
        connected: current.connected,
        guidance: guidance,
        trip: current.trip
      )
    }
  }

  public func publishTrip(_ trip: NavOSSCarPlayTrip) {
    guard trip.isValid else {
      return
    }
    update { current in
      NavOSSCarPlayState(connected: current.connected, guidance: nil, trip: trip)
    }
  }

  public func publishNavigationState(
    trip: NavOSSCarPlayTrip,
    guidance: NavOSSCarPlayGuidance?,
    generation: UInt64,
    sequence: Int
  ) {
    guard trip.isValid, guidance?.isValid != false else {
      return
    }
    update(generation: generation, sequence: sequence) { current in
      NavOSSCarPlayState(
        connected: current.connected,
        guidance: guidance,
        trip: trip
      )
    }
  }

  public func setConnected(_ connected: Bool) {
    update { current in
      NavOSSCarPlayState(
        connected: connected,
        guidance: current.guidance,
        trip: current.trip
      )
    }
  }

  public func snapshot() -> NavOSSCarPlayState {
    lock.lock()
    defer { lock.unlock() }
    return state
  }

  private func update(
    generation: UInt64? = nil,
    sequence: Int? = nil,
    _ transform: (NavOSSCarPlayState) -> NavOSSCarPlayState
  ) {
    lock.lock()
    if let generation, let sequence {
      guard
        generation > stateGeneration
          || (generation == stateGeneration && sequence >= stateSequence)
      else {
        lock.unlock()
        return
      }
      stateGeneration = generation
      stateSequence = sequence
    }
    let previous = state
    let next = transform(previous)
    state = next
    lock.unlock()

    guard next != previous else {
      return
    }
    notificationCenter.post(name: .navOSSCarPlayStateDidChange, object: self)
  }
}
