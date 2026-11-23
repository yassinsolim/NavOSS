import Foundation
import XCTest

@testable import NavOSSNavigationCore

/// Repeated departures through `NavigationEngine`, against a router double that answers like
/// Valhalla on a street grid: from where the vehicle is, in the direction it is heading (or,
/// without a heading, the way the road happens to point), to the next intersection, then back to
/// the chosen road and on.
///
/// The grid, in the local metre frame (`NavigationTrace`): north-south avenues every 200 m
/// (x = 0, 200, 400 ...), east-west streets every 200 m (y = 0, 200 ...). The chosen route runs
/// north up x = 0 to y = 3 600, then east to the destination at (600, 3 600).
final class NavigationRerouteBackoffTests: XCTestCase {
  private typealias Trace = NavigationTrace

  static let block = 200.0
  static let destination = (600.0, 3_600.0)
  static let startTime: TimeInterval = 800_000_000

  // MARK: Routes

  private static func carPlay(_ coordinates: [NavigationCoordinate]) -> [NavOSSCarPlayCoordinate] {
    coordinates.map { NavOSSCarPlayCoordinate(latitude: $0.latitude, longitude: $0.longitude) }
  }

  private static func course(_ from: (Double, Double), _ to: (Double, Double)) -> Double {
    (atan2(to.0 - from.0, to.1 - from.1) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
  }

  private static func roadName(_ from: (Double, Double), _ to: (Double, Double)) -> String {
    abs(to.0 - from.0) < abs(to.1 - from.1)
      ? "Avenue \(Int((from.0 / block).rounded()))" : "Street \(Int((from.1 / block).rounded()))"
  }

  /// A route along `corners` with a step per leg, as the router answers.
  static func trip(id: String, corners: [(Double, Double)]) -> NavOSSCarPlayTrip {
    var steps: [NavOSSCarPlayRouteStep] = []
    let legs = Array(zip(corners, corners.dropFirst())).filter {
      hypot($0.1.0 - $0.0.0, $0.1.1 - $0.0.1) > 0.5
    }
    for (index, (start, end)) in legs.enumerated() {
      let length = hypot(end.0 - start.0, end.1 - start.1)
      let road = roadName(start, end)
      let instruction: String
      let type: String
      if index == 0 {
        instruction = "Head along \(road)"
        type = "depart"
      } else {
        let before = course(legs[index - 1].0, legs[index - 1].1)
        let turn = (course(start, end) - before + 360).truncatingRemainder(dividingBy: 360)
        let side = turn > 135 && turn < 225 ? "Make a U-turn" : turn < 180 ? "Turn right" : "Turn left"
        instruction = "\(side) onto \(road)"
        type = "turn"
      }
      steps.append(
        NavOSSCarPlayRouteStep(
          distanceMeters: length, durationSeconds: length / 12,
          geometry: carPlay(Trace.route([start, end])), instruction: instruction,
          maneuverType: type, roadName: road))
    }
    let last = corners[corners.count - 1]
    steps.append(
      NavOSSCarPlayRouteStep(
        distanceMeters: 0, durationSeconds: 0, geometry: carPlay(Trace.route([last, last])),
        instruction: "You have arrived", maneuverType: "arrive", roadName: ""))
    let destination = Trace.coordinate(last.0, last.1)
    return NavOSSCarPlayTrip(
      destination: NavOSSCarPlayDestination(
        id: "grid-destination", label: "Grid", latitude: destination.latitude,
        longitude: destination.longitude, name: "Grid"),
      distanceMeters: steps.reduce(0) { $0 + $1.distanceMeters },
      durationSeconds: steps.reduce(0) { $0 + $1.durationSeconds },
      geometry: carPlay(Trace.route(corners)), id: id, steps: steps)
  }

  static let chosenCorners: [(Double, Double)] = [(0, 0), (0, 3_600), destination]

  /// The router double on the grid. `heading` picks the direction along the road the origin is
  /// on; without one the router takes the road's other direction (a route that starts with a
  /// U-turn), which is what a router does with no heading on a two-way street often enough.
  static func gridRoute(from origin: NavOSSCarPlayCoordinate, heading: Double?) -> [(Double, Double)] {
    let p = Trace.local(NavigationCoordinate(latitude: origin.latitude, longitude: origin.longitude))
    let avenue = (p.x / block).rounded() * block
    let street = (p.y / block).rounded() * block
    let onAvenue = abs(p.x - avenue) <= abs(p.y - street)
    var corners: [(Double, Double)] = []
    if onAvenue {
      let north: Bool = heading.map { cos($0 * .pi / 180) >= 0 } ?? false
      if avenue == 0, north {
        corners = [(0, p.y)]
      } else if north {
        let next = ((p.y + 60) / block).rounded(.up) * block
        corners = [(avenue, p.y), (avenue, next), (0, next)]
      } else {
        let previous = ((p.y - 60) / block).rounded(.down) * block
        corners = avenue == 0
          ? [(0, p.y), (0, previous), (block, previous), (block, previous + block), (0, previous + block)]
          : [(avenue, p.y), (avenue, previous), (0, previous)]
      }
    } else {
      let east: Bool = heading.map { sin($0 * .pi / 180) >= 0 } ?? false
      if east {
        let next = ((p.x + 60) / block).rounded(.up) * block
        corners = [(p.x, street), (next, street), (next, street + block), (0, street + block)]
      } else {
        corners = [(p.x, street), (0, street)]
      }
    }
    return corners + [(0, 3_600), destination]
  }

  // MARK: Rig

  final class Rig {
    let clock = EngineTestClock(NavigationRerouteBackoffTests.startTime)
    let host = RecordingEngineHost()
    let network: ScriptedEngineNetwork
    let storeFixture = EngineTripStoreFixture()
    let engine: NavigationEngine
    /// Seconds a reroute answer takes: it lands after this many more fixes.
    var latencyFixes = 1
    /// Whether the host gives the router the vehicle's heading.
    var sendsHeading = true
    private(set) var requests = 0
    private(set) var installs: [String] = []
    private var lastRequest: Task<Void, Never>?
    private var pending: (task: Task<Void, Never>, dueAfter: Int)?
    private var fixCount = 0
    var timeline: [String] = []

    init(
      mode: NavOSSRerouteMode = .adaptive,
      answer: @escaping (ScriptedEngineNetwork.Request) throws -> [NavOSSCarPlayTrip]
    ) {
      network = ScriptedEngineNetwork(answer: answer)
      engine = NavigationEngine(
        tripStore: storeFixture.store, audioMode: .allGuidance,
        preferences: NavOSSNavigationPreferences(rerouteMode: mode, speedingAudibleWarning: false),
        network: network, session: NavigationSession(), clock: { [clock] in clock.now })
      engine.host = host
    }

    var state: NavOSSNavigationServiceState { engine.currentState() }
    var spokenManeuvers: [String] { host.spoken.filter { $0.kind == .maneuver }.map(\.text) }
    var spokenAlerts: [String] { host.spoken.filter { $0.kind == .alert }.map(\.text) }

    func start(_ trip: NavOSSCarPlayTrip) throws {
      try engine.startNavigation(trip)
      engine.completePendingSafetyCameraFetch()
    }

    func fix(_ x: Double, _ y: Double, course: Double, speed: Double = 12) throws {
      clock.advance(1)
      fixCount += 1
      let coordinate = Trace.coordinate(x, y)
      host.rerouteOrigin = NavOSSNavigationRouteOrigin(
        coordinate: NavOSSCarPlayCoordinate(
          latitude: coordinate.latitude, longitude: coordinate.longitude),
        headingDegrees: sendsHeading && speed >= 2 ? course : nil, horizontalAccuracyMeters: 5)
      let tripBefore = state.trip?.id
      try engine.ingest(
        NavigationLocationSample(
          coordinate: coordinate, courseDegrees: course, horizontalAccuracyMeters: 5,
          speedMetersPerSecond: speed, timestamp: clock.time))
      if let pending, fixCount >= pending.dueAfter {
        self.pending = nil
        if engine.pendingRerouteTask == pending.task {
          engine.completePendingReroute(through: network)
        }
      }
      if let request = engine.pendingRerouteTask, request != lastRequest {
        timeline.append("t=\(fixCount) request at (\(Int(x)), \(Int(y))) d=\(Int(state.navigation.distanceFromRouteMeters ?? -1))")
        requests += 1
        lastRequest = request
        pending = (request, fixCount + latencyFixes)
      }
      if let trip = state.trip?.id, trip != tripBefore {
        installs.append(trip)
        timeline.append("t=\(fixCount) install \(trip) at (\(Int(x)), \(Int(y)))")
      }
    }

    func drive(_ corners: [(Double, Double)], speed: Double = 12) throws {
      for position in Trace.positions(along: corners, every: speed).dropFirst() {
        try fix(position.x, position.y, course: position.courseDegrees, speed: speed)
      }
    }

    /// Two fixes stopped at `point`, as at a destination.
    func stop(at point: (Double, Double), course: Double) throws {
      for _ in 0..<2 {
        try fix(point.0, point.1, course: course, speed: 0)
      }
    }
  }

  /// A rig on the grid router. `ignoresHeading`: the router starts every route the other way
  /// along the road, whatever heading it is sent.
  private static func gridRig(_ mode: NavOSSRerouteMode = .adaptive, ignoresHeading: Bool = false)
    -> Rig
  {
    var count = 0
    let lock = NSLock()
    return Rig(mode: mode) { request in
      let id = lock.withLock {
        count += 1
        return "grid-\(count)"
      }
      return [
        trip(
          id: id,
          corners: gridRoute(
            from: request.origin, heading: ignoresHeading ? nil : request.originHeadingDegrees))
      ]
    }
  }


  /// Leaves the chosen avenue at y = 400 for the next one east and drives 2.4 km up it before
  /// coming back at y = 2 800 and on to the destination.
  static let straightDetour: [(Double, Double)] = [
    (0, 0), (0, 400), (200, 400), (200, 2_800), (0, 2_800), (0, 3_600), destination,
  ]

  private static let newRouteAnnouncement = "A new route is ready."

  // MARK: The straight detour, in every mode

  /// Before: 12 requests and 12 installs in adaptive mode, the same in keep-route mode, and in
  /// ask-first mode 7 requests, 4 spoken proposals and 3 installs (see the PR).
  func testTheStraightDetourSettlesAfterTwoRoutesInAdaptiveMode() throws {
    let rig = Self.gridRig()
    try rig.start(Self.trip(id: "chosen", corners: Self.chosenCorners))
    try rig.drive(Self.straightDetour)
    XCTAssertEqual(rig.state.navigation.phase, .arrived, rig.timeline.joined(separator: "\n"))
    XCTAssertEqual(rig.requests, 2, rig.timeline.joined(separator: "\n"))
    XCTAssertEqual(rig.installs.count, 2)
    XCTAssertEqual(rig.state.rerouteCount, 2)
    XCTAssertFalse(rig.spokenAlerts.contains(Self.newRouteAnnouncement))
  }

  func testTheStraightDetourInKeepRouteModeRejoinsTwiceAtMost() throws {
    let rig = Self.gridRig(.keepRoute)
    try rig.start(Self.trip(id: "chosen", corners: Self.chosenCorners))
    try rig.drive(Self.straightDetour)
    XCTAssertEqual(rig.state.navigation.phase, .arrived, rig.timeline.joined(separator: "\n"))
    XCTAssertEqual(rig.requests, 2, rig.timeline.joined(separator: "\n"))
    XCTAssertEqual(rig.installs.count, 2)
    XCTAssertEqual(
      rig.network.requests.map(\.passThroughWaypointIds),
      [["navoss-route-rejoin"], ["navoss-route-rejoin"]], "every request rejoins the route ahead")
  }

  /// Nobody answers the proposal (CarPlay, hands on the wheel): it is spoken once, and when it
  /// expires one replacement is installed once the spacing allows, never a proposal per block.
  func testTheStraightDetourInAskFirstModeProposesOnceAndInstallsTheOwedRoute() throws {
    let rig = Self.gridRig(.askFirst)
    try rig.start(Self.trip(id: "chosen", corners: Self.chosenCorners))
    try rig.drive(Self.straightDetour)
    XCTAssertEqual(rig.state.navigation.phase, .arrived, rig.timeline.joined(separator: "\n"))
    XCTAssertEqual(rig.spokenAlerts.filter { $0 == Self.newRouteAnnouncement }.count, 1)
    XCTAssertEqual(rig.requests, 2, rig.timeline.joined(separator: "\n"))
    XCTAssertEqual(rig.installs.count, 1, "the replacement owed for the unanswered proposal")
  }

  func testADeclinedProposalIsNotOfferedAgainWhileTheDriverKeepsBesideTheRoute() throws {
    let rig = Self.gridRig(.askFirst)
    try rig.start(Self.trip(id: "chosen", corners: Self.chosenCorners))
    var declined = false
    for position in Trace.positions(along: Self.straightDetour, every: 12).dropFirst() {
      try rig.fix(position.x, position.y, course: position.courseDegrees)
      if !declined, let proposal = rig.state.rerouteProposal {
        XCTAssertTrue(rig.engine.declineRerouteProposal(id: proposal.id))
        declined = true
      }
    }
    XCTAssertTrue(declined)
    XCTAssertEqual(rig.state.navigation.phase, .arrived)
    XCTAssertEqual(rig.requests, 1, rig.timeline.joined(separator: "\n"))
    XCTAssertEqual(rig.spokenAlerts.filter { $0 == Self.newRouteAnnouncement }.count, 1)
    XCTAssertEqual(rig.installs, [])
  }

  /// A declined proposal stays declined: past the cooldown, the same route from a little further
  /// on is not offered again; a different one is.
  func testTheDeclinedRouteIsNotProposedAgainAfterTheCooldown() throws {
    // The router answers with the declined route each time: the vehicle drives away east.
    let declinedRoute = Self.trip(
      id: "declined", corners: [(0, 400), (200, 400), (200, 600), (0, 600), (0, 3_600), Self.destination])
    let rig = Rig(mode: .askFirst) { _ in [declinedRoute] }
    try rig.start(Self.trip(id: "chosen", corners: Self.chosenCorners))
    try rig.drive([(0, 0), (0, 400)])
    var x = 0.0
    while rig.state.rerouteProposal == nil, x < 300 {
      x += 12
      try rig.fix(x, 400, course: 90)
    }
    let proposal = try XCTUnwrap(rig.state.rerouteProposal, rig.timeline.joined(separator: "\n"))
    XCTAssertTrue(rig.engine.declineRerouteProposal(id: proposal.id))
    try rig.drive([(x, 400), (3_000, 400)])
    XCTAssertGreaterThan(rig.requests, 1, "the driver moving away is asked about again")
    XCTAssertNil(rig.state.rerouteProposal)
    XCTAssertEqual(rig.spokenAlerts.filter { $0 == Self.newRouteAnnouncement }.count, 1)
  }

  /// A deliberate parallel street: the next avenue over for 1.5 km, then back. After the first
  /// route (which turns back at the next street), the driver who keeps going gets one fresh route
  /// along the avenue they are on, 400 m and 20 s later; then nothing more until they rejoin.
  func testADriverOnAParallelStreetGetsOneFreshRouteAlongIt() throws {
    let rig = Self.gridRig()
    try rig.start(Self.trip(id: "chosen", corners: Self.chosenCorners))
    var installs: [(time: TimeInterval, along: Double)] = []
    var before = 0
    let path: [(Double, Double)] = [
      (0, 0), (0, 400), (200, 400), (200, 1_900), (0, 1_900), (0, 3_600), Self.destination,
    ]
    for position in Trace.positions(along: path, every: 12).dropFirst() {
      try rig.fix(position.x, position.y, course: position.courseDegrees)
      if rig.installs.count > before { installs.append((rig.clock.time, position.alongMeters)) }
      before = rig.installs.count
    }
    let log = rig.timeline.joined(separator: "\n")
    XCTAssertEqual(rig.state.navigation.phase, .arrived, log)
    XCTAssertEqual(installs.count, 2, log)
    guard installs.count == 2 else { return }
    XCTAssertLessThanOrEqual(installs[1].along - installs[0].along, 450, log)
    XCTAssertLessThanOrEqual(installs[1].time - installs[0].time, 40, log)
    // The fresh route goes on north up the avenue the driver is on.
    let fresh = try XCTUnwrap(rig.network.requests.last)
    let corners = Self.gridRoute(from: fresh.origin, heading: fresh.originHeadingDegrees)
    XCTAssertEqual(corners[0].0, 200, accuracy: 1)
    XCTAssertGreaterThan(corners[1].1, corners[0].1)
  }

  /// A service road 60 m beside the route: never far enough from it to count as moving away.
  /// The driver still gets one fresh route from where they are once the spacing has passed.
  func testAServiceRoadBesideTheRouteGetsOneFreshRoute() throws {
    var count = 0
    let lock = NSLock()
    let rig = Rig { request in
      let id = lock.withLock {
        count += 1
        return "service-\(count)"
      }
      let p = Trace.local(
        NavigationCoordinate(latitude: request.origin.latitude, longitude: request.origin.longitude))
      let next = ((p.y + 60) / Self.block).rounded(.up) * Self.block
      return [Self.trip(id: id, corners: [(60, p.y), (60, next), (0, next), (0, 3_600), Self.destination])]
    }
    try rig.start(Self.trip(id: "chosen", corners: Self.chosenCorners))
    try rig.drive([(0, 0), (0, 400), (60, 440), (60, 1_900), (0, 1_960), (0, 3_600), Self.destination])
    let log = rig.timeline.joined(separator: "\n")
    XCTAssertEqual(rig.state.navigation.phase, .arrived, log)
    XCTAssertEqual(rig.installs.count, 2, log)
  }

  // MARK: Safety: real departures still reroute

  /// A wrong turn east at y = 400 and on east for 2.4 km, ignoring every route. The first
  /// reroute is immediate; the driver still gets a second and a third route, each later.
  func testAWrongTurnIgnoredTwiceStillGetsAThirdRouteLater() throws {
    let rig = Self.gridRig()
    try rig.start(Self.trip(id: "chosen", corners: Self.chosenCorners))
    var requestYs: [Double] = []
    var installXs: [Double] = []
    var before = (requests: 0, installs: 0)
    for position in Trace.positions(along: [(0, 0), (0, 400), (2_400, 400)], every: 12).dropFirst() {
      try rig.fix(position.x, position.y, course: position.courseDegrees)
      if rig.requests > before.requests { requestYs.append(position.alongMeters) }
      if rig.installs.count > before.installs { installXs.append(position.x) }
      before = (rig.requests, rig.installs.count)
    }
    let log = rig.timeline.joined(separator: "\n")
    XCTAssertEqual(installXs.count, 3, log)
    XCTAssertLessThan(try XCTUnwrap(installXs.first), 100, "the first is not held: " + log)
    guard installXs.count == 3 else { return }
    let gaps = [installXs[1] - installXs[0], installXs[2] - installXs[1]]
    XCTAssertGreaterThanOrEqual(gaps[0], 400, log)
    XCTAssertLessThanOrEqual(gaps[0], 450, "held only for the spacing: " + log)
    XCTAssertGreaterThanOrEqual(gaps[1], 800, log)
    XCTAssertLessThanOrEqual(gaps[1], 850, log)
  }

  /// The freeway: exit at y = 2 000, the next one 3 km on at y = 5 000.
  static let freewayDestination = (300.0, 2_600.0)
  static let freewayCorners: [(Double, Double)] = [(0, 0), (0, 2_000), (300, 2_300), freewayDestination]

  static func freewayRoute(from origin: NavOSSCarPlayCoordinate, heading: Double?) -> [(Double, Double)] {
    let p = Trace.local(NavigationCoordinate(latitude: origin.latitude, longitude: origin.longitude))
    let north = heading.map { cos($0 * .pi / 180) >= 0 } ?? true
    return north
      ? [(0, p.y), (0, 5_000), (300, 5_000), freewayDestination]
      : [(0, p.y), (0, 500), (300, 500), freewayDestination]
  }

  private static func freewayRig() -> Rig {
    var count = 0
    let lock = NSLock()
    return Rig { request in
      let id = lock.withLock {
        count += 1
        return "freeway-\(count)"
      }
      return [trip(id: id, corners: freewayRoute(from: request.origin, heading: request.originHeadingDegrees))]
    }
  }

  func testAMissedFreewayExitReroutesOncePromptly() throws {
    let rig = Self.freewayRig()
    try rig.start(Self.trip(id: "freeway", corners: Self.freewayCorners))
    try rig.drive([(0, 0), (0, 2_000)], speed: 30)
    let missedAt = rig.clock.time
    try rig.drive([(0, 2_000), (0, 5_000), (300, 5_000), Self.freewayDestination], speed: 30)
    try rig.stop(at: Self.freewayDestination, course: 180)
    XCTAssertEqual(rig.state.navigation.phase, .arrived, rig.timeline.joined(separator: "\n"))
    XCTAssertEqual(rig.requests, 1)
    XCTAssertEqual(rig.installs.count, 1)
    let installedAfter = try XCTUnwrap(
      rig.timeline.first { $0.contains("install") }.flatMap { line in
        line.split(separator: " ").first.flatMap { Double($0.dropFirst(2)) }
      })
    // Fixes are counted from the start: the install's fix number less the missed exit's.
    let missedFix = missedAt - Self.startTime
    XCTAssertLessThanOrEqual(installedAfter - missedFix, 6, "rerouted within six seconds")
  }

  func testDrivingAFreewayRouteTheWrongWayReroutesOncePromptly() throws {
    let rig = Self.freewayRig()
    try rig.start(Self.trip(id: "freeway", corners: Self.freewayCorners))
    try rig.drive([(0, 0), (0, 1_200)], speed: 30)
    let turnedAt = rig.clock.time - Self.startTime
    try rig.drive([(0, 1_200), (0, 500), (300, 500), Self.freewayDestination], speed: 30)
    try rig.stop(at: Self.freewayDestination, course: 0)
    XCTAssertEqual(rig.state.navigation.phase, .arrived, rig.timeline.joined(separator: "\n"))
    XCTAssertEqual(rig.requests, 1)
    XCTAssertEqual(rig.installs.count, 1)
    let installedAt = try XCTUnwrap(
      rig.timeline.first { $0.contains("install") }.flatMap { line in
        line.split(separator: " ").first.flatMap { Double($0.dropFirst(2)) }
      })
    XCTAssertLessThanOrEqual(installedAt - turnedAt, 6, rig.timeline.joined(separator: "\n"))
  }

  /// A driver who follows the new route for a while is established on it: leaving it is a new
  /// departure, rerouted at once.
  func testLeavingARouteFollowedForAWhileIsReroutedAtOnce() throws {
    let rig = Self.freewayRig()
    try rig.start(Self.trip(id: "freeway", corners: Self.freewayCorners))
    // Miss the exit, follow the replacement 2 km up the freeway, then miss its exit too.
    try rig.drive([(0, 0), (0, 2_000), (0, 5_000), (0, 5_600)], speed: 30)
    XCTAssertEqual(rig.installs.count, 2, rig.timeline.joined(separator: "\n"))
    let requests = rig.timeline.filter { $0.contains("request") }
    let lastRequestY = try XCTUnwrap(
      requests.last.flatMap { $0.split(separator: ",").last }.flatMap {
        Double($0.split(separator: ")").first?.trimmingCharacters(in: .whitespaces) ?? "")
      })
    XCTAssertLessThan(lastRequestY, 5_150, "the second departure is not held")
  }

  // MARK: Routes that would be left at once, or change nothing

  /// The router ignores the heading and starts each route with a U-turn behind the vehicle.
  /// The driver drives on up the parallel avenue; the U-turn route is given its fair chance and
  /// the trip settles after two routes instead of one every nine seconds (24 before).
  func testAUTurnFirstRouteIsNotReplacedOnItsFirstFixes() throws {
    let rig = Self.gridRig(ignoresHeading: true)
    try rig.start(Self.trip(id: "chosen", corners: Self.chosenCorners))
    try rig.drive(Self.straightDetour)
    XCTAssertEqual(rig.state.navigation.phase, .arrived, rig.timeline.joined(separator: "\n"))
    XCTAssertLessThanOrEqual(rig.installs.count, 2, rig.timeline.joined(separator: "\n"))
  }

  /// With no heading from the platform (a course reported invalid), the request carries the
  /// direction the recent fixes show, so the router need not guess.
  func testARerouteWithoutAPlatformHeadingCarriesTheTrackHeading() throws {
    let rig = Self.gridRig()
    rig.sendsHeading = false
    try rig.start(Self.trip(id: "chosen", corners: Self.chosenCorners))
    try rig.drive([(0, 0), (0, 400), (120, 400)])
    let request = try XCTUnwrap(rig.network.requests.first)
    let heading = try XCTUnwrap(request.originHeadingDegrees)
    XCTAssertEqual(heading, 90, accuracy: 2)
  }

  /// The router answers with the chosen route itself (it snapped the origin onto it). Nothing
  /// is installed, counted, shown as new or said; the driver rejoins and carries on.
  func testAnIdenticalRouteIsNotInstalledOrAnnounced() throws {
    let chosen = Self.trip(id: "chosen", corners: Self.chosenCorners)
    for answer in ["identical", "rejoining"] {
      let rig = Rig { request in
        let p = Trace.local(
          NavigationCoordinate(latitude: request.origin.latitude, longitude: request.origin.longitude))
        return answer == "identical"
          ? [Self.trip(id: "same", corners: Self.chosenCorners)]
          // From the lay-by straight back onto the road and on: the chosen route again.
          : [Self.trip(id: "same", corners: [(p.x, p.y), (0, p.y + 40), (0, 3_600), Self.destination])]
      }
      try rig.start(chosen)
      // A lay-by 50 m east of the avenue for 600 m.
      try rig.drive([(0, 0), (0, 400), (50, 440), (50, 1_000), (0, 1_050), (0, 3_600), Self.destination])
      XCTAssertEqual(rig.state.navigation.phase, .arrived, answer)
      XCTAssertGreaterThanOrEqual(rig.requests, 1, answer)
      XCTAssertEqual(rig.installs, [], answer)
      XCTAssertFalse(rig.spokenAlerts.contains(Self.newRouteAnnouncement), answer)
    }
  }

  /// After a wrong turn the driver ignores the new route too; the router then answers with the
  /// route that was replaced. It is not installed back: it changes nothing the driver was not
  /// already told.
  func testTheRouteJustReplacedIsNotInstalledAgain() throws {
    var calls = 0
    let lock = NSLock()
    let rig = Rig { request in
      let call = lock.withLock {
        calls += 1
        return calls
      }
      return call == 1
        ? [Self.trip(id: "grid-1", corners: Self.gridRoute(from: request.origin, heading: request.originHeadingDegrees))]
        : [Self.trip(id: "chosen-again", corners: Self.chosenCorners)]
    }
    try rig.start(Self.trip(id: "chosen", corners: Self.chosenCorners))
    try rig.drive([(0, 0), (0, 400), (2_400, 400)])
    XCTAssertGreaterThanOrEqual(rig.requests, 2, rig.timeline.joined(separator: "\n"))
    XCTAssertEqual(rig.installs, ["grid-1"])
  }

  /// The control for the above: a different route from the same place is installed.
  func testADifferentRouteFromBesideTheRoadIsInstalled() throws {
    let rig = Rig { request in
      let p = Trace.local(
        NavigationCoordinate(latitude: request.origin.latitude, longitude: request.origin.longitude))
      return [Self.trip(id: "other", corners: [(p.x, p.y), (p.x, 3_600), Self.destination])]
    }
    try rig.start(Self.trip(id: "chosen", corners: Self.chosenCorners))
    try rig.drive([(0, 0), (0, 400), (50, 440), (50, 3_600), Self.destination])
    XCTAssertEqual(rig.installs, ["other"])
  }

  func testTheSameRouteComparison() {
    let chosen = Self.trip(id: "chosen", corners: Self.chosenCorners)
    func same(_ corners: [(Double, Double)]) -> Bool {
      navigationIsMateriallySameRoute(Self.trip(id: "candidate", corners: corners), as: chosen)
    }
    XCTAssertTrue(same(Self.chosenCorners))
    XCTAssertTrue(same([(0, 1_000), (0, 3_600), Self.destination]), "what is left of it")
    XCTAssertTrue(same([(40, 1_000), (0, 1_030), (0, 3_600), Self.destination]), "back onto it")
    XCTAssertFalse(
      same([(100, 1_000), (0, 1_000), (0, 3_600), Self.destination]), "from a road 100 m away")
    XCTAssertFalse(same([(150, 1_000), (0, 1_100), (0, 3_600), Self.destination]), "180 m off it")
    XCTAssertFalse(
      same([(0, 2_000), (0, 1_000), (0, 3_600), Self.destination]), "1 km of it the other way")
    XCTAssertFalse(same([(0, 1_000), (200, 1_000), (200, 3_600), Self.destination]))
  }

  // MARK: No network

  /// Every request fails: retries follow the failure schedule (10 s doubling to 2 min), and
  /// nothing is spoken about it.
  func testFailedRequestsBackOffWithoutSpeaking() throws {
    let rig = Rig { _ in throw NavOSSNavigationAPIError.invalidResponse }
    try rig.start(Self.trip(id: "chosen", corners: Self.chosenCorners))
    try rig.drive([(0, 0), (0, 400), (3_000, 400)])
    let times = rig.timeline.filter { $0.contains("request") }.compactMap {
      $0.split(separator: " ").first.flatMap { Double($0.dropFirst(2)) }
    }
    let gaps = zip(times, times.dropFirst()).map { $1 - $0 }
    XCTAssertEqual(gaps.prefix(4).map { Int($0) }, [11, 21, 41, 81], rig.timeline.joined(separator: "\n"))
    XCTAssertEqual(rig.host.spoken.filter { $0.kind == .alert }, [])
    XCTAssertEqual(rig.state.routeStatus, .rerouteFailed)
  }

  // MARK: The recorded Calgary drive

  /// Checkpoints and saved trips the engine writes, in memory.
  private final class RecordingTripStore: NavigationTripStoring {
    var checkpoints: [Int] = []
    var savedTrips = 0
    func save(_ trip: NavOSSCarPlayTrip) { savedTrips += 1 }
    func loadSaved() -> NavOSSSavedTrip { .none }
    func clear() {}
    func saveProgress(_ progress: NavigationResumeContext, forTripId tripId: String) {
      checkpoints.append(Int(progress.alongMeters.rounded()))
    }
    func loadProgress(for trip: NavOSSCarPlayTrip) -> NavigationResumePoint { .withoutProgress }
  }

  /// The recorded drive (Deerfoot Trail to Glenmore Trail, its detour from fix 176 to 213
  /// answered with the recorded route, as the Android replay does) speaks and checkpoints exactly
  /// what it did before the spacing (the committed replay transcript of 74f6f9f, #168's head),
  /// and checkpoints as it did up to the detour.
  func testTheRecordedCalgaryDriveSpeaksAndCheckpointsAsBefore() throws {
    let base = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    let document = try JSONSerialization.jsonObject(
      with: Data(contentsOf: base.appendingPathComponent(
        "../../../../test/fixtures/routes-v2/calgary-deerfoot-glenmore.v2.json")))
      as? [String: Any]
    let response = try JSONSerialization.data(withJSONObject: try XCTUnwrap(document?["response"]))
    let destination = NavOSSCarPlayDestination(
      id: "replay-destination", label: "Replay destination", latitude: 50.9881,
      longitude: -114.094978, name: "Replay destination")
    let trip = try XCTUnwrap(
      try navOSSTripsFromRoutesV2Response(response, destination: destination).first)
    let url = try XCTUnwrap(
      Bundle.module.url(
        forResource: "calgary-deerfoot-glenmore.trace", withExtension: "json",
        subdirectory: "Fixtures"))
    let trace = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
    let fixes = try XCTUnwrap(trace?["fixes"] as? [[String: Any]]).map { fix in
      NavigationLocationSample(
        coordinate: NavigationCoordinate(
          latitude: try XCTUnwrap(fix["latitude"] as? Double),
          longitude: try XCTUnwrap(fix["longitude"] as? Double)),
        courseDegrees: fix["courseDegrees"] as? Double,
        horizontalAccuracyMeters: fix["horizontalAccuracyMeters"] as? Double,
        speedMetersPerSecond: fix["speedMetersPerSecond"] as? Double,
        timestamp: try XCTUnwrap(fix["timestampMs"] as? Double) / 1_000 - 978_307_200)
    }
    let clock = EngineTestClock(try XCTUnwrap(fixes.first?.timestamp))
    let host = RecordingEngineHost()
    let store = RecordingTripStore()
    let network = ScriptedEngineNetwork { _ in [trip] }
    let engine = NavigationEngine(
      tripStore: store, audioMode: .allGuidance,
      preferences: NavOSSNavigationPreferences(rerouteMode: .adaptive, speedingAudibleWarning: true),
      network: network, session: NavigationSession(), clock: { [clock] in clock.now })
    engine.host = host
    try engine.startNavigation(trip)
    engine.completePendingSafetyCameraFetch()
    for fix in fixes {
      clock.time = try XCTUnwrap(fix.timestamp)
      try engine.ingest(fix)
      engine.completePendingReroute(through: network)
    }
    XCTAssertEqual(engine.currentState().navigation.phase, .arrived)
    XCTAssertEqual(
      host.spoken.map { "\($0.kind) \($0.text)" },
      [
        "maneuver In 1 kilometre, take exit 248 toward Glenmore Trail.",
        "maneuver Take exit 248 toward Glenmore Trail.",
        "maneuver In 750 metres, keep right to take exit 248B onto Glenmore Trail southeast toward Glenmore Trail West.",
        "maneuver Keep right to take exit 248B onto Glenmore Trail southeast toward Glenmore Trail West.",
        "alert Speed limit 80.",
        "maneuver In 2 kilometres, take the 14 Street W South exit toward 14 Street West (Hospital), then keep right to take 14 Street W South.",
        "maneuver In 1 kilometre, take the 14 Street W South exit toward 14 Street West (Hospital), then keep right to take 14 Street W South.",
        "maneuver Take the 14 Street W South exit toward 14 Street West (Hospital), then keep right to take 14 Street W South.",
        "maneuver Keep right to take 14 Street W South, then continue toward 14 Street W South.",
        "maneuver Continue toward 14 Street W South.",
        "maneuver In 500 metres, your destination is ahead.",
        "alert Speed limit 70.",
        "maneuver Your destination is ahead.",
        "maneuver You've arrived at Replay destination.",
      ])
    // On the route up to the detour, the checkpoints of 74f6f9f. That head installed the recorded
    // route again twice on the detour (restarting the fifteen-second checkpoint clock); now the
    // answer is recognised as the route followed and nothing is installed, so later checkpoints
    // fall a few seconds differently along the same route.
    XCTAssertEqual(
      Array(store.checkpoints.prefix(12)),
      [18, 304, 400, 687, 968, 1_256, 1_537, 1_863, 2_233, 2_608, 2_985, 3_360])
    XCTAssertEqual(
      Array(store.checkpoints.dropFirst(12)),
      [4_586, 4_961, 5_389, 5_855, 6_321, 6_706, 7_078, 7_457, 7_831, 8_204])
    XCTAssertEqual(store.savedTrips, 1, "the route was never replaced (twice on 74f6f9f)")
    // The first answer and the detour's fresh route, both the route followed: nothing installed.
    XCTAssertEqual(network.requests.count, 2)
    XCTAssertEqual(engine.currentState().rerouteCount, 0)
  }

  // MARK: The spacing itself

  func testTheSpacingDoublesToItsCeiling() {
    let spacings = (1...6).map { NavigationRerouteSpacing.spacing(answers: $0) }
    XCTAssertEqual(spacings.map(\.meters), [400, 800, 1_600, 1_600, 1_600, 1_600])
    XCTAssertEqual(spacings.map(\.seconds), [20, 40, 80, 120, 120, 120])
  }

  /// Two answers in a detour, the driver beside the route: held. After 500 m and 30 s on a
  /// route, the next departure is a first departure again.
  func testEstablishingOnARouteStartsTheCountAgain() {
    var spacing = NavigationRerouteSpacing()
    var time = 0.0
    var y = 0.0
    func observe(offRoute: Bool) {
      time += 1
      y += 12
      spacing.observe(
        coordinate: Trace.coordinate(0, y), accuracyMeters: 5, isOffRoute: offRoute,
        isMatched: !offRoute, distanceFromRouteMeters: offRoute ? 60 : nil, now: time)
    }
    spacing.answered(now: time)
    spacing.answered(now: time)
    for _ in 0..<100 { observe(offRoute: true) }
    XCTAssertFalse(spacing.allowsRequest(now: time), "beside the route, fresh route used")
    for _ in 0..<45 { observe(offRoute: false) }
    observe(offRoute: true)
    XCTAssertTrue(spacing.allowsRequest(now: time), "a first departure again")
    XCTAssertEqual(spacing.answers, 0)
  }

  func testTheTrackHeading() {
    let t = Self.startTime
    XCTAssertNil(navigationTrackHeadingDegrees([]))
    XCTAssertNil(
      navigationTrackHeadingDegrees([(Trace.coordinate(0, 0), t), (Trace.coordinate(5, 0), t + 1)]),
      "not far enough to tell")
    XCTAssertNil(
      navigationTrackHeadingDegrees([(Trace.coordinate(0, 0), t), (Trace.coordinate(0, 50), t + 30)]),
      "too old")
    XCTAssertEqual(
      try XCTUnwrap(
        navigationTrackHeadingDegrees([
          (Trace.coordinate(0, 0), t), (Trace.coordinate(0, 30), t + 2), (Trace.coordinate(-12, 30), t + 3),
        ])),
      338, accuracy: 2)
  }
}
