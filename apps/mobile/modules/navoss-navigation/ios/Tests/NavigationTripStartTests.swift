import Foundation
import XCTest

@testable import NavOSSNavigationCore

/// Starting a trip away from the road, on recorded production routes.
///
/// Square One Shopping Centre (Mississauga) to Scarborough Town Centre (Toronto), recorded from
/// the production API (`apps/mobile/test/fixtures/routes-v2/square-one-scarborough*.v2.json`):
/// the preview lists the Highway 401 Express route, the Highway 401 Collector route and a
/// QEW/Gardiner route; the same request made the way a reroute makes it (`alternatives: 0`)
/// returns the Collector route only. The vehicle is parked inside the mall, 100 m from where
/// every route starts on the nearest road.
///
/// Fixes are fed the way the simulator delivered them in the release validation that found
/// this (`round3/flows/locloop.sh`): a fresh fix every two seconds alternating by half a metre,
/// with no speed or course, then a drive onto and along the route.
final class NavigationTripStartTests: XCTestCase {
  override func tearDown() {
    ScriptedEngineNetwork.assertNothingWaiting()
    super.tearDown()
  }

  private static let fixtures = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .appendingPathComponent("../../../../test/fixtures/routes-v2")
  private static let destination = NavOSSCarPlayDestination(
    id: "scarborough-town-centre", label: "Scarborough Town Centre", latitude: 43.7756,
    longitude: -79.2578, name: "Scarborough Town Centre")
  /// Inside the mall, where the recorded requests started.
  private static let parked = NavigationCoordinate(latitude: 43.5926, longitude: -79.6437)
  private static let startTime: TimeInterval = 800_000_000

  private static func trips(_ name: String) throws -> [NavOSSCarPlayTrip] {
    let document = try JSONSerialization.jsonObject(
      with: Data(contentsOf: fixtures.appendingPathComponent("\(name).json"))) as? [String: Any]
    let response = try JSONSerialization.data(withJSONObject: try XCTUnwrap(document?["response"]))
    return try navigationTrips(
      from: JSONDecoder().decode(NavigationRouteResponseWire.self, from: response),
      version: .v2, destination: destination, preferences: NavOSSRoutePreferences(),
      waypoints: [])
  }

  private static func route(_ trips: [NavOSSCarPlayTrip], via road: String) throws
    -> NavOSSCarPlayTrip
  {
    try XCTUnwrap(trips.first { $0.steps.contains { $0.instruction.contains(road) } })
  }

  /// Drives a trip through the real `NavigationEngine`, as `NavOSSNavigationService` does:
  /// every fix is ingested, and a reroute the engine asks for is answered from the recorded
  /// production responses (the preview's three routes when it asks for alternatives, otherwise
  /// the reroute's one) before the next fix.
  private final class TripHarness {
    let session = NavigationSession()
    let engine: NavigationEngine
    private let host = RecordingEngineHost()
    private let network: ScriptedEngineNetwork
    private let clock = EngineTestClock(NavigationTripStartTests.startTime)
    private let store = EngineTripStoreFixture()
    private(set) var proposals = 0
    private(set) var installed: [String] = []
    private(set) var offRouteFixes = 0
    private(set) var latest: NavigationSessionUpdate?
    /// Every update, with the maneuver prompt the engine had spoken for it.
    private(set) var history: [(update: NavigationSessionUpdate, prompt: String?)] = []
    private var lastProposalId: String?
    var time = NavigationTripStartTests.startTime

    init(
      selected: NavOSSCarPlayTrip,
      preview: [NavOSSCarPlayTrip],
      reroute: [NavOSSCarPlayTrip],
      mode: NavOSSRerouteMode = .adaptive
    ) throws {
      network = ScriptedEngineNetwork { $0.alternatives > 0 ? preview : reroute }
      engine = NavigationEngine(
        tripStore: store.store, audioMode: .allGuidance,
        preferences: NavOSSNavigationPreferences(rerouteMode: mode), network: network,
        session: session, clock: { [clock] in clock.now })
      engine.host = host
      try engine.startNavigation(selected)
      engine.completePendingSafetyCameraFetch()
    }

    var activeRouteId: String? { session.trip?.id }
    /// Reroutes the engine asked the network for.
    var requests: Int { network.rerouteCount }

