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
      "14 Street W South",
      "the card shows the sign, not the provider's sentence, within two card lines"
    )
  }

  func testV2RecommendationOrderIsKeptAndFastestFollowsDuration() async throws {
    RoutesURLProtocol.handler = { request in
      switch request.url!.path {
      case "/v2/config": return Self.response(request, Self.v2Config)
      case "/v2/routes":
        return Self.response(request, try Self.fixture("community-protected-order.v2"))
      default: return Self.response(request, Data("{}".utf8), status: 404)
      }
    }
    let trips = try await makeClient().routes(
      origin: Self.calgaryOrigin, destination: Self.calgaryDestination,
      preferences: NavOSSRoutePreferences(), alternatives: 1
    )
    // The server kept the recommended route ahead of a faster, unobserved minor-road route.
    XCTAssertEqual(trips.map(\.id), ["recommended", "unobserved-minor"])
    // CarPlay names the faster one "Fastest route", by duration, not the first one.
    XCTAssertEqual(navOSSCarPlayFastestRouteIndex(trips), 1)
    XCTAssertNotNil(navOSSCarPlayTrafficAttribution(trips[0]))
    XCTAssertNil(navOSSCarPlayTrafficAttribution(trips[1]))
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

  // MARK: No road route

  /// The 422 the API returned for Toronto City Hall to Centre Island (no car ferry), recorded
  /// from the API with Valhalla's recorded 442 answer (`no-road-route-422.json`).
  private static func noRoadRoute() throws -> (status: Int, body: Data) {
    let document = try XCTUnwrap(
      JSONSerialization.jsonObject(
        with: Data(contentsOf: fixtures.appendingPathComponent("no-road-route-422.json")))
        as? [String: Any])
    return (
      try XCTUnwrap(document["status"] as? Int),
      Data(try XCTUnwrap(document["body"] as? String).utf8)
    )
  }

  func testNoRoadRouteCarriesTheServersWordsInsteadOfServiceUnavailable() async throws {
    let recorded = try Self.noRoadRoute()
    XCTAssertEqual(recorded.status, 422)
    let paths = PathLog()
    RoutesURLProtocol.handler = { request in
      paths.append(request.url!.path)
      switch request.url!.path {
      case "/v2/config": return Self.response(request, Self.v2Config)
      case "/v2/routes": return Self.response(request, recorded.body, status: recorded.status)
      default: return Self.response(request, Data("{}".utf8), status: 404)
      }
    }
    do {
      _ = try await makeClient().routes(
        origin: NavOSSCarPlayCoordinate(latitude: 43.6525, longitude: -79.3832),
        destination: NavOSSCarPlayDestination(
          id: "centre-island", label: "Toronto Islands", latitude: 43.6205, longitude: -79.3787,
          name: "Centre Island"),
        preferences: NavOSSRoutePreferences(), alternatives: 0, requireCoverage: false)
      XCTFail("expected routeNotFound")
    } catch NavOSSNavigationAPIError.routeNotFound(let problem) {
      XCTAssertEqual(problem.title, "No road route")
      XCTAssertEqual(
        problem.detailVariants,
        [
          "No road connects these places. Some are reached only by air, by water or by a winter road.",
          "No road connects these places.",
        ])
      // Neither retried as a malformed request nor sent to /v1/routes.
      XCTAssertEqual(paths.values.filter { $0 == "/v2/routes" }.count, 1)
      XCTAssertFalse(paths.values.contains("/v1/routes"))
    }
  }

  func testA422WithoutTheShippedProblemShapeStaysServiceUnavailable() async throws {
    RoutesURLProtocol.handler = { request in
      switch request.url!.path {
      case "/v2/config": return Self.response(request, Self.v2Config)
      case "/v2/routes": return Self.response(request, Data(#"{"title":""}"#.utf8), status: 422)
      default: return Self.response(request, Data("{}".utf8), status: 404)
      }
    }
    do {
      _ = try await makeClient().routes(
        origin: Self.calgaryOrigin, destination: Self.calgaryDestination,
        preferences: NavOSSRoutePreferences(), alternatives: 0, requireCoverage: false)
      XCTFail("expected serviceUnavailable")
    } catch NavOSSNavigationAPIError.serviceUnavailable {}
  }

  // MARK: No route between these provinces

  /// The 400 the API returned for Montreal to Iqaluit with all of Canada declared
  /// (`disconnected-provinces-400.json`).
  private static func disconnectedProvinces() throws -> (status: Int, body: Data) {
    let document = try XCTUnwrap(
      JSONSerialization.jsonObject(
        with: Data(contentsOf: fixtures.appendingPathComponent("disconnected-provinces-400.json")))
        as? [String: Any])
    return (
      try XCTUnwrap(document["status"] as? Int),
      Data(try XCTUnwrap(document["body"] as? String).utf8)
    )
  }

  func testA400RefusalCarriesTheServersWordsInsteadOfServiceUnavailable() async throws {
    let recorded = try Self.disconnectedProvinces()
    XCTAssertEqual(recorded.status, 400)
    let paths = PathLog()
    RoutesURLProtocol.handler = { request in
      paths.append(request.url!.path)
      switch request.url!.path {
      case "/v2/config": return Self.response(request, Self.v2Config)
      case "/v2/routes": return Self.response(request, recorded.body, status: recorded.status)
      default: return Self.response(request, Data("{}".utf8), status: 404)
      }
    }
    do {
      _ = try await makeClient().routes(
        origin: NavOSSCarPlayCoordinate(latitude: 45.5019, longitude: -73.5674),
        originHeadingDegrees: 90, originHorizontalAccuracyMeters: 10,
        destination: NavOSSCarPlayDestination(
          id: "iqaluit", label: "Iqaluit", latitude: 63.7467, longitude: -68.517, name: "Iqaluit"),
        preferences: NavOSSRoutePreferences(), alternatives: 0, requireCoverage: false)
      XCTFail("expected routeRefused")
    } catch let error as NavOSSNavigationAPIError {
      guard case .routeRefused(let problem) = error else {
        return XCTFail("expected routeRefused, got \(error)")
      }
      XCTAssertEqual(problem.title, "No route between these provinces")
      XCTAssertEqual(
        problem.detailVariants,
        ["NavOSS can't plan a drive between Quebec and Nunavut: no road it covers connects them."])
      XCTAssertEqual(error.serverProblem, problem)
      // A refusal is the server's answer about the route, not about the optional origin fields:
      // sent once, never retried without them and never sent to v1.
      XCTAssertEqual(paths.values.filter { $0 == "/v2/routes" }.count, 1)
      XCTAssertFalse(paths.values.contains("/v1/routes"))
    }
  }

  private static let contractRejection = Data(
    #"{"code":"invalid_request","detail":"The request does not match the API contract.","requestId":"req-1","status":400,"title":"Invalid request"}"#
      .utf8)

  func testV2DeclaresCityTrafficAndTheDeployedRejectionCostsOneRetryKeepingTheOrigin() async throws {
    // The deployed API rejects `trafficSources` with its contract 400. The route still comes
    // back after exactly one more request, which keeps the origin heading and accuracy.
    let bodies = BodyLog()
    RoutesURLProtocol.handler = { request in
      switch request.url!.path {
      case "/v2/config": return Self.response(request, Self.v2Config)
      case "/v2/routes":
        let body = try XCTUnwrap(
          JSONSerialization.jsonObject(with: Self.body(request)) as? [String: Any])
        bodies.append(body)
        return body["trafficSources"] == nil
          ? Self.response(request, try Self.fixture("calgary-deerfoot-glenmore.v2"))
          : Self.response(request, Self.contractRejection, status: 400)
      default: return Self.response(request, Data("{}".utf8), status: 404)
      }
    }
    let trips = try await makeClient().routes(
      origin: Self.calgaryOrigin, originHeadingDegrees: 90, originHorizontalAccuracyMeters: 10,
      destination: Self.calgaryDestination,
      preferences: NavOSSRoutePreferences(), alternatives: 0, requireCoverage: false)

    XCTAssertFalse(trips.isEmpty)
    XCTAssertNil(trips[0].trafficSource)
    XCTAssertNil(navOSSCarPlayTrafficAttribution(trips[0]))
    XCTAssertEqual(bodies.values.count, 2)
    XCTAssertEqual(bodies.values.first?["trafficSources"] as? [String], ["calgary-travel-times"])
    XCTAssertEqual(bodies.values.first?["originHeadingDegrees"] as? Double, 90)
    XCTAssertNil(bodies.values.last?["trafficSources"])
    XCTAssertEqual(bodies.values.last?["originHeadingDegrees"] as? Double, 90)
    XCTAssertEqual(bodies.values.last?["originHorizontalAccuracyMeters"] as? Double, 10)
  }

  func testAContractRejectionIsSentOnlyOnceMoreAndNeverShown() async throws {
    let bodies = BodyLog()
    RoutesURLProtocol.handler = { request in
      switch request.url!.path {
      case "/v2/config": return Self.response(request, Self.v2Config)
      case "/v2/routes":
        bodies.append(try XCTUnwrap(
          JSONSerialization.jsonObject(with: Self.body(request)) as? [String: Any]))
        return Self.response(request, Self.contractRejection, status: 400)
      default: return Self.response(request, Data("{}".utf8), status: 404)
      }
    }
    do {
      _ = try await makeClient().routes(
        origin: Self.calgaryOrigin, originHeadingDegrees: 90, originHorizontalAccuracyMeters: 10,
        destination: Self.calgaryDestination,
        preferences: NavOSSRoutePreferences(), alternatives: 0, requireCoverage: false)
      XCTFail("expected invalidRequest")
    } catch let error as NavOSSNavigationAPIError {
      // Not a reason to show the driver, and never more than one extra round trip.
      guard case .invalidRequest = error else { return XCTFail("got \(error)") }
      XCTAssertNil(error.serverProblem)
      XCTAssertEqual(bodies.values.count, 2)
    }
  }

  private func makeClient(discovery: NavOSSRoutesEndpointDiscovery) throws
    -> NavOSSNavigationAPIClient
  {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [RoutesURLProtocol.self]
    return try NavOSSNavigationAPIClient(
      baseURL: Self.baseURL, session: URLSession(configuration: configuration),
      routesDiscovery: discovery)
  }

  private func routeOnce(_ client: NavOSSNavigationAPIClient) async throws {
    _ = try await client.routes(
      origin: Self.calgaryOrigin, originHeadingDegrees: 90, originHorizontalAccuracyMeters: 10,
      destination: Self.calgaryDestination,
      preferences: NavOSSRoutePreferences(), alternatives: 0, requireCoverage: false)
  }

  func testARejectedDeclarationIsNotSentAgainUntilTheConfigIsFetchedAgain() async throws {
    let bodies = BodyLog()
    RoutesURLProtocol.handler = { request in
      switch request.url!.path {
      case "/v2/config": return Self.response(request, Self.v2Config)
      case "/v2/routes":
        let body = try XCTUnwrap(
          JSONSerialization.jsonObject(with: Self.body(request)) as? [String: Any])
        bodies.append(body)
        return body["trafficSources"] == nil
          ? Self.response(request, try Self.fixture("calgary-deerfoot-glenmore.v2"))
          : Self.response(request, Self.contractRejection, status: 400)
      default: return Self.response(request, Data("{}".utf8), status: 404)
      }
    }
    var now = Date(timeIntervalSince1970: 1_800_000_000)
    let discovery = NavOSSRoutesEndpointDiscovery(timeToLive: 3_600, clock: { now })
    let client = try makeClient(discovery: discovery)

    try await routeOnce(client)
    XCTAssertEqual(bodies.values.count, 2)
    try await routeOnce(client)
    XCTAssertEqual(bodies.values.count, 3, "the second request goes out once")
    XCTAssertNil(bodies.values[2]["trafficSources"])
    XCTAssertEqual(bodies.values[2]["originHeadingDegrees"] as? Double, 90)

    // An hour later the config is fetched again, and the declaration with it.
    now = now.addingTimeInterval(3_601)
    try await routeOnce(client)
    XCTAssertEqual(
      bodies.values[3]["trafficSources"] as? [String], ["calgary-travel-times"])

    // A new process (a new discovery cache) declares again.
    try await routeOnce(try makeClient(discovery: NavOSSRoutesEndpointDiscovery()))
    XCTAssertEqual(
      bodies.values[bodies.values.count - 2]["trafficSources"] as? [String],
      ["calgary-travel-times"])
  }

  func testADeclarationIsRememberedOnlyWhenTheRequestWithoutItIsAnswered() async throws {
    let bodies = BodyLog()
    RoutesURLProtocol.handler = { request in
      switch request.url!.path {
      case "/v2/config": return Self.response(request, Self.v2Config)
      case "/v2/routes":
        bodies.append(try XCTUnwrap(
          JSONSerialization.jsonObject(with: Self.body(request)) as? [String: Any]))
        return Self.response(request, Self.contractRejection, status: 400)
      default: return Self.response(request, Data("{}".utf8), status: 404)
      }
    }
    let client = try makeClient(discovery: NavOSSRoutesEndpointDiscovery())
    for _ in 0..<2 {
      do {
        try await routeOnce(client)
        XCTFail("expected invalidRequest")
      } catch NavOSSNavigationAPIError.invalidRequest {}
    }
    XCTAssertEqual(bodies.values.count, 4)
    XCTAssertEqual(
      bodies.values[2]["trafficSources"] as? [String], ["calgary-travel-times"])
  }

  /// A server being upgraded while request A, whose declaration it rejected, waits for the
  /// answer to its retry. Returns every `/v2/routes` body the server received, in order.
  private func upgradeRace(
    _ race: (
      _ server: DeclarationServer, _ client: NavOSSNavigationAPIClient, _ clock: TestClock
    ) async throws -> Void
  ) async throws -> [[String: Any]] {
    let server = DeclarationServer(
      config: Self.v2Config, rejection: Self.contractRejection,
      routes: try Self.fixture("calgary-deerfoot-glenmore.v2"))
    let clock = TestClock(Date(timeIntervalSince1970: 1_800_000_000))
    let discovery = NavOSSRoutesEndpointDiscovery(timeToLive: 3_600, clock: { clock.now })
    let client = try NavOSSNavigationAPIClient(
      baseURL: Self.baseURL, transport: server.transport, routesDiscovery: discovery,
      offlineFallback: nil)
    try await race(server, client, clock)
    return server.bodies.values
  }

  func testALateRejectionDoesNotOutliveAnUpgradeAnotherRequestFoundAndDeclaredTo() async throws {
    let bodies = try await upgradeRace { server, client, clock in
      server.holdNextUndeclared()
      let a = Task { try await self.routeOnce(client) }
      await server.undeclaredArrived.wait()
      // The server is upgraded; the config expires and B fetches it again, then declares.
      server.declared = .accepts
      clock.advance(by: 3_601)
      try await self.routeOnce(client)
      server.undeclaredRelease.open()
      try await a.value
      try await self.routeOnce(client)
    }
    XCTAssertEqual(
      bodies.map { $0["trafficSources"] != nil }, [true, false, true, true],
      "A declared, A's retry, B declared, the next request declares")
  }

  func testALateRejectionIsIgnoredAfterTheConfigWasFetchedAgain() async throws {
    let bodies = try await upgradeRace { server, client, clock in
      server.holdNextUndeclared()
      let a = Task { try await self.routeOnce(client) }
      await server.undeclaredArrived.wait()
      // B fetches the expired config again, and its route request does not get through.
      server.declared = .unavailable
      clock.advance(by: 3_601)
      do {
        try await self.routeOnce(client)
        XCTFail("expected B to fail")
      } catch {}
      server.undeclaredRelease.open()
      try await a.value
      server.declared = .accepts
      try await self.routeOnce(client)
    }
    XCTAssertEqual(bodies.map { $0["trafficSources"] != nil }, [true, false, true, true])
  }

  func testALateRejectionIsIgnoredAfterADeclaredRequestWasAnswered() async throws {
    let bodies = try await upgradeRace { server, client, _ in
      server.holdNextUndeclared()
      let a = Task { try await self.routeOnce(client) }
      await server.undeclaredArrived.wait()
      server.declared = .accepts
      try await self.routeOnce(client)
      server.undeclaredRelease.open()
      try await a.value
      try await self.routeOnce(client)
    }
    XCTAssertEqual(bodies.map { $0["trafficSources"] != nil }, [true, false, true, true])
  }

  func testAnAnsweredDeclaredRequestClearsARejectionRecordedWhileItWasInFlight() async throws {
    let bodies = try await upgradeRace { server, client, _ in
      server.holdNextUndeclared()
      let a = Task { try await self.routeOnce(client) }
      await server.undeclaredArrived.wait()
      server.declared = .accepts
      server.holdNextDeclared()
      let b = Task { try await self.routeOnce(client) }
      await server.declaredArrived.wait()
      // A's retry is answered first and records the rejection; B's answer then proves support.
      server.undeclaredRelease.open()
      try await a.value
      server.declaredRelease.open()
      try await b.value
      try await self.routeOnce(client)
    }
    XCTAssertEqual(bodies.map { $0["trafficSources"] != nil }, [true, false, true, true])
  }

  func testTheWholeLadderToAnOldV1OnlyAPITakesFourRequestsAtMost() async throws {
    let posts = BodyLog()
    RoutesURLProtocol.handler = { request in
      let path = request.url!.path
      guard path == "/v2/routes" || path == "/v1/routes" else {
        return Self.response(request, Data("{}".utf8), status: 503)
      }
      var body = try XCTUnwrap(
        JSONSerialization.jsonObject(with: Self.body(request)) as? [String: Any])
      body["path"] = path
      posts.append(body)
      if path == "/v2/routes" {
        return body["trafficSources"] == nil
          ? Self.response(request, Data("{}".utf8), status: 404)
          : Self.response(request, Self.contractRejection, status: 400)
      }
      return body["originHeadingDegrees"] == nil
        ? Self.response(request, try Self.fixture("calgary-deerfoot-glenmore.v1"))
        : Self.response(request, Self.contractRejection, status: 400)
    }
    try await routeOnce(try makeClient(discovery: NavOSSRoutesEndpointDiscovery()))
    XCTAssertEqual(
      posts.values.map {
        "\($0["path"] as? String ?? "") \($0["trafficSources"] != nil) \($0["originHeadingDegrees"] != nil)"
      },
      [
        "/v2/routes true true", "/v2/routes false true",
        "/v1/routes false true", "/v1/routes false false",
      ])
  }

  func testAV1ServerThatRejectsOriginMetadataIsRetriedOnceWithoutIt() async throws {
    // An API older than origin heading and accuracy has only /v1/routes, which is never sent the
    // traffic declaration.
    let bodies = BodyLog()
    RoutesURLProtocol.handler = { request in
      switch request.url!.path {
      case "/v1/routes":
        let body = try XCTUnwrap(
          JSONSerialization.jsonObject(with: Self.body(request)) as? [String: Any])
        bodies.append(body)
        return body["originHeadingDegrees"] == nil
          ? Self.response(request, try Self.fixture("calgary-deerfoot-glenmore.v1"))
          : Self.response(request, Self.contractRejection, status: 400)
      default: return Self.response(request, Data("{}".utf8), status: 404)
      }
    }
    let trips = try await makeClient().routes(
      origin: Self.calgaryOrigin, originHeadingDegrees: 90, originHorizontalAccuracyMeters: 10,
      destination: Self.calgaryDestination,
      preferences: NavOSSRoutePreferences(), alternatives: 0, requireCoverage: false)

    XCTAssertFalse(trips.isEmpty)
    XCTAssertEqual(bodies.values.count, 2)
    XCTAssertTrue(bodies.values.allSatisfy { $0["trafficSources"] == nil })
    XCTAssertEqual(bodies.values.first?["originHeadingDegrees"] as? Double, 90)
    XCTAssertNil(bodies.values.last?["originHeadingDegrees"])
    XCTAssertNil(bodies.values.last?["originHorizontalAccuracyMeters"])
  }

  func testA400WithoutTheProblemShapeStaysInvalidRequest() async throws {
    RoutesURLProtocol.handler = { request in
      switch request.url!.path {
      case "/v2/config": return Self.response(request, Self.v2Config)
      case "/v2/routes": return Self.response(request, Data("bad".utf8), status: 400)
      default: return Self.response(request, Data("{}".utf8), status: 404)
      }
    }
    do {
      _ = try await makeClient().routes(
        origin: Self.calgaryOrigin, destination: Self.calgaryDestination,
        preferences: NavOSSRoutePreferences(), alternatives: 0, requireCoverage: false)
      XCTFail("expected invalidRequest")
    } catch let error as NavOSSNavigationAPIError {
      guard case .invalidRequest = error else { return XCTFail("got \(error)") }
      XCTAssertNil(error.serverProblem)
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

  func testCommunityTrafficFreshnessIsTheOldestReleaseBoundaryAndIsOptional() throws {
    func trip(_ traffic: String) throws -> NavOSSCarPlayTrip {
      let json = """
        {
          "degraded": false,
          "generatedAt": "2026-11-12T18:07:31.250Z",
          "routes": [{
            "congestion": ["unknown", "slow"],
            "distanceMeters": 200, "durationSeconds": 40,
            "geometry": [[-114.08, 51.04], [-114.079, 51.04], [-114.078, 51.04]],
            "id": "r", "label": "fastest",
            "steps": [{"distanceMeters": 200, "durationSeconds": 40,
              "geometry": [[-114.08, 51.04], [-114.078, 51.04]],
              "instruction": "Head east", "maneuverType": "depart", "roadName": ""}],
            "traffic": \(traffic)
          }],
          "source": {"attribution": "Routing by Valhalla using OpenStreetMap data",
            "id": "valhalla-self-hosted", "mode": "production", "traffic": "live",
            "trafficSource": {"id": "navoss-community",
              "attribution": "Traffic from opted-in NavOSS drivers"}}
        }
        """
      return try XCTUnwrap(Self.trips(data: Data(json.utf8), version: .v2).first)
    }
    let fresh = try trip(
      """
      {"delaySeconds": 10, "typicalDurationSeconds": 30, "observedFraction": 0.5,
        "oldestObservedAt": "2026-11-12T18:00:00.000Z", "snapshotAt": "2026-11-12T18:05:00Z"}
      """)
    XCTAssertEqual(fresh.traffic?.oldestObservedAt, navOSSTrafficBoundary("2026-11-12T18:00:00Z"))
    let utc = try XCTUnwrap(TimeZone(identifier: "UTC"))
    let attribution = try XCTUnwrap(
      navOSSCarPlayTrafficAttribution(fresh, locale: Locale(identifier: "en_CA"), timeZone: utc))
    XCTAssertTrue(attribution.hasPrefix("Traffic: NavOSS drivers · updated 6:00"), attribution)
    XCTAssertFalse(attribution.contains("6:05") || attribution.contains("6:07"), attribution)
    // An older server, or an unreadable boundary: the route keeps its traffic, without a time.
    for traffic in [
      #"{"delaySeconds": 10, "typicalDurationSeconds": 30}"#,
      #"{"delaySeconds": 10, "typicalDurationSeconds": 30, "oldestObservedAt": 7}"#,
    ] {
      let older = try trip(traffic)
      XCTAssertEqual(older.traffic?.delaySeconds, 10)
      XCTAssertNil(older.traffic?.oldestObservedAt)
      XCTAssertEqual(navOSSCarPlayTrafficAttribution(older), "Traffic: NavOSS drivers")
    }
  }

  /// A two-route `/v2/routes` body in the shape the contract gives City of Calgary traffic
  /// (`packages/contracts/test/route-calgary-travel-times.test.ts`), with `trafficSource` as given.
  private static func sourcedTrafficResponse(trafficSource: String) -> Data {
    Data(
      """
      {
        "degraded": false,
        "generatedAt": "2026-11-27T16:00:00.000Z",
        "routes": [{
          "congestion": ["heavy", "unknown"],
          "distanceMeters": 200, "durationSeconds": 220,
          "geometry": [[-114.08, 51.04], [-114.079, 51.04], [-114.078, 51.04]],
          "id": "deerfoot", "label": "alternative",
          "steps": [{"distanceMeters": 200, "durationSeconds": 220,
            "geometry": [[-114.08, 51.04], [-114.078, 51.04]],
            "instruction": "Head east", "maneuverType": "depart", "roadName": "Deerfoot Trail"}],
          "traffic": {"delaySeconds": 180, "typicalDurationSeconds": 40, "observedFraction": 0.5,
            "oldestObservedAt": "2026-11-27T15:43:43.000Z",
            "snapshotAt": "2026-11-27T15:43:43.000Z"}
        }, {
          "distanceMeters": 250, "durationSeconds": 60,
          "geometry": [[-114.08, 51.04], [-114.078, 51.041]],
          "id": "local", "label": "fastest",
          "steps": [{"distanceMeters": 250, "durationSeconds": 60,
            "geometry": [[-114.08, 51.04], [-114.078, 51.041]],
            "instruction": "Head east", "maneuverType": "depart", "roadName": ""}]
        }],
        "source": {"attribution": "Routing by Valhalla using OpenStreetMap data",
          "id": "valhalla-self-hosted", "mode": "production", "traffic": "live",
          "trafficSource": \(trafficSource)}
      }
      """.utf8)
  }

  private static let cityTrafficSource =
    #"{"id": "calgary-travel-times", "attribution": "Traffic on main roads from The City of Calgary"}"#

  func testCityOfCalgaryTrafficIsKeptAndCreditedAsMainRoadsOnly() throws {
    let trips = try Self.trips(
      data: Self.sourcedTrafficResponse(trafficSource: Self.cityTrafficSource), version: .v2)
    XCTAssertEqual(trips[0].trafficSource, "calgary-travel-times")
    XCTAssertEqual(trips[0].congestion, [.heavy, .unknown])
    XCTAssertEqual(trips[0].durationSeconds, 220)
    XCTAssertEqual(
      trips[0].traffic,
      NavOSSCarPlayTraffic(
        delaySeconds: 180, typicalDurationSeconds: 40,
        oldestObservedAt: navOSSTrafficBoundary("2026-11-27T15:43:43Z")))
    XCTAssertNil(trips[1].trafficSource, "a route the City does not measure claims no traffic")
    XCTAssertNil(navOSSCarPlayTrafficAttribution(trips[1]))
    let utc = try XCTUnwrap(TimeZone(identifier: "UTC"))
    let credit = try XCTUnwrap(
      navOSSCarPlayTrafficAttribution(trips[0], locale: Locale(identifier: "en_CA"), timeZone: utc))
    XCTAssertTrue(
      credit.hasPrefix("Traffic: City of Calgary, main roads · updated 3:43"), credit)
    XCTAssertFalse(credit.localizedCaseInsensitiveContains("live"), credit)
  }

  func testCityTrafficIsCreditedFromCongestionAndDelayNotTheRoundedFraction() throws {
    // 100 m measured on a 40 km route arrives as observedFraction 0.
    let rounded = String(
      decoding: Self.sourcedTrafficResponse(trafficSource: Self.cityTrafficSource), as: UTF8.self
    ).replacingOccurrences(of: #""observedFraction": 0.5"#, with: #""observedFraction": 0"#)
    let trip = try XCTUnwrap(Self.trips(data: Data(rounded.utf8), version: .v2).first)
    XCTAssertNotNil(navOSSCarPlayTrafficAttribution(trip))
    let suite = "NavOSSCityTrafficRounded.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    NavOSSActiveTripStore(defaults: defaults).save(trip)
    let restored = try XCTUnwrap(NavOSSActiveTripStore(defaults: defaults).load())
    XCTAssertNotNil(navOSSCarPlayTrafficAttribution(restored))

    let unmeasured = NavOSSCarPlayTrip(
      destination: trip.destination, distanceMeters: trip.distanceMeters,
      durationSeconds: 40, geometry: trip.geometry, id: trip.id, source: trip.source,
      steps: trip.steps,
      traffic: NavOSSCarPlayTraffic(delaySeconds: 0, typicalDurationSeconds: 40),
      congestion: [.unknown, .unknown], trafficSource: navOSSCalgaryTravelTimesTrafficSource)
    XCTAssertNil(navOSSCarPlayTrafficAttribution(unmeasured))
  }

  func testTrafficFromAnUnknownSourceIsDroppedNotCreditedToAnother() throws {
    let trips = try Self.trips(
      data: Self.sourcedTrafficResponse(
        trafficSource: #"{"id": "someone-else", "attribution": "Traffic from someone else"}"#),
      version: .v2)
    XCTAssertEqual(trips.map(\.id), ["deerfoot", "local"], "the routes themselves stay")
    for trip in trips {
      XCTAssertNil(trip.trafficSource)
      XCTAssertNil(trip.traffic)
      XCTAssertNil(trip.congestion)
      XCTAssertNil(navOSSCarPlayTrafficAttribution(trip))
    }
  }

  func testARestoredTripKeepsItsCityOfCalgaryTraffic() throws {
    let trip = try XCTUnwrap(
      Self.trips(
        data: Self.sourcedTrafficResponse(trafficSource: Self.cityTrafficSource), version: .v2
      ).first)
    let suite = "NavOSSCityTrafficRestore.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    NavOSSActiveTripStore(defaults: defaults).save(trip)

    // A relaunch reads the trip with a new store.
    let restored = try XCTUnwrap(NavOSSActiveTripStore(defaults: defaults).load())
    XCTAssertEqual(restored, trip)
    XCTAssertEqual(restored.trafficSource, "calgary-travel-times")
    let utc = try XCTUnwrap(TimeZone(identifier: "UTC"))
    XCTAssertEqual(
      navOSSCarPlayTrafficAttribution(restored, locale: Locale(identifier: "en_CA"), timeZone: utc),
      navOSSCarPlayTrafficAttribution(trip, locale: Locale(identifier: "en_CA"), timeZone: utc))
    XCTAssertNotNil(navOSSCarPlayTrafficAttribution(restored))
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

/// Opens once; everything waiting on it, then and later, goes on.
private actor Gate {
  private var isOpen = false
  private var waiting: [CheckedContinuation<Void, Never>] = []

  func wait() async {
    if isOpen { return }
    await withCheckedContinuation { waiting.append($0) }
  }

  nonisolated func open() {
    Task { await self.openNow() }
  }

  private func openNow() {
    isOpen = true
    for continuation in waiting { continuation.resume() }
    waiting = []
  }
}

private final class TestClock: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Date
  init(_ start: Date) { value = start }
  var now: Date {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
  func advance(by interval: TimeInterval) {
    lock.lock()
    value = value.addingTimeInterval(interval)
    lock.unlock()
  }
}

/// A server whose answer to a declared `/v2/routes` request changes as the test upgrades it,
/// and which can hold the next declared or undeclared route request until released. Requests
/// without the declaration are answered with a route.
private final class DeclarationServer: @unchecked Sendable {
  enum DeclaredAnswer { case rejects, accepts, unavailable }

  let bodies = BodyLog()
  let undeclaredArrived = Gate()
  let undeclaredRelease = Gate()
  let declaredArrived = Gate()
  let declaredRelease = Gate()
  private let lock = NSLock()
  private let config: Data
  private let rejection: Data
  private let routes: Data
  private var declaredAnswer = DeclaredAnswer.rejects
  private var holdUndeclared = false
  private var holdDeclared = false

  init(config: Data, rejection: Data, routes: Data) {
    self.config = config
    self.rejection = rejection
    self.routes = routes
  }

  var declared: DeclaredAnswer {
    get { locked { declaredAnswer } }
    set { locked { declaredAnswer = newValue } }
  }

  func holdNextUndeclared() { locked { holdUndeclared = true } }
  func holdNextDeclared() { locked { holdDeclared = true } }

  var transport: NavOSSHTTPTransport {
    { request in try await self.answer(request) }
  }

  private func answer(_ request: NavOSSHTTPRequest) async throws -> NavOSSHTTPResponse {
    switch request.url.path {
    case "/v2/config": return NavOSSHTTPResponse(statusCode: 200, body: config)
    case "/v2/routes":
      let body = try XCTUnwrap(
        JSONSerialization.jsonObject(with: try XCTUnwrap(request.body)) as? [String: Any])
      bodies.append(body)
      guard body["trafficSources"] != nil else {
        if locked({ () -> Bool in defer { holdUndeclared = false }; return holdUndeclared }) {
          undeclaredArrived.open()
          await undeclaredRelease.wait()
        }
        return NavOSSHTTPResponse(statusCode: 200, body: routes)
      }
      if locked({ () -> Bool in defer { holdDeclared = false }; return holdDeclared }) {
        declaredArrived.open()
        await declaredRelease.wait()
      }
      switch declared {
      case .rejects: return NavOSSHTTPResponse(statusCode: 400, body: rejection)
      case .accepts: return NavOSSHTTPResponse(statusCode: 200, body: routes)
      case .unavailable: return NavOSSHTTPResponse(statusCode: 503, body: Data("{}".utf8))
      }
    default: return NavOSSHTTPResponse(statusCode: 404, body: Data("{}".utf8))
    }
  }

  private func locked<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
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
