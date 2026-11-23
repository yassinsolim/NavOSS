import Foundation

// The JSON shapes of the Android boundary (docs/architecture/android-core.md). Input records
// decode exactly as the iOS module's Expo records do (`ios/NavOSSNavigationModule.swift`), and
// snapshots are written with the keys, omissions and conversions of its `serialize` functions,
// so the Android module can pass JS objects through unchanged.

/// A JSON value, written with sorted keys.
enum NavOSSCoreJSON: Encodable, Equatable {
  case bool(Bool)
  case int(Int)
  case double(Double)
  case string(String)
  case array([NavOSSCoreJSON])
  case object([String: NavOSSCoreJSON])

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .bool(let value): try container.encode(value)
    case .int(let value): try container.encode(value)
    // Only finite values reach a snapshot; a non-finite one would not be JSON at all.
    case .double(let value): value.isFinite ? try container.encode(value) : try container.encodeNil()
    case .string(let value): try container.encode(value)
    case .array(let values): try container.encode(values)
    case .object(let members): try container.encode(members)
    }
  }

  func encodedString() -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    // Encoding a tree of finite values cannot fail.
    guard let data = try? encoder.encode(self) else { return "{}" }
    return String(decoding: data, as: UTF8.self)
  }
}

// MARK: - Input records

// Expo's rules for a record field, which these records follow:
// - a field that is not optional takes its default when the key is absent, and refuses an
//   explicit `null` (Expo's "Value for field … is required, got nil");
// - an optional field is `nil` for an absent key or `null`;
// - an `Int` takes any JS number, rounded to nearest, halves away from zero (Expo's
//   `Int(double.rounded())`).
// One Expo rule is not followed: Expo wraps a value that is not an array into a one-element
// array for an array field. Here that is a type mismatch (`invalid-json`); JS never sends one.

extension KeyedDecodingContainer {
  /// A field that is not optional: `value` when the key is absent, an error for `null`.
  fileprivate func field<T: Decodable>(_ key: Key, default value: T) throws -> T {
    guard contains(key) else { return value }
    guard try !decodeNil(forKey: key) else {
      throw DecodingError.valueNotFound(
        T.self, DecodingError.Context(codingPath: codingPath + [key], debugDescription: "null"))
    }
    return try decode(T.self, forKey: key)
  }
}

/// A JS number as an `Int`, as Expo converts it. A number no `Int` holds is a type mismatch
/// (Expo would trap).
private func roundedInt(_ double: Double, at codingPath: [CodingKey]) throws -> Int {
  let rounded = double.rounded()
  guard let value = Int(exactly: rounded) else {
    throw DecodingError.typeMismatch(
      Int.self,
      DecodingError.Context(codingPath: codingPath, debugDescription: "Expected an integer"))
  }
  return value
}

/// An array index in an error's path.
private struct IndexKey: CodingKey {
  let intValue: Int?
  var stringValue: String { "\(intValue ?? 0)" }

  init(_ index: Int) {
    intValue = index
  }

  init?(intValue: Int) {
    self.intValue = intValue
  }

  init?(stringValue: String) {
    return nil
  }
}

/// An optional integer field.
private func roundedInt<Key: CodingKey>(
  _ container: KeyedDecodingContainer<Key>, _ key: Key
) throws -> Int? {
  try container.decodeIfPresent(Double.self, forKey: key).map {
    try roundedInt($0, at: container.codingPath + [key])
  }
}

/// `NativeNavigationLocationSample`, as `NavigationLocationRecord`.
struct NavOSSCoreLocationRecord: Decodable {
  var courseDegrees: Double?
  var horizontalAccuracyMeters: Double?
  var latitude: Double = 0
  var longitude: Double = 0
  var speedMetersPerSecond: Double?
  /// Milliseconds since the Unix epoch.
  var timestampMs: Double?

  private enum CodingKeys: String, CodingKey {
    case courseDegrees, horizontalAccuracyMeters, latitude, longitude, speedMetersPerSecond
    case timestampMs
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    courseDegrees = try container.decodeIfPresent(Double.self, forKey: .courseDegrees)
    horizontalAccuracyMeters = try container.decodeIfPresent(
      Double.self, forKey: .horizontalAccuracyMeters)
    latitude = try container.field(.latitude, default: 0)
    longitude = try container.field(.longitude, default: 0)
    speedMetersPerSecond = try container.decodeIfPresent(Double.self, forKey: .speedMetersPerSecond)
    timestampMs = try container.decodeIfPresent(Double.self, forKey: .timestampMs)
  }

