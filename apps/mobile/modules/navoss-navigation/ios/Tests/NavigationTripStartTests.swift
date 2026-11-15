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
    let session = NavigationSession()
    var consent = NavigationRerouteConsent()
    let mode: NavOSSRerouteMode
    let preview: [NavOSSCarPlayTrip]
    let reroute: [NavOSSCarPlayTrip]
    private(set) var requests = 0
    private(set) var proposals = 0
    private(set) var installed: [String] = []
    private(set) var offRouteFixes = 0
    private(set) var latest: NavigationSessionUpdate?
    var time = NavigationTripStartTests.startTime

    init(
      selected: NavOSSCarPlayTrip,
      preview: [NavOSSCarPlayTrip],
      reroute: [NavOSSCarPlayTrip],
      mode: NavOSSRerouteMode = .adaptive
    ) throws {
      self.mode = mode
      self.preview = preview
      self.reroute = reroute
      try session.start(selected)
    }

    var activeRouteId: String? { session.trip?.id }

    func fix(
      _ coordinate: NavigationCoordinate,
      speed: Double? = nil,
      course: Double? = nil,
      accuracy: Double = 5,
      after seconds: TimeInterval
    ) throws {
      time += seconds
      let update = try session.updateLocation(
        NavigationLocationSample(
          coordinate: coordinate, courseDegrees: course, horizontalAccuracyMeters: accuracy,
          speedMetersPerSecond: speed, timestamp: time))
      latest = update
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

  /// Ten minutes parked off the road with the fix wandering never adds up to travel: half a
  /// metre (the simulator), and within 15 m in every direction (a poor sky view).
  func testTenMinutesParkedOffTheRoadWithJitterIsNeverRerouted() throws {
    for (jitter, accuracy) in [(0.5, 5.0), (15.0, 10.0), (15.0, 5.0)] {
      let (trip, express) = try harness(selecting: "Highway 401 Express")
      var generator = SplitMix64(seed: 7)
      for _ in 0..<600 {
        let angle = Double(generator.next() % 3_600) / 3_600 * 2 * .pi
        let radius = jitter * Double(generator.next() % 1_000) / 1_000
        try trip.fix(
          Self.offset(Self.parked, east: radius * cos(angle), north: radius * sin(angle)),
          accuracy: accuracy, after: 1)
      }
      XCTAssertEqual(trip.requests, 0, "jitter \(jitter) m, accuracy \(accuracy) m")
      XCTAssertEqual(trip.offRouteFixes, 0, "jitter \(jitter) m, accuracy \(accuracy) m")
      XCTAssertEqual(trip.activeRouteId, express.id)
    }
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
