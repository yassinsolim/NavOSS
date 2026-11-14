import Foundation
import XCTest

@testable import NavOSSNavigationCore

/// A position that moves kilometres between two fixes: a long gap in a tunnel or parkade, the
/// app suspended and resumed, a ferry, or a position that is simply wrong.
///
/// The first three geometries reproduce release-validation defect D17: the vehicle was on the
/// route, yet it was matched to other road up to a kilometre to the side, declared off route,
/// and never arrived. A jump the elapsed time makes possible is believed on its second fix. A
/// jump further along the route than any vehicle could have driven in the time is not proof that
/// the route was driven: it is not progress, and the trip recovers with one reroute from the
/// position, keeping the stops not yet reached.
final class NavigationPositionJumpTests: XCTestCase {
  private typealias Trace = NavigationTrace

  /// 17.5 km, shaped like the drive to an airport terminal: the last legs loop back, so the
  /// destination is 800 m beside an earlier part of the route.
  private static let terminalLoop: [(Double, Double)] = [
    (0, 0), (0, 9_000), (4_000, 9_000), (4_000, 12_000), (4_800, 12_000), (4_800, 11_300),
  ]
  /// 14 km that ends 2 km from where it starts.
  private static let horseshoe: [(Double, Double)] = [
    (0, 0), (0, 6_000), (2_000, 6_000), (2_000, 0),
  ]
  /// 17 km with nothing near the destination but the road to it.
  private static let simple: [(Double, Double)] = [(0, 0), (0, 12_000), (5_000, 12_000)]

  private func carPlay(_ coordinates: [NavigationCoordinate]) -> [NavOSSCarPlayCoordinate] {
    coordinates.map { NavOSSCarPlayCoordinate(latitude: $0.latitude, longitude: $0.longitude) }
  }

  /// One step per leg plus the arrival step, at 20 m/s.
  private func trip(_ corners: [(Double, Double)], id: String = "jump") -> NavOSSCarPlayTrip {
    var steps: [NavOSSCarPlayRouteStep] = []
    for (index, (start, end)) in zip(corners, corners.dropFirst()).enumerated() {
      let length = hypot(end.0 - start.0, end.1 - start.1)
      steps.append(
        NavOSSCarPlayRouteStep(
          distanceMeters: length,
          durationSeconds: length / 20,
          geometry: carPlay(Trace.route([start, end])),
          instruction: "Leg \(index)",
          maneuverType: index == 0 ? "depart" : "turn",
          roadName: "Road \(index)",
          spokenInstruction: nil
        )
      )
    }
    let last = corners[corners.count - 1]
    steps.append(
      NavOSSCarPlayRouteStep(
        distanceMeters: 0,
        durationSeconds: 0,
        geometry: carPlay(Trace.route([last, last])),
        instruction: "Arrive",
        maneuverType: "arrive",
        roadName: "",
        spokenInstruction: nil
      )
    )
    let destination = Trace.coordinate(last.0, last.1)
    return NavOSSCarPlayTrip(
      destination: NavOSSCarPlayDestination(
        id: "d", label: "d", latitude: destination.latitude, longitude: destination.longitude,
        name: "Destination"
      ),
      distanceMeters: steps.reduce(0) { $0 + $1.distanceMeters },
      durationSeconds: steps.reduce(0) { $0 + $1.durationSeconds },
      geometry: carPlay(Trace.route(corners)),
      id: id,
      steps: steps
    )
  }

  private func length(_ corners: [(Double, Double)]) -> Double {
    zip(corners, corners.dropFirst()).reduce(0) { $0 + hypot($1.1.0 - $1.0.0, $1.1.1 - $1.0.1) }
  }

  /// What the service does with each update: ask the consent machine whether to fetch a
  /// replacement. A request stays in flight until the test answers it.
  private struct RerouteProbe {
    var consent = NavigationRerouteConsent()
    var isInFlight = false
    var requestOrigins: [NavigationCoordinate] = []

    mutating func observe(_ update: NavigationSessionUpdate, now: TimeInterval) {
      let isOffRoute = update.snapshot.phase == .tracking && update.snapshot.isOffRoute
      let action = consent.evaluate(
        mode: .adaptive,
        isOffRoute: isOffRoute,
        canRequest: isOffRoute && update.snapshot.rawCoordinate != nil && !isInFlight,
        now: now
      )
      if action == .request, let origin = update.snapshot.rawCoordinate {
        isInFlight = true
        requestOrigins.append(origin)
      }
    }
  }