    func fix(
      _ coordinate: NavigationCoordinate,
      speed: Double? = nil,
      course: Double? = nil,
      accuracy: Double = 5,
      after seconds: TimeInterval
    ) throws {
      time += seconds
      clock.time = time
      let eventsBefore = host.events.count
      let update = try engine.ingest(
        NavigationLocationSample(
          coordinate: coordinate, courseDegrees: course, horizontalAccuracyMeters: accuracy,
          speedMetersPerSecond: speed, timestamp: time)
      ).versionedUpdate.update
      let prompts = host.events.dropFirst(eventsBefore).compactMap { event -> String? in
        if case .speak(let speech, _) = event, speech.kind == .maneuver { return speech.text }
        return nil
      }
      latest = update
      history.append((update, prompts.first))
      if update.snapshot.phase == .tracking && update.snapshot.isOffRoute { offRouteFixes += 1 }
      let installsBefore = engine.currentState().rerouteCount
      engine.completePendingReroute(through: network)
      let state = engine.currentState()
      if state.rerouteCount > installsBefore, let id = state.trip?.id {
        installed.append(id)
      }
      if let proposal = state.rerouteProposal?.id, proposal != lastProposalId {
        proposals += 1
      }
      lastProposalId = state.rerouteProposal?.id
    }

    /// Parked: a fix every two seconds, half a metre apart, no speed or course.
    func standStill(at coordinate: NavigationCoordinate, seconds: Int) throws {
      for index in 0..<(seconds / 2) {
        try fix(offsetCoordinate(coordinate, east: 0, north: index.isMultiple(of: 2) ? 0 : 0.5), after: 2)
      }
    }

    /// Straight-line driving between points, one fix a second.
    func drive(_ points: [NavigationCoordinate], speed: Double) throws {
      for (start, end) in zip(points, points.dropFirst()) {
        let length = navigationDistanceMeters(from: start, to: end)
        guard length > 0 else { continue }
        let course = navigationCourseDegrees(from: start, to: end)
        let count = max(1, Int((length / speed).rounded(.up)))
        for index in 1...count {
          let fraction = Double(index) / Double(count)
          try fix(
            NavigationCoordinate(
              latitude: start.latitude + (end.latitude - start.latitude) * fraction,
              longitude: start.longitude + (end.longitude - start.longitude) * fraction),
            speed: speed, course: course, after: length / Double(count) / speed)
        }
      }
    }
  }

  private static func offset(_ coordinate: NavigationCoordinate, east: Double, north: Double)
    -> NavigationCoordinate
  {
    offsetCoordinate(coordinate, east: east, north: north)
  }

  private static func points(_ trip: NavOSSCarPlayTrip, upToMeters limit: Double = .infinity)
    -> [NavigationCoordinate]
  {
    var result: [NavigationCoordinate] = []
    var travelled = 0.0
    for coordinate in trip.geometry {
      let point = NavigationCoordinate(latitude: coordinate.latitude, longitude: coordinate.longitude)
      if let last = result.last { travelled += navigationDistanceMeters(from: last, to: point) }
      result.append(point)
      if travelled >= limit { break }
    }
    return result
  }

  private func harness(selecting road: String, mode: NavOSSRerouteMode = .adaptive) throws
    -> (TripHarness, NavOSSCarPlayTrip)
  {
    let preview = try Self.trips("square-one-scarborough.v2")
    let reroute = try Self.trips("square-one-scarborough-reroute.v2")
    let selected = try Self.route(preview, via: road)
    return (try TripHarness(selected: selected, preview: preview, reroute: reroute, mode: mode), selected)
  }

  // MARK: The recorded data

  func testRecordedRoutesStartOnTheRoadAHundredMetresFromTheParkedCar() throws {
    let preview = try Self.trips("square-one-scarborough.v2")
    let reroute = try Self.trips("square-one-scarborough-reroute.v2")
    let express = try Self.route(preview, via: "Highway 401 Express")
    let collector = try Self.route(preview, via: "Highway 401 Collector")
    XCTAssertEqual(preview.count, 3)
    XCTAssertEqual(preview.first?.id, express.id, "the server lists Express first")
    XCTAssertEqual(reroute.count, 1)
    XCTAssertTrue(reroute[0].steps.contains { $0.instruction.contains("Highway 401 Collector") })
    XCTAssertEqual(reroute[0].geometry, collector.geometry, "a reroute from the car is the Collector")
    let start = try XCTUnwrap(express.geometry.first)
    let distance = navigationDistanceMeters(
      from: Self.parked, to: NavigationCoordinate(latitude: start.latitude, longitude: start.longitude))
    XCTAssertEqual(distance, 100, accuracy: 2)
  }

