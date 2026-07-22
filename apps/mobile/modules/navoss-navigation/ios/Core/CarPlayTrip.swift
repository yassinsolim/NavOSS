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

public struct NavOSSCarPlayRouteStep: Codable, Equatable, Sendable {
  public let distanceMeters: Double
  public let durationSeconds: Double
  public let geometry: [NavOSSCarPlayCoordinate]
  public let instruction: String
  public let maneuverType: String
  public let roadName: String

  public init(
    distanceMeters: Double,
    durationSeconds: Double,
    geometry: [NavOSSCarPlayCoordinate],
    instruction: String,
    maneuverType: String,
    roadName: String
  ) {
    self.distanceMeters = distanceMeters
    self.durationSeconds = durationSeconds
    self.geometry = geometry
    self.instruction = instruction
    self.maneuverType = maneuverType
    self.roadName = roadName
  }

  var isValid: Bool {
    distanceMeters.isFinite && distanceMeters >= 0 && durationSeconds.isFinite
      && durationSeconds >= 0 && geometry.count >= 2 && geometry.allSatisfy(\.isValid)
      && !instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && !maneuverType.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }
}

public struct NavOSSCarPlayTrip: Codable, Equatable, Sendable {
  public let destination: NavOSSCarPlayDestination
  public let distanceMeters: Double
  public let durationSeconds: Double
  public let geometry: [NavOSSCarPlayCoordinate]
  public let id: String
  public let steps: [NavOSSCarPlayRouteStep]

  public init(
    destination: NavOSSCarPlayDestination,
    distanceMeters: Double,
    durationSeconds: Double,
    geometry: [NavOSSCarPlayCoordinate],
    id: String,
    steps: [NavOSSCarPlayRouteStep]
  ) {
    self.destination = destination
    self.distanceMeters = distanceMeters
    self.durationSeconds = durationSeconds
    self.geometry = geometry
    self.id = id
    self.steps = steps
  }

  var isValid: Bool {
    destination.isValid && !id.isEmpty && distanceMeters.isFinite && distanceMeters > 0
      && durationSeconds.isFinite && durationSeconds > 0 && geometry.count >= 2
      && geometry.allSatisfy(\.isValid) && !steps.isEmpty && steps.allSatisfy(\.isValid)
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

  public init(notificationCenter: NotificationCenter = .default) {
    self.notificationCenter = notificationCenter
  }

  public func clearTrip() {
    update { current in
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

  private func update(_ transform: (NavOSSCarPlayState) -> NavOSSCarPlayState) {
    lock.lock()
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
