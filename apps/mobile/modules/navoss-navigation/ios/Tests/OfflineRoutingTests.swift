import XCTest

@testable import NavOSSNavigationCore

/// The adapter is checked against responses recorded from the real Valhalla 3.9.1 engine on the
/// real Calgary routing extract, for requests built by `navOSSOfflineRouteRequest` itself.
final class OfflineRoutingTests: XCTestCase {
  private let destination = NavOSSCarPlayDestination(
    id: "dest", label: "Destination", latitude: 51.0866, longitude: -114.1305, name: "Destination")

  private func trips(_ fixture: String, waypoints: [NavOSSCarPlayDestination] = []) throws
    -> [NavOSSCarPlayTrip]
  {
    try navOSSOfflineTrips(
      fromValhallaJSON: OfflineFixtures.data("\(fixture).response.json"),
      destination: destination,
      waypoints: waypoints,
      preferences: NavOSSRoutePreferences()
    )
  }

  private func assertRequest(_ fixture: String, _ built: String, file: StaticString = #filePath, line: UInt = #line) throws {
    let expected = try OfflineFixtures.json("\(fixture).request.json") as? NSDictionary
    let actual = try JSONSerialization.jsonObject(with: Data(built.utf8)) as? NSDictionary
    XCTAssertEqual(actual, expected, file: file, line: line)
  }