  // MARK: Parked off the road, then joining the chosen route

  /// G2: the driver chose Express and tapped Start while parked inside the mall. The selected
  /// route stays active while the car stands there, in every reroute mode, and is the route
  /// matched once the car drives onto it and along it to Scarborough.
  func testParkedInTheMallTheChosenExpressRouteIsKeptThroughStartAndDriven() throws {
    for mode in NavOSSRerouteMode.allCases {
      let (trip, express) = try harness(selecting: "Highway 401 Express", mode: mode)
      try trip.standStill(at: Self.parked, seconds: 120)
      XCTAssertEqual(trip.offRouteFixes, 0, "\(mode): parked 100 m from the road")
      XCTAssertEqual(trip.requests, 0, "\(mode): no replacement is asked for")
      XCTAssertEqual(trip.proposals, 0, "\(mode)")
      XCTAssertEqual(trip.activeRouteId, express.id, "\(mode)")

      try trip.drive([Self.parked] + Self.points(express), speed: 25)
      XCTAssertEqual(trip.requests, 0, "\(mode): driving the chosen route")
      XCTAssertEqual(trip.installed, [], "\(mode)")
      XCTAssertEqual(trip.activeRouteId, express.id, "\(mode)")
      let snapshot = try XCTUnwrap(trip.latest?.snapshot)
      XCTAssertFalse(snapshot.isOffRoute, "\(mode)")
      XCTAssertGreaterThan(snapshot.routeProgress, 0.98, "\(mode)")
    }
  }

  /// A driver who manoeuvres in the parking lot before leaving it, then joins the chosen route
  /// at its start, keeps it.
  func testManoeuvringInTheParkingLotThenJoiningKeepsTheChosenRoute() throws {
    let (trip, express) = try harness(selecting: "Highway 401 Express")
    try trip.standStill(at: Self.parked, seconds: 20)
    // Back out south, along the aisle east, north up the next aisle, then west to the exit.
    let aisle = [
      Self.parked,
      Self.offset(Self.parked, east: 0, north: -30),
      Self.offset(Self.parked, east: 60, north: -30),
      Self.offset(Self.parked, east: 60, north: 40),
      Self.offset(Self.parked, east: 0, north: 60),
    ]
    try trip.drive(aisle, speed: 3)
    try trip.drive([aisle.last!] + Self.points(express, upToMeters: 3_000), speed: 12)
    XCTAssertEqual(trip.requests, 0)
    XCTAssertEqual(trip.activeRouteId, express.id)
    let snapshot = try XCTUnwrap(trip.latest?.snapshot)
    XCTAssertFalse(snapshot.isOffRoute)
    XCTAssertNotNil(snapshot.matchedCoordinate)
  }

  // MARK: What is published before the first match

  /// Until a fix is matched the trip is acquiring, as the phone already shows a trip without a
  /// matched position ("acquiring route position", "Waiting for GPS"): the raw position, no
  /// position on the route, no progress, road or speed limit, no progress checkpoint, and
  /// nothing spoken. CarPlay is given the raw position. The route's first maneuver may still be
  /// shown as the step ahead. Asserted for every update while not matched.
  private func assertAcquiring(
    _ history: ArraySlice<(update: NavigationSessionUpdate, prompt: String?)>,
    _ label: String,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    XCTAssertFalse(history.isEmpty, label, file: file, line: line)
    for (index, entry) in history.enumerated() {
      let snapshot = entry.update.snapshot
      let context = "\(label), update \(index)"
      XCTAssertEqual(snapshot.phase, .tracking, context, file: file, line: line)
      XCTAssertNil(snapshot.matchedCoordinate, context, file: file, line: line)
      XCTAssertNil(snapshot.matchedCourseDegrees, context, file: file, line: line)
      XCTAssertNil(snapshot.geometrySegmentIndex, context, file: file, line: line)
      XCTAssertEqual(snapshot.routeProgress, 0, context, file: file, line: line)
      XCTAssertEqual(entry.update.roadContext, .unknown, context, file: file, line: line)
      XCTAssertFalse(navOSSIsProgressCheckpoint(snapshot), context, file: file, line: line)
      XCTAssertNil(entry.prompt, context, file: file, line: line)
      let raw = snapshot.rawCoordinate.map {
        NavOSSCarPlayCoordinate(latitude: $0.latitude, longitude: $0.longitude)
      }
      XCTAssertEqual(
        navOSSCarPlayPublishedPosition(
          matchedCoordinate: snapshot.matchedCoordinate, rawCoordinate: snapshot.rawCoordinate,
          matchedCourseDegrees: snapshot.matchedCourseDegrees,
          speedMetersPerSecond: snapshot.speedMetersPerSecond, source: .fix(capturedAt: 0),
          fallback: nil)?.coordinate,
        raw, context, file: file, line: line)
    }
  }

