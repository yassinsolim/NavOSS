import Foundation
import XCTest

@testable import NavOSSNavigationCore

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// `/v2/routes` client behaviour against real responses recorded from the NavOSS API with the
/// public development Valhalla (`apps/mobile/test/fixtures/routes-v2`), plus the discovery and
/// v1 fallback rules.
final class NavigationRoutesV2Tests: XCTestCase {
  private static let baseURL = URL(string: "https://routes.example.test")!
  private static let fixtures = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .appendingPathComponent("../../../../test/fixtures/routes-v2")
    .standardized

  override func tearDown() {
    RoutesURLProtocol.handler = nil
    super.tearDown()
  }

  // MARK: Real recordings

  func testCalgaryInterchangeDecodesLanesSignpostsAndLimitsFromTheRealResponse() async throws {
    let paths = PathLog()
    RoutesURLProtocol.handler = { request in
      paths.append(request.url!.path)
      switch request.url!.path {
      case "/v2/config": return Self.response(request, Self.v2Config)
      case "/v2/routes": return Self.response(request, try Self.fixture("calgary-deerfoot-glenmore.v2"))
      default: return Self.response(request, Data("{}".utf8), status: 404)
      }
    }
    let client = try makeClient()

    let tripResult = try await client.routes(
      origin: Self.calgaryOrigin, destination: Self.calgaryDestination,
      preferences: NavOSSRoutePreferences(), alternatives: 0
    ).first
    let trip = try XCTUnwrap(tripResult)
    _ = try await client.routes(
      origin: Self.calgaryOrigin, destination: Self.calgaryDestination,
      preferences: NavOSSRoutePreferences(), alternatives: 0
    )

    XCTAssertEqual(paths.values, ["/v2/config", "/v2/routes", "/v2/routes"], "config is asked once")
    XCTAssertTrue(trip.isValid)
    XCTAssertEqual(trip.steps[0].currentRoadName, "Deerfoot Trail SE")
    let exit = trip.steps[1]
    XCTAssertEqual(exit.maneuverType, "off ramp")
    XCTAssertEqual(exit.exitNumber, "248")
    XCTAssertEqual(exit.signpostToward, ["Glenmore Trail"])
    XCTAssertEqual(exit.maneuverModifier, "slight right")
    XCTAssertEqual(exit.spokenInstruction, "Take exit 248 toward Glenmore Trail.")
    XCTAssertEqual(
      exit.lanes,
      [
        NavOSSCarPlayLane(indications: [.straight], isValid: false),
        NavOSSCarPlayLane(indications: [.straight], isValid: false),
        NavOSSCarPlayLane(
          indications: [.right], isValid: true, isPreferred: true, activeIndication: .right),
      ]
    )
    XCTAssertEqual(trip.steps[2].exitNumber, "248B")
    XCTAssertEqual(trip.steps[3].signpostBranch, ["14 Street W South"])
    XCTAssertEqual(trip.steps[3].signpostToward, ["14 Street West (Hospital)"])
    // Recorded mix of posted and unknown limits, aligned to the geometry.
    let limits = try XCTUnwrap(trip.speedLimitsKph)
    XCTAssertEqual(limits.count, trip.geometry.count - 1)
    XCTAssertEqual(Set(limits), [0, 70, 80, 100])
    XCTAssertNil(trip.congestion, "the development server publishes no traffic")
    XCTAssertNil(trip.trafficSource)
    XCTAssertNil(navOSSCarPlayTrafficAttribution(trip), "no traffic credit without traffic")

    // CarPlay: lanes, exit label and signpost text come from the data.
    let info = try XCTUnwrap(navOSSCarPlayManeuverInfo(trip: trip, stepIndex: 1))
    XCTAssertEqual(info.highwayExitLabel, "Exit 248")
    XCTAssertEqual(info.lanes?.map(\.status), [.notGood, .notGood, .preferred])
    XCTAssertEqual(info.lanes?.last?.highlightedAngle, 90)
    XCTAssertEqual(info.kind, .offRampRight)
    XCTAssertEqual(info.turnAngleDegrees, 40, "recorded 205° → 206° bearings must not draw a straight arrow")
    let later = try XCTUnwrap(navOSSCarPlayManeuverInfo(trip: trip, stepIndex: 3))
    XCTAssertEqual(
      later.instructionVariants.first,
      "Take the 14 Street W South exit toward 14 Street West (Hospital).",
      "a provider instruction that already names the destination is not padded"
    )
  }

