import Foundation

// Wire types and mapping for `POST /v1/routes` and `POST /v2/routes`.
//
// `/v2/routes` adds optional step metadata (lanes, signposts, exits, junctions, roundabout exits,
// bearings, the road driven along the step), geometry-aligned `speedLimits` with explicit
// unknown/unlimited states, and optional sourced traffic and congestion (opted-in NavOSS drivers,
// or The City of Calgary's main-road travel times for a client that declared it). Every optional
// field decodes
// leniently: a malformed or unrecognised value is dropped on its own and never fails the route,
// because a route without lanes is still a route. Required fields stay strict.
//
// The two versions also differ in what a step's `spokenInstruction` describes. In v1 it is the
// announcement made while driving the step, for the maneuver that ends it (the next step's
// maneuver). In v2 it describes the step's own maneuver. `NavOSSCarPlayRouteStep` uses the v2
// meaning, so v1 responses are shifted by one step when they are decoded.

/// `NavOSSCarPlayTrip.source` of a route planned on the device by the offline router. Defined
/// here, with the route model's decoding, so builds without the offline router still know it.
public let navOSSOfflineRouteSource = "offline-valhalla"

/// `NavOSSCarPlayTrip.trafficSource` of traffic measured by opted-in NavOSS drivers.
public let navOSSCommunityTrafficSource = "navoss-community"
/// `NavOSSCarPlayTrip.trafficSource` of traffic from The City of Calgary's main-road travel times.
/// `/v2/routes` sends it only to a client that declares it (`trafficSources`).
public let navOSSCalgaryTravelTimesTrafficSource = "calgary-travel-times"
/// Route traffic sources the app presents. Traffic from any other source is dropped when a route
/// is decoded, never presented under another source's name.
let navOSSPresentedTrafficSources: Set<String> = [
  navOSSCommunityTrafficSource, navOSSCalgaryTravelTimesTrafficSource,
]
/// The sources a route request declares in `trafficSources`: those that need a declaration.
let navOSSDeclaredTrafficSources = [navOSSCalgaryTravelTimesTrafficSource]

struct NavigationRouteWaypointRequest: Encodable {
  let latitude: Double
  let longitude: Double
  /// `through` only; omitted for ordinary stops (the v2 default `break`) and always for v1.
  let type: String?
}

struct NavigationRouteRequest: Encodable {
  let alternatives: Int
  let destination: NavOSSCarPlayCoordinate
  let origin: NavOSSCarPlayCoordinate
  let originHeadingDegrees: Double?
  let originHorizontalAccuracyMeters: Double?
  let preferences: NavOSSRoutePreferences
  /// `/v2/routes` only: the extra traffic sources this client presents. `nil` for `/v1/routes`.
  let trafficSources: [String]?
  let waypoints: [NavigationRouteWaypointRequest]?

  /// The request to send once more after the API rejected this one as not matching its contract,
  /// or `nil` when nothing optional is left to drop. Only the newest optional field it carries is
  /// dropped, so one field an older API does not know never costs the others:
  /// - `trafficSources` (2026-11-27), which the deployed API rejects until it learns it. Every API
  ///   that serves `/v2/routes` accepts the origin metadata (both arrived in the contract in
  ///   August 2026, before `/v2/routes`), so a rejected request that declared sources is that.
  /// - Otherwise the origin heading and accuracy, which an API older than August 2026 rejected
  ///   (only ever on `/v1/routes`, which is never sent `trafficSources`).
  func withoutNewestOptionalField() -> NavigationRouteRequest? {
    let dropsSources = trafficSources != nil
    guard dropsSources || originHeadingDegrees != nil || originHorizontalAccuracyMeters != nil
    else {
      return nil
    }
    return NavigationRouteRequest(
      alternatives: alternatives,
      destination: destination,
      origin: origin,
      originHeadingDegrees: dropsSources ? originHeadingDegrees : nil,
      originHorizontalAccuracyMeters: dropsSources ? originHorizontalAccuracyMeters : nil,
      preferences: preferences,
      trafficSources: nil,
      waypoints: waypoints
    )
  }
}

/// Decodes a value, or `nil` when it is absent or malformed.
private func lenient<Value: Decodable, Key: CodingKey>(
  _ type: Value.Type,
  _ container: KeyedDecodingContainer<Key>,
  _ key: Key
) -> Value? {
  (try? container.decodeIfPresent(type, forKey: key)) ?? nil
}

private func nonEmpty(_ value: String?) -> String? {
  guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
    return nil
  }
  return value
}

private func nonEmpty(_ values: [String]?) -> [String]? {
  let cleaned = (values ?? []).compactMap { nonEmpty($0) }
  return cleaned.isEmpty ? nil : cleaned
}

private func bearing(_ value: Double?) -> Double? {
  guard let value, value.isFinite, value >= 0, value < 360 else { return nil }
  return value
}

/// One geometry segment's posted limit as `/v2/routes` states it.
enum NavigationRouteSpeedLimit: Decodable, Equatable {
  case known(kph: Int)
  case unknown
  case unlimited