  /// Re-review of #133: parked 100 m from the road on 400 m fixes. Such a fix "fits" the route
  /// through its own accuracy, but cannot place the vehicle: before the first usable match it is
  /// acquiring like any other unmatched fix, and once fixes are usable the trip matches as usual.
  func testParkedOnFixesTooPoorToPlaceTheTripStaysAcquiring() throws {
    let (trip, express) = try harness(selecting: "Highway 401 Express")
    for index in 0..<30 {
      try trip.fix(
        Self.offset(Self.parked, east: 0, north: index.isMultiple(of: 2) ? 0 : 0.5),
        accuracy: 400, after: 2)
    }
    assertAcquiring(trip.history[...], "parked on 400 m fixes")
    XCTAssertFalse(trip.session.hasMatchedRoute)
    XCTAssertEqual(trip.requests, 0)

    try trip.drive([Self.parked] + Self.points(express, upToMeters: 2_000), speed: 12)
    XCTAssertTrue(trip.session.hasMatchedRoute)
    XCTAssertNotNil(trip.latest?.snapshot.matchedCoordinate)
    XCTAssertEqual(trip.activeRouteId, express.id)
  }

  func testParkedOffTheRoadTheTripIsAcquiringAndSilentUntilItJoinsTheRoute() throws {
    let (trip, express) = try harness(selecting: "Highway 401 Express")
    try trip.standStill(at: Self.parked, seconds: 60)
    assertAcquiring(trip.history[...], "parked 100 m from the road")
    XCTAssertFalse(trip.session.hasMatchedRoute)

    let parked = trip.history.count
    try trip.drive([Self.parked] + Self.points(express, upToMeters: 3_000), speed: 12)
    let firstMatch = try XCTUnwrap(
      trip.history.indices.first { trip.history[$0].update.snapshot.matchedCoordinate != nil })
    assertAcquiring(trip.history[parked..<firstMatch], "driving to the road")
    XCTAssertTrue(trip.session.hasMatchedRoute)
    XCTAssertTrue(
      trip.history[firstMatch...].contains { $0.prompt != nil },
      "guidance is spoken once matched")
    XCTAssertEqual(trip.activeRouteId, express.id)
  }

  /// Review of #133: starting 100 m from the route and driving 200 m along a parallel service
  /// road. The puck must not sit on the route, and nothing may be guided or spoken for a road
  /// the driver is not on.
  func testDrivingAParallelServiceRoadBeforeTheFirstMatchIsNotGuidedFromTheRoute() throws {
    let end = NavigationTrace.coordinate(300, 1_000)
    let first = NavigationTrace.route([(0, 0), (300, 0)])
    let second = NavigationTrace.route([(300, 0), (300, 1_000)])
    func carPlay(_ points: [NavigationCoordinate]) -> [NavOSSCarPlayCoordinate] {
      points.map { NavOSSCarPlayCoordinate(latitude: $0.latitude, longitude: $0.longitude) }
    }
    let selected = NavOSSCarPlayTrip(
      destination: NavOSSCarPlayDestination(
        id: "d", label: "d", latitude: end.latitude, longitude: end.longitude, name: "d"),
      distanceMeters: 1_300, durationSeconds: 100,
      geometry: carPlay(first + second.dropFirst()), id: "turn",
      steps: [
        NavOSSCarPlayRouteStep(
          distanceMeters: 300, durationSeconds: 25, geometry: carPlay(first),
          instruction: "Head east", maneuverType: "depart", roadName: "First Street"),
        NavOSSCarPlayRouteStep(
          distanceMeters: 1_000, durationSeconds: 75, geometry: carPlay(second),
          instruction: "Turn left onto Second Street.", maneuverType: "turn",
          roadName: "Second Street"),
        NavOSSCarPlayRouteStep(
          distanceMeters: 0, durationSeconds: 0,
          geometry: carPlay([end, end]), instruction: "Arrive", maneuverType: "arrive",
          roadName: ""),
      ])
    let replacement = try Self.trips("square-one-scarborough-reroute.v2")
    let trip = try TripHarness(selected: selected, preview: [selected], reroute: replacement)
    try trip.standStill(at: NavigationTrace.coordinate(-100, -100), seconds: 6)
    var x = -100.0
    while x < 100 {
      x += 10
      try trip.fix(NavigationTrace.coordinate(x, -100), speed: 10, course: 90, after: 1)
    }
    XCTAssertEqual(trip.requests, 0)
    assertAcquiring(trip.history[...], "200 m along a parallel road")
  }

