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

  /// Drives a trip the way `NavOSSNavigationService` does: every fix goes through the session
  /// and reroute consent; a request asks for the alternatives the service asks for, is answered
  /// from the recorded production responses (the preview's three routes, or the reroute's
  /// one), and the replacement is chosen with the service's rule.
  private final class TripHarness {
    private(set) var session = NavigationSession()
    var consent = NavigationRerouteConsent()
    let mode: NavOSSRerouteMode
    let preview: [NavOSSCarPlayTrip]
    let reroute: [NavOSSCarPlayTrip]
    private(set) var requests = 0
    private(set) var proposals = 0
    private(set) var installed: [String] = []
    private(set) var offRouteFixes = 0
    private(set) var latest: NavigationSessionUpdate?
    /// Every update, with the maneuver prompt the service would speak for it.
    private(set) var history: [(update: NavigationSessionUpdate, prompt: String?)] = []
    let planner = NavigationSpeechPlanner()
    var time = NavigationTripStartTests.startTime
    /// With `persisting`, the trip is kept where the service keeps it (`NavOSSActiveTripStore`),
    /// with what the service checkpoints, so that `relaunch` can restore it.
    let store: NavOSSActiveTripStore?
    private let defaults: UserDefaults?
    private let suiteName = "org.navoss.tests.trip-start.\(UUID().uuidString)"
    private var lastRecord: NavigationTripRecord?
    private var lastRecordAt: Date?
    /// A restored trip whose first fixes are judged by `navOSSPersistedNavigationDecision`.
    private var validatesRestoredTrip = false
    /// The restored trip was ended for being off its route ("Trip ended").
    private(set) var endedOffRoute = false
    /// `history` index of the first update after the last relaunch.
    private(set) var relaunchedAt = 0
    /// Injected failure: progress records are not written until the next relaunch, as if the
    /// app were killed after the first match and before its record.
    var dropsNextProgressRecord = false

    init(
      selected: NavOSSCarPlayTrip,
      preview: [NavOSSCarPlayTrip],
      reroute: [NavOSSCarPlayTrip],
      mode: NavOSSRerouteMode = .adaptive,
      persisting: Bool = false
    ) throws {
      self.mode = mode
      self.preview = preview
      self.reroute = reroute
      defaults = persisting ? UserDefaults(suiteName: suiteName) : nil
      store = defaults.map { NavOSSActiveTripStore(defaults: $0) }
      try session.start(selected)
      store?.save(selected)
    }

    deinit {
      defaults?.removePersistentDomain(forName: suiteName)
    }

    var activeRouteId: String? { session.trip?.id }

    /// The app is killed (the service and its session are gone, the store stays) and launched
    /// again `seconds` later: the stored trip is resumed as `resumePersistedNavigation` does.
    func relaunch(after seconds: TimeInterval) throws {
      time += seconds
      session = NavigationSession()
      consent = NavigationRerouteConsent()
      lastRecord = nil
      lastRecordAt = nil
      relaunchedAt = history.count
      dropsNextProgressRecord = false
      guard let store, let trip = store.load() else { return }
      let resume = store.loadProgress(for: trip)
      try session.start(trip, resume: resume)
      validatesRestoredTrip = resume.isWithheldUntilMatched
    }

    /// What the service writes after a published update (`persistRecordIfDue`).
    private func checkpoint(_ update: NavigationSessionUpdate) {
      let now = Date(timeIntervalSinceReferenceDate: time)
      guard let store, let trip = update.trip, let record = session.record(after: update.snapshot),
        navOSSShouldPersistRecord(
          record, lastPersisted: lastRecord, now: now, lastPersistedAt: lastRecordAt)
      else { return }
      if dropsNextProgressRecord, case .progress = record { return }
      lastRecord = record
      lastRecordAt = now
      store.save(record, forTripId: trip.id)
    }

    func fix(
      _ coordinate: NavigationCoordinate,
      speed: Double? = nil,
      course: Double? = nil,
      accuracy: Double = 5,
      after seconds: TimeInterval
    ) throws {
      time += seconds
      guard session.trip != nil else { return }
      let update = try session.updateLocation(
        NavigationLocationSample(
          coordinate: coordinate, courseDegrees: course, horizontalAccuracyMeters: accuracy,
          speedMetersPerSecond: speed, timestamp: time))
      latest = update
      // A restored trip waiting for its first fixes to be judged publishes nothing but the trip
      // and the raw position, and is not rerouted; one judged off its route is ended.
      if validatesRestoredTrip {
        switch navOSSPersistedNavigationDecision(update.snapshot) {
        case .discard:
          session.clear()
          store?.clear()
          validatesRestoredTrip = false
          endedOffRoute = true
          return
        case .wait:
          history.append((update, nil))
          return
        case .publish:
          validatesRestoredTrip = false
        }
      }
      history.append((update, planner.prompt(for: update, now: time)?.text))
      checkpoint(update)
      let isOffRoute = update.snapshot.phase == .tracking && update.snapshot.isOffRoute
      if isOffRoute { offRouteFixes += 1 }
      switch consent.evaluate(
        mode: mode, isOffRoute: isOffRoute,
        canRequest: isOffRoute && update.snapshot.rawCoordinate != nil, now: time)
      {
      case .request:
        requests += 1
        let hasMatchedRoute = session.hasMatchedRoute
        let alternatives = navigationRerouteAlternatives(
          hasMatchedRoute: hasMatchedRoute, waypointCount: 0)
        let answer = alternatives > 0 ? preview : reroute
        guard let current = session.trip,
          let replacement = navigationReplacement(
            from: answer, closestTo: current, hasMatchedRoute: hasMatchedRoute)
        else { return }
        switch consent.received(
          replacement, mode: mode,
          remainingDurationSeconds: update.guidance?.remainingDurationSeconds,
          remainingDistanceMeters: update.guidance?.remainingDistanceMeters, now: time)
        {
        case .install: try install(replacement)
        case .propose: proposals += 1
        }
      case .installProposal(let proposal):
        try install(proposal.trip)
      case .none, .withdrew, .expired:
        break
      }
    }

    private func install(_ trip: NavOSSCarPlayTrip) throws {
      try session.start(trip)
      store?.save(trip)
      lastRecord = nil
      lastRecordAt = nil
      consent.reset()
      installed.append(trip.id)
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

  private func harness(
    selecting road: String, mode: NavOSSRerouteMode = .adaptive, persisting: Bool = false
  ) throws -> (TripHarness, NavOSSCarPlayTrip) {
    let preview = try Self.trips("square-one-scarborough.v2")
    let reroute = try Self.trips("square-one-scarborough-reroute.v2")
    let selected = try Self.route(preview, via: road)
    return (
      try TripHarness(
        selected: selected, preview: preview, reroute: reroute, mode: mode, persisting: persisting),
      selected
    )
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
          speedMetersPerSecond: snapshot.speedMetersPerSecond, fallback: nil)?.coordinate,
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

  // MARK: Restored after the app was closed

  /// Release validation of main at 82 (`r2-parked2`): the driver chose the third route (QEW and
  /// Gardiner) and tapped Start parked in the mall, 100 m from the road; the app was closed and
  /// opened again where the car still stood. The trip was ended ("Trip ended · … no longer on its
  /// route"). A trip saved before its first match is restored as it was started: the chosen
  /// route, acquiring, silent, with no route request, in every reroute mode; also when the app
  /// was closed before it had a fix.
  func testARestoredTripStartedParkedOffTheRoadKeepsTheChosenRouteAndIsAcquiring() throws {
    for mode in NavOSSRerouteMode.allCases {
      for parkedBeforeClosing in [30, 0] {
        let label = "\(mode), closed after \(parkedBeforeClosing) s"
        let (trip, gardiner) = try harness(
          selecting: "Gardiner Expressway", mode: mode, persisting: true)
        XCTAssertNotEqual(try Self.trips("square-one-scarborough.v2").first?.id, gardiner.id)
        try trip.standStill(at: Self.parked, seconds: parkedBeforeClosing)
        try trip.relaunch(after: 30)
        try trip.standStill(at: Self.parked, seconds: 120)
        XCTAssertFalse(trip.endedOffRoute, "\(label): the driver never left a route")
        XCTAssertEqual(trip.activeRouteId, gardiner.id, label)
        XCTAssertEqual(trip.store?.load()?.id, gardiner.id, "\(label): still the stored trip")
        XCTAssertEqual(trip.requests, 0, "\(label): no replacement is asked for")
        XCTAssertEqual(trip.proposals, 0, label)
        XCTAssertFalse(trip.session.hasMatchedRoute, label)
        assertAcquiring(trip.history[trip.relaunchedAt...], "\(label): restored, parked")
      }
    }
  }

  /// The restored trip then joins its route as a fresh start does: guidance starts at the first
  /// match, on the chosen route, and nothing is asked of the server.
  func testARestoredTripStartedParkedOffTheRoadJoinsTheRouteAndIsGuided() throws {
    let (trip, gardiner) = try harness(selecting: "Gardiner Expressway", persisting: true)
    try trip.standStill(at: Self.parked, seconds: 30)
    try trip.relaunch(after: 30)
    try trip.standStill(at: Self.parked, seconds: 10)
    let parked = trip.history.count
    try trip.drive([Self.parked] + Self.points(gardiner, upToMeters: 3_000), speed: 12)
    XCTAssertFalse(trip.endedOffRoute)
    XCTAssertEqual(trip.requests, 0)
    XCTAssertEqual(trip.activeRouteId, gardiner.id)
    XCTAssertTrue(trip.session.hasMatchedRoute)
    let firstMatch = try XCTUnwrap(
      trip.history.indices.first { trip.history[$0].update.snapshot.matchedCoordinate != nil })
    assertAcquiring(trip.history[parked..<firstMatch], "restored, driving to the road")
    XCTAssertTrue(
      trip.history[firstMatch...].contains { $0.prompt != nil }, "guidance is spoken once matched")
    XCTAssertNotNil(trip.latest?.snapshot.matchedCoordinate)
    XCTAssertFalse(try XCTUnwrap(trip.latest).snapshot.isOffRoute)
  }

  /// Restored, then driven away from the route: rerouted under the rules of a fresh start,
  /// within a short distance of moving away, to the alternative closest to the chosen route.
  func testARestoredTripStartedParkedOffTheRoadThenDrivenAwayIsRerouted() throws {
    let (trip, gardiner) = try harness(selecting: "Gardiner Expressway", persisting: true)
    try trip.standStill(at: Self.parked, seconds: 30)
    try trip.relaunch(after: 30)
    try trip.standStill(at: Self.parked, seconds: 10)
    XCTAssertEqual(trip.requests, 0)
    var position = Self.parked
    var driven = 0.0
    while trip.requests == 0, driven < 400 {
      let next = Self.offset(position, east: 0, north: -10)
      try trip.fix(next, speed: 10, course: 180, after: 1)
      position = next
      driven += 10
    }
    XCTAssertFalse(trip.endedOffRoute)
    XCTAssertEqual(trip.requests, 1)
    XCTAssertLessThanOrEqual(driven, 120, "rerouted soon after moving away")
    XCTAssertEqual(trip.installed, [gardiner.id])
  }

  /// The car was moved while the app was closed. A few metres across the lot changes nothing.
  /// Kilometres away from the route, the restored trip is judged against how close the car had
  /// come before the app closed, as if it had been running: the car has gone away from the
  /// route, so it is rerouted from where it now is (once: the replacement starts there), not
  /// left acquiring a route it is no longer near, and not ended.
  func testARestoredTripMovedWhileTheAppWasClosedIsJudgedFromBeforeIt() throws {
    let (nearby, gardiner) = try harness(selecting: "Gardiner Expressway", persisting: true)
    try nearby.standStill(at: Self.parked, seconds: 30)
    try nearby.relaunch(after: 60)
    try nearby.standStill(at: Self.offset(Self.parked, east: 30, north: 0), seconds: 60)
    XCTAssertFalse(nearby.endedOffRoute)
    XCTAssertEqual(nearby.requests, 0)
    XCTAssertEqual(nearby.activeRouteId, gardiner.id)

    let (far, _) = try harness(selecting: "Gardiner Expressway", persisting: true)
    try far.standStill(at: Self.parked, seconds: 30)
    try far.relaunch(after: 600)
    let moved = Self.offset(Self.parked, east: 0, north: -3_000)
    try far.standStill(at: moved, seconds: 8)
    XCTAssertFalse(far.endedOffRoute)
    XCTAssertEqual(far.requests, 1, "three fixes 3 km from a route the car had come within 100 m of")
    try far.standStill(at: moved, seconds: 120)
    XCTAssertEqual(far.requests, 1, "the replacement starts where the car stands")
  }

  /// A trip that had matched its route before the app was closed, restored somewhere off it
  /// (here back in the mall), is still ended as before.
  func testAMatchedTripRestoredOffItsRouteIsStillEnded() throws {
    let (trip, _) = try harness(selecting: "Gardiner Expressway", persisting: true)
    let gardiner = try XCTUnwrap(trip.session.trip)
    try trip.standStill(at: Self.parked, seconds: 10)
    try trip.drive([Self.parked] + Self.points(gardiner, upToMeters: 3_000), speed: 12)
    XCTAssertTrue(trip.session.hasMatchedRoute)
    try trip.relaunch(after: 60)
    try trip.standStill(at: Self.parked, seconds: 10)
    XCTAssertTrue(trip.endedOffRoute)
    XCTAssertNil(trip.activeRouteId)
    XCTAssertNil(trip.store?.load())
    XCTAssertEqual(trip.requests, 0)
  }

  /// A trip that had matched its route, restored on it further along, resumes as before.
  func testAMatchedTripRestoredOnItsRouteResumes() throws {
    let (trip, gardiner) = try harness(selecting: "Gardiner Expressway", persisting: true)
    try trip.standStill(at: Self.parked, seconds: 10)
    let first = Self.points(gardiner, upToMeters: 3_000)
    try trip.drive([Self.parked] + first, speed: 12)
    try trip.relaunch(after: 20)
    let rest = Array(Self.points(gardiner, upToMeters: 6_000).dropFirst(first.count - 1))
    try trip.drive(rest, speed: 12)
    XCTAssertFalse(trip.endedOffRoute)
    XCTAssertEqual(trip.requests, 0)
    XCTAssertEqual(trip.activeRouteId, gardiner.id)
    XCTAssertTrue(trip.session.hasMatchedRoute)
    XCTAssertTrue(trip.history[trip.relaunchedAt...].contains { $0.prompt != nil })
    let snapshot = try XCTUnwrap(trip.latest?.snapshot)
    XCTAssertNotNil(snapshot.matchedCoordinate)
    XCTAssertEqual(
      snapshot.routeProgress * (trip.session.routeLengthMeters ?? 0), 6_000, accuracy: 200)
  }

  // MARK: A first match that fits more than one pass

  /// A hairpin: 140 m north, 20 m east, then south past the start on the return arm 20 m from
  /// the outbound one, and east to the destination. A fix on either arm fits both.
  private static let hairpin: [(Double, Double)] = [
    (0, 0), (0, 140), (20, 140), (20, -600), (600, -600),
  ]

  private static func legTrip(
    _ corners: [(Double, Double)], stops: [(Double, Double)] = []
  ) -> NavOSSCarPlayTrip {
    func carPlay(_ points: [NavigationCoordinate]) -> [NavOSSCarPlayCoordinate] {
      points.map { NavOSSCarPlayCoordinate(latitude: $0.latitude, longitude: $0.longitude) }
    }
    var steps: [NavOSSCarPlayRouteStep] = []
    for (index, (start, end)) in zip(corners, corners.dropFirst()).enumerated() {
      let length = hypot(end.0 - start.0, end.1 - start.1)
      steps.append(
        NavOSSCarPlayRouteStep(
          distanceMeters: length, durationSeconds: length / 10,
          geometry: carPlay(NavigationTrace.route([start, end])),
          instruction: index == 0 ? "Head north" : "Turn \(index == 3 ? "left" : "right")",
          maneuverType: index == 0 ? "depart" : "turn", roadName: "Hairpin \(index)"))
    }
    let last = corners[corners.count - 1]
    let end = NavigationTrace.coordinate(last.0, last.1)
    steps.append(
      NavOSSCarPlayRouteStep(
        distanceMeters: 0, durationSeconds: 0, geometry: carPlay([end, end]),
        instruction: "Arrive", maneuverType: "arrive", roadName: ""))
    return NavOSSCarPlayTrip(
      destination: NavOSSCarPlayDestination(
        id: "d", label: "d", latitude: end.latitude, longitude: end.longitude, name: "d"),
      distanceMeters: steps.reduce(0) { $0 + $1.distanceMeters },
      durationSeconds: steps.reduce(0) { $0 + $1.durationSeconds },
      geometry: carPlay(NavigationTrace.route(corners)), id: "hairpin", steps: steps,
      waypoints: stops.isEmpty
        ? nil
        : stops.enumerated().map { index, stop in
          let point = NavigationTrace.coordinate(stop.0, stop.1)
          return NavOSSCarPlayDestination(
            id: "stop-\(index)", label: "Stop \(index)", latitude: point.latitude,
            longitude: point.longitude, name: "Stop \(index)")
        })
  }

  private func along(_ trip: TripHarness) -> Double? {
    trip.latest.flatMap { update in
      update.snapshot.matchedCoordinate.map { _ in
        update.snapshot.routeProgress * (trip.session.routeLengthMeters ?? 0)
      }
    }
  }

  /// Stopped halfway down the return arm, then driving south on it: nothing is matched,
  /// guided or spoken from the outbound arm, and once the heading tells the arms apart the
  /// return arm is matched and guided.
  private func assertJoinsTheReturnArm(
    _ trip: TripHarness, _ label: String, stoppedAt stop: Double = 70,
    file: StaticString = #filePath, line: UInt = #line
  ) throws {
    let stopped = trip.history.count
    for _ in 0..<15 {
      try trip.fix(NavigationTrace.coordinate(20, stop), speed: 0, after: 2)
    }
    assertAcquiring(trip.history[stopped...], "\(label): stopped on the return arm", file: file, line: line)
    var y = stop
    while along(trip) == nil, y > -200 {
      y -= 10
      try trip.fix(NavigationTrace.coordinate(20, y), speed: 10, course: 180, after: 1)
    }
    let joined = try XCTUnwrap(along(trip), label, file: file, line: line)
    XCTAssertGreaterThan(joined, 160, "\(label): matched on the return arm", file: file, line: line)
    while y > -500 {
      y -= 10
      try trip.fix(NavigationTrace.coordinate(20, y), speed: 10, course: 180, after: 1)
    }
    XCTAssertTrue(
      trip.history[stopped...].contains { $0.prompt != nil }, "\(label): guided once matched",
      file: file, line: line)
    XCTAssertFalse(trip.endedOffRoute, label, file: file, line: line)
    XCTAssertEqual(trip.requests, 0, label, file: file, line: line)
  }

  /// Review of this change: started parked off the road, closed before the first match; while
  /// the app was closed the car was moved onto the return arm of a hairpin. Its stopped fixes
  /// fit both arms; the outbound arm must not be taken for it.
  /// A restored trip trusts no stretch of the route, not even its beginning: stopped on the
  /// return arm beside the route's first 20 m is not matched there either.
  func testARestoredTripOnTheReturnArmOfAHairpinIsNotPlacedOnTheOutboundArm() throws {
    let selected = Self.legTrip(Self.hairpin)
    let replacement = try Self.trips("square-one-scarborough-reroute.v2")
    for stop in [70.0, 20.0] {
      let trip = try TripHarness(
        selected: selected, preview: [selected], reroute: replacement, persisting: true)
      try trip.standStill(at: NavigationTrace.coordinate(-100, 0), seconds: 20)
      try trip.relaunch(after: 120)
      try assertJoinsTheReturnArm(trip, "restored, stopped at \(stop)", stoppedAt: stop)
    }
  }

  /// The same exposure without a relaunch: the route was asked for at its start, and the
  /// trip's first fix is on the return arm (the car was moved after the preview, before Start,
  /// or location came back only there). A first fix at the route's beginning is where the
  /// route was asked for: one there that also fits the return arm is matched at once.
  func testAFreshStartFirstPlacedOnTheReturnArmOfAHairpinIsNotPlacedOnTheOutboundArm() throws {
    let selected = Self.legTrip(Self.hairpin)
    let replacement = try Self.trips("square-one-scarborough-reroute.v2")
    let trip = try TripHarness(selected: selected, preview: [selected], reroute: replacement)
    try assertJoinsTheReturnArm(trip, "fresh")

    let atStart = try TripHarness(selected: selected, preview: [selected], reroute: replacement)
    try atStart.fix(NavigationTrace.coordinate(0, 10), speed: 0, after: 1)
    XCTAssertEqual(try XCTUnwrap(along(atStart)), 10, accuracy: 2, "matched at once at the start")
  }

  /// Review of this change: the first match is followed by its progress record, and the app is
  /// killed between the two (injected here: the record is not written). The trip is restored
  /// as one before its first match, so it is placed only on a pass a fix identifies.
  func testATripKilledBeforeItsFirstMatchWasRecordedIsPlacedConservatively() throws {
    let selected = Self.legTrip(Self.hairpin)
    let replacement = try Self.trips("square-one-scarborough-reroute.v2")
    let trip = try TripHarness(
      selected: selected, preview: [selected], reroute: replacement, persisting: true)
    try trip.standStill(at: NavigationTrace.coordinate(-100, 0), seconds: 10)
    trip.dropsNextProgressRecord = true
    try trip.drive(
      [NavigationTrace.coordinate(-100, 0), NavigationTrace.coordinate(0, 0),
        NavigationTrace.coordinate(0, 60)], speed: 10)
    XCTAssertTrue(trip.session.hasMatchedRoute)
    guard case .beforeFirstMatch = try XCTUnwrap(trip.store).loadProgress(for: selected) else {
      return XCTFail("the first match's record was not dropped")
    }
    try trip.relaunch(after: 60)
    try assertJoinsTheReturnArm(trip, "killed between the match and its record")
  }

  /// Re-review of this change: 6 km north to 50 m short of a turn, 20 m east, and 50 m back
  /// south to the destination, across the carriageway from the outbound side. Stopped fixes at
  /// the outbound side fit both passes; the outbound one is past 98% of the route and within
  /// 30 m of the destination. They must not arrive, restored or fresh; driving round does.
  func testAnUnidentifiedFixBesideTheDestinationDoesNotArrive() throws {
    let selected = Self.legTrip([(0, -6_000), (0, 50), (20, 50), (20, 0)])
    let replacement = try Self.trips("square-one-scarborough-reroute.v2")
    for restored in [true, false] {
      let label = restored ? "restored" : "fresh"
      let trip = try TripHarness(
        selected: selected, preview: [selected], reroute: replacement, persisting: restored)
      if restored {
        try trip.standStill(at: NavigationTrace.coordinate(-100, -6_000), seconds: 10)
        try trip.relaunch(after: 600)
      }
      let stopped = trip.history.count
      for _ in 0..<10 {
        try trip.fix(NavigationTrace.coordinate(0, 0), speed: 0, after: 2)
      }
      XCTAssertFalse(
        trip.history[stopped...].contains { $0.update.snapshot.phase == .arrived }, label)
      assertAcquiring(trip.history[stopped...], "\(label): stopped beside the destination")
      try trip.drive(
        [NavigationTrace.coordinate(0, 0), NavigationTrace.coordinate(0, 50),
          NavigationTrace.coordinate(20, 50), NavigationTrace.coordinate(20, 0)], speed: 5)
      for _ in 0..<3 {
        try trip.fix(NavigationTrace.coordinate(20, 0), speed: 0, after: 1)
      }
      XCTAssertEqual(trip.latest?.snapshot.phase, .arrived, "\(label): arrives once driven round")
      XCTAssertEqual(trip.requests, 0, label)
    }
  }

  /// Re-review of this change: restored before its first match onto the hairpin's return arm,
  /// and followed south on it slowly (2 m/s, a fix every 15 s, no heading). Each fix fits both
  /// arms and is held; none may count as backward travel against the outbound arm that a held
  /// fix was guessed onto, so nothing is rerouted. Faster, the heading picks the return arm.
  func testFollowingTheReturnArmSlowlyBeforeTheFirstMatchIsNotADeparture() throws {
    let selected = Self.legTrip(Self.hairpin)
    let replacement = try Self.trips("square-one-scarborough-reroute.v2")
    let trip = try TripHarness(
      selected: selected, preview: [selected], reroute: replacement, persisting: true)
    try trip.standStill(at: NavigationTrace.coordinate(-100, 0), seconds: 20)
    try trip.relaunch(after: 120)
    let slow = trip.history.count
    for y in [110.0, 80, 50, 20] {
      try trip.fix(NavigationTrace.coordinate(20, y), speed: 2, after: 15)
    }
    assertAcquiring(trip.history[slow...], "following the return arm slowly")
    XCTAssertEqual(trip.offRouteFixes, 0)
    XCTAssertEqual(trip.requests, 0)
    try trip.drive(
      [NavigationTrace.coordinate(20, 20), NavigationTrace.coordinate(20, -400)], speed: 10)
    XCTAssertGreaterThan(try XCTUnwrap(along(trip)), 160)
    XCTAssertEqual(trip.requests, 0)
  }

  /// Every consumer of a position on the route, for a fix not matched before the first match
  /// (held as unidentified, too poor to place, or off the road), restored and fresh: none is
  /// fed from the guessed projection.
  /// - snapshot: no matched position, course, geometry segment or progress, not off route;
  /// - road context (current road, speed limit, so speeding) unknown;
  /// - guidance: the route's first step, with its full distance (so the "then" maneuver, lane
  ///   guidance and CarPlay's estimates are the route's start, never a guessed step);
  /// - speech: no maneuver prompt;
  /// - arrival: never;
  /// - checkpoint: not a progress checkpoint; the trip record stays "before the first match",
  ///   and there is no resume context (no anchor);
  /// - dead reckoning: none;
  /// - safety cameras and road-report alerts, which require a matched position (asserted nil);
  /// - CarPlay's position: the raw fix (`assertAcquiring`).
  /// The rerouting rules before the first match still see the fix (tested above).
  func testAFixNotMatchedBeforeTheFirstMatchFeedsNothingFromItsGuess() throws {
    let replacement = try Self.trips("square-one-scarborough-reroute.v2")
    let hairpin = Self.legTrip(Self.hairpin)
    let besideDestination = Self.legTrip([(0, -6_000), (0, 50), (20, 50), (20, 0)])
    let scenarios: [(String, NavOSSCarPlayTrip, [(x: Double, y: Double, accuracy: Double)])] = [
      ("return arm", hairpin, [(20, 70, 5), (20, 40, 5), (20, 10, 5), (20, -20, 5)]),
      ("too poor", hairpin, [(20, 70, 400), (0, 70, 400)]),
      ("off the road", hairpin, [(-100, 70, 5), (-100, 40, 5)]),
      ("beside the destination", besideDestination, [(0, 0, 5), (0, 0, 5), (0, 0, 5)]),
    ]
    for (name, selected, fixes) in scenarios {
      for restored in [true, false] {
        let label = "\(name), \(restored ? "restored" : "fresh")"
        let trip = try TripHarness(
          selected: selected, preview: [selected], reroute: replacement, persisting: restored)
        if restored {
          try trip.relaunch(after: 60)
        }
        let first = try XCTUnwrap(selected.steps.first)
        let start = trip.history.count
        for fix in fixes {
          try trip.fix(
            NavigationTrace.coordinate(fix.x, fix.y), speed: 2, accuracy: fix.accuracy, after: 15)
          let update = try XCTUnwrap(trip.latest, label)
          XCTAssertFalse(update.snapshot.isOffRoute, label)
          XCTAssertNotEqual(update.snapshot.phase, .arrived, label)
          XCTAssertEqual(update.guidance?.stepIndex, 0, label)
          XCTAssertEqual(
            update.guidance?.distanceToManeuverMeters ?? 0, first.distanceMeters, accuracy: 1,
            label)
          XCTAssertFalse(navOSSIsProgressCheckpoint(update.snapshot), label)
          if case .progress = trip.session.record(after: update.snapshot) {
            XCTFail("\(label): a progress record")
          }
          XCTAssertNil(trip.session.resumeContext, label)
          XCTAssertNil(trip.session.deadReckon(at: trip.time + 3), label)
          XCTAssertFalse(trip.session.hasMatchedRoute, label)
        }
        assertAcquiring(trip.history[start...], label)
        XCTAssertEqual(trip.requests, 0, label)
      }
    }
  }

  // MARK: Routes that use a road more than once

  /// A multi-stop route that drives the same road north twice: a 1 km square loop through two
  /// stops back to the origin, then on north.
  private static let loop: [(Double, Double)] = [
    (0, 0), (0, 1_000), (1_000, 1_000), (1_000, 0), (0, 0), (0, 2_000),
  ]

  private static func loopTrip() -> NavOSSCarPlayTrip {
    legTrip(loop, stops: [(1_000, 1_000), (1_000, 0)])
  }

  private static func points(_ corners: [(Double, Double)]) -> [NavigationCoordinate] {
    corners.map { NavigationTrace.coordinate($0.0, $0.1) }
  }

  /// Along-route position of the first matched update after `index`, and the index of it.
  private func firstMatch(_ trip: TripHarness, after index: Int) -> (along: Double, index: Int)? {
    guard let found = trip.history.indices.first(where: {
      $0 >= index && trip.history[$0].update.snapshot.matchedCoordinate != nil
    }) else { return nil }
    let snapshot = trip.history[found].update.snapshot
    return (snapshot.routeProgress * (trip.session.routeLengthMeters ?? 0), found)
  }

  /// Re-review of this change: parked 100 m off the road, a fresh start joins the loop route at
  /// its origin. The first pass is matched on the first fixes on the road, and the trip is
  /// guided round the loop through its stops and on north, with no route request.
  func testAFreshStartParkedOffTheRoadJoiningALoopAtItsOriginMatchesTheFirstPass() throws {
    let selected = Self.loopTrip()
    let replacement = try Self.trips("square-one-scarborough-reroute.v2")
    let trip = try TripHarness(selected: selected, preview: [selected], reroute: replacement)
    try trip.standStill(at: NavigationTrace.coordinate(-100, 0), seconds: 20)
    let joining = trip.history.count
    try trip.drive(Self.points([(-100, 0), (0, 0)]), speed: 5)
    let onRoad = trip.history.count
    try trip.drive(Self.points([(0, 0), (0, 1_000)]), speed: 12)
    let first = try XCTUnwrap(firstMatch(trip, after: joining))
    XCTAssertLessThan(first.along, 60, "the first pass")
    XCTAssertLessThanOrEqual(first.index, onRoad + 1, "on the first fixes on the road")
    try trip.drive(Self.points(Array(Self.loop[1...4]) + [(0, 1_500)]), speed: 12)
    let steps = Set(trip.history[first.index...].compactMap { $0.update.guidance?.stepIndex })
    XCTAssertTrue(steps.isSuperset(of: [0, 1, 2, 3, 4]), "\(steps)")
    XCTAssertEqual(try XCTUnwrap(along(trip)), 5_500, accuracy: 60)
    XCTAssertEqual(trip.requests, 0)
  }

  /// Joined at the origin, then straight on past the loop's first turn: off the route and
  /// rerouted, never placed on the later pass of the shared road (which would skip the loop and
  /// its stops).
  func testAFreshStartThatMissesTheLoopIsReroutedNotSkippedAhead() throws {
    let selected = Self.loopTrip()
    let replacement = try Self.trips("square-one-scarborough-reroute.v2")
    let trip = try TripHarness(selected: selected, preview: [selected], reroute: replacement)
    try trip.standStill(at: NavigationTrace.coordinate(-100, 0), seconds: 20)
    try trip.drive(Self.points([(-100, 0), (0, 0), (0, 1_400)]), speed: 12)
    XCTAssertGreaterThanOrEqual(trip.requests, 1)
    let beforeReroute = trip.history.prefix { !$0.update.snapshot.isOffRoute }
    XCTAssertFalse(
      beforeReroute.contains {
        $0.update.snapshot.matchedCoordinate != nil
          && $0.update.snapshot.routeProgress * selected.distanceMeters > 1_100
      }, "skipped to the later pass")
  }

  /// Restored before its first match with the car stopped at the loop's origin: the shared
  /// road is driven in one direction, so the stopped fix is on that road whichever pass, and is
  /// matched to the first one; guided round the loop as before.
  func testARestoredTripAtTheOriginOfALoopIsMatchedToTheFirstPass() throws {
    let selected = Self.loopTrip()
    let replacement = try Self.trips("square-one-scarborough-reroute.v2")
    let trip = try TripHarness(
      selected: selected, preview: [selected], reroute: replacement, persisting: true)
    try trip.standStill(at: NavigationTrace.coordinate(-100, 0), seconds: 20)
    try trip.relaunch(after: 120)
    let restored = trip.history.count
    for _ in 0..<3 {
      try trip.fix(NavigationTrace.coordinate(0, 10), speed: 0, after: 2)
    }
    let first = try XCTUnwrap(firstMatch(trip, after: restored))
    XCTAssertEqual(first.along, 10, accuracy: 5)
    try trip.drive(Self.points(Array(Self.loop[0...4]) + [(0, 1_500)]), speed: 12)
    XCTAssertEqual(try XCTUnwrap(along(trip)), 5_500, accuracy: 60)
    XCTAssertEqual(trip.requests, 0)
  }

  /// Other shapes that use a road twice, fresh (parked off the road, next placeable at a point
  /// two passes share) and restored before the first match: where the passes are the same road in the same direction the first is taken
  /// at once; where they differ (opposite directions of a two-way street, crossing roads) a
  /// stopped fix is held and the moving vehicle's heading picks the pass.
  func testRoutesThatUseARoadTwice() throws {
    let replacement = try Self.trips("square-one-scarborough-reroute.v2")
    struct Case {
      let name: String
      let corners: [(Double, Double)]
      let parked: (Double, Double)
      let stop: (Double, Double)
      let heldWhileStopped: Bool
      let moveTo: (Double, Double)
      let along: ClosedRange<Double>
    }
    let outAndBack: [(Double, Double)] = [(0, 0), (0, 1_000), (0, 0), (600, 0)]
    let passesStart: [(Double, Double)] = [
      (0, 0), (0, 500), (500, 500), (500, -500), (0, -500), (0, 0), (0, 1_500),
    ]
    let figureEight: [(Double, Double)] = [
      (0, 0), (0, 1_000), (500, 1_000), (500, 500), (-500, 500), (-500, -300), (300, -300),
    ]
    let cases = [
      // Opposite directions of one street: held until the heading says which.
      Case(name: "out and back, north", corners: outAndBack, parked: (-100, 500), stop: (0, 500),
        heldWhileStopped: true, moveTo: (0, 700), along: 500...720),
      Case(name: "out and back, south", corners: outAndBack, parked: (-100, 500), stop: (0, 500),
        heldWhileStopped: true, moveTo: (0, 300), along: 1_480...1_720),
      // Back through its own start in the same direction: the first pass at once.
      Case(name: "passes its start", corners: passesStart, parked: (-100, 0), stop: (0, 10),
        heldWhileStopped: false, moveTo: (0, 200), along: 0...220),
      // Crossing roads: held until the heading says which.
      Case(name: "figure eight, north", corners: figureEight, parked: (-100, 400),
        stop: (0, 500), heldWhileStopped: true, moveTo: (0, 700), along: 500...720),
      Case(name: "figure eight, west", corners: figureEight, parked: (-100, 400),
        stop: (0, 500), heldWhileStopped: true, moveTo: (-200, 500), along: 2_480...2_720),
    ]
    for item in cases {
      for restored in [false, true] {
        let label = "\(item.name), \(restored ? "restored" : "fresh")"
        let selected = Self.legTrip(item.corners)
        let trip = try TripHarness(
          selected: selected, preview: [selected], reroute: replacement, persisting: restored)
        try trip.standStill(
          at: NavigationTrace.coordinate(item.parked.0, item.parked.1), seconds: 20)
        if restored {
          try trip.relaunch(after: 120)
        }
        // The next usable fix is on the road (moved while the app was closed, or with fixes
        // too poor to place the vehicle on the way).
        let stopped = trip.history.count
        for _ in 0..<5 {
          try trip.fix(NavigationTrace.coordinate(item.stop.0, item.stop.1), speed: 0, after: 2)
        }
        if item.heldWhileStopped {
          assertAcquiring(trip.history[stopped...], "\(label): stopped")
        } else {
          XCTAssertNotNil(trip.latest?.snapshot.matchedCoordinate, "\(label): matched stopped")
        }
        try trip.drive(Self.points([item.stop, item.moveTo]), speed: 10)
        let along = try XCTUnwrap(along(trip), label)
        XCTAssertTrue(item.along.contains(along), "\(label): \(along)")
        XCTAssertEqual(trip.requests, 0, label)
      }
    }
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
