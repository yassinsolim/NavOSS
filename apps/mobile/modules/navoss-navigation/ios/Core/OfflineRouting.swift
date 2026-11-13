import Foundation

#if canImport(CryptoKit)
  import CryptoKit
#endif

// On-device routing adapter between NavOSS's route model and Valhalla 3.9.1's native JSON.
//
// The embedded wrapper (Rallista valhalla-mobile 0.6.4) rejects PBF output, and the OSRM format
// flattens exit signs into one `destinations` string. Native JSON keeps sign elements, lanes and
// bearings as separate fields, so the adapter requests `"format": "json"` and maps maneuvers the
// same way the API's lossless v2 adapter maps native PBF maneuvers.

public let navOSSOfflineRouteSource = "offline-valhalla"

public enum NavOSSOfflineRoutingError: Error, Equatable, Sendable {
  /// No region installed on this device covers every stop of the trip.
  case outsideInstalledCoverage
  /// The engine found no route between the stops.
  case noRoute
  /// A route left the installed coverage; offline routes must stay inside the downloaded region.
  case routeLeavesCoverage
  /// The engine's answer was not a valid Valhalla JSON trip.
  case invalidResponse
  /// The engine could not be started on the installed files.
  case engineUnavailable
}

/// Builds a native-JSON Valhalla route request with the same costing and origin handling as the
/// API's online request, so offline and online routes differ only by data and engine version.
public func navOSSOfflineRouteRequest(
  origin: NavOSSCarPlayCoordinate,
  originHeadingDegrees: Double?,
  originHorizontalAccuracyMeters: Double?,
  destination: NavOSSCarPlayCoordinate,
  waypoints: [NavOSSCarPlayCoordinate],
  preferences: NavOSSRoutePreferences,
  alternatives: Int
) throws -> String {
  var originLocation: [String: Any] = ["lat": origin.latitude, "lon": origin.longitude]
  if let originHeadingDegrees, originHeadingDegrees.isFinite {
    originLocation["heading"] = Int(originHeadingDegrees.rounded()) % 360
    originLocation["heading_tolerance"] = 45
  }
  if let originHorizontalAccuracyMeters, originHorizontalAccuracyMeters.isFinite {
    originLocation["radius"] = Int(min(100, max(15, originHorizontalAccuracyMeters * 2)).rounded(.up))
  }
  let stops = (waypoints + [destination]).map { ["lat": $0.latitude, "lon": $0.longitude] }
  let request: [String: Any] = [
    "alternates": max(0, min(2, alternatives)),
    "costing": "auto",
    "costing_options": [
      "auto": [
        "exclude_unpaved": preferences.avoidUnpaved,
        "use_ferry": preferences.avoidFerries ? 0 : 0.5,
        "use_highways": preferences.avoidHighways ? 0 : 0.5,
        "use_tolls": preferences.avoidTolls ? 0 : 0.5,
      ]
    ],
    "directions_type": "instructions",
    "format": "json",
    "language": "en-US",
    "locations": [originLocation] + stops,
    "roundabout_exits": true,
    "shape_format": "polyline6",
    "turn_lanes": true,
    "units": "kilometers",
  ]
  let data = try JSONSerialization.data(withJSONObject: request, options: [.sortedKeys])
  return String(decoding: data, as: UTF8.self)
}

/// Converts a Valhalla 3.9.1 native JSON route response (main trip plus `alternates`) into
/// NavOSS trips, in the same display order the online client uses.
public func navOSSOfflineTrips(
  fromValhallaJSON data: Data,
  destination: NavOSSCarPlayDestination,
  waypoints: [NavOSSCarPlayDestination],
  preferences: NavOSSRoutePreferences
) throws -> [NavOSSCarPlayTrip] {
  guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    throw NavOSSOfflineRoutingError.invalidResponse
  }
  if root["error_code"] != nil || root["error"] != nil {
    throw NavOSSOfflineRoutingError.noRoute
  }
  guard let main = root["trip"] as? [String: Any] else {
    throw NavOSSOfflineRoutingError.invalidResponse
  }
  let alternates = (root["alternates"] as? [[String: Any]] ?? []).compactMap {
    $0["trip"] as? [String: Any]
  }
  let trips = try ([main] + alternates).enumerated().map { index, trip in
    try offlineTrip(
      trip, index: index, destination: destination, waypoints: waypoints, preferences: preferences)
  }
  return navOSSCarPlayTripsOrderedForDisplay(trips)
}