  // MARK: A reroute that is needed still happens

  /// Starting off the route and driving away from all of it is still rerouted, within a short
  /// distance of moving away.
  func testStartingOffTheRouteAndDrivingAwayIsRerouted() throws {
    let (trip, express) = try harness(selecting: "Highway 401 Express")
    try trip.standStill(at: Self.parked, seconds: 20)
    XCTAssertEqual(trip.requests, 0)
    // South through the mall's lot and away: every route leaves northward.
    var position = Self.parked
    var driven = 0.0
    while trip.requests == 0, driven < 400 {
      let next = Self.offset(position, east: 0, north: -10)
      try trip.fix(next, speed: 10, course: 180, after: 1)
      position = next
      driven += 10
    }
    XCTAssertEqual(trip.requests, 1)
    XCTAssertLessThanOrEqual(driven, 120, "rerouted soon after moving away")
    // Not yet matched, so the server's alternatives are asked for and the one closest to the
    // chosen route is installed (the recorded preview answer stands in for the server's).
    XCTAssertEqual(trip.installed, [express.id])
  }

  // MARK: Which replacement a reroute takes

  func testBeforeTheFirstMatchTheReplacementIsTheAlternativeClosestToTheChosenRoute() throws {
    let preview = try Self.trips("square-one-scarborough.v2")
    let express = try Self.route(preview, via: "Highway 401 Express")
    let collector = try Self.route(preview, via: "Highway 401 Collector")
    let gardiner = try Self.route(preview, via: "Gardiner Expressway")
    for selected in [express, collector, gardiner] {
      for candidates in [preview, preview.reversed()] {
        XCTAssertEqual(
          navigationReplacement(from: candidates, closestTo: selected, hasMatchedRoute: false)?.id,
          selected.id)
      }
    }
    // Without the chosen route itself, the one sharing most of its road: Collector, not QEW.
    XCTAssertEqual(
      navigationReplacement(from: [gardiner, collector], closestTo: express, hasMatchedRoute: false)?
        .id,
      collector.id)
    // Once matched, the server's first, as before.
    XCTAssertEqual(
      navigationReplacement(from: preview, closestTo: collector, hasMatchedRoute: true)?.id,
      preview.first?.id)
    XCTAssertEqual(navigationRerouteAlternatives(hasMatchedRoute: false, waypointCount: 0), 2)
    XCTAssertEqual(navigationRerouteAlternatives(hasMatchedRoute: false, waypointCount: 1), 0)
    XCTAssertEqual(navigationRerouteAlternatives(hasMatchedRoute: true, waypointCount: 0), 0)
  }

  /// Starting beside the route and driving alongside it, never closer, is not joining it: the
  /// vehicle is on another road (a parallel street, the far side of a barrier) and is rerouted
  /// once it has gone well past the distance that reaching the route would take.
  func testStartingBesideTheRouteAndDrivingAlongsideItIsRerouted() throws {
    let selected = Self.syntheticTrip(NavigationTrace.route([(0.0, 0.0), (3_000.0, 0.0)]))
    let replacement = try Self.trips("square-one-scarborough-reroute.v2")
    let trip = try TripHarness(selected: selected, preview: [selected], reroute: replacement)
    let start = NavigationTrace.coordinate(0, -100)
    try trip.standStill(at: start, seconds: 10)
    XCTAssertEqual(trip.requests, 0)
    var x = 0.0
    while trip.requests == 0, x < 1_500 {
      x += 12
      try trip.fix(NavigationTrace.coordinate(x, -100), speed: 12, course: 90, after: 1)
    }
    XCTAssertEqual(trip.requests, 1)
    // The start's 100 m from the route plus the 500 m travel budget, plus three fixes.
    XCTAssertLessThanOrEqual(x, 650)
  }