  /// Matches a session at the route start, waits `gapSeconds`, then drives the last
  /// `tailMeters` of the route at 8 m/s with a fix every half second and stops at the end.
  private func driveTheTailAfterAJump(
    _ corners: [(Double, Double)],
    startSpeed: Double?,
    gapSeconds: Double,
    tailSpeed: Double? = 8,
    tailMeters: Double = 180,
    file: StaticString = #filePath,
    line: UInt = #line
  ) throws {
    let total = length(corners)
    let session = NavigationSession()
    try session.start(trip(corners))
    var probe = RerouteProbe()
    var time = 0.0
    for _ in 0..<5 {
      let update = try session.updateLocation(
        Trace.sample(x: corners[0].0, y: corners[0].1, speed: startSpeed, time: time)
      )
      probe.observe(update, now: time)
      time += 1
    }
    XCTAssertEqual(session.currentUpdate().guidance?.stepIndex, 0, file: file, line: line)

    time += gapSeconds
    let tail = Trace.positions(along: corners, every: 4).filter {
      $0.alongMeters >= total - tailMeters
    }
    let parked = Array(repeating: tail[tail.count - 1], count: 6)
    var arrivedAtFix: Int?
    for (index, position) in (tail + parked).enumerated() {
      let isMoving = index < tail.count
      let update = try session.updateLocation(
        Trace.sample(
          x: position.x, y: position.y,
          courseDegrees: isMoving && tailSpeed != nil ? position.courseDegrees : nil,
          speed: tailSpeed.map { isMoving ? $0 : 0 },
          time: time
        )
      )
      probe.observe(update, now: time)
      time += 0.5
      XCTAssertFalse(
        update.snapshot.isOffRoute, "fix \(index) on the route was off route", file: file,
        line: line
      )
      if index >= 1, update.snapshot.phase == .tracking {
        // Believed by the second fix: one fix is held as a possible outlier, never more.
        let remaining = try XCTUnwrap(update.guidance, file: file, line: line)
        XCTAssertEqual(
          remaining.remainingDistanceMeters, total - position.alongMeters, accuracy: 10,
          "fix \(index) kept stale remaining distance", file: file, line: line
        )
        XCTAssertLessThan(remaining.remainingDurationSeconds, 60, file: file, line: line)
        XCTAssertEqual(
          remaining.stepIndex, corners.count - 2, "fix \(index) kept a stale step", file: file,
          line: line
        )
        XCTAssertEqual(
          remaining.distanceToManeuverMeters, total - position.alongMeters, accuracy: 10,
          file: file, line: line
        )
      }
      if update.snapshot.phase == .arrived, arrivedAtFix == nil {
        arrivedAtFix = index
      }
    }
    let arrived = try XCTUnwrap(arrivedAtFix, "never arrived", file: file, line: line)
    // Arrival still needs two accurate fixes within 30 m of the destination, no earlier.
    XCTAssertGreaterThan(arrived, tail.count - 9, file: file, line: line)
    XCTAssertLessThanOrEqual(arrived, tail.count + 1, file: file, line: line)
    XCTAssertEqual(probe.requestOrigins.count, 0, "requested a reroute", file: file, line: line)
  }

  // MARK: Far ahead along the route

  /// A stop halfway along `corners`, as a waypoint of the trip, and where it is.
  private func halfwayStop(
    _ corners: [(Double, Double)]
  ) -> (stop: NavOSSCarPlayDestination, x: Double, y: Double) {
    let total = length(corners)
    let halfway = Trace.positions(along: corners, every: 4).first { $0.alongMeters >= total / 2 }!
    let coordinate = Trace.coordinate(halfway.x, halfway.y)
    return (
      NavOSSCarPlayDestination(
        id: "stop", label: "stop", latitude: coordinate.latitude,
        longitude: coordinate.longitude, name: "Stop"
      ),
      halfway.x, halfway.y
    )
  }

