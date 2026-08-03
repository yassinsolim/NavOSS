import Foundation

public func navOSSCarPlayDistanceMeasurement(
  _ distanceMeters: Double
) -> Measurement<UnitLength> {
  let distance = max(0, distanceMeters)
  return distance >= 1_000
    ? Measurement(value: distance / 1_000, unit: .kilometers)
    : Measurement(value: distance, unit: .meters)
}

public func navOSSCarPlayViewingDistance(_ distanceToManeuverMeters: Double?) -> Double {
  guard let distanceToManeuverMeters, distanceToManeuverMeters.isFinite else {
    return 850
  }
  if distanceToManeuverMeters < 120 { return 450 }
  if distanceToManeuverMeters < 500 { return 650 }
  if distanceToManeuverMeters < 2_000 { return 900 }
  return 1_200
}

public func navOSSCarPlaySpeedLimit(
  _ speedLimitsKph: [Int]?,
  geometry: [NavOSSCarPlayCoordinate],
  matchedCoordinate: NavOSSCarPlayCoordinate?,
  routeProgress: Double
) -> Int? {
  guard let speedLimitsKph, speedLimitsKph.count == geometry.count - 1,
    !speedLimitsKph.isEmpty, routeProgress.isFinite
  else {
    return nil
  }
  let index =
    matchedCoordinate.flatMap { coordinate in
      geometry.indices.dropLast().min { left, right in
        navOSSCarPlayDistanceToSegment(
          coordinate,
          start: geometry[left],
          end: geometry[left + 1]
        )
          < navOSSCarPlayDistanceToSegment(
            coordinate,
            start: geometry[right],
            end: geometry[right + 1]
          )
      }
    }
    ?? min(
      speedLimitsKph.count - 1,
      Int(floor(min(1, max(0, routeProgress)) * Double(speedLimitsKph.count)))
    )
  let speedLimit = speedLimitsKph[index]
  return speedLimit > 0 ? speedLimit : nil
}

private func navOSSCarPlayDistanceToSegment(
  _ coordinate: NavOSSCarPlayCoordinate,
  start: NavOSSCarPlayCoordinate,
  end: NavOSSCarPlayCoordinate
) -> Double {
  let latitudeScale = 111_320.0
  let longitudeScale = latitudeScale * cos(coordinate.latitude * .pi / 180)
  let startX = (start.longitude - coordinate.longitude) * longitudeScale
  let startY = (start.latitude - coordinate.latitude) * latitudeScale
  let endX = (end.longitude - coordinate.longitude) * longitudeScale
  let endY = (end.latitude - coordinate.latitude) * latitudeScale
  let deltaX = endX - startX
  let deltaY = endY - startY
  let squaredLength = deltaX * deltaX + deltaY * deltaY
  let projection =
    squaredLength == 0
    ? 0
    : min(1, max(0, -(startX * deltaX + startY * deltaY) / squaredLength))
  return hypot(startX + projection * deltaX, startY + projection * deltaY)
}

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

public struct NavOSSCarPlayTraffic: Codable, Equatable, Sendable {
  public let delaySeconds: Double
  public let typicalDurationSeconds: Double

  public init(delaySeconds: Double, typicalDurationSeconds: Double) {
    self.delaySeconds = delaySeconds
    self.typicalDurationSeconds = typicalDurationSeconds
  }

  var isValid: Bool {
    delaySeconds.isFinite && delaySeconds >= 0
      && typicalDurationSeconds.isFinite && typicalDurationSeconds > 0
  }
}

public struct NavOSSCarPlayTrip: Codable, Equatable, Sendable {
  public let destination: NavOSSCarPlayDestination
  public let distanceMeters: Double
  public let durationSeconds: Double
  public let geometry: [NavOSSCarPlayCoordinate]
  public let id: String
  public let preferences: NavOSSRoutePreferences
  public let source: String?
  public let speedLimitsKph: [Int]?
  public let steps: [NavOSSCarPlayRouteStep]
  public let traffic: NavOSSCarPlayTraffic?
  public let waypoints: [NavOSSCarPlayDestination]?

