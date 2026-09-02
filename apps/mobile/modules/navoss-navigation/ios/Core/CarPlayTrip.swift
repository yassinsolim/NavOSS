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

public func navOSSCarPlayRouteChoiceDetails(
  _ routes: [NavOSSCarPlayTrip]
) -> [String?] {
  struct RoadCandidate {
    let displayName: String
    let firstStepIndex: Int
    let key: String
    var distanceMeters: Double
  }

  let candidatesByRoute = routes.map { route in
    var candidates: [String: RoadCandidate] = [:]
    for (stepIndex, step) in route.steps.enumerated() {
      let displayName = step.roadName.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !displayName.isEmpty else { continue }
      let key = displayName.lowercased()
      if var candidate = candidates[key] {
        candidate.distanceMeters += max(0, step.distanceMeters)
        candidates[key] = candidate
      } else {
        candidates[key] = RoadCandidate(
          displayName: displayName,
          firstStepIndex: stepIndex,
          key: key,
          distanceMeters: max(0, step.distanceMeters)
        )
      }
    }
    return Array(candidates.values)
  }
  var routePresenceByRoad: [String: Int] = [:]
  for candidates in candidatesByRoute {
    for key in Set(candidates.map(\.key)) {
      routePresenceByRoad[key, default: 0] += 1
    }
  }

  return candidatesByRoute.enumerated().map { routeIndex, candidates in
    let minimumMajorRoadDistance = max(200, routes[routeIndex].distanceMeters * 0.05)
    let majorCandidates = candidates.filter {
      $0.distanceMeters >= minimumMajorRoadDistance
        && routePresenceByRoad[$0.key, default: routes.count] < routes.count
    }
    let selected = majorCandidates.sorted { left, right in
      let leftPresence = routePresenceByRoad[left.key, default: routes.count]
      let rightPresence = routePresenceByRoad[right.key, default: routes.count]
      if leftPresence != rightPresence { return leftPresence < rightPresence }
      if left.distanceMeters != right.distanceMeters {
        return left.distanceMeters > right.distanceMeters
      }
      return left.firstStepIndex < right.firstStepIndex
    }.first
    if let selected { return "via \(selected.displayName)" }
    guard routeIndex > 0, let fastestRoute = routes.first else { return nil }
    let extraDistanceMeters = routes[routeIndex].distanceMeters - fastestRoute.distanceMeters
    if extraDistanceMeters >= 50 {
      if extraDistanceMeters < 1_000 {
        let roundedMeters = max(50, Int((extraDistanceMeters / 50).rounded()) * 50)
        return "\(roundedMeters) m longer"
      }
      return String(format: "%.1f km longer", extraDistanceMeters / 1_000)
    }
    let extraDurationMinutes = Int(
      ((routes[routeIndex].durationSeconds - fastestRoute.durationSeconds) / 60).rounded()
    )
    if extraDurationMinutes > 0 { return "\(extraDurationMinutes) min slower" }
    return "Similar route"
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
  public let compassHeadingDegrees: Double?
  public let speedMetersPerSecond: Double?

  public init(
    coordinate: NavOSSCarPlayCoordinate,
    courseDegrees: Double?,
    compassHeadingDegrees: Double? = nil,
    speedMetersPerSecond: Double? = nil
  ) {
    self.coordinate = coordinate
    self.courseDegrees = courseDegrees
    self.compassHeadingDegrees = compassHeadingDegrees
    self.speedMetersPerSecond = speedMetersPerSecond
  }

  var isValid: Bool {
    coordinate.isValid
      && courseDegrees.map { $0.isFinite && (0..<360).contains($0) } != false
      && compassHeadingDegrees.map { $0.isFinite && (0..<360).contains($0) } != false
      && speedMetersPerSecond.map { $0.isFinite && $0 >= 0 && $0 <= 100 } != false
  }
}

/// Replaces only a published position's compass heading so a heading callback does not perturb
/// the matching output from its latest location sample.
public func navOSSCarPlayPositionApplyingCompassHeading(
  _ compassHeadingDegrees: Double?,
  to position: NavOSSCarPlayPosition?
) -> NavOSSCarPlayPosition? {
  guard let position else { return nil }
  return NavOSSCarPlayPosition(
    coordinate: position.coordinate,
    courseDegrees: position.courseDegrees,
    compassHeadingDegrees: compassHeadingDegrees,
    speedMetersPerSecond: position.speedMetersPerSecond
  )
}

/// Resolves the facing cone independently from the vehicle marker's course-based rotation.
public func navOSSCarPlayConeHeadingDegrees(
  compassHeadingDegrees: Double?,
  fallbackCourseDegrees: Double?
) -> Double? {
  if let compassHeadingDegrees,
    compassHeadingDegrees.isFinite,
    (0..<360).contains(compassHeadingDegrees)
  {
    return compassHeadingDegrees
  }
  guard let fallbackCourseDegrees,
    fallbackCourseDegrees.isFinite,
    (0..<360).contains(fallbackCourseDegrees)
  else {
    return nil
  }
  return fallbackCourseDegrees
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
  // Distance from the route origin to each vertex, so a candidate segment's position can be
  // compared against the progress point along the road rather than by vertex count.
  var cumulativeLengths = [0.0]
  cumulativeLengths.reserveCapacity(geometry.count)
  for length in segmentLengths {
    cumulativeLengths.append(cumulativeLengths[cumulativeLengths.count - 1] + length)
  }
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
    // `matchedCoordinate` is the rendered puck, which interpolates toward the snapshot and can
    // therefore sit behind `routeProgress`. Splice from whichever of the two is earlier so the
    // vertices between them survive; otherwise the polyline cuts straight across any bend the
    // interpolation has not reached yet.
    let spliceIndex =
      matchedCoordinate.flatMap {
        navOSSNearestSegmentIndex(
          $0,
          in: geometry,
          segmentLengths: segmentLengths,
          cumulativeLengths: cumulativeLengths,
          completedLength: completedLength
        )
      }.map { min(index, $0) } ?? index
    return navOSSVisibleRouteTail(
      [matchedCoordinate ?? routePosition] + geometry.dropFirst(spliceIndex + 1),
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

/// How far behind the progress point the puck may project and still be treated as sitting on that
/// segment, measured along the route so sparse and dense geometry behave alike.
///
/// The puck lags the snapshot only by interpolation, so a legitimate match is a short way back; a
/// parallel outbound carriageway is far back along the route even though it is metres away in
/// space. That separation is what makes the bound work.
///
/// The value is derived from the interpolation contract, not from a sweep. The puck trails the
/// snapshot by at most `navOSSCarPlayMaximumInterpolationSeconds`, so at roughly 50 m/s the
/// legitimate lag is about 100 m; 250 m keeps a wide margin over that while staying far below the
/// separation between carriageways. A sweep cannot choose this number: any bound rejects
/// candidates beyond itself by construction, so measuring "splices past W" against bound W is
/// circular.
///
/// What is measured, via `pnpm --filter @navoss/mobile test:carplay-splice` over a checked-in real
/// 8.9 km Calgary out-and-back: the unbounded search picks a segment on the opposite carriageway
/// 179 times in 11,328 samples, worst case 8,902 m behind, so the defect is real on real geometry;
/// and bounding costs almost nothing, rejecting the correct segment in 5 of those samples at 250 m
/// against 7 at 50 m. The corner guarantee in the tests independently requires at least 186 m.
private let navOSSMaximumSegmentLookbackMeters = 250.0

private func navOSSNearestSegmentIndex(
  _ coordinate: NavOSSCarPlayCoordinate,
  in geometry: [NavOSSCarPlayCoordinate],
  segmentLengths: [Double],
  cumulativeLengths: [Double],
  completedLength: Double
) -> Int? {
  var bestIndex: Int?
  var bestDistanceMeters = Double.infinity
  for index in geometry.indices.dropLast() {
    let projection = navOSSCarPlaySegmentProjection(
      coordinate,
      start: geometry[index],
      end: geometry[index + 1]
    )
    // Measure from where the puck actually projects, not from the segment's start vertex: a long
    // segment would otherwise be rejected wholesale even when the puck sits near its far end.
    let projectedAlongRoute =
      cumulativeLengths[index] + projection.fraction * segmentLengths[index]
    // Only the backward direction is bounded. Road ahead stays eligible, because a duplicate leg
    // can only masquerade as the current one from behind.
    if completedLength - projectedAlongRoute > navOSSMaximumSegmentLookbackMeters {
      continue
    }
    if projection.distanceMeters < bestDistanceMeters {
      bestDistanceMeters = projection.distanceMeters
      bestIndex = index
    }
  }
  return bestIndex
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

/// Closed polygon ring for the vehicle's forward-looking heading cone.
///
/// Bearings use the navigation convention: 0° is true north and values increase clockwise.
/// The local metre conversion intentionally matches `navOSSCarPlaySegmentProjection`.
public func navOSSHeadingConePolygon(
  apex: NavOSSCarPlayCoordinate,
  headingDegrees: Double,
  radiusMeters: Double,
  spreadDegrees: Double
) -> [NavOSSCarPlayCoordinate] {
  guard apex.isValid, headingDegrees.isFinite, radiusMeters.isFinite, radiusMeters >= 0,
    spreadDegrees.isFinite, (0...360).contains(spreadDegrees)
  else {
    return []
  }

  let latitudeScale = 111_320.0
  let longitudeScale = latitudeScale * cos(apex.latitude * .pi / 180)
  let segmentCount = max(1, Int(ceil(spreadDegrees / 5)))
  let startBearingDegrees = headingDegrees - spreadDegrees / 2
  var polygon = [apex]
  polygon.reserveCapacity(segmentCount + 3)

  for segment in 0...segmentCount {
    let bearingDegrees = startBearingDegrees
      + spreadDegrees * Double(segment) / Double(segmentCount)
    let bearingRadians = bearingDegrees * .pi / 180
    polygon.append(
      NavOSSCarPlayCoordinate(
        latitude: apex.latitude + radiusMeters * cos(bearingRadians) / latitudeScale,
        longitude: apex.longitude + radiusMeters * sin(bearingRadians) / longitudeScale
      )
    )
  }

  polygon.append(apex)
  return polygon
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

/// Maximum distance from the route at which the route's own heading may stand in for a missing
/// vehicle course. Matches the off-route departure threshold in `NavigationCore`, so a vehicle
/// the matcher would call off-route never inherits the route's bearing.
public let navOSSRouteBearingMaxDistanceMeters = 35.0

/// Bearing of the route segment nearest `coordinate`, or `nil` when the coordinate is farther
/// than `maxDistanceMeters` from the route. Used only as a fallback when the vehicle reports no
/// usable course; an off-route vehicle must not be shown pointing along a road it is not on.
///
/// - Important: Pass true road geometry. Passing `navOSSRemainingRouteGeometry` output defeats
///   the distance gate, because that helper prepends the vehicle's own matched coordinate as
///   element 0, putting the query point 0 m from the "route". An early revision of the CarPlay
///   controller made exactly this mistake and the gate was inert until review caught it.
public func navOSSRouteBearingDegrees(
  near coordinate: NavOSSCarPlayCoordinate,
  in geometry: [NavOSSCarPlayCoordinate],
  maxDistanceMeters: Double = navOSSRouteBearingMaxDistanceMeters
) -> Double? {
  guard geometry.count >= 2 else { return nil }
  var bestDistanceMeters = Double.infinity
  var bestBearingDegrees: Double?
  for index in geometry.indices.dropLast() {
    let start = geometry[index]
    let end = geometry[index + 1]
    guard start != end else { continue }
    let projection = navOSSCarPlaySegmentProjection(coordinate, start: start, end: end)
    guard projection.distanceMeters < bestDistanceMeters else { continue }
    bestDistanceMeters = projection.distanceMeters
    let meanLatitude = (start.latitude + end.latitude) / 2 * .pi / 180
    let degrees =
      atan2(
        (end.longitude - start.longitude) * cos(meanLatitude),
        end.latitude - start.latitude
      ) * 180 / .pi
    bestBearingDegrees = degrees >= 0 ? degrees : degrees + 360
  }
  guard bestDistanceMeters <= maxDistanceMeters else { return nil }
  return bestBearingDegrees
}

/// Fallback animation span used before two targets have been seen.
public let navOSSCarPlayDefaultInterpolationSeconds = 0.9
/// Clamp bounds. Below the floor the animation is imperceptible and churns frames; above the
/// ceiling a late fix would stretch one span so far that the vehicle visibly crawls.
public let navOSSCarPlayMinimumInterpolationSeconds = 0.25
public let navOSSCarPlayMaximumInterpolationSeconds = 2.0

/// Animation span for one position update.
///
/// A fixed span cannot match a variable sample interval: when it is shorter than the gap the
/// vehicle reaches its target and sits still until the next fix, and when it is longer the
/// vehicle is still catching up when a new target arrives. Feeding the observed interval back in
/// keeps the animation continuous, so the span tracks however often fixes actually arrive.
public func navOSSCarPlayInterpolationSeconds(
  sinceLastTargetSeconds: Double?,
  defaultSeconds: Double = navOSSCarPlayDefaultInterpolationSeconds
) -> Double {
  guard let sinceLastTargetSeconds, sinceLastTargetSeconds.isFinite, sinceLastTargetSeconds > 0
  else {
    return defaultSeconds
  }
  return min(
    navOSSCarPlayMaximumInterpolationSeconds,
    max(navOSSCarPlayMinimumInterpolationSeconds, sinceLastTargetSeconds)
  )
}