  func testBuildsTheRequestsTheFixturesWereRecordedWith() throws {
    try assertRequest(
      "calgary-downtown-north",
      navOSSOfflineRouteRequest(
        origin: .init(latitude: 51.0447, longitude: -114.0719), originHeadingDegrees: 272.6,
        originHorizontalAccuracyMeters: 10, destination: .init(latitude: 51.0866, longitude: -114.1305),
        waypoints: [], preferences: NavOSSRoutePreferences(), alternatives: 2))
    try assertRequest(
      "calgary-waypoint",
      navOSSOfflineRouteRequest(
        origin: .init(latitude: 51.0626, longitude: -114.0201), originHeadingDegrees: nil,
        originHorizontalAccuracyMeters: nil, destination: .init(latitude: 50.9932, longitude: -114.0943),
        waypoints: [.init(latitude: 51.009261, longitude: -114.013047)],
        preferences: NavOSSRoutePreferences(), alternatives: 0))
    // The wrapper rejects PBF; the adapter must always ask for native JSON.
    let avoiding = try navOSSOfflineRouteRequest(
      origin: .init(latitude: 51, longitude: -114), originHeadingDegrees: nil,
      originHorizontalAccuracyMeters: 500, destination: .init(latitude: 51.1, longitude: -114),
      waypoints: [], preferences: NavOSSRoutePreferences(avoidFerries: true, avoidHighways: true, avoidTolls: true, avoidUnpaved: true),
      alternatives: 5)
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(avoiding.utf8)) as? [String: Any])
    XCTAssertEqual(object["format"] as? String, "json")
    XCTAssertEqual(object["alternates"] as? Int, 2)
    let auto = try XCTUnwrap((object["costing_options"] as? [String: Any])?["auto"] as? [String: Any])
    XCTAssertEqual(auto["use_highways"] as? Double, 0)
    XCTAssertEqual(auto["exclude_unpaved"] as? Bool, true)
    let origin = try XCTUnwrap((object["locations"] as? [[String: Any]])?.first)
    XCTAssertEqual(origin["radius"] as? Int, 100)
  }

  func testAdaptsMainTripAndAlternatesWithLanesSignsAndSpeech() throws {
    let trips = try trips("calgary-downtown-north")
    XCTAssertEqual(trips.count, 3)
    for trip in trips {
      XCTAssertTrue(trip.isValid, trip.id)
      XCTAssertEqual(trip.source, "offline-valhalla")
      XCTAssertNil(trip.traffic)
      XCTAssertNil(trip.speedLimitsKph)
      XCTAssertTrue(trip.id.hasPrefix("offline-valhalla-"))
      XCTAssertEqual(trip.steps.first?.maneuverType, "depart")
      XCTAssertEqual(trip.steps.last?.maneuverType, "arrive")
      // Step geometries tile the route geometry exactly.
      let stepPoints = trip.steps.dropLast().reduce(into: [NavOSSCarPlayCoordinate]()) {
        $0.append(contentsOf: $0.isEmpty ? $1.geometry[...] : $1.geometry.dropFirst())
      }
      XCTAssertEqual(stepPoints, trip.geometry)
    }
    let main = try XCTUnwrap(trips.first { $0.distanceMeters == 9_049 })
    XCTAssertEqual(main.durationSeconds, 929.408, accuracy: 0.001)
    XCTAssertEqual(main.steps[0].instruction, "Drive west.")
    // Contract v10: each step carries its own maneuver's announcement.
    XCTAssertEqual(main.steps[0].spokenInstruction, "Drive west. Then Turn right.")
    XCTAssertEqual(main.steps[1].spokenInstruction, "Turn right. Then Turn right onto 9 Avenue SW.")
    XCTAssertEqual(main.steps.last?.spokenInstruction, "You have arrived at your destination.")
    XCTAssertEqual(main.steps[1].maneuverType, "turn")
    XCTAssertEqual(main.steps[1].maneuverModifier, "right")
    XCTAssertEqual(main.steps[1].bearingBeforeDegrees, 273)
    XCTAssertEqual(main.steps[1].bearingAfterDegrees, 2)

    let left = try XCTUnwrap(main.steps.first { $0.instruction == "Turn left onto 2 Street SW." })
    XCTAssertEqual(left.roadName, "2 Street SW")
    XCTAssertEqual(
      left.lanes,
      [
        NavOSSCarPlayLane(indications: [.left], isValid: true, isPreferred: true, activeIndication: .left),
        NavOSSCarPlayLane(indications: [.left, .straight], isValid: true, isPreferred: false, activeIndication: .left),
        NavOSSCarPlayLane(indications: [.straight], isValid: false),
        NavOSSCarPlayLane(indications: [.straight], isValid: false),
        NavOSSCarPlayLane(indications: [.straight, .right], isValid: false),
      ])
    XCTAssertNotNil(navOSSCarPlayLaneSpecs(left.lanes))

    let ramp = try XCTUnwrap(main.steps.first { $0.instruction == "Take the ramp toward Crowchild Trail." })
    XCTAssertEqual(ramp.maneuverType, "on ramp")
    XCTAssertEqual(ramp.signpostToward, ["Crowchild Trail"])
    XCTAssertEqual(ramp.signpost, "Crowchild Trail")
    XCTAssertNil(ramp.exitNumber)
  }

  func testKeepsExitNumbersAndSignElementsSeparate() throws {
    let steps = try trips("calgary-stoney-airport").flatMap(\.steps)
    let exit60 = try XCTUnwrap(steps.first { $0.exitNumber == "60" })
    XCTAssertEqual(exit60.maneuverType, "off ramp")
    XCTAssertEqual(exit60.maneuverModifier, "slight right")
    XCTAssertEqual(exit60.signpostBranch, ["2"])
    XCTAssertEqual(
      exit60.signpostToward,
      ["Deerfoot Trail", "Calgary International Airport", "Edmonton"])
    XCTAssertEqual(exit60.signpost, "2: Deerfoot Trail, Calgary International Airport, Edmonton")

    let glenmore = try XCTUnwrap(try trips("calgary-deerfoot-glenmore").first)
    let fork = try XCTUnwrap(glenmore.steps.first { $0.exitNumber == "248B" })
    XCTAssertEqual(fork.maneuverType, "fork")
    XCTAssertEqual(fork.maneuverModifier, "slight right")
    XCTAssertEqual(fork.signpostToward, ["Glenmore Trail West"])
  }

  func testRoundaboutCarriesItsExitCountAndArrivalKeepsTheRoadName() throws {
    let trip = try XCTUnwrap(try trips("calgary-roundabout").first)
    XCTAssertEqual(
      trip.steps.map(\.maneuverType), ["depart", "roundabout", "exit roundabout", "turn", "arrive"])
    XCTAssertEqual(trip.steps[1].roundaboutExit, 1)
    XCTAssertEqual(trip.steps.last?.roadName, "Peacekeepers Way SW")
    // A zero-length arrival still has a two-point geometry, as the guidance model requires.
    XCTAssertEqual(trip.steps.last?.geometry.count, 2)
  }

  func testWaypointLegsJoinWithoutDuplicatingTheStop() throws {
    let stop = NavOSSCarPlayDestination(
      id: "stop", label: "Stop", latitude: 51.009261, longitude: -114.013047, name: "Stop")
    let trip = try XCTUnwrap(try trips("calgary-waypoint", waypoints: [stop]).first)
    XCTAssertEqual(trip.waypoints, [stop])
    let arrivals = trip.steps.indices.filter { trip.steps[$0].maneuverType == "arrive" }
    XCTAssertEqual(arrivals.count, 2)
    XCTAssertEqual(trip.steps[arrivals[0] + 1].maneuverType, "depart")
    XCTAssertEqual(trip.steps[arrivals[0] + 1].roadName, "2 / Deerfoot Trail SE")
    // The second leg starts at the stop the first leg ended on; it is listed once.
    let legs = try XCTUnwrap(
      (try OfflineFixtures.json("calgary-waypoint.response.json") as? [String: Any])
        .flatMap { ($0["trip"] as? [String: Any])?["legs"] as? [[String: Any]] })
    let shapes = try legs.map { try navOSSDecodePolyline6(try XCTUnwrap($0["shape"] as? String)) }
    XCTAssertEqual(trip.geometry.count, shapes[0].count + shapes[1].count - 1)
    XCTAssertEqual(Array(trip.geometry.prefix(shapes[0].count)), shapes[0])
    XCTAssertEqual(Array(trip.geometry.suffix(shapes[1].count)), shapes[1])
  }

  func testEngineErrorsAndGarbageAreNotRoutes() throws {
    XCTAssertThrowsError(try trips("outside-coverage")) { error in
      XCTAssertEqual(error as? NavOSSOfflineRoutingError, .noRoute)
    }
    XCTAssertThrowsError(
      try navOSSOfflineTrips(
        fromValhallaJSON: Data(#"{"trip":{"status":0,"legs":[]}}"#.utf8), destination: destination,
        waypoints: [], preferences: NavOSSRoutePreferences())
    ) { error in
      XCTAssertEqual(error as? NavOSSOfflineRoutingError, .invalidResponse)
    }
  }

  func testPolyline6DecodesTheReferenceVector() throws {
    // Google's documented polyline example; at precision 6 every value is a tenth.
    let points = try navOSSDecodePolyline6("_p~iF~ps|U_ulLnnqC_mqNvxq`@")
    XCTAssertEqual(points.count, 3)
    XCTAssertEqual(points[0].latitude, 3.85, accuracy: 1e-9)
    XCTAssertEqual(points[0].longitude, -12.02, accuracy: 1e-9)
    XCTAssertEqual(points[2].latitude, 4.3252, accuracy: 1e-9)
    XCTAssertEqual(points[2].longitude, -12.6453, accuracy: 1e-9)
    XCTAssertThrowsError(try navOSSDecodePolyline6("_p~iF~ps|U_"))
  }

  func testCoverageCheckRejectsARouteLeavingTheRegion() throws {
    let manifest = try NavOSSOfflineManifest.parse(OfflineFixtures.data("manifest-2026-11-11.json"))
    let calgary = try XCTUnwrap(manifest.region(id: "calgary"))
    let trips = try trips("calgary-downtown-north")
    XCTAssertTrue(navOSSOfflineTripsStayInside(trips, region: calgary))
    let first = try XCTUnwrap(trips.first)
    let escaped = NavOSSCarPlayTrip(
      destination: first.destination, distanceMeters: first.distanceMeters,
      durationSeconds: first.durationSeconds,
      geometry: first.geometry + [NavOSSCarPlayCoordinate(latitude: 53.5, longitude: -113.5)],
      id: first.id, steps: first.steps)
    XCTAssertFalse(navOSSOfflineTripsStayInside([escaped], region: calgary))
  }

  func testOfflineRoutesAreLabelledOnCarPlayRouteChoices() throws {
    let details = navOSSCarPlayRouteChoiceDetails(try trips("calgary-downtown-north"))
    XCTAssertEqual(details.count, 3)
    for detail in details {
      XCTAssertTrue(detail?.hasPrefix("Offline, no traffic or closures") == true, detail ?? "nil")
    }
  }
}