/// Whether every point of every trip lies inside `region`'s advertised coverage.
public func navOSSOfflineTripsStayInside(
  _ trips: [NavOSSCarPlayTrip],
  region: NavOSSOfflineRegion
) -> Bool {
  trips.allSatisfy { trip in trip.geometry.allSatisfy(region.covers) }
}

private func offlineTrip(
  _ trip: [String: Any],
  index: Int,
  destination: NavOSSCarPlayDestination,
  waypoints: [NavOSSCarPlayDestination],
  preferences: NavOSSRoutePreferences
) throws -> NavOSSCarPlayTrip {
  guard let status = trip["status"] as? Int, status == 0,
    let legs = trip["legs"] as? [[String: Any]], !legs.isEmpty,
    let summary = trip["summary"] as? [String: Any],
    let lengthKm = summary["length"] as? Double, let time = summary["time"] as? Double,
    lengthKm > 0, time > 0
  else {
    throw NavOSSOfflineRoutingError.invalidResponse
  }
  var geometry: [NavOSSCarPlayCoordinate] = []
  var steps: [NavOSSCarPlayRouteStep] = []
  for leg in legs {
    guard let encoded = leg["shape"] as? String,
      let maneuvers = leg["maneuvers"] as? [[String: Any]], !maneuvers.isEmpty
    else {
      throw NavOSSOfflineRoutingError.invalidResponse
    }
    let shape = try navOSSDecodePolyline6(encoded)
    guard shape.count >= 2 else { throw NavOSSOfflineRoutingError.invalidResponse }
    geometry.append(contentsOf: geometry.isEmpty ? shape[...] : shape.dropFirst())
    var previousRoadName = ""
    for maneuver in maneuvers {
      let step = try offlineStep(maneuver, shape: shape, previousRoadName: previousRoadName)
      previousRoadName = step.roadName
      steps.append(step)
    }
  }
  let built = NavOSSCarPlayTrip(
    destination: destination,
    distanceMeters: lengthKm * 1_000,
    durationSeconds: time,
    geometry: geometry,
    id: "",
    preferences: preferences,
    source: navOSSOfflineRouteSource,
    steps: steps,
    waypoints: waypoints.isEmpty ? nil : waypoints
  )
  let identified = NavOSSCarPlayTrip(
    destination: built.destination,
    distanceMeters: built.distanceMeters,
    durationSeconds: built.durationSeconds,
    geometry: built.geometry,
    id: "offline-valhalla-\(index + 1)-\(tripDigest(built))",
    preferences: built.preferences,
    source: built.source,
    steps: built.steps,
    waypoints: built.waypoints
  )
  guard identified.isValid else { throw NavOSSOfflineRoutingError.invalidResponse }
  return identified
}