  var sample: NavigationLocationSample {
    NavigationLocationSample(
      coordinate: NavigationCoordinate(latitude: latitude, longitude: longitude),
      courseDegrees: courseDegrees,
      horizontalAccuracyMeters: horizontalAccuracyMeters,
      speedMetersPerSecond: speedMetersPerSecond,
      timestamp: timestampMs.map {
        Date(timeIntervalSince1970: $0 / 1_000).timeIntervalSinceReferenceDate
      }
    )
  }
}

private struct CoordinateRecord: Decodable {
  var latitude: Double = 0
  var longitude: Double = 0

  private enum CodingKeys: String, CodingKey { case latitude, longitude }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    latitude = try container.field(.latitude, default: 0)
    longitude = try container.field(.longitude, default: 0)
  }

  var coordinate: NavOSSCarPlayCoordinate {
    NavOSSCarPlayCoordinate(latitude: latitude, longitude: longitude)
  }
}

/// `NativeNavigationDestination`, as `NavigationDestinationRecord`.
private struct DestinationRecord: Decodable {
  var category: String?
  var id = ""
  var label = ""
  var latitude: Double = 0
  var longitude: Double = 0
  var name = ""

  private enum CodingKeys: String, CodingKey {
    case category, id, label, latitude, longitude, name
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    category = try container.decodeIfPresent(String.self, forKey: .category)
    id = try container.field(.id, default: "")
    label = try container.field(.label, default: "")
    latitude = try container.field(.latitude, default: 0)
    longitude = try container.field(.longitude, default: 0)
    name = try container.field(.name, default: "")
  }

  var destination: NavOSSCarPlayDestination {
    NavOSSCarPlayDestination(
      category: category, id: id, label: label, latitude: latitude, longitude: longitude,
      name: name)
  }
}

/// `NativeRouteLane`, as `CarPlayLaneRecord`.
private struct LaneRecord: Decodable {
  var active: Bool?
  var indications: [String] = []
  var valid = false
  var validIndication: String?

  private enum CodingKeys: String, CodingKey { case active, indications, valid, validIndication }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    active = try container.decodeIfPresent(Bool.self, forKey: .active)
    indications = try container.field(.indications, default: [])
    valid = try container.field(.valid, default: false)
    validIndication = try container.decodeIfPresent(String.self, forKey: .validIndication)
  }

  var lane: NavOSSCarPlayLane? {
    let parsed = indications.compactMap(NavOSSCarPlayLaneIndication.init(rawValue:))
    guard parsed.count == indications.count else { return nil }
    return NavOSSCarPlayLane(
      indications: parsed,
      isValid: valid,
      isPreferred: active ?? false,
      activeIndication: validIndication.flatMap(NavOSSCarPlayLaneIndication.init(rawValue:))
    )
  }
}

/// `NativeCarPlayRouteStep`, as `CarPlayRouteStepRecord`.
private struct StepRecord: Decodable {
  var distanceMeters: Double = 0
  var durationSeconds: Double = 0
  var geometry: [CoordinateRecord] = []
  var instruction = ""
  var maneuverType = ""
  var roadName = ""
  var spokenInstruction: String?
  var bearingAfterDegrees: Double?
  var bearingBeforeDegrees: Double?
  var currentRoadName: String?
  var exitNumber: String?
  var junctionName: String?
  var lanes: [LaneRecord]?
  var maneuverModifier: String?
  var roundaboutExit: Int?
  var signpost: String?
  var signpostBranch: [String]?
  var signpostToward: [String]?