  /// Matches a session at the route start, waits `gapSeconds`, then drives the last
  /// `tailMeters` of the route at 8 m/s: further along the route than the speed ceiling covers
  /// in that time. The position is sustained and credible, but the route cannot have been
  /// driven to it. Nothing about the selected route moves; off route on the third fix; one
  /// reroute from the raw position that keeps the halfway stop; and guidance on the
  /// replacement then arrives.
  private func recoverFromAnImpossibleJump(
    _ corners: [(Double, Double)],
    startSpeed: Double?,
    gapSeconds: Double,
    tailSpeed: Double? = 8,
    tailMeters: Double = 180,
    file: StaticString = #filePath,
    line: UInt = #line
  ) throws {
    let total = length(corners)
    let halfway = halfwayStop(corners)
    let selected = trip(corners, id: "selected").replacingWaypoints([halfway.stop])
    let session = NavigationSession()
    try session.start(selected)
    var probe = RerouteProbe()
    var time = 0.0
    for _ in 0..<5 {
      let update = try session.updateLocation(
        Trace.sample(x: corners[0].0, y: corners[0].1, speed: startSpeed, time: time)
      )
      probe.observe(update, now: time)
      time += 1
    }
    let lastAccepted = time - 1
    time += gapSeconds
    let tail = Trace.positions(along: corners, every: 4).filter {
      $0.alongMeters >= total - tailMeters
    }
    let context = "gap \(gapSeconds), length \(total)"
    // The premise: the jump is further than 45 m/s covers in the time, up to the third fix.
    XCTAssertGreaterThan(
      tail[0].alongMeters, (time - lastAccepted + 1.5) * 45 + 50, context, file: file,
      line: line
    )

    func sample(_ position: Trace.Position, moving: Bool) -> NavigationLocationSample {
      Trace.sample(
        x: position.x, y: position.y,
        courseDegrees: moving && tailSpeed != nil ? position.courseDegrees : nil,
        speed: tailSpeed.map { moving ? $0 : 0 },
        time: time
      )
    }

    var update = session.currentUpdate()
    var index = 0
    while probe.requestOrigins.isEmpty, index < tail.count {
      update = try session.updateLocation(sample(tail[index], moving: true))
      probe.observe(update, now: time)
      time += 0.5
      index += 1
      // No progress, no step change and no arrival on the selected route.
      XCTAssertEqual(update.snapshot.phase, .tracking, context, file: file, line: line)
      XCTAssertEqual(
        update.snapshot.routeProgress, 0, accuracy: 1 / total, context, file: file, line: line
      )
      XCTAssertEqual(
        try XCTUnwrap(update.guidance, file: file, line: line).remainingDistanceMeters, total,
        accuracy: 1, context, file: file, line: line
      )
      XCTAssertEqual(update.guidance?.stepIndex, 0, context, file: file, line: line)
    }
    XCTAssertTrue(update.snapshot.isOffRoute, context, file: file, line: line)
    XCTAssertEqual(
      index, 3, "off route, and the reroute requested, on the third fix", file: file, line: line
    )
    XCTAssertEqual(probe.requestOrigins.count, 1, context, file: file, line: line)
    let origin = Trace.local(try XCTUnwrap(probe.requestOrigins.first, file: file, line: line))
    XCTAssertEqual(origin.x, tail[2].x, accuracy: 1, context, file: file, line: line)
    XCTAssertEqual(origin.y, tail[2].y, accuracy: 1, context, file: file, line: line)
    // The request keeps the stop the vehicle has not been seen to reach.
    XCTAssertEqual(
      navOSSRemainingWaypoints(in: selected, after: update.snapshot.routeProgress).map(\.id),
      ["stop"], context, file: file, line: line
    )

    // While the request is in flight, more fixes in the same place request nothing more.
    for _ in 0..<3 {
      update = try session.updateLocation(sample(tail[index - 1], moving: false))
      probe.observe(update, now: time)
      time += 0.5
      XCTAssertTrue(update.snapshot.isOffRoute, context, file: file, line: line)
    }
    XCTAssertEqual(probe.requestOrigins.count, 1, context, file: file, line: line)

    // The replacement from the raw position, through the stop, is installed as the service
    // does, and driven.
    XCTAssertTrue(
      navigationShouldInstallReplacement(
        generationMatches: true, requestMatches: true, tripMatches: true,
        phase: update.snapshot.phase, isOffRoute: update.snapshot.isOffRoute),
      file: file, line: line
    )
    let end = corners[corners.count - 1]
    let replacement = [(origin.x, origin.y), (halfway.x, halfway.y), end]
    try session.start(trip(replacement, id: "replacement").replacingWaypoints([halfway.stop]))
    probe.consent.reset()
    probe.isInFlight = false
    for position in Trace.positions(along: replacement, every: 20).dropFirst() {
      time += 1
      update = try session.updateLocation(
        Trace.sample(
          x: position.x, y: position.y, courseDegrees: position.courseDegrees, speed: 20,
          time: time)
      )
      probe.observe(update, now: time)
      XCTAssertFalse(update.snapshot.isOffRoute, context, file: file, line: line)
      XCTAssertEqual(update.trip?.id, "replacement", file: file, line: line)
    }
    for _ in 0..<3 {
      time += 1
      update = try session.updateLocation(Trace.sample(x: end.0, y: end.1, speed: 0, time: time))
      probe.observe(update, now: time)
    }
    XCTAssertEqual(update.snapshot.phase, .arrived, context, file: file, line: line)
    XCTAssertEqual(probe.requestOrigins.count, 1, "no further reroute", file: file, line: line)
  }