  /// Review of #133: a service-road loop of 100 m radius inside a concentric loop of the chosen
  /// route 45 m further out. Every fix is outside the on-route band, the vehicle never gets
  /// further from the route than about 100 m and never more than 200 m from where it started,
  /// whichever way it drives. It has really driven, though, and never joined: it is rerouted.
  func testCirclingAServiceRoadLoopInsideTheRouteIsRerouted() throws {
    func circle(_ radius: Double, clockwise: Bool, laps: Double = 1) -> [(Double, Double)] {
      let count = Int(72 * laps)
      return (0...count).map { index in
        let angle = Double(index) / 72 * 2 * .pi * (clockwise ? -1 : 1)
        return (radius * cos(angle), radius * sin(angle))
      }
    }
    // The route goes once round the outer loop, then leaves east.
    let selected = Self.syntheticTrip(
      NavigationTrace.route(circle(145, clockwise: false) + [(2_000, 0)], spacing: 10))
    let replacement = try Self.trips("square-one-scarborough-reroute.v2")
    let trip = try TripHarness(selected: selected, preview: [selected], reroute: replacement)
    try trip.standStill(at: NavigationTrace.coordinate(100, 0), seconds: 10)
    XCTAssertEqual(trip.requests, 0)
    // Round the inner loop the other way at 8 m/s, a fix a second: up to three laps (1.9 km).
    var driven = 0.0
    for position in NavigationTrace.positions(along: circle(100, clockwise: true, laps: 3), every: 8)
    where trip.requests == 0 {
      try trip.fix(
        NavigationTrace.coordinate(position.x, position.y), speed: 8,
        course: position.courseDegrees, after: 1)
      driven = position.alongMeters
    }
    XCTAssertEqual(trip.requests, 1)
    // The start's 45 m from the route plus the 500 m travel budget, plus three fixes.
    XCTAssertLessThanOrEqual(driven, 650)
  }

  /// The chosen trade-off: travel is positional only, so a vehicle circling a loop of 10 m
  /// radius (a parkade ramp, a small roundabout in a lot) beside the route, whatever speed it
  /// reports, is never counted as travelling. It is not going anywhere: for ten minutes it stays
  /// acquiring and silent with no reroute request. Once it leaves the loop along a road parallel
  /// to the route, its positional travel passes the budget (its 55 m start plus 500 m) and it is
  /// rerouted.
  func testCirclingATightLoopStaysAcquiringUntilItLeavesThenIsRerouted() throws {
    let selected = Self.syntheticTrip(NavigationTrace.route([(-2_000.0, 55.0), (3_000.0, 55.0)]))
    let replacement = try Self.trips("square-one-scarborough-reroute.v2")
    let trip = try TripHarness(selected: selected, preview: [selected], reroute: replacement)
    for second in 1...600 {
      let angle = Double(second) * 3 / 10
      try trip.fix(
        NavigationTrace.coordinate(10 * cos(angle), 10 * sin(angle)), speed: 3,
        course: ((-angle * 180 / .pi).truncatingRemainder(dividingBy: 360) + 360)
          .truncatingRemainder(dividingBy: 360),
        after: 1)
    }
    XCTAssertEqual(trip.requests, 0)
    assertAcquiring(trip.history[...], "ten minutes round a 10 m loop")

    // Out of the loop and east along a road parallel to the route, 55 m from it.
    var x = 10 * cos(600 * 0.3)
    var driven = 0.0
    while trip.requests == 0, driven < 1_500 {
      x += 10
      driven += 10
      try trip.fix(NavigationTrace.coordinate(x, 0), speed: 10, course: 90, after: 1)
    }
    XCTAssertEqual(trip.requests, 1)
    XCTAssertGreaterThanOrEqual(driven, 500, "not before the budget is driven")
    XCTAssertLessThanOrEqual(driven, 700)
  }

  /// Ten minutes parked off the road with the fix wandering never adds up to travel: half a
  /// metre (the simulator), and within 15 m in every direction (a poor sky view); with no
  /// reported speed, a stationary one, and a spurious 2 m/s (a speed never credits travel).
  func testTenMinutesParkedOffTheRoadWithJitterIsNeverRerouted() throws {
    for (jitter, accuracy) in [(0.0, 20.0), (0.5, 5.0), (15.0, 10.0), (15.0, 5.0)] {
      for speed in [nil, 0.0, 2.0] as [Double?] {
        let label = "jitter \(jitter) m, accuracy \(accuracy) m, speed \(String(describing: speed))"
        let (trip, express) = try harness(selecting: "Highway 401 Express")
        var generator = SplitMix64(seed: 7)
        for _ in 0..<600 {
          let angle = Double(generator.next() % 3_600) / 3_600 * 2 * .pi
          let radius = jitter * Double(generator.next() % 1_000) / 1_000
          try trip.fix(
            Self.offset(Self.parked, east: radius * cos(angle), north: radius * sin(angle)),
            speed: speed, accuracy: accuracy, after: 1)
        }
        XCTAssertEqual(trip.requests, 0, label)
        XCTAssertEqual(trip.offRouteFixes, 0, label)
        XCTAssertEqual(trip.activeRouteId, express.id, label)
      }
    }
  }