private func offlineStep(
  _ maneuver: [String: Any],
  shape: [NavOSSCarPlayCoordinate],
  previousRoadName: String
) throws -> NavOSSCarPlayRouteStep {
  guard let type = maneuver["type"] as? Int,
    let instruction = maneuver["instruction"] as? String, !instruction.isEmpty,
    let begin = maneuver["begin_shape_index"] as? Int,
    let end = maneuver["end_shape_index"] as? Int,
    let lengthKm = maneuver["length"] as? Double, let time = maneuver["time"] as? Double,
    begin >= 0, begin <= end, end < shape.count
  else {
    throw NavOSSOfflineRoutingError.invalidResponse
  }
  var stepGeometry = Array(shape[begin...end])
  if stepGeometry.count == 1 { stepGeometry.append(stepGeometry[0]) }
  let (maneuverType, modifier) =
    valhallaManeuvers[type] ?? ("valhalla-\(type)", nil)
  let streetNames = (maneuver["street_names"] as? [String] ?? []).filter { !$0.isEmpty }
  let beginNames = (maneuver["begin_street_names"] as? [String] ?? []).filter { !$0.isEmpty }
  // OSRM-compatible steps keep the previous name on arrival; match that so phone and CarPlay
  // show the same road name either way.
  let roadName =
    streetNames.isEmpty && maneuverType == "arrive"
    ? previousRoadName : streetNames.joined(separator: " / ")
  let currentRoadName = beginNames.isEmpty ? nil : beginNames.joined(separator: " / ")
  let sign = signFields(maneuver["sign"] as? [String: Any])
  // Contract v10: each step carries its own maneuver's announcement.
  let spoken = (maneuver["verbal_pre_transition_instruction"] as? String).flatMap {
    $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0
  }
  return NavOSSCarPlayRouteStep(
    distanceMeters: lengthKm * 1_000,
    durationSeconds: time,
    geometry: stepGeometry,
    instruction: instruction,
    maneuverType: maneuverType,
    roadName: roadName,
    spokenInstruction: spoken,
    maneuverModifier: modifier,
    roundaboutExit: (maneuver["roundabout_exit_count"] as? Int).flatMap { $0 > 0 ? $0 : nil },
    exitNumber: sign.exitNumber,
    signpost: sign.signpost,
    lanes: lanes(maneuver["lanes"] as? [[String: Any]]),
    currentRoadName: currentRoadName == roadName ? nil : currentRoadName,
    bearingBeforeDegrees: bearing(maneuver["bearing_before"]),
    bearingAfterDegrees: bearing(maneuver["bearing_after"]),
    signpostBranch: sign.branch,
    signpostToward: sign.toward,
    junctionName: sign.junctionName
  )
}

/// Valhalla `DirectionsLeg.Maneuver.Type` → OSRM-style type and modifier, the vocabulary every
/// NavOSS consumer reads. Same table as the API's lossless v2 adapter.
private let valhallaManeuvers: [Int: (String, String?)] = [
  0: ("notification", nil),
  1: ("depart", nil), 2: ("depart", "right"), 3: ("depart", "left"),
  4: ("arrive", nil), 5: ("arrive", "right"), 6: ("arrive", "left"),
  7: ("new name", nil),
  8: ("continue", "straight"),
  9: ("turn", "slight right"), 10: ("turn", "right"), 11: ("turn", "sharp right"),
  12: ("turn", "uturn"), 13: ("turn", "uturn"),
  14: ("turn", "sharp left"), 15: ("turn", "left"), 16: ("turn", "slight left"),
  17: ("on ramp", "straight"), 18: ("on ramp", "slight right"), 19: ("on ramp", "slight left"),
  20: ("off ramp", "slight right"), 21: ("off ramp", "slight left"),
  22: ("fork", "straight"), 23: ("fork", "slight right"), 24: ("fork", "slight left"),
  25: ("merge", nil),
  26: ("roundabout", nil), 27: ("exit roundabout", nil),
  28: ("ferry", nil), 29: ("exit ferry", nil),
  37: ("merge", "slight right"), 38: ("merge", "slight left"),
]

/// Valhalla turn-lane bits, left to right as drivers read them.
private let laneDirections: [(Int, NavOSSCarPlayLaneIndication)] = [
  (1, .none), (256, .uturn), (4, .sharpLeft), (8, .left), (16, .slightLeft), (2, .straight),
  (32, .slightRight), (64, .right), (128, .sharpRight), (512, .mergeLeft), (1024, .mergeRight),
]