  func testVancouverInterchangeDecodesFromTheRealResponse() throws {
    let trip = try XCTUnwrap(try Self.trips("vancouver-bc91-highway99.v2", version: .v2).first)
    XCTAssertTrue(trip.isValid)
    XCTAssertEqual(trip.steps[0].currentRoadName, "East-West Connector")
    let exit = trip.steps[1]
    XCTAssertEqual(exit.exitNumber, "23B")
    XCTAssertEqual(exit.signpostBranch, ["99 North"])
    XCTAssertEqual(exit.signpostToward?.first, "Vancouver-YVR International Airport")
    XCTAssertEqual(exit.lanes?.map(\.isValid), [false, false, true])
    XCTAssertEqual(exit.lanes?.last?.activeIndication, .slightRight)
    // Two usable lanes for the left turn onto Bridgeport Road, both preferred.
    let bridgeport = trip.steps[3]
    XCTAssertEqual(bridgeport.roadName, "Bridgeport Road")
    XCTAssertEqual(navOSSCarPlayLaneSpecs(bridgeport.lanes)?.map(\.status), [.preferred, .preferred])
    XCTAssertEqual(navOSSCarPlayLaneSpecs(bridgeport.lanes)?.map(\.highlightedAngle), [-90, -90])
    XCTAssertEqual(navOSSCarPlayLaneSpecs(bridgeport.lanes)?.last?.angles, [0])
  }

  // MARK: Discovery and the v1 fallback

  func testV1OnlyServerFallsBackAndMatchesTheV2SpokenInstructions() async throws {
    let paths = PathLog()
    RoutesURLProtocol.handler = { request in
      paths.append(request.url!.path)
      switch request.url!.path {
      case "/v1/routes": return Self.response(request, try Self.fixture("calgary-deerfoot-glenmore.v1"))
      default: return Self.response(request, Data("{}".utf8), status: 404)
      }
    }
    let client = try makeClient()

    let v1Result = try await client.routes(
      origin: Self.calgaryOrigin, destination: Self.calgaryDestination,
      preferences: NavOSSRoutePreferences(), alternatives: 0
    ).first
    let v1 = try XCTUnwrap(v1Result)
    _ = try await client.routes(
      origin: Self.calgaryOrigin, destination: Self.calgaryDestination,
      preferences: NavOSSRoutePreferences(), alternatives: 0
    )

    XCTAssertEqual(paths.values, ["/v2/config", "/v1/routes", "/v1/routes"])
    XCTAssertTrue(v1.isValid)
    XCTAssertNil(v1.steps[1].lanes)
    XCTAssertNil(v1.steps[1].exitNumber)
    // Both recordings describe the same route. After normalising v1's one-step-early spoken
    // instructions, every maneuver is announced with the same words.
    let v2 = try XCTUnwrap(try Self.trips("calgary-deerfoot-glenmore.v2", version: .v2).first)
    XCTAssertEqual(v1.steps.count, v2.steps.count)
    XCTAssertEqual(v1.steps.dropFirst().map(\.spokenInstruction), v2.steps.dropFirst().map(\.spokenInstruction))
    XCTAssertNil(v1.steps[0].spokenInstruction)
    XCTAssertEqual(v1.speedLimitsKph, v2.speedLimitsKph)
  }

  func testMissingV2RoutesFallsBackWhenConfigWasUnreachable() async throws {
    let paths = PathLog()
    RoutesURLProtocol.handler = { request in
      paths.append(request.url!.path)
      switch request.url!.path {
      case "/v2/config": return Self.response(request, Data("{}".utf8), status: 503)
      case "/v1/routes": return Self.response(request, try Self.fixture("calgary-deerfoot-glenmore.v1"))
      default: return Self.response(request, Data("{}".utf8), status: 404)
      }
    }
    let trips = try await makeClient().routes(
      origin: Self.calgaryOrigin, destination: Self.calgaryDestination,
      preferences: NavOSSRoutePreferences(), alternatives: 0
    )
    XCTAssertEqual(trips.count, 1)
    XCTAssertEqual(paths.values, ["/v2/config", "/v2/routes", "/v1/routes"])
  }