  /// Final review of #133: a parked fix drifts 12 m at a reported 2 m/s, then stays where it
  /// drifted to, still reporting 2 m/s, for fifteen minutes. Nothing of that is travel.
  func testParkedFixDriftingThenStillWithASpuriousSpeedIsNeverRerouted() throws {
    let (trip, express) = try harness(selecting: "Highway 401 Express")
    for step in 1...6 {
      try trip.fix(
        Self.offset(Self.parked, east: Double(step) * 2, north: 0), speed: 2, course: 90,
        after: 1)
    }
    let drifted = Self.offset(Self.parked, east: 12, north: 0)
    for _ in 0..<900 {
      try trip.fix(drifted, speed: 2, course: 90, after: 1)
    }
    XCTAssertEqual(trip.requests, 0)
    XCTAssertEqual(trip.offRouteFixes, 0)
    XCTAssertEqual(trip.activeRouteId, express.id)
  }

  /// Review of #133: crawling at 0.8 m/s, below the stationary speed, along a frontage road
  /// 100 m from the chosen route, with accurate fixes. Once the vehicle is further from where its
  /// travel was last counted than any parked receiver wanders, its position wins over the
  /// reported speed: it is rerouted within the travel budget (its 100 m start plus 500 m) plus
  /// that bound (100 m and both accuracies).
  func testCrawlingAlongAParallelRoadBelowTheStationarySpeedIsRerouted() throws {
    let selected = Self.syntheticTrip(NavigationTrace.route([(-1_000.0, 0.0), (3_000.0, 0.0)]))
    let replacement = try Self.trips("square-one-scarborough-reroute.v2")
    let trip = try TripHarness(selected: selected, preview: [selected], reroute: replacement)
    var x = 0.0
    while trip.requests == 0, x < 1_000 {
      x += 0.8
      try trip.fix(NavigationTrace.coordinate(x, -100), speed: 0.8, course: 90, after: 1)
    }
    XCTAssertEqual(trip.requests, 1)
    XCTAssertGreaterThanOrEqual(x, 600, "not before the budget is driven")
    XCTAssertLessThanOrEqual(x, 100 + 500 + 110 + 10)
  }

  /// Parked for fifteen minutes reporting a speed of zero, with a multipath jump of 40 m every
  /// half minute that returns to the true position on the next fix: never travel.
  func testParkedWithMultipathJumpsAtZeroSpeedIsNeverRerouted() throws {
    let (trip, express) = try harness(selecting: "Highway 401 Express")
    for second in 1...900 {
      let jumped = second.isMultiple(of: 30)
      try trip.fix(
        Self.offset(Self.parked, east: jumped ? 40 : 0, north: 0), speed: 0, after: 1)
    }
    XCTAssertEqual(trip.requests, 0)
    XCTAssertEqual(trip.offRouteFixes, 0)
    XCTAssertEqual(trip.activeRouteId, express.id)
  }

  /// Before the first match a fix worse than `navigationPoorAccuracyMeters` counts neither way,
  /// as its own accuracy keeps it from departing after a match. In particular its accuracy never
  /// becomes part of a margin: a start on a 400 m fix does not let the vehicle drive 450 m
  /// further away before it is rerouted.
  func testPreMatchFixesTooPoorToPlaceCountNeitherWay() throws {
    let selected = Self.syntheticTrip(NavigationTrace.route([(0.0, 0.0), (3_000.0, 0.0)]))
    let replacement = try Self.trips("square-one-scarborough-reroute.v2")
    let trip = try TripHarness(selected: selected, preview: [selected], reroute: replacement)
    for index in 0..<10 {
      try trip.fix(
        NavigationTrace.coordinate(0, index.isMultiple(of: 2) ? -100 : -100.5), accuracy: 400,
        after: 2)
    }
    var y = -100.0
    for _ in 0..<30 {
      y -= 10
      try trip.fix(NavigationTrace.coordinate(0, y), speed: 10, course: 180, accuracy: 400, after: 1)
    }
    XCTAssertEqual(trip.requests, 0, "300 m away on fixes that cannot place the vehicle")
    var usableFixes = 0
    while trip.requests == 0, usableFixes < 40 {
      y -= 10
      usableFixes += 1
      try trip.fix(NavigationTrace.coordinate(0, y), speed: 10, course: 180, after: 1)
    }
    XCTAssertEqual(trip.requests, 1)
    // Closest approach is the first usable fix: 50 m + both accuracies further, then 3 fixes.
    XCTAssertLessThanOrEqual(usableFixes, 10)
  }