  /// Parked at the start, then the last 180 m of the route a second or a minute later (the old
  /// harness teleport), or five minutes later at speed. Not progress; one reroute from where
  /// the position is.
  func testATeleportFurtherThanPossibleIsRecoveredByOneRerouteFromThePosition() throws {
    for corners in [Self.terminalLoop, Self.horseshoe, Self.simple] {
      try recoverFromAnImpossibleJump(corners, startSpeed: 0, gapSeconds: 1)
      try recoverFromAnImpossibleJump(corners, startSpeed: 0, gapSeconds: 60)
      // 13.5 km at the ceiling, short of these destinations.
      try recoverFromAnImpossibleJump(corners, startSpeed: 25, gapSeconds: 300)
      // Without speed or course.
      try recoverFromAnImpossibleJump(corners, startSpeed: nil, gapSeconds: 1, tailSpeed: nil)
      try recoverFromAnImpossibleJump(corners, startSpeed: nil, gapSeconds: 300)
    }
  }

  /// A drive that went quiet at speed and came back near the destination, long enough later
  /// to have driven there. The reported speeds explain a few kilometres of it at most.
  func testLongGapEndingNearTheDestinationIsBelievedOnTheSecondFixAndArrives() throws {
    for corners in [Self.terminalLoop, Self.horseshoe, Self.simple] {
      // Past the ten minutes over which elapsed time is trusted.
      try driveTheTailAfterAJump(corners, startSpeed: 25, gapSeconds: 900)
      try driveTheTailAfterAJump(corners, startSpeed: 0, gapSeconds: 3_600)
    }
  }

  /// Simulator and some device fixes carry no speed or course.
  func testJumpIsBelievedWithoutSpeedOrCourse() throws {
    for corners in [Self.terminalLoop, Self.horseshoe, Self.simple] {
      try driveTheTailAfterAJump(corners, startSpeed: nil, gapSeconds: 900, tailSpeed: nil)
      try driveTheTailAfterAJump(corners, startSpeed: nil, gapSeconds: 900)
    }
  }

  /// Review of 3da587c: two agreeing fixes 13.5 km along the horseshoe, 2 km from the vehicle,
  /// 10 s or 180 s after it was seen moving at 20 m/s. At 45 m/s that is 0.5 km or 8.1 km at
  /// most. No fix is progress, the third is off route, and fixes back at the real position
  /// are matched there.
  func testTwoAgreeingFixesFurtherThanPossibleAreNotProgress() throws {
    for gap in [10.0, 180] {
      let core = NavigationCore()
      try core.setRoute(Trace.route(Self.horseshoe))
      let total = try XCTUnwrap(core.routeLengthMeters)
      for second in 0...10 {
        try core.updateLocation(
          Trace.sample(
            x: 0, y: Double(second) * 20, courseDegrees: 0, speed: 20, time: Double(second))
        )
      }
      var snapshot = core.currentSnapshot()
      for index in 0..<3 {
        snapshot = try core.updateLocation(
          Trace.sample(
            x: 2_000, y: 500 - Double(index) * 20, courseDegrees: 180, speed: 20,
            time: 10 + gap + Double(index))
        )
        XCTAssertEqual(snapshot.phase, .tracking, "gap \(gap), fix \(index)")
        XCTAssertEqual(
          snapshot.routeProgress * total, 200, accuracy: 1, "gap \(gap), fix \(index)"
        )
      }
      XCTAssertTrue(snapshot.isOffRoute, "gap \(gap)")
      XCTAssertNil(snapshot.matchedCoordinate, "gap \(gap)")
      // Back where the vehicle really is, moving on: matched there, never at 13.5 km.
      for index in 0..<3 {
        snapshot = try core.updateLocation(
          Trace.sample(
            x: 0, y: 220 + Double(index) * 20, courseDegrees: 0, speed: 20,
            time: 13 + gap + Double(index))
        )
        XCTAssertLessThan(snapshot.routeProgress * total, 300, "gap \(gap), back \(index)")
      }
      XCTAssertFalse(snapshot.isOffRoute, "gap \(gap)")
    }
  }