private func lanes(_ values: [[String: Any]]?) -> [NavOSSCarPlayLane]? {
  guard let values, values.count > 1 else { return nil }
  var lanes: [NavOSSCarPlayLane] = []
  for value in values {
    guard let mask = value["directions"] as? Int, mask >= 0 else { return nil }
    let active = value["active"] as? Int
    let valid = active ?? value["valid"] as? Int
    if let valid, valid == 0 || valid & mask != valid { return nil }
    var indications = laneDirections.filter { mask & $0.0 != 0 }.map(\.1)
    if indications.isEmpty { indications = [.none] }
    let followed = valid.map { valid in laneDirections.filter { valid & $0.0 != 0 }.map(\.1) }
    lanes.append(
      NavOSSCarPlayLane(
        indications: indications,
        isValid: valid != nil,
        isPreferred: active != nil,
        activeIndication: followed?.count == 1 ? followed?.first : nil
      ))
  }
  // Only a lane list that tells the driver which lane to use is guidance.
  return lanes.contains(where: \.isValid) ? lanes : nil
}

private struct SignFields {
  var exitNumber: String?
  var branch: [String]?
  var toward: [String]?
  var junctionName: String?
  var signpost: String?
}

private func signFields(_ sign: [String: Any]?) -> SignFields {
  guard let sign else { return SignFields() }
  func texts(_ key: String) -> [String] {
    (sign[key] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }
      .filter { !$0.isEmpty }
  }
  let numbers = texts("exit_number_elements")
  let branch = texts("exit_branch_elements")
  let toward = texts("exit_toward_elements")
  let names = texts("exit_name_elements")
  let junction = names.joined(separator: ", ")
  let signpost = [branch.joined(separator: ", "), toward.joined(separator: ", ")]
    .filter { !$0.isEmpty }.joined(separator: ": ")
  return SignFields(
    exitNumber: numbers.isEmpty ? nil : numbers.joined(separator: ", "),
    branch: branch.isEmpty ? nil : branch,
    toward: toward.isEmpty ? nil : toward,
    junctionName: junction.isEmpty ? nil : junction,
    signpost: signpost.isEmpty ? (junction.isEmpty ? nil : junction) : signpost
  )
}

private func bearing(_ value: Any?) -> Double? {
  guard let number = value as? Double, number.isFinite, (0..<360).contains(number) else {
    return nil
  }
  return number
}

/// Decodes a Valhalla polyline with six decimal places.
public func navOSSDecodePolyline6(_ encoded: String) throws -> [NavOSSCarPlayCoordinate] {
  var coordinates: [NavOSSCarPlayCoordinate] = []
  let bytes = Array(encoded.utf8)
  var index = 0
  var latitude = 0
  var longitude = 0
  func delta() throws -> Int {
    var result = 0
    var shift = 0
    while true {
      guard index < bytes.count, shift <= 30 else {
        throw NavOSSOfflineRoutingError.invalidResponse
      }
      let byte = Int(bytes[index]) - 63
      index += 1
      guard (0...63).contains(byte) else { throw NavOSSOfflineRoutingError.invalidResponse }
      result |= (byte & 0x1f) << shift
      shift += 5
      if byte < 0x20 { break }
    }
    return result & 1 != 0 ? ~(result >> 1) : result >> 1
  }
  while index < bytes.count {
    latitude += try delta()
    longitude += try delta()
    let coordinate = NavOSSCarPlayCoordinate(
      latitude: Double(latitude) / 1_000_000, longitude: Double(longitude) / 1_000_000)
    guard coordinate.isValid else { throw NavOSSOfflineRoutingError.invalidResponse }
    coordinates.append(coordinate)
  }
  return coordinates
}

private func tripDigest(_ trip: NavOSSCarPlayTrip) -> String {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys]
  let data = (try? encoder.encode(trip)) ?? Data()
  #if canImport(CryptoKit)
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined().prefix(16)
      .description
  #else
    return String(data.hashValue, radix: 16)
  #endif
}