/// One offline drive through the real speech planner: every maneuver of the recorded trip is
/// approached in turn, and the planner must speak that maneuver's own Valhalla announcement.
final class OfflineSpeechTests: XCTestCase {
  func testPlannerSpeaksEachOfflineManeuverInOrder() throws {
    let destination = NavOSSCarPlayDestination(
      id: "dest", label: "Destination", latitude: 51.0866, longitude: -114.1305,
      name: "Destination")
    let trip = try XCTUnwrap(
      try navOSSOfflineTrips(
        fromValhallaJSON: OfflineFixtures.data("calgary-downtown-north.response.json"),
        destination: destination, waypoints: [], preferences: NavOSSRoutePreferences()
      ).first { $0.distanceMeters == 9_049 })
    let planner = NavigationSpeechPlanner()
    var now = 10_000.0
    var spoken: [String] = []
    for index in 0..<(trip.steps.count - 1) {
      let step = trip.steps[index + 1]
      let guidance = NavOSSCarPlayGuidance(
        distanceToManeuverMeters: 40, durationToManeuverSeconds: 4, instruction: step.instruction,
        maneuverType: step.maneuverType, phase: .navigating, remainingDistanceMeters: 2_000,
        remainingDurationSeconds: 200, roadName: step.roadName, stepIndex: index)
      if let prompt = planner.prompt(
        trip: trip, guidance: guidance, hasCurrentLocation: true, speedMetersPerSecond: 10,
        now: now)
      {
        spoken.append(prompt.text)
      }
      now += 120
    }
    print("OFFLINE_SPOKEN_PROMPTS", spoken)
    // The first maneuver after departure is announced with its own words, not the next one's.
    XCTAssertTrue(spoken.first?.hasPrefix("Turn right") == true, spoken.first ?? "nil")
    XCTAssertTrue(spoken.contains { $0.contains("2 Street") }, "\(spoken)")
    XCTAssertTrue(spoken.contains { $0.localizedCaseInsensitiveContains("Crowchild") }, "\(spoken)")
    XCTAssertGreaterThanOrEqual(spoken.count, trip.steps.count / 2)
  }
}