  private enum CodingKeys: String, CodingKey {
    case distanceMeters, durationSeconds, geometry, instruction, maneuverType, roadName
    case spokenInstruction, bearingAfterDegrees, bearingBeforeDegrees, currentRoadName
    case exitNumber, junctionName, lanes, maneuverModifier, roundaboutExit, signpost
    case signpostBranch, signpostToward
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    distanceMeters = try c.field(.distanceMeters, default: 0)
    durationSeconds = try c.field(.durationSeconds, default: 0)
    geometry = try c.field(.geometry, default: [])
    instruction = try c.field(.instruction, default: "")
    maneuverType = try c.field(.maneuverType, default: "")
    roadName = try c.field(.roadName, default: "")
    spokenInstruction = try c.decodeIfPresent(String.self, forKey: .spokenInstruction)
    bearingAfterDegrees = try c.decodeIfPresent(Double.self, forKey: .bearingAfterDegrees)
    bearingBeforeDegrees = try c.decodeIfPresent(Double.self, forKey: .bearingBeforeDegrees)
    currentRoadName = try c.decodeIfPresent(String.self, forKey: .currentRoadName)
    exitNumber = try c.decodeIfPresent(String.self, forKey: .exitNumber)
    junctionName = try c.decodeIfPresent(String.self, forKey: .junctionName)
    lanes = try c.decodeIfPresent([LaneRecord].self, forKey: .lanes)
    maneuverModifier = try c.decodeIfPresent(String.self, forKey: .maneuverModifier)
    roundaboutExit = try roundedInt(c, .roundaboutExit)
    signpost = try c.decodeIfPresent(String.self, forKey: .signpost)
    signpostBranch = try c.decodeIfPresent([String].self, forKey: .signpostBranch)
    signpostToward = try c.decodeIfPresent([String].self, forKey: .signpostToward)
  }

  var step: NavOSSCarPlayRouteStep {
    // A lane list with any unrecognised arrow is dropped whole: a partial strip would misplace
    // the lanes it kept.
    let decodedLanes = lanes?.map(\.lane)
    return NavOSSCarPlayRouteStep(
      distanceMeters: distanceMeters,
      durationSeconds: durationSeconds,
      geometry: geometry.map(\.coordinate),
      instruction: instruction,
      maneuverType: maneuverType,
      roadName: roadName,
      spokenInstruction: spokenInstruction,
      maneuverModifier: maneuverModifier,
      roundaboutExit: roundaboutExit,
      exitNumber: exitNumber,
      signpost: signpost,
      lanes: decodedLanes?.contains(where: { $0 == nil }) == false && decodedLanes?.isEmpty == false
        ? decodedLanes?.compactMap { $0 } : nil,
      currentRoadName: currentRoadName,
      bearingBeforeDegrees: bearingBeforeDegrees,
      bearingAfterDegrees: bearingAfterDegrees,
      signpostBranch: signpostBranch,
      signpostToward: signpostToward,
      junctionName: junctionName
    )
  }
}

/// `NativeRoutePreferences`, as `RoutePreferencesRecord`.
private struct PreferencesRecord: Decodable {
  var preferences = NavOSSRoutePreferences()

  private enum CodingKeys: String, CodingKey {
    case avoidFerries, avoidHighways, avoidTolls, avoidUnpaved
  }

  init() {}

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    preferences = NavOSSRoutePreferences(
      avoidFerries: try c.field(.avoidFerries, default: false),
      avoidHighways: try c.field(.avoidHighways, default: false),
      avoidTolls: try c.field(.avoidTolls, default: false),
      avoidUnpaved: try c.field(.avoidUnpaved, default: false)
    )
  }
}

/// `traffic` of `NativeCarPlayTrip`, as `CarPlayTrafficRecord`.
private struct TrafficRecord: Decodable {
  var delaySeconds: Double = 0
  var oldestObservedAt: String?
  var typicalDurationSeconds: Double = 0

  private enum CodingKeys: String, CodingKey {
    case delaySeconds, oldestObservedAt, typicalDurationSeconds
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    delaySeconds = try c.field(.delaySeconds, default: 0)
    oldestObservedAt = try c.decodeIfPresent(String.self, forKey: .oldestObservedAt)
    typicalDurationSeconds = try c.field(.typicalDurationSeconds, default: 0)
  }

  var traffic: NavOSSCarPlayTraffic {
    NavOSSCarPlayTraffic(
      delaySeconds: delaySeconds,
      typicalDurationSeconds: typicalDurationSeconds,
      oldestObservedAt: navOSSTrafficBoundary(oldestObservedAt)
    )
  }
}

/// `NativeCarPlayTrip`, as `CarPlayTripRecord`.
struct NavOSSCoreTripRecord: Decodable {
  private var destination: DestinationRecord?
  private var distanceMeters: Double = 0
  private var durationSeconds: Double = 0
  private var geometry: [CoordinateRecord] = []
  private var id = ""
  private var preferences = PreferencesRecord()
  private var source: String?
  private var speedLimitsKph: [Int]?
  private var steps: [StepRecord] = []
  private var traffic: TrafficRecord?
  private var waypoints: [DestinationRecord] = []
  private var congestion: [String]?
  private var trafficSource: String?