  private enum CodingKeys: String, CodingKey {
    case kph
    case status
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    switch try container.decode(String.self, forKey: .status) {
    case "known":
      let kph = try container.decode(Int.self, forKey: .kph)
      guard (1...250).contains(kph) else {
        throw DecodingError.dataCorruptedError(
          forKey: .kph, in: container, debugDescription: "implausible limit")
      }
      self = .known(kph: kph)
    case "unknown":
      self = .unknown
    case "unlimited":
      self = .unlimited
    default:
      throw DecodingError.dataCorruptedError(
        forKey: .status, in: container, debugDescription: "unknown speed limit status")
    }
  }

  /// The legacy `speedLimitsKph` value: zero means "no posted limit to show". An unlimited
  /// segment shows no limit and never produces a speeding warning, exactly like an unknown one;
  /// it must never be shown as a number.
  var legacyKph: Int {
    if case .known(let kph) = self { return kph }
    return 0
  }
}

struct NavigationRouteStepWire: Decodable {
  let distanceMeters: Double
  let durationSeconds: Double
  let geometry: [[Double]]
  let instruction: String
  let maneuverType: String
  let roadName: String
  let spokenInstruction: String?
  let bearingAfterDegrees: Double?
  let bearingBeforeDegrees: Double?
  let currentRoadName: String?
  let exitNumber: String?
  let junctionName: String?
  let lanes: [NavOSSCarPlayLane]?
  let maneuverModifier: String?
  let roundaboutExit: Int?
  let signpost: String?
  let signpostBranch: [String]?
  let signpostToward: [String]?

  private enum CodingKeys: String, CodingKey {
    case distanceMeters, durationSeconds, geometry, instruction, maneuverType, roadName
    case spokenInstruction, bearingAfterDegrees, bearingBeforeDegrees, currentRoadName
    case exitNumber, junctionName, lanes, maneuverModifier, roundaboutExit, signpost
    case signpostBranch, signpostToward
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    distanceMeters = try container.decode(Double.self, forKey: .distanceMeters)
    durationSeconds = try container.decode(Double.self, forKey: .durationSeconds)
    geometry = try container.decode([[Double]].self, forKey: .geometry)
    instruction = try container.decode(String.self, forKey: .instruction)
    maneuverType = try container.decode(String.self, forKey: .maneuverType)
    roadName = try container.decode(String.self, forKey: .roadName)
    spokenInstruction = nonEmpty(lenient(String.self, container, .spokenInstruction))
    bearingAfterDegrees = bearing(lenient(Double.self, container, .bearingAfterDegrees))
    bearingBeforeDegrees = bearing(lenient(Double.self, container, .bearingBeforeDegrees))
    currentRoadName = nonEmpty(lenient(String.self, container, .currentRoadName))
    exitNumber = nonEmpty(lenient(String.self, container, .exitNumber))
    junctionName = nonEmpty(lenient(String.self, container, .junctionName))
    let lanes = lenient([NavOSSCarPlayLane].self, container, .lanes)
    self.lanes = lanes?.isEmpty == false ? lanes : nil
    maneuverModifier = nonEmpty(lenient(String.self, container, .maneuverModifier))
    roundaboutExit = lenient(Int.self, container, .roundaboutExit).flatMap {
      (1...19).contains($0) ? $0 : nil
    }
    signpost = nonEmpty(lenient(String.self, container, .signpost))
    signpostBranch = nonEmpty(lenient([String].self, container, .signpostBranch))
    signpostToward = nonEmpty(lenient([String].self, container, .signpostToward))
  }
}

struct NavigationRouteWire: Decodable {
  struct Traffic: Decodable {
    let delaySeconds: Double
    /// Sourced traffic only: the oldest publication boundary of the traffic applied (for City
    /// of Calgary traffic, the City's last update). Optional, and dropped rather than failing the
    /// route when it is missing or unreadable.
    let oldestObservedAt: Date?
    let typicalDurationSeconds: Double

    private enum CodingKeys: String, CodingKey {
      case delaySeconds, oldestObservedAt, typicalDurationSeconds
    }

    init(from decoder: Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      delaySeconds = try container.decode(Double.self, forKey: .delaySeconds)
      typicalDurationSeconds = try container.decode(Double.self, forKey: .typicalDurationSeconds)
      oldestObservedAt = navOSSTrafficBoundary(lenient(String.self, container, .oldestObservedAt))
    }
  }

  let congestion: [NavOSSCarPlayCongestionLevel]?
  let distanceMeters: Double
  let durationSeconds: Double
  let geometry: [[Double]]
  let id: String
  let speedLimits: [NavigationRouteSpeedLimit]?
  let speedLimitsKph: [Int]?
  let steps: [NavigationRouteStepWire]
  let traffic: Traffic?