  public init(
    destination: NavOSSCarPlayDestination,
    distanceMeters: Double,
    durationSeconds: Double,
    geometry: [NavOSSCarPlayCoordinate],
    id: String,
    preferences: NavOSSRoutePreferences = NavOSSRoutePreferences(),
    source: String? = nil,
    speedLimitsKph: [Int]? = nil,
    steps: [NavOSSCarPlayRouteStep],
    traffic: NavOSSCarPlayTraffic? = nil,
    waypoints: [NavOSSCarPlayDestination]? = nil
  ) {
    self.destination = destination
    self.distanceMeters = distanceMeters
    self.durationSeconds = durationSeconds
    self.geometry = geometry
    self.id = id
    self.preferences = preferences
    self.source = source
    self.speedLimitsKph = speedLimitsKph
    self.steps = steps
    self.traffic = traffic
    self.waypoints = waypoints
  }

  var isValid: Bool {
    destination.isValid && !id.isEmpty && distanceMeters.isFinite && distanceMeters > 0
      && durationSeconds.isFinite && durationSeconds > 0 && geometry.count >= 2
      && geometry.allSatisfy(\.isValid) && geometry.contains { $0 != geometry[0] }
      && speedLimitsKph.map {
        $0.count == geometry.count - 1 && $0.allSatisfy { (0...250).contains($0) }
      } != false
      && !steps.isEmpty && steps.allSatisfy(\.isValid) && traffic?.isValid != false
      && waypoints?.allSatisfy(\.isValid) != false
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

public struct NavOSSCarPlayPosition: Equatable, Sendable {
  public let coordinate: NavOSSCarPlayCoordinate
  public let courseDegrees: Double?
  public let speedMetersPerSecond: Double?

  public init(
    coordinate: NavOSSCarPlayCoordinate,
    courseDegrees: Double?,
    speedMetersPerSecond: Double? = nil
  ) {
    self.coordinate = coordinate
    self.courseDegrees = courseDegrees
    self.speedMetersPerSecond = speedMetersPerSecond
  }

  var isValid: Bool {
    coordinate.isValid
      && courseDegrees.map { $0.isFinite && (0..<360).contains($0) } != false
      && speedMetersPerSecond.map { $0.isFinite && $0 >= 0 && $0 <= 100 } != false
  }
}

public func navOSSCarPlayIsSpeeding(speedKph: Int, speedLimitKph: Int?) -> Bool {
  speedLimitKph.map { speedKph >= $0 + 5 } ?? false
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
  public let position: NavOSSCarPlayPosition?
  public let routeProgress: Double
  public let trip: NavOSSCarPlayTrip?

  public init(
    connected: Bool,
    guidance: NavOSSCarPlayGuidance?,
    position: NavOSSCarPlayPosition? = nil,
    routeProgress: Double = 0,
    trip: NavOSSCarPlayTrip?
  ) {
    self.connected = connected
    self.guidance = guidance
    self.position = position
    self.routeProgress = min(1, max(0, routeProgress.isFinite ? routeProgress : 0))
    self.trip = trip
  }
}

public struct NavOSSCarPlayControlState: Equatable, Sendable {
  public let drivingControlsVisible: Bool
  public let endNavigationVisible: Bool
  public let reportVisible: Bool
  public let returnToRootFromSearch: Bool
  public let searchVisible: Bool
  public let settingsVisible: Bool
  public let soundSettingsVisible: Bool

  public init(hasActiveTrip: Bool, searchVisible: Bool) {
    drivingControlsVisible = hasActiveTrip
    endNavigationVisible = hasActiveTrip
    reportVisible = hasActiveTrip
    returnToRootFromSearch = hasActiveTrip && searchVisible
    self.searchVisible = !hasActiveTrip
    settingsVisible = !hasActiveTrip
    soundSettingsVisible = hasActiveTrip
  }
}

public struct NavOSSCarPlayAudioState: Equatable, Sendable {
  public private(set) var mode: NavOSSCarPlayAudioMode

  public init(mode: NavOSSCarPlayAudioMode = .allGuidance) {
    self.mode = mode
  }

  public var allowsAlerts: Bool {
    mode != .muted
  }

  public var allowsManeuverGuidance: Bool {
    mode == .allGuidance
  }

  public mutating func setMode(_ mode: NavOSSCarPlayAudioMode) {
    self.mode = mode
  }
}

public func navOSSRemainingRouteGeometry(
  _ geometry: [NavOSSCarPlayCoordinate],
  routeProgress: Double,
  matchedCoordinate: NavOSSCarPlayCoordinate? = nil
) -> [NavOSSCarPlayCoordinate] {
  guard geometry.count >= 2 else {
    return geometry
  }
  let segmentLengths = zip(geometry, geometry.dropFirst()).map { start, end in
    navOSSCarPlayCoordinateDistance(from: start, to: end)
  }
  let totalLength = segmentLengths.reduce(0, +)
  let progress = min(1, max(0, routeProgress.isFinite ? routeProgress : 0))
  let completedLength = progress * totalLength
  var traversedLength = 0.0

  for (index, segmentLength) in segmentLengths.enumerated() {
    if traversedLength + segmentLength < completedLength {
      traversedLength += segmentLength
      continue
    }
    let start = geometry[index]
    let end = geometry[index + 1]
    let segmentProgress =
      segmentLength == 0
      ? 0
      : (completedLength - traversedLength) / segmentLength
    let routePosition = NavOSSCarPlayCoordinate(
      latitude: start.latitude + (end.latitude - start.latitude) * segmentProgress,
      longitude: start.longitude + (end.longitude - start.longitude) * segmentProgress
    )
    return navOSSVisibleRouteTail(
      [matchedCoordinate ?? routePosition] + geometry.dropFirst(index + 1),
      fullGeometry: geometry
    )
  }

  let destination = geometry[geometry.count - 1]
  return navOSSVisibleRouteTail(
    [matchedCoordinate ?? destination, destination],
    fullGeometry: geometry
  )
}

private func navOSSVisibleRouteTail(
  _ remaining: [NavOSSCarPlayCoordinate],
  fullGeometry: [NavOSSCarPlayCoordinate]
) -> [NavOSSCarPlayCoordinate] {
  guard let first = remaining.first,
    !remaining.dropFirst().contains(where: { $0 != first }),
    let destination = fullGeometry.last,
    let anchor = fullGeometry.dropLast().last(where: { $0 != destination })
  else {
    return remaining
  }
  return [anchor, destination]
}

public func navOSSRemainingWaypoints(
  in trip: NavOSSCarPlayTrip,
  after routeProgress: Double
) -> [NavOSSCarPlayDestination] {
  guard let waypoints = trip.waypoints, !waypoints.isEmpty else {
    return []
  }
  return waypoints.filter { waypoint in
    navOSSWaypointProgress(waypoint, along: trip.geometry) > routeProgress
  }
}

private func navOSSWaypointProgress(
  _ waypoint: NavOSSCarPlayDestination,
  along geometry: [NavOSSCarPlayCoordinate]
) -> Double {
  guard geometry.count >= 2 else { return 1 }
  var cumulativeDistances = [0.0]
  for index in 1..<geometry.count {
    cumulativeDistances.append(
      cumulativeDistances[index - 1]
        + navOSSCarPlayCoordinateDistance(from: geometry[index - 1], to: geometry[index])
    )
  }
  guard let totalDistance = cumulativeDistances.last, totalDistance > 0 else { return 1 }
  let coordinate = NavOSSCarPlayCoordinate(
    latitude: waypoint.latitude,
    longitude: waypoint.longitude
  )
  var bestDistance = Double.infinity
  var bestProgress = 1.0
  for index in geometry.indices.dropLast() {
    let projection = navOSSCarPlaySegmentProjection(
      coordinate,
      start: geometry[index],
      end: geometry[index + 1]
    )
    guard projection.distanceMeters < bestDistance else { continue }
    bestDistance = projection.distanceMeters
    let segmentLength = cumulativeDistances[index + 1] - cumulativeDistances[index]
    bestProgress =
      (cumulativeDistances[index] + segmentLength * projection.fraction) / totalDistance
  }
  return bestProgress
}

private func navOSSCarPlaySegmentProjection(
  _ coordinate: NavOSSCarPlayCoordinate,
  start: NavOSSCarPlayCoordinate,
  end: NavOSSCarPlayCoordinate
) -> (distanceMeters: Double, fraction: Double) {
  let latitudeScale = 111_320.0
  let longitudeScale = latitudeScale * cos(coordinate.latitude * .pi / 180)
  let startX = (start.longitude - coordinate.longitude) * longitudeScale
  let startY = (start.latitude - coordinate.latitude) * latitudeScale
  let endX = (end.longitude - coordinate.longitude) * longitudeScale
  let endY = (end.latitude - coordinate.latitude) * latitudeScale
  let deltaX = endX - startX
  let deltaY = endY - startY
  let squaredLength = deltaX * deltaX + deltaY * deltaY
  let fraction = squaredLength == 0
    ? 0
    : min(1, max(0, -(startX * deltaX + startY * deltaY) / squaredLength))
  return (hypot(startX + fraction * deltaX, startY + fraction * deltaY), fraction)
}

private func navOSSCarPlayCoordinateDistance(
  from start: NavOSSCarPlayCoordinate,
  to end: NavOSSCarPlayCoordinate
) -> Double {
  let latitudeDelta = (end.latitude - start.latitude) * .pi / 180
  let longitudeDelta = (end.longitude - start.longitude) * .pi / 180
  let startLatitude = start.latitude * .pi / 180
  let endLatitude = end.latitude * .pi / 180
  let haversine =
    sin(latitudeDelta / 2) * sin(latitudeDelta / 2)
    + cos(startLatitude) * cos(endLatitude)
    * sin(longitudeDelta / 2) * sin(longitudeDelta / 2)
  return 2 * 6_371_000 * asin(sqrt(haversine))
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
      NavOSSCarPlayState(
        connected: current.connected,
        guidance: nil,
        position: nil,
        routeProgress: 0,
        trip: nil
      )
    }
  }

