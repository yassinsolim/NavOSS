import Foundation

public func navOSSCarPlayDistanceMeasurement(
  _ distanceMeters: Double
) -> Measurement<UnitLength> {
  let distance = max(0, distanceMeters)
  return distance >= 1_000
    ? Measurement(value: distance / 1_000, unit: .kilometers)
    : Measurement(value: distance, unit: .meters)
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
  /// What to say for this step's own maneuver (the `/v2/routes` meaning). Responses from
  /// `/v1/routes`, where it described the following maneuver, are shifted when decoded.
  public let spokenInstruction: String?
  /// Optional OSRM maneuver modifier ("left", "slight right", …) from `/v2/routes`. When absent
  /// the instruction text is used instead.
  public let maneuverModifier: String?
  /// Optional 1-based roundabout exit count from the provider.
  public let roundaboutExit: Int?
  /// Optional posted exit number ("12A"), shown as a highway exit label.
  public let exitNumber: String?
  /// Optional signpost destination text ("Downtown / Banff").
  public let signpost: String?
  /// Optional signpost branch (route numbers or road names) and toward (place names) elements,
  /// kept as the provider wrote them.
  public let signpostBranch: [String]?
  public let signpostToward: [String]?
  /// Optional name of the junction or interchange.
  public let junctionName: String?
  /// Optional lanes at the approach to this step's maneuver, left to right.
  public let lanes: [NavOSSCarPlayLane]?
  /// Optional name of the road driven along this step's geometry, when it differs from the
  /// maneuver's road name.
  public let currentRoadName: String?
  /// Optional provider bearings either side of this step's maneuver, in degrees from north.
  public let bearingBeforeDegrees: Double?
  public let bearingAfterDegrees: Double?

  public init(
    distanceMeters: Double,
    durationSeconds: Double,
    geometry: [NavOSSCarPlayCoordinate],
    instruction: String,
    maneuverType: String,
    roadName: String,
    spokenInstruction: String? = nil,
    maneuverModifier: String? = nil,
    roundaboutExit: Int? = nil,
    exitNumber: String? = nil,
    signpost: String? = nil,
    lanes: [NavOSSCarPlayLane]? = nil,
    currentRoadName: String? = nil,
    bearingBeforeDegrees: Double? = nil,
    bearingAfterDegrees: Double? = nil,
    signpostBranch: [String]? = nil,
    signpostToward: [String]? = nil,
    junctionName: String? = nil
  ) {
    self.distanceMeters = distanceMeters
    self.durationSeconds = durationSeconds
    self.geometry = geometry
    self.instruction = instruction
    self.maneuverType = maneuverType
    self.roadName = roadName
    self.spokenInstruction = spokenInstruction
    self.maneuverModifier = maneuverModifier
    self.roundaboutExit = roundaboutExit
    self.exitNumber = exitNumber
    self.signpost = signpost
    self.lanes = lanes
    self.currentRoadName = currentRoadName
    self.bearingBeforeDegrees = bearingBeforeDegrees
    self.bearingAfterDegrees = bearingAfterDegrees
    self.signpostBranch = signpostBranch
    self.signpostToward = signpostToward
    self.junctionName = junctionName
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

/// Parses a traffic publication boundary (ISO 8601, with or without fractional seconds).
public func navOSSTrafficBoundary(_ value: String?) -> Date? {
  guard let value else { return nil }
  let fractional = ISO8601DateFormatter()
  fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
}

public struct NavOSSCarPlayTraffic: Codable, Equatable, Sendable {
  public let delaySeconds: Double
  public let typicalDurationSeconds: Double
  /// Community traffic only: the oldest publication boundary of the speeds applied to the route,
  /// shown as "as of" wherever the traffic is credited. `nil` when the server did not say.
  public let oldestObservedAt: Date?

  public init(delaySeconds: Double, typicalDurationSeconds: Double, oldestObservedAt: Date? = nil) {
    self.delaySeconds = delaySeconds
    self.typicalDurationSeconds = typicalDurationSeconds
    self.oldestObservedAt = oldestObservedAt
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
  /// Optional observed congestion, one level per geometry segment like `speedLimitsKph`. Present
  /// only when a real traffic source observed this route; a misaligned array is ignored by the
  /// renderer.
  public let congestion: [NavOSSCarPlayCongestionLevel]?
  /// Id of the traffic source behind `congestion`/`traffic` when it is not the routing provider
  /// itself (`navoss-community` for opted-in NavOSS driver speeds). `nil` without such traffic.
  public let trafficSource: String?

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
    waypoints: [NavOSSCarPlayDestination]? = nil,
    congestion: [NavOSSCarPlayCongestionLevel]? = nil,
    trafficSource: String? = nil
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
    self.congestion = congestion
    self.trafficSource = trafficSource
  }

  /// The same route with a different stop list; every other field is kept.
  public func replacingWaypoints(_ waypoints: [NavOSSCarPlayDestination]?) -> NavOSSCarPlayTrip {
    NavOSSCarPlayTrip(
      destination: destination,
      distanceMeters: distanceMeters,
      durationSeconds: durationSeconds,
      geometry: geometry,
      id: id,
      preferences: preferences,
      source: source,
      speedLimitsKph: speedLimitsKph,
      steps: steps,
      traffic: traffic,
      waypoints: waypoints,
      congestion: congestion,
      trafficSource: trafficSource
    )
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

/// Returns the index of the fastest route by raw driving duration, breaking an exact-duration tie
/// by the shorter distance. `routes` may already be sorted for recommendation display (a
/// same-displayed-minute, shorter route can legitimately sort first), so the fastest route cannot
/// be inferred from array position.
public func navOSSCarPlayFastestRouteIndex(_ routes: [NavOSSCarPlayTrip]) -> Int? {
  guard !routes.isEmpty else { return nil }
  var fastestIndex = 0
  for index in 1..<routes.count {
    let candidate = routes[index]
    let current = routes[fastestIndex]
    if candidate.durationSeconds < current.durationSeconds
      || (candidate.durationSeconds == current.durationSeconds
        && candidate.distanceMeters < current.distanceMeters)
    {
      fastestIndex = index
    }
  }
  return fastestIndex
}

/// Orders routes for phone/CarPlay display: routes that round to the same displayed minute are
/// ordered by shorter distance, then by raw duration, so a same-displayed-minute, shorter route
/// can legitimately sort ahead of a route with a lower raw duration. Mirrors
/// `compareRouteAlternatives` in `packages/contracts/src/route.ts` so both API-derived clients
/// present routes in the order they promise. Does not affect which route is fastest by raw
/// duration; see `navOSSCarPlayFastestRouteIndex`.
public func navOSSCarPlayTripsOrderedForDisplay(
  _ trips: [NavOSSCarPlayTrip]
) -> [NavOSSCarPlayTrip] {
  trips.sorted { left, right in
    let leftMinutes = max(1, (left.durationSeconds / 60).rounded())
    let rightMinutes = max(1, (right.durationSeconds / 60).rounded())
    if leftMinutes != rightMinutes { return leftMinutes < rightMinutes }
    if left.distanceMeters != right.distanceMeters {
      return left.distanceMeters < right.distanceMeters
    }
    return left.durationSeconds < right.durationSeconds
  }
}

public func navOSSCarPlayRouteChoiceDetails(
  _ routes: [NavOSSCarPlayTrip]
) -> [String?] {
  // An on-device route has no live traffic or closure data; say so on every choice.
  zip(routes, navOSSCarPlayRoadChoiceDetails(routes)).map { route, detail in
    guard route.source == navOSSOfflineRouteSource else { return detail }
    return ["Offline, no traffic or closures", detail].compactMap { $0 }.joined(separator: " · ")
  }
}

private func navOSSCarPlayRoadChoiceDetails(
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
      let displayName = navOSSReadableRoadName(step.roadName)
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
  let fastestIndex = navOSSCarPlayFastestRouteIndex(routes)

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
    guard let fastestIndex, routeIndex != fastestIndex else { return nil }
    let fastestRoute = routes[fastestIndex]
    let extraDistanceMeters = routes[routeIndex].distanceMeters - fastestRoute.distanceMeters
    if extraDistanceMeters >= 50 {
      if extraDistanceMeters < 1_000 {
        let roundedMeters = max(50, Int((extraDistanceMeters / 50).rounded()) * 50)
        return "\(roundedMeters) m longer"
      }
      return "\(navOSSCarPlayDistanceLabel(extraDistanceMeters)) longer"
    }
    let extraDurationMinutes = Int(
      ((routes[routeIndex].durationSeconds - fastestRoute.durationSeconds) / 60).rounded()
    )
    if extraDurationMinutes > 0 { return "\(extraDurationMinutes) min slower" }
    return "Similar route"
  }
}

/// Where `NavOSSActiveTripStore` keeps its records: `UserDefaults` on iOS, the host's storage
/// on Android (docs/architecture/android-core.md).
public protocol NavOSSKeyValueStore: AnyObject {
  func data(forKey key: String) -> Data?
  func setData(_ data: Data, forKey key: String)
  func removeObject(forKey key: String)
}

extension UserDefaults: NavOSSKeyValueStore {
  public func setData(_ data: Data, forKey key: String) {
    set(data, forKey: key)
  }
}

/// What the store held for a relaunch to restore.
enum NavOSSSavedTrip: Equatable {
  /// No trip was saved.
  case none
  case trip(NavOSSCarPlayTrip)
  /// A trip was saved 12 hours ago or more; it has been removed.
  case expired
  /// A trip was saved that cannot be read; it has been removed.
  case unreadable
}

public final class NavOSSActiveTripStore: @unchecked Sendable {
  private struct StoredTrip: Codable {
    let expiresAt: Date
    let trip: NavOSSCarPlayTrip
  }

  /// How far the stored trip had got, for resuming it: the matcher's last accepted fix, as
  /// distances along the stored route (where it matched, the furthest point reached, how far
  /// the fix may have been from the route), its capture time and reported speed, and where an
  /// arrival still waiting for movement started waiting. No coordinate, heading or fix history.
  /// Together with the stored route a distance along it is a position, so the record lives and
  /// dies with the trip. Kept under its own key: it is rewritten during the trip and the trip
  /// itself is large.
  private struct StoredProgress: Codable {
    /// Records without this exact format (earlier development builds wrote others) are not
    /// read: their missing fields would have to be guessed.
    static let currentFormat = 2

    struct Deferral: Codable {
      let alongMeters: Double
      let uncertaintyMeters: Double
    }

    let format: Int
    let tripId: String
    let alongMeters: Double
    let highWaterAlongMeters: Double
    let uncertaintyMeters: Double
    let capturedAt: TimeInterval?
    let speedMetersPerSecond: Double?
    let arrivalDeferral: Deferral?
  }

  /// Written under the progress key with the trip, until the first checkpoint replaces it: the
  /// trip has not been matched on its route yet, so it resumes as it was started. It holds the
  /// trip's identifier and nothing else. It has no `format` field, so a build that reads only
  /// `StoredProgress` (builds 80 to 85) cannot decode it and reads it as an unusable record,
  /// without failing. A record without it (builds up to 85, which wrote nothing here before the
  /// first match) is read as a trip saved without progress.
  private struct StoredBeforeFirstMatch: Codable {
    let beforeFirstMatch: Bool
    let tripId: String
  }

  /// Identifier of the trip this store currently holds, as far as this process has seen. A
  /// checkpoint for any other trip (one that has since been cleared or replaced) is dropped.
  private var storedTripId: String?

  private var progressKey: String {
    key + ".progress"
  }

  private let clock: () -> Date
  private let defaults: NavOSSKeyValueStore
  private let expirationInterval: TimeInterval
  private let key: String
  private let lock = NSLock()

  public init(
    defaults: NavOSSKeyValueStore = UserDefaults.standard,
    // v2: steps carry `spokenInstruction` for their own maneuver. A trip saved by an older build
    // (the v1 meaning) is not restored rather than announcing every maneuver one step late.
    key: String = "org.navoss.mobile.active-navigation-trip.v2",
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
    removeLocked()
    lock.unlock()
  }

  /// The trip and its progress go together. Caller holds `lock`.
  private func removeLocked() {
    defaults.removeObject(forKey: key)
    defaults.removeObject(forKey: progressKey)
    storedTripId = nil
  }

  /// How the stored trip resumes. `.beforeFirstMatch` for a trip saved before its first
  /// checkpoint; `.withoutProgress` for a trip saved without a progress record (by builds up to
  /// 85, before its first match); `.unusable` when a record is there but is damaged, in another
  /// format, or another trip's.
  func loadProgress(for trip: NavOSSCarPlayTrip) -> NavigationResumePoint {
    lock.lock()
    defer { lock.unlock() }
    guard let data = defaults.data(forKey: progressKey) else {
      return .withoutProgress
    }
    if let marker = try? JSONDecoder().decode(StoredBeforeFirstMatch.self, from: data),
      marker.beforeFirstMatch
    {
      return marker.tripId == trip.id ? .beforeFirstMatch : .unusable
    }
    guard let stored = try? JSONDecoder().decode(StoredProgress.self, from: data),
      stored.format == StoredProgress.currentFormat, stored.tripId == trip.id
    else {
      return .unusable
    }
    let progress = NavigationResumeContext(
      alongMeters: stored.alongMeters,
      highWaterAlongMeters: stored.highWaterAlongMeters,
      uncertaintyMeters: stored.uncertaintyMeters,
      timestamp: stored.capturedAt,
      speedMetersPerSecond: stored.speedMetersPerSecond,
      arrivalDeferral: stored.arrivalDeferral.map {
        NavigationResumeContext.ArrivalDeferral(
          alongMeters: $0.alongMeters, uncertaintyMeters: $0.uncertaintyMeters)
      }
    )
    return progress.isUsable ? .progress(progress) : .unusable
  }

  /// Records where the stored trip has got to. Dropped unless `tripId` is the trip this store
  /// holds now: a writer that lost a race with `clear()` or `save(_:)` cannot bring a
  /// checkpoint back or overwrite a newer trip's. (A replacement route keeps its trip's
  /// identifier; the navigation service orders checkpoints against those itself.)
  func saveProgress(_ progress: NavigationResumeContext, forTripId tripId: String) {
    guard progress.isUsable,
      let data = try? JSONEncoder().encode(
        StoredProgress(
          format: StoredProgress.currentFormat,
          tripId: tripId,
          alongMeters: progress.alongMeters,
          highWaterAlongMeters: progress.highWaterAlongMeters,
          uncertaintyMeters: progress.uncertaintyMeters,
          capturedAt: progress.timestamp,
          speedMetersPerSecond: progress.speedMetersPerSecond,
          arrivalDeferral: progress.arrivalDeferral.map {
            StoredProgress.Deferral(
              alongMeters: $0.alongMeters, uncertaintyMeters: $0.uncertaintyMeters)
          }
        )
      )
    else {
      return
    }
    lock.lock()
    if storedTripId == tripId {
      defaults.setData(data, forKey: progressKey)
    }
    lock.unlock()
  }

  public func load() -> NavOSSCarPlayTrip? {
    guard case .trip(let trip) = loadSaved() else {
      return nil
    }
    return trip
  }

  /// The stored trip, or why there is none. An expired or unreadable trip is removed, with its
  /// progress. A trip expires 12 hours after the later of when its route was saved and when its
  /// last checkpoint was captured, so a long drive that is still moving does not expire on the
  /// way. A clock set back since either (both in the future) expires nothing.
  func loadSaved() -> NavOSSSavedTrip {
    lock.lock()
    defer { lock.unlock() }
    guard let data = defaults.data(forKey: key) else {
      removeLocked()
      return .none
    }
    guard let stored = try? JSONDecoder().decode(StoredTrip.self, from: data) else {
      removeLocked()
      return .unreadable
    }
    let now = clock()
    guard stored.expiresAt > now || checkpointExpiryLocked(of: stored.trip).map({ $0 > now }) == true
    else {
      removeLocked()
      return .expired
    }
    storedTripId = stored.trip.id
    return .trip(stored.trip)
  }

  /// When the stored trip's last checkpoint makes it expire, if it has one with a capture time.
  /// Caller holds `lock`.
  private func checkpointExpiryLocked(of trip: NavOSSCarPlayTrip) -> Date? {
    guard let data = defaults.data(forKey: progressKey),
      let stored = try? JSONDecoder().decode(StoredProgress.self, from: data),
      stored.format == StoredProgress.currentFormat, stored.tripId == trip.id,
      let capturedAt = stored.capturedAt, capturedAt.isFinite
    else {
      return nil
    }
    return Date(timeIntervalSinceReferenceDate: capturedAt).addingTimeInterval(expirationInterval)
  }

  /// Saves a trip that has just started or been given a new route, with the record that it has
  /// not been matched yet (`StoredBeforeFirstMatch`) in place of any progress: a new route
  /// starts from its own beginning.
  public func save(_ trip: NavOSSCarPlayTrip) {
    let stored = StoredTrip(
      expiresAt: clock().addingTimeInterval(expirationInterval),
      trip: trip
    )
    guard trip.isValid, let data = try? JSONEncoder().encode(stored),
      let marker = try? JSONEncoder().encode(
        StoredBeforeFirstMatch(beforeFirstMatch: true, tripId: trip.id))
    else {
      return
    }
    lock.lock()
    defaults.setData(data, forKey: key)
    defaults.setData(marker, forKey: progressKey)
    storedTripId = trip.id
    lock.unlock()
  }
}

public enum NavOSSCarPlayGuidancePhase: String, Codable, Equatable, Sendable {
  case arrived
  case navigating
  case preview
}

/// What lets the CarPlay map carry the vehicle on past a published position
/// (`NavOSSCarPlayVehicleMotion`): only a real fix the matcher accepted, with a reported speed.
/// Positions without it (a held or rejected fix, a dead-reckoned one, a raw position) are drawn
/// where they are and never carried on.
public struct NavOSSCarPlayRunOn: Equatable, Sendable {
  /// When the fix was taken, in seconds since the reference date. The carry-on time runs from
  /// here, not from when the position was published or received.
  public let fixTimestamp: TimeInterval
  /// The speed the fix reported.
  public let speedMetersPerSecond: Double
  /// The furthest along the route, as a share of its length, the navigation core itself would
  /// predict from this fix: short of the next maneuver it has not seen taken and of arrival. Nil in
  /// free drive.
  public let limitProgress: Double?

  public init(fixTimestamp: TimeInterval, speedMetersPerSecond: Double, limitProgress: Double? = nil) {
    self.fixTimestamp = fixTimestamp
    self.speedMetersPerSecond = speedMetersPerSecond
    self.limitProgress = limitProgress
  }

  var isValid: Bool {
    fixTimestamp.isFinite && speedMetersPerSecond.isFinite && speedMetersPerSecond >= 0
      && speedMetersPerSecond <= 100
      && limitProgress.map { $0.isFinite && (0...1).contains($0) } != false
  }
}

public struct NavOSSCarPlayPosition: Equatable, Sendable {
  public let coordinate: NavOSSCarPlayCoordinate
  public let courseDegrees: Double?
  public let compassHeadingDegrees: Double?
  public let speedMetersPerSecond: Double?
  public let runOn: NavOSSCarPlayRunOn?

  public init(
    coordinate: NavOSSCarPlayCoordinate,
    courseDegrees: Double?,
    compassHeadingDegrees: Double? = nil,
    speedMetersPerSecond: Double? = nil,
    runOn: NavOSSCarPlayRunOn? = nil
  ) {
    self.coordinate = coordinate
    self.courseDegrees = courseDegrees
    self.compassHeadingDegrees = compassHeadingDegrees
    self.speedMetersPerSecond = speedMetersPerSecond
    self.runOn = runOn
  }

  var isValid: Bool {
    coordinate.isValid
      && courseDegrees.map { $0.isFinite && (0..<360).contains($0) } != false
      && compassHeadingDegrees.map { $0.isFinite && (0..<360).contains($0) } != false
      && speedMetersPerSecond.map { $0.isFinite && $0 >= 0 && $0 <= 100 } != false
      && runOn?.isValid != false
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
    speedMetersPerSecond: position.speedMetersPerSecond,
    runOn: position.runOn
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

/// Why a trip under way has no maneuver to show: CarPlay keeps its navigation session running,
/// follows the vehicle and presents proposals, with this in place of the maneuver
/// (`CPTripPauseReason`); the phone shows the trip without a step or estimate. Decided by the
/// navigation core (`NavigationEngine.tripPauseLocked`), never inferred from missing guidance.
/// The raw value is the snapshot's `tripPause`.
public enum NavOSSCarPlayTripPause: String, Equatable, Sendable {
  /// A restored trip finding its place on the route.
  case locating
  /// Off the route, a new route being fetched.
  case rerouting
  /// Off the route, no route being fetched: a proposal waiting for the driver, the reroute
  /// mode keeping the route, or a request that failed and will be retried.
  case proceedToRoute = "proceed-to-route"
}

/// What CarPlay shows in place of the maneuver while a trip under way is paused: short enough
/// for one line on an 800x480 head unit. The phone words its own.
public func navOSSCarPlayTripPauseDescription(_ pause: NavOSSCarPlayTripPause) -> String {
  switch pause {
  case .locating: "Finding your place"
  case .rerouting: "Finding a new route"
  case .proceedToRoute: "Off route"
  }
}

public struct NavOSSCarPlayState: Equatable, Sendable {
  public let connected: Bool
  public let guidance: NavOSSCarPlayGuidance?
  public let position: NavOSSCarPlayPosition?
  public let routeProgress: Double
  public let trip: NavOSSCarPlayTrip?
  /// Set only for a trip under way without guidance; see `NavOSSCarPlayTripPause`.
  public let tripPause: NavOSSCarPlayTripPause?

  public init(
    connected: Bool,
    guidance: NavOSSCarPlayGuidance?,
    position: NavOSSCarPlayPosition? = nil,
    routeProgress: Double = 0,
    trip: NavOSSCarPlayTrip?,
    tripPause: NavOSSCarPlayTripPause? = nil
  ) {
    self.connected = connected
    self.guidance = guidance
    self.position = position
    self.routeProgress = min(1, max(0, routeProgress.isFinite ? routeProgress : 0))
    self.trip = trip
    self.tripPause = trip != nil && guidance == nil ? tripPause : nil
  }

  /// A trip is under way: guided, or paused without a maneuver. What every trip action (change
  /// destination, stops, alternatives, Siri) and every replacement asks; an arrived trip is not.
  public var isTripUnderWay: Bool {
    trip != nil && (guidance?.phase == .navigating || tripPause != nil)
  }

  /// CarPlay runs its navigation session and follows the vehicle: a trip under way, or one
  /// showing its arrival.
  public var isNavigating: Bool {
    isTripUnderWay || (trip != nil && guidance?.phase == .arrived)
  }
}

/// A button on the CarPlay map.
public enum NavOSSCarPlayMapControl: Hashable, Sendable {
  case search
  case recenter
  case settings
  /// Guidance sound (all, alerts only, muted).
  case sound
  case report
  /// Route overview, toggling back to following the car.
  case overview
}

/// A button in the map's trailing navigation-bar slot.
public enum NavOSSCarPlayBarItem: Equatable, Sendable {
  case end
  /// The traffic credit for the route on screen: `title` is what the bar shows, `credit` the full
  /// attribution shown when it is tapped.
  case trafficCredit(title: String, credit: String)
}

public struct NavOSSCarPlayControlState: Equatable, Sendable {
  /// Map buttons, top to bottom. During a trip there are three; End is not a map button.
  public let mapControls: [NavOSSCarPlayMapControl]
  /// The trailing navigation-bar buttons. CarPlay reveals the bar (with the leading Trip button)
  /// on any touch while guiding. During a trip End comes first and the traffic credit, when the
  /// route has one, shrinks to "Traffic" so it never crowds End; tapping it shows the full credit.
  public let trailingBarItems: [NavOSSCarPlayBarItem]
  public let returnToRootFromSearch: Bool

  public init(hasActiveTrip: Bool, searchVisible: Bool, trafficAttribution: String? = nil) {
    mapControls = hasActiveTrip ? [.sound, .report, .overview] : [.search, .recenter, .settings]
    let credit = trafficAttribution.flatMap { $0.isEmpty ? nil : $0 }
    trailingBarItems =
      hasActiveTrip
      ? [.end] + (credit.map { [.trafficCredit(title: "Traffic", credit: $0)] } ?? [])
      : credit.map { [.trafficCredit(title: $0, credit: $0)] } ?? []
    returnToRootFromSearch = hasActiveTrip && searchVisible
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
    // `matchedCoordinate` is the rendered puck, which follows the snapshot and can therefore sit
    // behind `routeProgress`. Splice from whichever of the two is earlier so the vertices between
    // them survive; otherwise the polyline cuts straight across any bend the puck has not reached
    // yet.
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
/// The puck lags the snapshot only while it catches up with it, so a legitimate match is a short way back; a
/// parallel outbound carriageway is far back along the route even though it is metres away in
/// space. That separation is what makes the bound work.
///
/// The value is derived from the vehicle motion contract, not from a sweep. The drawn puck is
/// placed where the fix puts it whenever it would otherwise trail the expected track by more than
/// `navOSSCarPlaySnapSeconds` of travel (`NavOSSCarPlayVehicleMotion`), so at roughly 50 m/s the
/// legitimate lag is about 125 m; 250 m keeps a wide margin over that. A sweep cannot choose this
/// number: a bound of W rejects candidates past W by construction, so measuring "splices past W"
/// against bound W is circular.
///
/// `pnpm --filter @navoss/mobile test:carplay-splice` shows what the bound does on a checked-in
/// real 8.9 km Calgary out-and-back with a puck lagging up to 125 m: the unbounded search picks the
/// opposite carriageway 71 times in 5,664 samples, worst case 8,902 m behind, and the bound cuts
/// that to none in that sample (2 of 5,664 when the lag was drawn up to 100 m). Zero is not claimed
/// in general. Where the carriageways run within the lookback
/// of each other, position alone is genuinely ambiguous and only heading could resolve it; what
/// the bound removes is the catastrophic case of splicing kilometres of travelled road back in.
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

/// What to do with the vehicle's render link before the next frame.
public enum NavOSSCarPlayDisplayLinkAction: String, Sendable {
  case create
  case keep
  case rebuild
}

/// The render link must be driven by the display the CarPlay window is on.
///
/// A link built for the handset's own display stops firing the moment that display sleeps, which
/// froze the car's map mid-route while fixes were still arriving. A link left behind after the
/// window moves to another screen has the same problem, so a link whose screen no longer matches
/// the window is replaced rather than reused.
public func navOSSCarPlayDisplayLinkAction(
  hasLink: Bool,
  linkedScreenMatchesWindow: Bool
) -> NavOSSCarPlayDisplayLinkAction {
  guard hasLink else { return .create }
  return linkedScreenMatchesWindow ? .keep : .rebuild
}

/// Bearing from `start` to `end` in the navigation convention: 0° is true north, increasing
/// clockwise. The local metre conversion intentionally matches `navOSSCarPlaySegmentProjection`.
func navOSSCarPlayBearingDegrees(
  from start: NavOSSCarPlayCoordinate,
  to end: NavOSSCarPlayCoordinate
) -> Double {
  let meanLatitude = (start.latitude + end.latitude) / 2 * .pi / 180
  let degrees =
    atan2(
      (end.longitude - start.longitude) * cos(meanLatitude),
      end.latitude - start.latitude
    ) * 180 / .pi
  return degrees >= 0 ? degrees : degrees + 360
}

/// How far off the route a fix may sit and still be drawn moving along the road.
public let navOSSCarPlayPathInterpolationMaxOffsetMeters = 30.0

/// A route vertex turning at least this much is a turn the vehicle may not take: the drawn vehicle
/// is never carried past one ahead of a fix that shows it there. Curves drawn as many shallow
/// vertices (a ramp, a roundabout ring) are followed.
public let navOSSCarPlayTurnVertexDegrees = 30.0

/// Road either side of the vehicle used to measure which way it is pointing.
///
/// A single segment's bearing is constant along it and steps at the vertex, so a right-angle turn
/// would snap the arrow round in one frame. Sixteen metres of road, eight either side, spreads that
/// rotation across the approach and exit at any speed while still turning promptly.
public let navOSSCarPlayBearingWindowMeters = 8.0

/// A route measured once: its vertices and the distance from the start to each. Building it is
/// O(vertices); point lookups are O(log vertices), so the render loop never re-measures the route.
public struct NavOSSCarPlayRoutePath: Sendable {
  public let geometry: [NavOSSCarPlayCoordinate]
  let cumulativeLengths: [Double]
  /// Distances along the route of its turns (`navOSSCarPlayTurnVertexDegrees`), ascending.
  let turnDistances: [Double]

  public init(_ geometry: [NavOSSCarPlayCoordinate]) {
    self.geometry = geometry
    var lengths = [0.0]
    lengths.reserveCapacity(geometry.count)
    for index in geometry.indices.dropFirst() {
      lengths.append(
        lengths[index - 1]
          + navOSSCarPlayCoordinateDistance(from: geometry[index - 1], to: geometry[index]))
    }
    cumulativeLengths = geometry.isEmpty ? [] : lengths
    var turns: [Double] = []
    var incoming: Double?
    for index in geometry.indices.dropFirst() where lengths[index] > lengths[index - 1] {
      let bearing = navOSSCarPlayBearingDegrees(from: geometry[index - 1], to: geometry[index])
      if let incoming {
        let change = abs((bearing - incoming + 540).truncatingRemainder(dividingBy: 360) - 180)
        if change >= navOSSCarPlayTurnVertexDegrees { turns.append(lengths[index - 1]) }
      }
      incoming = bearing
    }
    turnDistances = turns
  }

  public var lengthMeters: Double { cumulativeLengths.last ?? 0 }

  /// The first turn at or beyond `distanceMeters`, or nil when the route runs straight on. A fix
  /// on the turn itself has not shown which way the vehicle left it; only one beyond it has.
  func nextTurn(atOrAfter distanceMeters: Double) -> Double? {
    // Projections onto a vertex land within rounding of its cumulative length.
    let from = distanceMeters - 0.01
    var low = 0
    var high = turnDistances.count
    while low < high {
      let middle = (low + high) / 2
      if turnDistances[middle] < from { low = middle + 1 } else { high = middle }
    }
    return low < turnDistances.count ? turnDistances[low] : nil
  }

  /// The point `distanceMeters` along the route, pointing the way the road runs across a short
  /// window either side (`navOSSCarPlayBearingWindowMeters`). A single segment's bearing is
  /// constant along it and then changes in one step at the vertex, so a right-angle intersection
  /// would snap the arrow round in a single frame; the window turns it over the approach and exit
  /// instead, which is what the corner looks like from the seat.
  func pointAlongRoad(atDistance distanceMeters: Double)
    -> (coordinate: NavOSSCarPlayCoordinate, bearingDegrees: Double)?
  {
    guard let point = point(atDistance: distanceMeters) else { return nil }
    let travelled = min(max(distanceMeters, 0), lengthMeters)
    // Clamping narrows the window at the ends of the route — and a route shorter than the window
    // is spanned whole — but over a route of non-zero length the two offsets cannot collapse onto
    // one another, so there is always a direction to measure.
    guard
      let behind = self.point(atDistance: max(0, travelled - navOSSCarPlayBearingWindowMeters)),
      let ahead = self.point(
        atDistance: min(lengthMeters, travelled + navOSSCarPlayBearingWindowMeters))
    else {
      return point
    }
    return (point.coordinate, navOSSCarPlayBearingDegrees(from: behind.coordinate, to: ahead.coordinate))
  }

  /// Distance of `coordinate` measured along the route, or `nil` when it sits farther than
  /// `maxOffsetMeters` from every segment.
  func distanceAlong(_ coordinate: NavOSSCarPlayCoordinate, maxOffsetMeters: Double) -> Double? {
    var bestDistanceMeters = Double.infinity
    var bestAlongMeters: Double?
    for index in geometry.indices.dropLast() {
      let projection = navOSSCarPlaySegmentProjection(
        coordinate,
        start: geometry[index],
        end: geometry[index + 1]
      )
      guard projection.distanceMeters < bestDistanceMeters else { continue }
      bestDistanceMeters = projection.distanceMeters
      let segmentLength = cumulativeLengths[index + 1] - cumulativeLengths[index]
      bestAlongMeters = cumulativeLengths[index] + segmentLength * projection.fraction
    }
    guard bestDistanceMeters <= maxOffsetMeters else { return nil }
    return bestAlongMeters
  }

  /// The point `distanceMeters` along the route, with the bearing of the segment carrying it.
  func point(atDistance distanceMeters: Double)
    -> (coordinate: NavOSSCarPlayCoordinate, bearingDegrees: Double)?
  {
    guard geometry.count >= 2, lengthMeters > 0 else { return nil }
    let clamped = min(max(distanceMeters, 0), lengthMeters)
    // First segment whose end lies at or beyond `clamped`.
    var low = 0
    var high = geometry.count - 2
    while low < high {
      let middle = (low + high) / 2
      if clamped <= cumulativeLengths[middle + 1] {
        high = middle
      } else {
        low = middle + 1
      }
    }
    let start = geometry[low]
    let end = geometry[low + 1]
    let segmentLength = cumulativeLengths[low + 1] - cumulativeLengths[low]
    let fraction = segmentLength > 0 ? (clamped - cumulativeLengths[low]) / segmentLength : 0
    return (
      NavOSSCarPlayCoordinate(
        latitude: start.latitude + (end.latitude - start.latitude) * fraction,
        longitude: start.longitude + (end.longitude - start.longitude) * fraction
      ),
      navOSSCarPlayBearingDegrees(from: start, to: end)
    )
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
    tripPause: NavOSSCarPlayTripPause? = nil,
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
        trip: trip,
        tripPause: tripPause
      )
    }
  }

  /// Takes the reason the trip under way has no maneuver whenever the core's state changes
  /// without a fix (a reroute request started or failed, a proposal offered or withdrawn), so
  /// CarPlay never keeps a stale one. Only for the trip the store holds; a trip with guidance
  /// has no reason (`NavOSSCarPlayState.init`).
  public func publishTripPause(_ tripPause: NavOSSCarPlayTripPause?, forTripId tripId: String) {
    update { current in
      guard current.trip?.id == tripId, current.tripPause != tripPause else {
        return current
      }
      return NavOSSCarPlayState(
        connected: current.connected,
        guidance: current.guidance,
        position: current.position,
        routeProgress: current.routeProgress,
        trip: current.trip,
        tripPause: tripPause
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
        trip: current.trip,
        tripPause: current.tripPause
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
    bestBearingDegrees = navOSSCarPlayBearingDegrees(from: start, to: end)
  }
  guard bestDistanceMeters <= maxDistanceMeters else { return nil }
  return bestBearingDegrees
}