  private enum CodingKeys: String, CodingKey {
    case congestion, distanceMeters, durationSeconds, geometry, id, speedLimits, speedLimitsKph
    case steps, traffic
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    distanceMeters = try container.decode(Double.self, forKey: .distanceMeters)
    durationSeconds = try container.decode(Double.self, forKey: .durationSeconds)
    geometry = try container.decode([[Double]].self, forKey: .geometry)
    id = try container.decode(String.self, forKey: .id)
    steps = try container.decode([NavigationRouteStepWire].self, forKey: .steps)
    traffic = lenient(Traffic.self, container, .traffic)
    let segments = geometry.count - 1
    // Annotations that do not line up with the geometry would colour or limit the wrong road.
    congestion = lenient([NavOSSCarPlayCongestionLevel].self, container, .congestion)
      .flatMap { $0.count == segments ? $0 : nil }
    speedLimits = lenient([NavigationRouteSpeedLimit].self, container, .speedLimits)
      .flatMap { $0.count == segments ? $0 : nil }
    speedLimitsKph = lenient([Int].self, container, .speedLimitsKph)
  }
}

struct NavigationRouteResponseWire: Decodable {
  struct Source: Decodable {
    struct TrafficSource: Decodable {
      let id: String
    }

    let id: String
    let trafficSource: TrafficSource?

    private enum CodingKeys: String, CodingKey {
      case id, trafficSource
    }

    init(from decoder: Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      id = try container.decode(String.self, forKey: .id)
      trafficSource = lenient(TrafficSource.self, container, .trafficSource)
    }
  }

  let routes: [NavigationRouteWire]
  let source: Source
}

private func navigationCoordinates(_ values: [[Double]]) throws -> [NavOSSCarPlayCoordinate] {
  try values.map { value in
    guard value.count == 2 else {
      throw NavOSSNavigationAPIError.invalidResponse
    }
    return NavOSSCarPlayCoordinate(latitude: value[1], longitude: value[0])
  }
}

/// Maps a decoded routes response to trips, normalising v1 to the v2 step semantics.
func navigationTrips(
  from response: NavigationRouteResponseWire,
  version: NavigationRoutesAPIVersion,
  destination: NavOSSCarPlayDestination,
  preferences: NavOSSRoutePreferences,
  waypoints: [NavOSSCarPlayDestination]
) throws -> [NavOSSCarPlayTrip] {
  try response.routes.map { route in
    let spoken: [String?] =
      switch version {
      case .v2:
        route.steps.map(\.spokenInstruction)
      case .v1:
        // v1 step i announces step i + 1's maneuver.
        [nil] + route.steps.dropLast().map(\.spokenInstruction)
      }
    let steps = try route.steps.enumerated().map { index, step in
      NavOSSCarPlayRouteStep(
        distanceMeters: step.distanceMeters,
        durationSeconds: step.durationSeconds,
        geometry: try navigationCoordinates(step.geometry),
        instruction: navOSSPresentedInstruction(step.instruction, maneuverType: step.maneuverType),
        maneuverType: step.maneuverType,
        roadName: step.roadName,
        spokenInstruction: spoken[index],
        maneuverModifier: step.maneuverModifier,
        roundaboutExit: step.roundaboutExit,
        exitNumber: step.exitNumber,
        signpost: step.signpost,
        lanes: step.lanes,
        currentRoadName: step.currentRoadName,
        bearingBeforeDegrees: step.bearingBeforeDegrees,
        bearingAfterDegrees: step.bearingAfterDegrees,
        signpostBranch: step.signpostBranch,
        signpostToward: step.signpostToward,
        junctionName: step.junctionName
      )
    }
    // Route traffic is presented only from the routing provider itself (Mapbox) or a traffic
    // source the app knows; an unknown source's delays and congestion are dropped, not presented
    // under another source's name.
    let trafficSource = response.source.trafficSource.map(\.id)
    let knownTrafficSource = trafficSource.map(navOSSPresentedTrafficSources.contains) ?? false
    let keepsTraffic = knownTrafficSource || response.source.id == "mapbox-traffic"
    let traffic = keepsTraffic ? route.traffic : nil
    let congestion = knownTrafficSource ? route.congestion : nil
    return NavOSSCarPlayTrip(
      destination: destination,
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      geometry: try navigationCoordinates(route.geometry),
      id: route.id,
      preferences: preferences,
      source: response.source.id,
      speedLimitsKph: route.speedLimits?.map(\.legacyKph) ?? route.speedLimitsKph,
      steps: steps,
      traffic: traffic.map {
        NavOSSCarPlayTraffic(
          delaySeconds: $0.delaySeconds,
          typicalDurationSeconds: $0.typicalDurationSeconds,
          oldestObservedAt: $0.oldestObservedAt
        )
      },
      waypoints: waypoints.isEmpty ? nil : waypoints,
      congestion: congestion,
      trafficSource: knownTrafficSource && (traffic != nil || congestion != nil) ? trafficSource : nil
    )
  }
}

/// Decodes a `/v2/routes` response body into trips, exactly as the API client does. Used by the
/// simulator CarPlay harness to render real recorded responses.
public func navOSSTripsFromRoutesV2Response(
  _ data: Data,
  destination: NavOSSCarPlayDestination,
  preferences: NavOSSRoutePreferences = NavOSSRoutePreferences()
) throws -> [NavOSSCarPlayTrip] {
  try navigationTrips(
    from: JSONDecoder().decode(NavigationRouteResponseWire.self, from: data),
    version: .v2,
    destination: destination,
    preferences: preferences,
    waypoints: []
  )
}