  public func clearTrip(generation: UInt64, sequence: Int) {
    update(generation: generation, sequence: sequence) { current in
      NavOSSCarPlayState(
        connected: current.connected,
        guidance: nil,
        position: nil,
        routeProgress: 0,
        trip: nil
      )
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
        position: current.position,
        routeProgress: current.routeProgress,
        trip: current.trip
      )
    }
  }

  public func publishTrip(_ trip: NavOSSCarPlayTrip) {
    guard trip.isValid else {
      return
    }
    update { current in
      NavOSSCarPlayState(
        connected: current.connected,
        guidance: nil,
        position: current.position,
        routeProgress: 0,
        trip: trip
      )
    }
  }

  public func publishNavigationState(
    trip: NavOSSCarPlayTrip,
    guidance: NavOSSCarPlayGuidance?,
    position: NavOSSCarPlayPosition? = nil,
    routeProgress: Double = 0,
    generation: UInt64,
    sequence: Int
  ) {
    guard trip.isValid, guidance?.isValid != false, position?.isValid != false,
      routeProgress.isFinite, (0...1).contains(routeProgress)
    else {
      return
    }
    update(generation: generation, sequence: sequence) { current in
      NavOSSCarPlayState(
        connected: current.connected,
        guidance: guidance,
        position: position,
        routeProgress: routeProgress,
        trip: trip
      )
    }
  }

  public func setConnected(_ connected: Bool) {
    update { current in
      NavOSSCarPlayState(
        connected: connected,
        guidance: current.guidance,
        position: current.position,
        routeProgress: current.routeProgress,
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