  func testPassThroughWaypointsAreSentAsThroughAndAreNotStops() async throws {
    let bodies = BodyLog()
    RoutesURLProtocol.handler = { request in
      switch request.url!.path {
      case "/v2/config": return Self.response(request, Self.v2Config)
      case "/v2/routes":
        bodies.append(try XCTUnwrap(
          JSONSerialization.jsonObject(with: Self.body(request)) as? [String: Any]))
        return Self.response(request, try Self.fixture("calgary-deerfoot-glenmore-through.v2"))
      default: return Self.response(request, Data("{}".utf8), status: 404)
      }
    }
    let stop = NavOSSCarPlayDestination(
      id: "coffee", label: "", latitude: 50.99, longitude: -114.09, name: "Coffee")
    let tripResult = try await makeClient().routes(
      origin: Self.calgaryOrigin, destination: Self.calgaryDestination,
      preferences: NavOSSRoutePreferences(), alternatives: 0,
      waypoints: [Self.rejoin, stop], passThroughWaypointIds: [Self.rejoin.id]
    ).first
    let trip = try XCTUnwrap(tripResult)

    let waypoints = try XCTUnwrap(bodies.values.first?["waypoints"] as? [[String: Any]])
    XCTAssertEqual(waypoints.first?["type"] as? String, "through")
    XCTAssertNil(waypoints.last?["type"], "an ordinary stop keeps the server's break default")
    XCTAssertEqual(trip.waypoints?.map(\.id), ["coffee"])
  }

  func testPassThroughWaypointOnAV1OnlyServerIsRefusedRatherThanBecomingAStop() async throws {
    let paths = PathLog()
    RoutesURLProtocol.handler = { request in
      paths.append(request.url!.path)
      return Self.response(request, Data("{}".utf8), status: 404)
    }
    do {
      _ = try await makeClient().routes(
        origin: Self.calgaryOrigin, destination: Self.calgaryDestination,
        preferences: NavOSSRoutePreferences(), alternatives: 0,
        waypoints: [Self.rejoin], passThroughWaypointIds: [Self.rejoin.id]
      )
      XCTFail("expected throughWaypointsUnsupported")
    } catch NavOSSNavigationAPIError.throughWaypointsUnsupported {
      XCTAssertFalse(paths.values.contains("/v1/routes"))
    }
  }

  // MARK: Keep-route rejoin without the step-merging workaround

  func testRealThroughResponseHasNoStopAtTheRejoinPoint() throws {
    let through = try XCTUnwrap(try Self.trips("calgary-deerfoot-glenmore-through.v2", version: .v2).first)
    let asStop = try XCTUnwrap(try Self.trips("calgary-deerfoot-glenmore-break.v2", version: .v2).first)
    XCTAssertEqual(through.steps.filter { $0.maneuverType == "arrive" }.count, 1)
    XCTAssertEqual(through.steps.filter { $0.maneuverType == "depart" }.count, 1)
    XCTAssertEqual(asStop.steps.filter { $0.maneuverType == "arrive" }.count, 2, "the contrast case")

    // Drive the whole through route: nothing but the final arrival is ever announced as one.
    let session = NavigationSession()
    try session.start(through)
    let planner = NavigationSpeechPlanner()
    let geometry = through.geometry
    var spoken: [String] = []
    var time = 0.0
    for index in 0..<(geometry.count - 1) {
      let point = geometry[index]
      let next = geometry[index + 1]
      let course = navOSSCarPlayBearingDegrees(from: point, to: next)
      time += 2
      let update = try session.updateLocation(
        NavigationLocationSample(
          coordinate: NavigationCoordinate(latitude: point.latitude, longitude: point.longitude),
          courseDegrees: course, horizontalAccuracyMeters: 5, speedMetersPerSecond: 20,
          timestamp: time))
      if let guidance = update.guidance,
        let prompt = planner.prompt(
          trip: through, guidance: guidance, hasCurrentLocation: true, speedMetersPerSecond: 20,
          isOffRoute: update.snapshot.isOffRoute, now: time)
      {
        spoken.append(prompt.text)
      }
    }
    XCTAssertFalse(spoken.isEmpty)
    XCTAssertTrue(spoken.contains { $0.localizedCaseInsensitiveContains("exit 248 toward Glenmore") })
    // Arrival is only ever announced after the route's last real maneuver.
    let firstArrival = try XCTUnwrap(spoken.firstIndex { $0.localizedCaseInsensitiveContains("arrived") })
    let lastManeuver = try XCTUnwrap(spoken.lastIndex { $0 == "Continue toward 14 Street W South." })
    XCTAssertGreaterThan(firstArrival, lastManeuver, "no arrival before the destination: \(spoken)")
  }