  /// The same along one straight road: two agreeing fixes 5.8 km further down it, 10 s after
  /// the vehicle was seen at 20 m/s. The displacement accounts for the advance (direct), but
  /// no vehicle covers it in the time.
  func testADirectJumpFurtherThanPossibleIsNotProgress() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route(Self.simple))
    let total = try XCTUnwrap(core.routeLengthMeters)
    for second in 0...10 {
      try core.updateLocation(
        Trace.sample(
          x: 0, y: Double(second) * 20, courseDegrees: 0, speed: 20, time: Double(second))
      )
    }
    var snapshot = core.currentSnapshot()
    for index in 0..<3 {
      snapshot = try core.updateLocation(
        Trace.sample(
          x: 0, y: 6_000 + Double(index) * 20, courseDegrees: 0, speed: 20,
          time: 20 + Double(index))
      )
      XCTAssertEqual(snapshot.routeProgress * total, 200, accuracy: 1, "fix \(index)")
    }
    XCTAssertTrue(snapshot.isOffRoute)
  }

  /// Mid-route, not only at the destination: remaining distance and the step follow the jump.
  func testJumpToTheMiddleOfTheRouteUpdatesTheStepAndRemainingDistance() throws {
    let corners = Self.terminalLoop
    let total = length(corners)
    let session = NavigationSession()
    try session.start(trip(corners))
    for second in 0...10 {
      _ = try session.updateLocation(
        Trace.sample(
          x: 0, y: Double(second) * 20, courseDegrees: 0, speed: 20, time: Double(second))
      )
    }
    // Five minutes later (13.5 km at the speed ceiling), 11.3 km further on: on the third leg.
    let held = try session.updateLocation(
      Trace.sample(x: 4_000, y: 9_500, courseDegrees: 0, speed: 20, time: 310)
    )
    XCTAssertFalse(held.snapshot.isOffRoute)
    XCTAssertEqual(held.guidance?.stepIndex, 0, "a single far fix must be held")
    XCTAssertEqual(try XCTUnwrap(held.guidance).remainingDistanceMeters, total - 200, accuracy: 10)

    let confirmed = try session.updateLocation(
      Trace.sample(x: 4_000, y: 9_520, courseDegrees: 0, speed: 20, time: 311)
    )
    XCTAssertFalse(confirmed.snapshot.isOffRoute)
    XCTAssertEqual(confirmed.guidance?.stepIndex, 2)
    XCTAssertEqual(
      try XCTUnwrap(confirmed.guidance).remainingDistanceMeters, total - 13_520, accuracy: 10
    )
    XCTAssertEqual(try XCTUnwrap(confirmed.guidance).distanceToManeuverMeters, 2_480, accuracy: 10)
  }

  /// After an accepted jump, everything measured from "the last match" is measured from the new
  /// position: dead reckoning, the matching window, and the backward-travel mark.
  func testAcceptedJumpReseedsDeadReckoningTheWindowAndTheHighWaterMark() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route(Self.terminalLoop))
    let total = try XCTUnwrap(core.routeLengthMeters)
    for second in 0...5 {
      try core.updateLocation(
        Trace.sample(
          x: 0, y: Double(second) * 20, courseDegrees: 0, speed: 20, time: Double(second))
      )
    }
    let windowCost = core.lastEvaluatedSegmentCount
    // Five minutes later: possible at the speed ceiling, far beyond what 20 m/s explains.
    let gap = 300.0
    try core.updateLocation(
      Trace.sample(x: 4_000, y: 9_500, courseDegrees: 0, speed: 20, time: 6 + gap)
    )
    XCTAssertNil(
      core.deadReckon(at: Trace.time(9 + gap)), "a held fix is not a dead-reckoning anchor"
    )
    try core.updateLocation(
      Trace.sample(x: 4_000, y: 9_520, courseDegrees: 0, speed: 20, time: 7 + gap)
    )
    XCTAssertEqual(try XCTUnwrap(core.fixAlongMeters), 13_520, accuracy: 10)

    let reckoned = try XCTUnwrap(core.deadReckon(at: Trace.time(10 + gap)))
    XCTAssertEqual(
      reckoned.routeProgress * total, try XCTUnwrap(core.fixAlongMeters) + 60, accuracy: 1
    )

    // Normal driving resumes inside the window around the new position.
    var snapshot = reckoned
    for second in 8...20 {
      snapshot = try core.updateLocation(
        Trace.sample(
          x: 4_000, y: 9_520 + Double(second - 7) * 20, courseDegrees: 0, speed: 20,
          time: Double(second) + gap)
      )
      XCTAssertFalse(snapshot.isOffRoute)
      XCTAssertLessThanOrEqual(core.lastEvaluatedSegmentCount, windowCost + 5)
    }
    XCTAssertEqual(snapshot.routeProgress * total, 13_780, accuracy: 10)

    // Driving back from here is reverse travel measured from the new position.
    for second in 21...23 {
      snapshot = try core.updateLocation(
        Trace.sample(
          x: 4_000, y: 9_780 - Double(second - 20) * 40, courseDegrees: 180, speed: 20,
          time: Double(second) + gap)
      )
    }
    XCTAssertTrue(snapshot.isOffRoute)
    XCTAssertEqual(snapshot.routeProgress * total, 13_780, accuracy: 10)
  }

  // MARK: Multipath protection is unchanged

  /// One accurate fix at the destination while the vehicle is at the start is an outlier,
  /// whether or not the fixes report a speed.
  func testSingleFarFixIsHeldAndDrivingContinues() throws {
    for corners in [Self.terminalLoop, Self.horseshoe, Self.simple] {
      for speed in [15.0, nil] as [Double?] {
        let core = NavigationCore()
        try core.setRoute(Trace.route(corners))
        let total = try XCTUnwrap(core.routeLengthMeters)
        for second in 0...10 {
          try core.updateLocation(
            Trace.sample(
              x: 0, y: Double(second) * 15, courseDegrees: 0, speed: speed, time: Double(second))
          )
        }
        let last = corners[corners.count - 1]
        let outlier = try core.updateLocation(
          Trace.sample(x: last.0, y: last.1, speed: speed, time: 11)
        )
        XCTAssertFalse(outlier.isOffRoute)
        XCTAssertEqual(outlier.phase, .tracking)
        XCTAssertEqual(outlier.routeProgress * total, 150, accuracy: 1)

        let next = try core.updateLocation(
          Trace.sample(x: 0, y: 180, courseDegrees: 0, speed: speed, time: 12)
        )
        XCTAssertFalse(next.isOffRoute)
        XCTAssertEqual(next.routeProgress * total, 180, accuracy: 1)
      }
    }
  }

  /// Two far fixes that are nowhere near each other do not confirm one another; the position
  /// is believed once two consecutive fixes agree. After a gap that makes either possible.
  func testTwoOutliersInDifferentPlacesAreNotAConfirmation() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route(Self.terminalLoop))
    let total = try XCTUnwrap(core.routeLengthMeters)
    for second in 0...10 {
      try core.updateLocation(
        Trace.sample(
          x: 0, y: Double(second) * 15, courseDegrees: 0, speed: 15, time: Double(second))
      )
    }
    _ = try core.updateLocation(Trace.sample(x: 4_800, y: 11_300, speed: 15, time: 411))
    let second = try core.updateLocation(Trace.sample(x: 2_000, y: 9_000, speed: 15, time: 412))
    XCTAssertFalse(second.isOffRoute)
    XCTAssertEqual(second.routeProgress * total, 150, accuracy: 1)

    let agreeing = try core.updateLocation(
      Trace.sample(x: 2_015, y: 9_000, courseDegrees: 90, speed: 15, time: 413)
    )
    XCTAssertEqual(agreeing.routeProgress * total, 11_015, accuracy: 10)
  }

  // MARK: Far from the route

  /// A jump to somewhere that is not on the route: off route after the usual three fixes, one
  /// replacement requested from where the vehicle is, and guidance on the replacement afterwards.
  func testFarJumpOffTheRouteReroutesOnceFromTheNewPositionOntoTheReplacement() throws {
    for gapSeconds in [1.0, 300, 900] {
      let session = NavigationSession()
      try session.start(trip(Self.terminalLoop, id: "selected"))
      var probe = RerouteProbe()
      var time = 0.0
      for second in 0...10 {
        let update = try session.updateLocation(
          Trace.sample(x: 0, y: Double(second) * 20, courseDegrees: 0, speed: 20, time: time)
        )
        probe.observe(update, now: time)
        time += 1
      }
      // 6.5 km up the route's first leg, but 2.5 km east of it, driving east.
      time += gapSeconds
      var update = session.currentUpdate()
      var fixesUntilOffRoute = 0
      for index in 0..<8 {
        update = try session.updateLocation(
          Trace.sample(
            x: 2_500 + Double(index) * 15, y: 6_500, courseDegrees: 90, speed: 15, time: time)
        )
        probe.observe(update, now: time)
        time += 1
        if !update.snapshot.isOffRoute {
          fixesUntilOffRoute += 1
          XCTAssertEqual(
            try XCTUnwrap(update.guidance).remainingDistanceMeters, 17_500 - 200, accuracy: 10,
            "progress must not move while the position is unconfirmed"
          )
        }
      }
      XCTAssertTrue(update.snapshot.isOffRoute)
      XCTAssertEqual(fixesUntilOffRoute, 2, "off route on the third fix")
      XCTAssertEqual(probe.requestOrigins.count, 1, "one request while it is in flight")
      let origin = Trace.local(try XCTUnwrap(probe.requestOrigins.first))
      XCTAssertEqual(origin.x, 2_530, accuracy: 1)
      XCTAssertEqual(origin.y, 6_500, accuracy: 1)

      // The replacement from the vehicle's position is installed, as the service does.
      let replacement: [(Double, Double)] = [(2_500, 6_500), (4_000, 6_500), (4_000, 8_000)]
      XCTAssertTrue(
        navigationShouldInstallReplacement(
          generationMatches: true, requestMatches: true, tripMatches: true,
          phase: update.snapshot.phase, isOffRoute: update.snapshot.isOffRoute)
      )
      let installed = try session.start(trip(replacement, id: "replacement"))
      probe.consent.reset()
      probe.isInFlight = false
      XCTAssertEqual(installed.snapshot.routeProgress, 0)
      XCTAssertFalse(installed.snapshot.isOffRoute)
      XCTAssertNil(session.deadReckon(at: Trace.time(time + 5)), "no anchor from the old route")

      // The very next fix, 135 m along the replacement, is matched on it at once: nothing from
      // the old route (anchor, held jump, progress mark) holds it back or sends it off route.
      var position = 2_635.0
      update = try session.updateLocation(
        Trace.sample(x: position, y: 6_500, courseDegrees: 90, speed: 15, time: time)
      )
      probe.observe(update, now: time)
      XCTAssertFalse(update.snapshot.isOffRoute)
      XCTAssertEqual(update.trip?.id, "replacement")
      XCTAssertEqual(update.guidance?.stepIndex, 0)
      XCTAssertEqual(
        try XCTUnwrap(update.guidance).remainingDistanceMeters, 3_000 - 135, accuracy: 5
      )
      let reckoned = try XCTUnwrap(session.deadReckon(at: Trace.time(time + 3)))
      XCTAssertEqual(
        try XCTUnwrap(reckoned.guidance).remainingDistanceMeters, 3_000 - 135 - 45, accuracy: 5
      )

      // Drive the replacement to its end.
      for corner in Trace.positions(along: replacement, every: 15).dropFirst(10) {
        time += 1
        position = corner.x
        update = try session.updateLocation(
          Trace.sample(
            x: corner.x, y: corner.y, courseDegrees: corner.courseDegrees, speed: 15, time: time)
        )
        probe.observe(update, now: time)
        XCTAssertFalse(update.snapshot.isOffRoute)
      }
      for _ in 0..<3 {
        time += 1
        update = try session.updateLocation(Trace.sample(x: 4_000, y: 8_000, speed: 0, time: time))
        probe.observe(update, now: time)
      }
      XCTAssertEqual(update.snapshot.phase, .arrived)
      XCTAssertEqual(probe.requestOrigins.count, 1, "no further reroute after the replacement")
    }
  }

  /// Off route with no replacement (offline, or a declined proposal), the driver rejoins the
  /// selected route kilometres further on. Guidance resumes there.
  func testRejoiningTheRouteFarAheadWhileOffRouteRecoversThere() throws {
    let session = NavigationSession()
    try session.start(trip(Self.terminalLoop))
    var time = 0.0
    for second in 0...10 {
      _ = try session.updateLocation(
        Trace.sample(x: 0, y: Double(second) * 20, courseDegrees: 0, speed: 20, time: time)
      )
      time += 1
    }
    var update = session.currentUpdate()
    for index in 0..<5 {
      update = try session.updateLocation(
        Trace.sample(
          x: 150 + Double(index) * 15, y: 215, courseDegrees: 90, speed: 15, time: time)
      )
      time += 1
    }
    XCTAssertTrue(update.snapshot.isOffRoute)

    time += 400
    for index in 0..<2 {
      update = try session.updateLocation(
        Trace.sample(
          x: 3_000 + Double(index) * 15, y: 9_000, courseDegrees: 90, speed: 15, time: time)
      )
      time += 1
    }
    XCTAssertFalse(update.snapshot.isOffRoute)
    XCTAssertEqual(update.guidance?.stepIndex, 1)
    XCTAssertEqual(
      try XCTUnwrap(update.guidance).remainingDistanceMeters, 17_500 - 12_015, accuracy: 10
    )
  }

  // MARK: Keep-route rejoin point

  /// A keep-route recovery rejoins the selected route ahead of the vehicle, not 800 m after the
  /// place it was last confirmed, which after a jump is far behind it.
  func testKeepRouteRejoinIsMeasuredFromWhereTheVehicleIsNow() throws {
    let session = NavigationSession()
    try session.start(trip(Self.terminalLoop))
    for second in 0...10 {
      _ = try session.updateLocation(
        Trace.sample(
          x: 0, y: Double(second) * 20, courseDegrees: 0, speed: 20, time: Double(second))
      )
    }
    // Before any jump the base is the confirmed position.
    XCTAssertEqual(
      try XCTUnwrap(session.rejoinBaseAlongMeters(near: Trace.coordinate(60, 200))), 200,
      accuracy: 1
    )
    // 7 km further on and 300 m beside the route.
    let base = try XCTUnwrap(session.rejoinBaseAlongMeters(near: Trace.coordinate(300, 7_000)))
    XCTAssertEqual(base, 7_000, accuracy: 1)
    let rejoin = try XCTUnwrap(
      navigationKeepRouteRejoinAlongMeters(fixAlongMeters: base, routeLengthMeters: 17_500)
    )
    let point = Trace.local(try XCTUnwrap(session.routePoint(alongMeters: rejoin)))
    XCTAssertEqual(point.x, 0, accuracy: 1)
    XCTAssertEqual(point.y, 7_800, accuracy: 1)
    // Nowhere near the route: the confirmed position is all there is.
    XCTAssertEqual(
      try XCTUnwrap(session.rejoinBaseAlongMeters(near: Trace.coordinate(-9_000, 3_000))), 200,
      accuracy: 1
    )
  }

  /// Beside an out-and-back, the base stays on the leg being driven even where the return leg
  /// is marginally closer, so the recovery cannot skip the far end of the route.
  func testKeepRouteRejoinBaseDoesNotSkipToAReturnLeg() throws {
    let outAndBack: [(Double, Double)] = [(0, 0), (0, 3_000), (40, 3_000), (40, 0)]
    let session = NavigationSession()
    try session.start(trip(outAndBack))
    for second in 0...10 {
      _ = try session.updateLocation(
        Trace.sample(
          x: 0, y: Double(second) * 20, courseDegrees: 0, speed: 20, time: Double(second))
      )
    }
    // 60 m east of the outbound leg, 20 m east of the return leg.
    XCTAssertEqual(
      try XCTUnwrap(session.rejoinBaseAlongMeters(near: Trace.coordinate(60, 1_000))), 1_000,
      accuracy: 1
    )
  }
}