  private enum CodingKeys: String, CodingKey {
    case destination, distanceMeters, durationSeconds, geometry, id, preferences, source
    case speedLimitsKph, steps, traffic, waypoints, congestion, trafficSource
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    destination = try c.field(.destination, default: DestinationRecord?.none)
    distanceMeters = try c.field(.distanceMeters, default: 0)
    durationSeconds = try c.field(.durationSeconds, default: 0)
    geometry = try c.field(.geometry, default: [])
    id = try c.field(.id, default: "")
    preferences = try c.field(.preferences, default: PreferencesRecord())
    source = try c.decodeIfPresent(String.self, forKey: .source)
    if let limits = try c.decodeIfPresent([Double?].self, forKey: .speedLimitsKph) {
      speedLimitsKph = try limits.enumerated().map { index, limit in
        let path = c.codingPath + [CodingKeys.speedLimitsKph, IndexKey(index)]
        guard let limit else {
          throw DecodingError.valueNotFound(
            Int.self, DecodingError.Context(codingPath: path, debugDescription: "null"))
        }
        return try roundedInt(limit, at: path)
      }
    }
    steps = try c.field(.steps, default: [])
    traffic = try c.decodeIfPresent(TrafficRecord.self, forKey: .traffic)
    waypoints = try c.field(.waypoints, default: [])
    congestion = try c.decodeIfPresent([String].self, forKey: .congestion)
    trafficSource = try c.decodeIfPresent(String.self, forKey: .trafficSource)
  }

  var trip: NavOSSCarPlayTrip {
    // Expo fills a missing record with its defaults: an empty destination, which then fails
    // the trip's validation like any other invalid field.
    let destination =
      destination?.destination
      ?? NavOSSCarPlayDestination(id: "", label: "", latitude: 0, longitude: 0, name: "")
    let levels = congestion?.compactMap(NavOSSCarPlayCongestionLevel.init(rawValue:))
    return NavOSSCarPlayTrip(
      destination: destination,
      distanceMeters: distanceMeters,
      durationSeconds: durationSeconds,
      geometry: geometry.map(\.coordinate),
      id: id,
      preferences: preferences.preferences,
      source: source,
      speedLimitsKph: speedLimitsKph,
      steps: steps.map(\.step),
      traffic: traffic?.traffic,
      waypoints: waypoints.isEmpty ? nil : waypoints.map(\.destination),
      congestion: levels?.count == congestion?.count ? levels : nil,
      trafficSource: trafficSource
    )
  }
}

/// The engine's creation settings (see "Create" in the contract).
struct NavOSSCoreConfig: Decodable {
  let apiBaseUrl: String
  let audioMode: String?
  let rerouteMode: String?
  let speedingToleranceKph: Int?
  let speedingAudibleWarning: Bool?
  let announceRoadReports: Bool?
}

// MARK: - Snapshot