  func testRecoveryUsesTheThroughRouteAndRejectsOneThatStillStops() async throws {
    let through = try XCTUnwrap(try Self.trips("calgary-deerfoot-glenmore-through.v2", version: .v2).first)
    let asStop = try XCTUnwrap(try Self.trips("calgary-deerfoot-glenmore-break.v2", version: .v2).first)
    let plain = try XCTUnwrap(try Self.trips("calgary-deerfoot-glenmore.v2", version: .v2).first)

    var requests: [Set<String>] = []
    let kept = try await navigationFetchRecoveryRoute(rejoin: Self.rejoin, remainingWaypoints: []) {
      _, passThrough in
      requests.append(passThrough)
      return through
    }
    XCTAssertEqual(kept, through)
    XCTAssertEqual(requests, [[Self.rejoin.id]])

    requests = []
    let recovered = try await navigationFetchRecoveryRoute(rejoin: Self.rejoin, remainingWaypoints: []) {
      _, passThrough in
      requests.append(passThrough)
      return passThrough.isEmpty ? plain : asStop
    }
    XCTAssertEqual(recovered, plain, "a rejoin route that stops at the rejoin point is not installed")
    XCTAssertEqual(requests, [[Self.rejoin.id], []])
  }

  // MARK: Tolerant decoding

  func testSpeedLimitStatesAndMalformedOptionalFields() throws {
    let json = """
      {
        "degraded": false,
        "generatedAt": "2026-11-12T00:00:00.000Z",
        "routes": [{
          "congestion": ["slow", "heavy", "teleporting"],
          "distanceMeters": 300,
          "durationSeconds": 30,
          "geometry": [[-114.08, 51.04], [-114.079, 51.04], [-114.078, 51.04], [-114.077, 51.04]],
          "id": "r",
          "label": "fastest",
          "speedLimits": [{"status": "known", "kph": 80}, {"status": "unlimited"}, {"status": "unknown"}],
          "speedLimitsKph": [80, 0, 0],
          "steps": [{
            "distanceMeters": 300, "durationSeconds": 30,
            "geometry": [[-114.08, 51.04], [-114.077, 51.04]],
            "instruction": "Head east", "maneuverType": "depart", "roadName": "",
            "lanes": [{"indications": ["hover"], "valid": true}],
            "exitNumber": "",
            "roundaboutExit": 0,
            "bearingAfterDegrees": 400,
            "signpostToward": ["", "Banff"]
          }]
        }],
        "source": {"attribution": "Routing by Valhalla using OpenStreetMap data",
          "id": "valhalla-self-hosted", "mode": "production", "traffic": "unavailable"}
      }
      """
    let trip = try XCTUnwrap(try Self.trips(data: Data(json.utf8), version: .v2).first)
    XCTAssertEqual(trip.speedLimitsKph, [80, 0, 0], "unknown and unlimited never show a number")
    XCTAssertNil(trip.congestion, "an unrecognised level drops the whole array")
    let step = trip.steps[0]
    XCTAssertNil(step.lanes)
    XCTAssertNil(step.exitNumber)
    XCTAssertNil(step.roundaboutExit)
    XCTAssertNil(step.bearingAfterDegrees)
    XCTAssertEqual(step.signpostToward, ["Banff"])
  }