  /// Far from a long route (30,000 points, 300 km), a pre-match fix is not a scan of every
  /// segment: parked, one scan in ten minutes; driving, one per 100 m moved.
  func testPreMatchDistanceFarFromALongRouteScansRarely() throws {
    let core = NavigationCore()
    try core.setRoute(NavigationTrace.route([(0.0, 0.0), (300_000.0, 0.0)], spacing: 10))
    let scanStart = Date()
    var generator = SplitMix64(seed: 11)
    var time = Self.startTime
    for _ in 0..<600 {
      time += 1
      let jitter = Double(generator.next() % 1_000) / 100
      _ = try core.updateLocation(
        NavigationLocationSample(
          coordinate: NavigationTrace.coordinate(150_000 + jitter, 2_000 + jitter),
          horizontalAccuracyMeters: 5, timestamp: time))
    }
    XCTAssertEqual(core.preMatchFullScanCount, 1)
    for step in 1...100 {
      time += 1
      _ = try core.updateLocation(
        NavigationLocationSample(
          coordinate: NavigationTrace.coordinate(150_000, 2_000 + Double(step) * 10),
          courseDegrees: 0, horizontalAccuracyMeters: 5, speedMetersPerSecond: 10, timestamp: time))
    }
    XCTAssertLessThanOrEqual(core.preMatchFullScanCount, 1 + 11, "1 km driven")
    let elapsed = Date().timeIntervalSince(scanStart)
    // Recorded for the review: 700 fixes including at most 12 full scans of 30,000 segments.
    print("700 pre-match fixes, \(core.preMatchFullScanCount) full scans: \(elapsed) s")
  }

  private static func syntheticTrip(_ points: [NavigationCoordinate]) -> NavOSSCarPlayTrip {
    let geometry = points.map {
      NavOSSCarPlayCoordinate(latitude: $0.latitude, longitude: $0.longitude)
    }
    let end = points.last!
    let length = zip(points, points.dropFirst()).reduce(0) {
      $0 + navigationDistanceMeters(from: $1.0, to: $1.1)
    }
    return NavOSSCarPlayTrip(
      destination: NavOSSCarPlayDestination(
        id: "d", label: "d", latitude: end.latitude, longitude: end.longitude, name: "d"),
      distanceMeters: length, durationSeconds: length / 15, geometry: geometry, id: "synthetic",
      steps: [
        NavOSSCarPlayRouteStep(
          distanceMeters: length, durationSeconds: length / 15, geometry: geometry,
          instruction: "Head east", maneuverType: "depart", roadName: ""),
        NavOSSCarPlayRouteStep(
          distanceMeters: 0, durationSeconds: 0, geometry: [geometry.last!, geometry.last!],
          instruction: "Arrive", maneuverType: "arrive", roadName: ""),
      ])
  }
}

/// Deterministic pseudo-random numbers for repeatable jitter.
struct SplitMix64 {
  private var state: UInt64
  init(seed: UInt64) { state = seed }
  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var value = state
    value = (value ^ (value >> 30)) &* 0xBF58_476D_1CE4_E5B9
    value = (value ^ (value >> 27)) &* 0x94D0_49BB_1331_11EB
    return value ^ (value >> 31)
  }
}

/// `coordinate` moved `east` and `north` metres.
func offsetCoordinate(_ coordinate: NavigationCoordinate, east: Double, north: Double)
  -> NavigationCoordinate
{
  let metersPerDegreeLatitude = Double.pi * 6_371_000 / 180
  return NavigationCoordinate(
    latitude: coordinate.latitude + north / metersPerDegreeLatitude,
    longitude: coordinate.longitude
      + east / (metersPerDegreeLatitude * cos(coordinate.latitude * .pi / 180)))
}