/// The iOS module's `serialize(_ state:)`, without the community alert payload (Android has no
/// community reports).
func navOSSCoreSnapshot(_ state: NavOSSNavigationServiceState) -> NavOSSCoreJSON {
  let snapshot = state.navigation
  var payload: [String: NavOSSCoreJSON] = [
    "isOffRoute": .bool(snapshot.isOffRoute),
    "phase": .string(snapshot.phase.rawValue),
    "rerouteCount": .int(state.rerouteCount),
    "routeProgress": .double(snapshot.routeProgress),
    "routeStatus": .string(state.routeStatus.rawValue),
    "routeVersion": .int(snapshot.routeVersion),
    "sequence": .int(snapshot.sequence),
    "stateVersion": .int(Int(truncatingIfNeeded: state.stateVersion)),
    "isDeadReckoning": .bool(snapshot.isDeadReckoning),
    "rerouteMode": .string(state.rerouteMode.rawValue),
    "speedingState": .string(state.speedingState.rawValue),
  ]
  if let tripEndReason = state.tripEndReason {
    payload["tripEndReason"] = .string(tripEndReason.rawValue)
  }
  if state.isAcquiringPosition {
    payload["isAcquiringPosition"] = .bool(true)
  }
  if let tripPause = state.tripPause {
    payload["tripPause"] = .string(tripPause.rawValue)
  }
  if let speedMetersPerSecond = snapshot.speedMetersPerSecond {
    payload["speedMetersPerSecond"] = .double(speedMetersPerSecond)
  }
  if let speedLimitKph = state.roadContext.speedLimitKph {
    payload["speedLimitKph"] = .int(speedLimitKph)
  }
  if let currentRoadName = state.roadContext.currentRoadName {
    payload["currentRoadName"] = .string(currentRoadName)
  }
  if let proposal = state.rerouteProposal {
    payload["rerouteProposal"] = .object([
      "createdAtMs": .double(
        Date(timeIntervalSinceReferenceDate: proposal.createdAt).timeIntervalSince1970 * 1_000),
      "distanceDeltaMeters": .double(proposal.distanceDeltaMeters),
      "distanceMeters": .double(proposal.trip.distanceMeters),
      "durationDeltaSeconds": .double(proposal.durationDeltaSeconds),
      "durationSeconds": .double(proposal.trip.durationSeconds),
      "id": .string(proposal.id),
      "respondWithinSeconds": .double(Double(NavigationRerouteConsent.askFirstResponseSeconds)),
      "trip": navOSSCoreTrip(proposal.trip),
    ])
  }
  if let alert = state.safetyCameraAlert {
    payload["safetyCameraAlert"] = .object([
      "cameraId": .string(alert.cameraId),
      "distanceAheadMeters": .double(alert.distanceAheadMeters),
      "location": .string(alert.location),
      "sequence": .int(alert.sequence),
    ])
  }
  if let rawCoordinate = snapshot.rawCoordinate {
    payload["rawCoordinate"] = coordinate(rawCoordinate.latitude, rawCoordinate.longitude)
  }
  if let matchedCoordinate = snapshot.matchedCoordinate {
    payload["matchedCoordinate"] = coordinate(
      matchedCoordinate.latitude, matchedCoordinate.longitude)
  }
  if let matchedCourseDegrees = snapshot.matchedCourseDegrees {
    payload["matchedCourseDegrees"] = .double(matchedCourseDegrees)
  }
  if let distanceFromRouteMeters = snapshot.distanceFromRouteMeters {
    payload["distanceFromRouteMeters"] = .double(distanceFromRouteMeters)
  }
  if let horizontalAccuracyMeters = snapshot.horizontalAccuracyMeters {
    payload["horizontalAccuracyMeters"] = .double(horizontalAccuracyMeters)
  }
  if snapshot.phase != .idle, let guidance = state.guidance {
    payload["guidance"] = navOSSCoreGuidance(guidance)
  }
  if snapshot.phase != .idle, let trip = state.trip {
    payload["trip"] = navOSSCoreTrip(trip)
  }
  return .object(payload)
}

/// The iOS module's `serialize(_ guidance:)`.
func navOSSCoreGuidance(_ guidance: NavOSSCarPlayGuidance) -> NavOSSCoreJSON {
  .object([
    "distanceToManeuverMeters": .double(guidance.distanceToManeuverMeters),
    "durationToManeuverSeconds": .double(guidance.durationToManeuverSeconds),
    "instruction": .string(guidance.instruction),
    "maneuverType": .string(guidance.maneuverType),
    "phase": .string(guidance.phase.rawValue),
    "remainingDistanceMeters": .double(guidance.remainingDistanceMeters),
    "remainingDurationSeconds": .double(guidance.remainingDurationSeconds),
    "roadName": .string(guidance.roadName),
    "stepIndex": .int(guidance.stepIndex),
  ])
}

private func coordinate(_ latitude: Double, _ longitude: Double) -> NavOSSCoreJSON {
  .object(["latitude": .double(latitude), "longitude": .double(longitude)])
}

/// ISO 8601 in UTC without fractional seconds, as `ISO8601DateFormatter()` writes it.
func navOSSCoreISO8601(_ date: Date) -> String {
  Date.ISO8601FormatStyle().format(date)
}