  func testCommunityCongestionAndTrafficSourceAreKept() throws {
    let json = """
      {
        "degraded": false,
        "generatedAt": "2026-11-12T00:00:00.000Z",
        "routes": [{
          "congestion": ["unknown", "slow"],
          "distanceMeters": 200, "durationSeconds": 40,
          "geometry": [[-114.08, 51.04], [-114.079, 51.04], [-114.078, 51.04]],
          "id": "r", "label": "fastest",
          "steps": [{"distanceMeters": 200, "durationSeconds": 40,
            "geometry": [[-114.08, 51.04], [-114.078, 51.04]],
            "instruction": "Head east", "maneuverType": "depart", "roadName": ""}],
          "traffic": {"delaySeconds": 10, "typicalDurationSeconds": 30, "observedFraction": 0.5}
        }, {
          "distanceMeters": 250, "durationSeconds": 30,
          "geometry": [[-114.08, 51.04], [-114.078, 51.041]],
          "id": "unobserved", "label": "alternative",
          "steps": [{"distanceMeters": 250, "durationSeconds": 30,
            "geometry": [[-114.08, 51.04], [-114.078, 51.041]],
            "instruction": "Head east", "maneuverType": "depart", "roadName": ""}]
        }],
        "source": {"attribution": "Routing by Valhalla using OpenStreetMap data",
          "id": "valhalla-self-hosted", "mode": "production", "traffic": "live",
          "trafficSource": {"id": "navoss-community",
            "attribution": "Traffic from opted-in NavOSS drivers"}}
      }
      """
    let trips = try Self.trips(data: Data(json.utf8), version: .v2)
    XCTAssertEqual(trips[0].congestion, [.unknown, .slow])
    XCTAssertEqual(trips[0].trafficSource, "navoss-community")
    XCTAssertEqual(trips[0].traffic, NavOSSCarPlayTraffic(delaySeconds: 10, typicalDurationSeconds: 30))
    XCTAssertNil(trips[1].congestion)
    XCTAssertNil(trips[1].trafficSource, "an unobserved alternative claims no traffic")
    XCTAssertEqual(navOSSCarPlayTrafficAttribution(trips[0]), "Traffic: NavOSS drivers")
    XCTAssertNil(navOSSCarPlayTrafficAttribution(trips[1]))
  }

  // MARK: Spoken signposts

  func testPromptsUseSignedExitAndDestinationsOnlyWhenTheRouteHasThem() {
    func step(
      _ type: String, instruction: String, spoken: String? = nil, modifier: String? = nil,
      exit: String? = nil, branch: [String]? = nil, toward: [String]? = nil
    ) -> NavOSSCarPlayRouteStep {
      NavOSSCarPlayRouteStep(
        distanceMeters: 100, durationSeconds: 10,
        geometry: [Self.calgaryOrigin, Self.calgaryDestinationCoordinate], instruction: instruction,
        maneuverType: type, roadName: "", spokenInstruction: spoken, maneuverModifier: modifier,
        exitNumber: exit, signpostBranch: branch, signpostToward: toward)
    }
    let prompt = NavigationSpeechPlanner.maneuverPrompt
    // Generic provider wording is replaced by what the signs say.
    XCTAssertEqual(
      prompt(step("off ramp", instruction: "Take the ramp on the right.", modifier: "slight right",
        exit: "248", toward: ["Banff"])),
      "Take exit 248 toward Banff.")
    XCTAssertEqual(
      prompt(step("fork", instruction: "Keep right.", modifier: "slight right", exit: "248B",
        toward: ["Glenmore Trail West", "Airport", "Downtown"])),
      "Keep right for exit 248B toward Glenmore Trail West and Airport.")
    XCTAssertEqual(
      prompt(step("on ramp", instruction: "Take the ramp on the left.", modifier: "slight left",
        branch: ["2 South"], toward: ["Fort Macleod"])),
      "Take the ramp on the left onto 2 South toward Fort Macleod.")
    XCTAssertEqual(
      prompt(step("turn", instruction: "Turn right onto 16 Avenue NE.", toward: ["Banff"])),
      "Turn right onto 16 Avenue northeast toward Banff.")
    // Provider text that already states them is kept as written.
    XCTAssertEqual(
      prompt(step("off ramp", instruction: "Take exit 248 toward Glenmore Trail.",
        spoken: "Take exit 248 toward Glenmore Trail.", exit: "248", toward: ["Glenmore Trail"])),
      "Take exit 248 toward Glenmore Trail.")
    // Nothing known, nothing added.
    XCTAssertEqual(
      prompt(step("off ramp", instruction: "Take the ramp on the right.")),
      "Take the ramp on the right.")
  }