/// The iOS module's `serialize(_ trip:)`.
func navOSSCoreTrip(_ trip: NavOSSCarPlayTrip) -> NavOSSCoreJSON {
  var payload: [String: NavOSSCoreJSON] = [
    "destination": .object([
      "id": .string(trip.destination.id),
      "label": .string(trip.destination.label),
      "latitude": .double(trip.destination.latitude),
      "longitude": .double(trip.destination.longitude),
      "name": .string(trip.destination.name),
    ]),
    "distanceMeters": .double(trip.distanceMeters),
    "durationSeconds": .double(trip.durationSeconds),
    "geometry": .array(trip.geometry.map { coordinate($0.latitude, $0.longitude) }),
    "id": .string(trip.id),
    "preferences": .object([
      "avoidFerries": .bool(trip.preferences.avoidFerries),
      "avoidHighways": .bool(trip.preferences.avoidHighways),
      "avoidTolls": .bool(trip.preferences.avoidTolls),
      "avoidUnpaved": .bool(trip.preferences.avoidUnpaved),
    ]),
    "steps": .array(trip.steps.map(step)),
  ]
  if let source = trip.source {
    payload["source"] = .string(source)
  }
  if let speedLimitsKph = trip.speedLimitsKph {
    payload["speedLimitsKph"] = .array(speedLimitsKph.map { .int($0) })
  }
  if let traffic = trip.traffic {
    var trafficPayload: [String: NavOSSCoreJSON] = [
      "delaySeconds": .double(traffic.delaySeconds),
      "typicalDurationSeconds": .double(traffic.typicalDurationSeconds),
    ]
    if let observedAt = traffic.oldestObservedAt {
      trafficPayload["oldestObservedAt"] = .string(navOSSCoreISO8601(observedAt))
    }
    payload["traffic"] = .object(trafficPayload)
  }
  if let congestion = trip.congestion {
    payload["congestion"] = .array(congestion.map { .string($0.rawValue) })
  }
  if let trafficSource = trip.trafficSource {
    payload["trafficSource"] = .string(trafficSource)
  }
  if let waypoints = trip.waypoints {
    payload["waypoints"] = .array(
      waypoints.map { waypoint in
        var destination: [String: NavOSSCoreJSON] = [
          "id": .string(waypoint.id),
          "label": .string(waypoint.label),
          "latitude": .double(waypoint.latitude),
          "longitude": .double(waypoint.longitude),
          "name": .string(waypoint.name),
        ]
        if let category = waypoint.category {
          destination["category"] = .string(category)
        }
        return .object(destination)
      })
  }
  return .object(payload)
}

private func step(_ step: NavOSSCarPlayRouteStep) -> NavOSSCoreJSON {
  var payload: [String: NavOSSCoreJSON] = [
    "distanceMeters": .double(step.distanceMeters),
    "durationSeconds": .double(step.durationSeconds),
    "geometry": .array(step.geometry.map { coordinate($0.latitude, $0.longitude) }),
    "instruction": .string(step.instruction),
    "maneuverType": .string(step.maneuverType),
    "roadName": .string(step.roadName),
  ]
  if let spokenInstruction = step.spokenInstruction {
    payload["spokenInstruction"] = .string(spokenInstruction)
  }
  if let lanes = step.lanes {
    payload["lanes"] = .array(
      lanes.map { lane in
        var value: [String: NavOSSCoreJSON] = [
          "active": .bool(lane.isPreferred),
          "indications": .array(lane.indications.map { .string($0.rawValue) }),
          "valid": .bool(lane.isValid),
        ]
        if let activeIndication = lane.activeIndication {
          value["validIndication"] = .string(activeIndication.rawValue)
        }
        return .object(value)
      })
  }
  let optionalFields: [String: NavOSSCoreJSON?] = [
    "bearingAfterDegrees": step.bearingAfterDegrees.map { .double($0) },
    "bearingBeforeDegrees": step.bearingBeforeDegrees.map { .double($0) },
    "currentRoadName": step.currentRoadName.map { .string($0) },
    "exitNumber": step.exitNumber.map { .string($0) },
    "junctionName": step.junctionName.map { .string($0) },
    "maneuverModifier": step.maneuverModifier.map { .string($0) },
    "roundaboutExit": step.roundaboutExit.map { .int($0) },
    "signpost": step.signpost.map { .string($0) },
    "signpostBranch": step.signpostBranch.map { .array($0.map { .string($0) }) },
    "signpostToward": step.signpostToward.map { .array($0.map { .string($0) }) },
  ]
  for case let (key, value?) in optionalFields {
    payload[key] = value
  }
  return .object(payload)
}