  func testHighwayPromptOnTheRealCalgaryRouteNamesTheExit() throws {
    let trip = try XCTUnwrap(try Self.trips("calgary-deerfoot-glenmore.v2", version: .v2).first)
    let planner = NavigationSpeechPlanner()
    let prompt = planner.prompt(
      trip: trip,
      guidance: NavOSSCarPlayGuidance(
        distanceToManeuverMeters: 1_500, durationToManeuverSeconds: 54, instruction: "",
        maneuverType: "off ramp", phase: .navigating, remainingDistanceMeters: 8_000,
        remainingDurationSeconds: 400, roadName: "", stepIndex: 0),
      hasCurrentLocation: true, speedMetersPerSecond: 28, now: 0)
    XCTAssertEqual(prompt?.text, "In 1.5 kilometres, take exit 248 toward Glenmore Trail.")
  }

  // MARK: Helpers

  private static let calgaryOrigin = NavOSSCarPlayCoordinate(latitude: 51.01428, longitude: -114.005743)
  private static let calgaryDestination = NavOSSCarPlayDestination(
    id: "destination", label: "14 Street SW", latitude: 50.9881, longitude: -114.094978,
    name: "14 Street SW")
  private static let calgaryDestinationCoordinate = NavOSSCarPlayCoordinate(
    latitude: 50.9881, longitude: -114.094978)
  private static let rejoin = NavOSSCarPlayDestination(
    id: "navoss-route-rejoin", label: "", latitude: 50.99449, longitude: -114.047507,
    name: "Selected route")
  private static let v2Config = Data(
    #"{"apiVersion":"v2","endpoints":{"cameras":"/v1/cameras","events":"/v1/events","routes":"/v2/routes","search":"/v1/search"}}"#
      .utf8)

  private func makeClient() throws -> NavOSSNavigationAPIClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [RoutesURLProtocol.self]
    return try NavOSSNavigationAPIClient(
      baseURL: Self.baseURL,
      session: URLSession(configuration: configuration),
      routesDiscovery: NavOSSRoutesEndpointDiscovery()
    )
  }

  /// The recorded response body of a fixture.
  static func fixture(_ name: String) throws -> Data {
    let document = try JSONSerialization.jsonObject(
      with: Data(contentsOf: fixtures.appendingPathComponent("\(name).json"))) as? [String: Any]
    return try JSONSerialization.data(withJSONObject: try XCTUnwrap(document?["response"]))
  }

  static func trips(_ name: String, version: NavigationRoutesAPIVersion) throws -> [NavOSSCarPlayTrip] {
    try trips(data: fixture(name), version: version)
  }

  private static func trips(data: Data, version: NavigationRoutesAPIVersion) throws -> [NavOSSCarPlayTrip] {
    try navigationTrips(
      from: JSONDecoder().decode(NavigationRouteResponseWire.self, from: data),
      version: version, destination: calgaryDestination, preferences: NavOSSRoutePreferences(),
      waypoints: [])
  }

  private static func response(
    _ request: URLRequest, _ data: Data, status: Int = 200
  ) -> (HTTPURLResponse, Data) {
    (
      HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: nil,
        headerFields: ["content-type": "application/json"])!,
      data
    )
  }

  private static func body(_ request: URLRequest) throws -> Data {
    if let body = request.httpBody { return body }
    let stream = try XCTUnwrap(request.httpBodyStream)
    stream.open()
    defer { stream.close() }
    var body = Data()
    var buffer = [UInt8](repeating: 0, count: 4_096)
    while stream.hasBytesAvailable {
      let count = stream.read(&buffer, maxLength: buffer.count)
      if count <= 0 { break }
      body.append(buffer, count: count)
    }
    return body
  }
}

private final class PathLog: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: [String] = []
  func append(_ value: String) {
    lock.lock()
    storage.append(value)
    lock.unlock()
  }
  var values: [String] {
    lock.lock()
    defer { lock.unlock() }
    return storage
  }
}

private final class BodyLog: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: [[String: Any]] = []
  func append(_ value: [String: Any]) {
    lock.lock()
    storage.append(value)
    lock.unlock()
  }
  var values: [[String: Any]] {
    lock.lock()
    defer { lock.unlock() }
    return storage
  }
}

private final class RoutesURLProtocol: URLProtocol {
  static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    do {
      let (response, data) = try Self.handler!(request)
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch {
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  override func stopLoading() {}
}
