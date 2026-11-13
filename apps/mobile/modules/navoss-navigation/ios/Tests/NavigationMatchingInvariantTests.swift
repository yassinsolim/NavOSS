import Foundation
import XCTest

@testable import NavOSSNavigationCore

/// The matching invariants stated at the top of `NavigationCore.swift`, as regressions from the
/// second review of the position-jump fix and as properties over generated routes.
final class NavigationMatchingInvariantTests: XCTestCase {
  private typealias Trace = NavigationTrace

  private func along(_ snapshot: NavigationSnapshot, _ core: NavigationCore) -> Double {
    snapshot.routeProgress * (core.routeLengthMeters ?? 0)
  }

  /// How fixes are timestamped. Only `.everySecond` and `.gap` give elapsed time; the rest are
  /// the ways elapsed time can be missing.
  private enum Clock: CaseIterable {
    case everySecond, repeatedTimestamp, untimed, longGap, veryLongGap

    /// Timestamp of fix `index`, where fix 0 is the last one before the injected fixes.
    func time(_ index: Int) -> TimeInterval? {
      switch self {
      case .everySecond: return Double(index)
      case .repeatedTimestamp: return 0
      case .untimed: return nil
      case .longGap: return index == 0 ? 0 : 600 + Double(index)
      case .veryLongGap: return index == 0 ? 0 : 7_200 + Double(index)
      }
    }
  }

  // MARK: Review finding 1: a loop's end is not reached by standing at its start

  private static let loop: [(Double, Double)] = [
    (0, 0), (0, 3_000), (3_000, 3_000), (3_000, 0), (20, 0),
  ]

  /// Parked at the start of a 12 km loop that ends 20 m away. Two identical fixes 44 m east fit
  /// the final leg and not the first. Whatever the clock, they are not travel.
  func testBiasedFixesAtTheStartOfALoopNeitherSkipTheLoopNorArrive() throws {
    for clock in Clock.allCases {
      for speed in [0.0, nil] as [Double?] {
        let core = NavigationCore()
        try core.setRoute(Trace.route(Self.loop))
        try core.updateLocation(Trace.sample(x: 0, y: 0, speed: speed, time: clock.time(0)))
        var index = 1
        // The biased pair, the genuine position, then both again.
        for x in [44.0, 44, 0, 0, 44, 44, 44, 0, 44, 0] {
          let snapshot = try core.updateLocation(
            Trace.sample(x: x, y: 0, speed: speed, time: clock.time(index))
          )
          index += 1
          XCTAssertEqual(snapshot.phase, .tracking, "\(clock) speed \(String(describing: speed))")
          XCTAssertLessThan(along(snapshot, core), 50, "\(clock) fix \(index)")
        }
      }
    }
  }

  /// The same through the session: guidance stays on the first step.
  func testBiasedFixesAtTheStartOfALoopKeepGuidanceOnTheFirstStep() throws {
    let session = NavigationSession()
    try session.start(Self.trip(Self.loop))
    _ = try session.updateLocation(Trace.sample(x: 0, y: 0, speed: 0, time: 0))
    _ = try session.updateLocation(Trace.sample(x: 44, y: 0, speed: 0, time: 1))
    let second = try session.updateLocation(Trace.sample(x: 44, y: 0, speed: 0, time: 2))
    XCTAssertEqual(second.guidance?.stepIndex, 0)
    let genuine = try session.updateLocation(Trace.sample(x: 0, y: 0, speed: 0, time: 3))
    XCTAssertEqual(genuine.snapshot.phase, .tracking)
    XCTAssertEqual(genuine.guidance?.stepIndex, 0)
    XCTAssertLessThan(genuine.snapshot.routeProgress, 0.01)
  }

  /// A loop that is driven still ends: continuously, and through an outage that ends away from
  /// the start.
  func testADrivenLoopArrives() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route(Self.loop))
    var time = 0.0
    var snapshot = core.currentSnapshot()
    let positions = Trace.positions(along: Self.loop, every: 20)
    for position in positions + [positions[positions.count - 1]] {
      snapshot = try core.updateLocation(
        Trace.sample(
          x: position.x, y: position.y, courseDegrees: position.courseDegrees, speed: 20,
          time: time)
      )
      time += 1
      XCTAssertFalse(snapshot.isOffRoute)
    }
    XCTAssertEqual(snapshot.phase, .arrived)

    for clock in [Clock.everySecond, .longGap, .veryLongGap] {
      let outage = NavigationCore()
      try outage.setRoute(Trace.route(Self.loop))
      try outage.updateLocation(
        Trace.sample(x: 0, y: 100, courseDegrees: 0, speed: 20, time: clock.time(0))
      )
      // Reappears on the final leg, 1 km before the end, and drives in.
      var index = 1
      var last = outage.currentSnapshot()
      for x in stride(from: 1_020.0, through: 20, by: -20) {
        last = try outage.updateLocation(
          Trace.sample(x: x, y: 0, courseDegrees: 270, speed: 20, time: clock.time(index))
        )
        index += 1
        if index > 2 {
          XCTAssertFalse(last.isOffRoute, "\(clock)")
          XCTAssertEqual(along(last, outage), 11_980 - (x - 20), accuracy: 15, "\(clock)")
        }
      }
      last = try outage.updateLocation(Trace.sample(x: 20, y: 0, speed: 0, time: clock.time(index)))
      XCTAssertEqual(last.phase, .arrived, "\(clock)")
    }
  }

  // MARK: Review finding 2: heading does not decide which road a fix lies on

  /// A U-turn on the outbound carriageway of a divided road is wrong-way travel on that
  /// carriageway, not progress on the return carriageway 12 m away.
  func testUTurnOnADividedRoadIsWrongWayNotTheReturnCarriageway() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route([(0, 0), (2_000, 0), (2_000, 12), (0, 12)]))
    for second in 0...40 {
      try core.updateLocation(
        Trace.sample(
          x: Double(second) * 15, y: 0, courseDegrees: 90, speed: 15, time: Double(second))
      )
    }
    let before = core.currentSnapshot()
    var snapshot = before
    for second in 41...43 {
      snapshot = try core.updateLocation(
        Trace.sample(
          x: 600 - Double(second - 40) * 15, y: 0, courseDegrees: 270, speed: 15,
          time: Double(second))
      )
      XCTAssertEqual(along(snapshot, core), along(before, core), accuracy: 1)
    }
    XCTAssertTrue(snapshot.isOffRoute)
  }

  /// The same after a gap in fixes: reappearing 300 m back on the outbound carriageway, heading
  /// back, is far enough from the last accepted fix to qualify as a jump, and the return
  /// carriageway agrees with the heading. The road under the fix still explains it.
  func testReversingThroughAGapOnADividedRoadIsNotTheReturnCarriageway() throws {
    for gapSeconds in [20.0, 700] {
      let core = NavigationCore()
      try core.setRoute(Trace.route([(0, 0), (2_000, 0), (2_000, 12), (0, 12)]))
      for second in 0...40 {
        try core.updateLocation(
          Trace.sample(
            x: Double(second) * 15, y: 0, courseDegrees: 90, speed: 15, time: Double(second))
        )
      }
      let before = core.currentSnapshot()
      var snapshot = before
      for index in 0..<3 {
        snapshot = try core.updateLocation(
          Trace.sample(
            x: 300 - Double(index) * 15, y: 0, courseDegrees: 270, speed: 15,
            time: 40 + gapSeconds + Double(index))
        )
        XCTAssertEqual(along(snapshot, core), along(before, core), accuracy: 1)
      }
      XCTAssertTrue(snapshot.isOffRoute)
    }
  }

  /// Invariant 1: a fix that the road within reach explains is not a jump, even where a later
  /// part of the route is nearer and agrees with the heading. Here the next leg of a hairpin
  /// starts just past what is believed without travel evidence.
  func testAPositionExplainedByTheRoadWithinReachIsNotAJump() throws {
    let core = NavigationCore()
    // One segment per leg, so the return leg is either the point beside the fix or nothing.
    let corners: [(Double, Double)] = [(0, 0), (300, 0), (300, 35), (-500, 35)]
    try core.setRoute(corners.map { Trace.coordinate($0.0, $0.1) })
    try core.updateLocation(Trace.sample(x: 0, y: 0))
    // 25 m from the outbound leg (200 m on), 10 m from the return leg (435 m on).
    let fix = try core.updateLocation(Trace.sample(x: 200, y: 25, courseDegrees: 270))
    XCTAssertEqual(along(fix, core), 200, accuracy: 2)
  }

  // MARK: Review finding 3: a held fix is not published by recovery

  /// Off route, two far fixes a kilometre apart each look like a return to the route. They do
  /// not agree, so neither is believed; a third that agrees with the second is.
  func testDisagreeingFarFixesWhileOffRouteStayOffRouteAndUnpublished() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route([(0, 0), (0, 6_000), (2_000, 6_000), (2_000, 0)]))
    try core.updateLocation(Trace.sample(x: 0, y: 200, courseDegrees: 0, speed: 15, time: 0))
    for second in 1...3 {
      try core.updateLocation(
        Trace.sample(x: 150, y: 200, courseDegrees: 90, speed: 15, time: Double(second))
      )
    }
    let before = core.currentSnapshot()
    XCTAssertTrue(before.isOffRoute)
    for (second, y) in [(4, 0.0), (5, 1_000)] {
      let outlier = try core.updateLocation(
        Trace.sample(x: 2_000, y: y, speed: 15, time: Double(second))
      )
      XCTAssertTrue(outlier.isOffRoute)
      XCTAssertNil(outlier.matchedCoordinate)
      XCTAssertEqual(along(outlier, core), along(before, core), accuracy: 1)
    }
    let confirmed = try core.updateLocation(
      Trace.sample(x: 2_000, y: 985, courseDegrees: 180, speed: 15, time: 6)
    )
    XCTAssertFalse(confirmed.isOffRoute)
    XCTAssertEqual(along(confirmed, core), 13_015, accuracy: 10)
  }

  // MARK: Review finding 4: the rejoin base follows the route, not the grid

  /// Sparse geometry: the grid returns the outbound and the return segment but not the far
  /// turnaround between them. The base stays on the leg being driven.
  func testKeepRouteRejoinBaseDoesNotCrossAGapInSparseGeometry() throws {
    let core = NavigationCore()
    let corners: [(Double, Double)] = [(0, 0), (0, 6_000), (40, 6_000), (40, 0)]
    try core.setRoute(corners.map { Trace.coordinate($0.0, $0.1) })
    try core.updateLocation(Trace.sample(x: 0, y: 0, courseDegrees: 0, speed: 20, time: 0))
    try core.updateLocation(Trace.sample(x: 0, y: 3_000, courseDegrees: 0, speed: 20, time: 150))
    for second in 151...153 {
      try core.updateLocation(
        Trace.sample(x: 60, y: 3_000, courseDegrees: 90, speed: 15, time: Double(second))
      )
    }
    XCTAssertTrue(core.currentSnapshot().isOffRoute)
    let base = try XCTUnwrap(core.rejoinBaseAlongMeters(near: Trace.coordinate(60, 3_000)))
    XCTAssertEqual(base, 3_000, accuracy: 1)
    let rejoin = try XCTUnwrap(
      navigationKeepRouteRejoinAlongMeters(
        fixAlongMeters: base, routeLengthMeters: try XCTUnwrap(core.routeLengthMeters))
    )
    let point = Trace.local(try XCTUnwrap(core.routePoint(alongMeters: rejoin)))
    XCTAssertEqual(point.x, 0, accuracy: 1)
    XCTAssertEqual(point.y, 3_800, accuracy: 1)
  }

  // MARK: Properties over generated routes

  private struct Shape {
    let name: String
    let corners: [(Double, Double)]
    /// Where the vehicle waits, as metres along the route, and where that is.
    let parkedAlong: Double
    let parked: (x: Double, y: Double)
    /// Offsets from `parked` that land on, or beside, a much later part of the route.
    let lures: [(dx: Double, dy: Double)]
  }

  /// Loops ending near their start, divided out-and-backs, and self-crossings, with the
  /// vehicle parked where a later part of the route is within reach of GPS error.
  private func shapes(seed: UInt64, count: Int) -> [Shape] {
    var random = Trace.Noise(seed: seed)
    func pick(_ low: Double, _ high: Double) -> Double {
      (low + high) / 2 + random.next(amplitude: (high - low) / 2)
    }
    var shapes: [Shape] = []
    for _ in 0..<count {
      let width = pick(900, 4_000).rounded()
      let height = pick(900, 4_000).rounded()
      let gap = pick(8, 60).rounded()
      shapes.append(
        Shape(
          name: "loop \(width)x\(height) gap \(gap)",
          corners: [(0, 0), (0, height), (width, height), (width, 0), (gap, 0)],
          parkedAlong: 0, parked: (0, 0),
          lures: [(gap, 0), (gap + pick(5, 70), 0), (gap + pick(5, 70), pick(-30, 30))]
        )
      )
      let length = pick(1_500, 4_000).rounded()
      let separation = pick(8, 30).rounded()
      let stopped = pick(100, length - 600).rounded()
      shapes.append(
        Shape(
          name: "out-and-back \(length) separation \(separation) at \(stopped)",
          corners: [(0, 0), (length, 0), (length, separation), (0, separation)],
          parkedAlong: stopped, parked: (stopped, 0),
          lures: [
            (0, separation), (pick(-60, 60), separation), (pick(-60, 60), separation + pick(0, 30)),
          ]
        )
      )
      let reach = pick(1_200, 3_000).rounded()
      let rise = pick(600, 2_000).rounded()
      shapes.append(
        Shape(
          name: "self-crossing \(reach) rise \(rise)",
          corners: [(0, 0), (reach, 0), (reach, rise), (reach / 2, rise), (reach / 2, -rise)],
          parkedAlong: reach / 2, parked: (reach / 2, 0),
          lures: [(0, pick(40, 110)), (0, -pick(40, 110)), (pick(-20, 20), pick(45, 120))]
        )
      )
    }
    return shapes
  }

  /// Brings a new core to `shape.parked`. A route that passes the parked position twice is
  /// approached along its first pass, so the match is the earlier one.
  private func park(
    _ shape: Shape, speed: Double?, time: TimeInterval?
  ) throws -> NavigationCore {
    let core = NavigationCore()
    try core.setRoute(Trace.route(shape.corners))
    if shape.parkedAlong >= 60 {
      let approach = Trace.positions(along: shape.corners, every: 20).last {
        $0.alongMeters <= shape.parkedAlong - 40
      }!
      try core.updateLocation(
        Trace.sample(
          x: approach.x, y: approach.y, courseDegrees: approach.courseDegrees, speed: 10,
          time: -10)
      )
    }
    for _ in 0..<2 {
      try core.updateLocation(
        Trace.sample(x: shape.parked.x, y: shape.parked.y, speed: speed, time: time)
      )
    }
    XCTAssertEqual(
      core.currentSnapshot().routeProgress * (core.routeLengthMeters ?? 0), shape.parkedAlong,
      accuracy: 5, shape.name
    )
    return core
  }

  /// Invariants 2 and 4: a vehicle that does not move makes no kilometre-scale progress and
  /// never arrives, whatever pair of fixes lands on a later part of the route nearby and
  /// however the fixes are timestamped.
  func testNoProgressWithoutTravelOnGeneratedRoutes() throws {
    var cases = 0
    for shape in shapes(seed: 0x5EED_0001, count: 12) {
      for clock in Clock.allCases {
        for speed in [0.0, nil] as [Double?] {
          for lure in shape.lures {
            cases += 1
            let core = try park(shape, speed: speed, time: clock.time(0))
            let total = try XCTUnwrap(core.routeLengthMeters)
            // The lure twice, home, the lure twice more, home.
            let offsets = [lure, lure, (0, 0), lure, lure, (0, 0)]
            for (index, offset) in offsets.enumerated() {
              let snapshot = try core.updateLocation(
                Trace.sample(
                  x: shape.parked.x + offset.0, y: shape.parked.y + offset.1, speed: speed,
                  time: clock.time(index + 1))
              )
              let context = "\(shape.name), \(clock), speed \(String(describing: speed)), "
                + "lure \(lure), fix \(index)"
              XCTAssertEqual(snapshot.phase, .tracking, context)
              // Never further than the window that is believed without travel evidence.
              XCTAssertLessThanOrEqual(
                snapshot.routeProgress * total, shape.parkedAlong + 440, context
              )
              if speed == 0, clock == .everySecond {
                // A reported standstill allows only the multipath margin.
                XCTAssertLessThanOrEqual(
                  snapshot.routeProgress * total, shape.parkedAlong + 185, context
                )
              }
            }
          }
        }
      }
    }
    XCTAssertGreaterThan(cases, 1_000)
  }

  /// Invariant 3: one far fix changes nothing that is published, on or off the route, and two
  /// that disagree change nothing either.
  func testHeldFixesAreNeverPublishedOnGeneratedRoutes() throws {
    var random = Trace.Noise(seed: 0x5EED_0002)
    var cases = 0
    for shape in shapes(seed: 0x5EED_0003, count: 12) {
      let positions = Trace.positions(along: shape.corners, every: 25)
      // Far along the route and far away on the ground.
      let far = positions.filter {
        $0.alongMeters > shape.parkedAlong + 700
          && hypot($0.x - shape.parked.x, $0.y - shape.parked.y) > 500
      }
      guard far.count > 40 else { continue }
      for clock in [Clock.everySecond, .repeatedTimestamp, .longGap, .veryLongGap] {
        for startsOffRoute in [false, true] {
          cases += 1
          let core = try park(shape, speed: 0, time: -4)
          let total = try XCTUnwrap(core.routeLengthMeters)
          if startsOffRoute {
            for second in -3...(-1) {
              // 150 m from every part of these routes near the parked position.
              try core.updateLocation(
                Trace.sample(
                  x: shape.parked.x - 150, y: shape.parked.y - 150, speed: 0,
                  time: Double(second))
              )
            }
            XCTAssertTrue(core.currentSnapshot().isOffRoute, shape.name)
          } else {
            try core.updateLocation(
              Trace.sample(x: shape.parked.x, y: shape.parked.y, speed: 0, time: clock.time(0))
            )
          }
          let before = core.currentSnapshot()
          let first = far[Int(abs(random.next(amplitude: 1)) * Double(far.count - 1))]
          // Somewhere else on the ground, not only along the route: the two carriageways of
          // a divided road are the same place.
          let others = far.filter { hypot($0.x - first.x, $0.y - first.y) > 500 }
          guard !others.isEmpty else { continue }
          let second = others[Int(abs(random.next(amplitude: 1)) * Double(others.count - 1))]
          for (index, outlier) in [first, second].enumerated() {
            let snapshot = try core.updateLocation(
              Trace.sample(x: outlier.x, y: outlier.y, speed: 0, time: clock.time(index + 1))
            )
            let context = "\(shape.name), \(clock), off route \(startsOffRoute), fix \(index)"
            XCTAssertEqual(snapshot.phase, .tracking, context)
            XCTAssertEqual(snapshot.isOffRoute, before.isOffRoute, context)
            XCTAssertEqual(snapshot.matchedCoordinate, before.matchedCoordinate, context)
            XCTAssertEqual(
              snapshot.routeProgress * total, before.routeProgress * total, accuracy: 1, context
            )
            XCTAssertNil(core.deadReckon(at: Trace.time(10_000)), context)
          }
        }
      }
    }
    XCTAssertGreaterThan(cases, 150)
  }

  /// Invariant 2 the other way round: a position that is sustained, away from the last
  /// accepted fix and not explained by the road near it is believed on its second fix.
  func testSustainedFarPositionsAreBelievedOnGeneratedRoutes() throws {
    var random = Trace.Noise(seed: 0x5EED_0004)
    var cases = 0
    for shape in shapes(seed: 0x5EED_0005, count: 12) {
      let positions = Trace.positions(along: shape.corners, every: 10)
      for clock in [Clock.everySecond, .repeatedTimestamp, .longGap, .veryLongGap] {
        for _ in 0..<4 {
          let index = Int(abs(random.next(amplitude: 1)) * Double(positions.count - 3))
          let target = positions[index]
          let next = positions[index + 1]
          guard target.alongMeters > shape.parkedAlong + 700,
            hypot(target.x - shape.parked.x, target.y - shape.parked.y) > 500,
            target.courseDegrees == next.courseDegrees
          else { continue }
          // Somewhere the route passes only once: the expected match is unambiguous.
          let passes = positions.filter {
            hypot($0.x - target.x, $0.y - target.y) < 60
              && abs($0.alongMeters - target.alongMeters) > 150
          }
          guard passes.isEmpty else { continue }
          cases += 1
          let core = try park(shape, speed: 0, time: clock.time(0))
          let total = try XCTUnwrap(core.routeLengthMeters)
          let held = try core.updateLocation(
            Trace.sample(
              x: target.x, y: target.y, courseDegrees: target.courseDegrees, speed: 10,
              time: clock.time(1))
          )
          let context = "\(shape.name), \(clock), target \(target.alongMeters)"
          XCTAssertEqual(held.routeProgress * total, shape.parkedAlong, accuracy: 5, context)
          let believed = try core.updateLocation(
            Trace.sample(
              x: next.x, y: next.y, courseDegrees: next.courseDegrees, speed: 10,
              time: clock.time(2))
          )
          XCTAssertFalse(believed.isOffRoute, context)
          XCTAssertEqual(believed.routeProgress * total, next.alongMeters, accuracy: 15, context)
        }
      }
    }
    XCTAssertGreaterThan(cases, 60)
  }

  /// Invariant 1 on divided roads: reversing on the carriageway being driven is off route by
  /// the third fix and never moves progress forward.
  func testReversingOnGeneratedDividedRoadsNeverSkipsForward() throws {
    var random = Trace.Noise(seed: 0x5EED_0006)
    for _ in 0..<40 {
      let length = (2_750 + random.next(amplitude: 1_250)).rounded()
      let separation = (19 + random.next(amplitude: 11)).rounded()
      let turn = (length / 2 + random.next(amplitude: length / 2 - 400)).rounded()
      let speed = 14 + random.next(amplitude: 8)
      let core = NavigationCore()
      try core.setRoute(Trace.route([(0, 0), (length, 0), (length, separation), (0, separation)]))
      let total = try XCTUnwrap(core.routeLengthMeters)
      var time = 0.0
      var x = 0.0
      while x < turn {
        try core.updateLocation(
          Trace.sample(x: x, y: 0, courseDegrees: 90, speed: speed, time: time)
        )
        x += speed
        time += 1
      }
      let before = core.currentSnapshot().routeProgress * total
      var snapshot = core.currentSnapshot()
      for _ in 0..<3 {
        x -= speed
        snapshot = try core.updateLocation(
          Trace.sample(x: x, y: 0, courseDegrees: 270, speed: speed, time: time)
        )
        time += 1
        let context = "length \(length) separation \(separation) turn \(turn) speed \(speed)"
        XCTAssertLessThanOrEqual(snapshot.routeProgress * total, before + 1, context)
      }
      XCTAssertTrue(snapshot.isOffRoute)
    }
  }

  // MARK: Support

  private static func carPlay(_ coordinates: [NavigationCoordinate]) -> [NavOSSCarPlayCoordinate] {
    coordinates.map { NavOSSCarPlayCoordinate(latitude: $0.latitude, longitude: $0.longitude) }
  }

  private static func trip(_ corners: [(Double, Double)]) -> NavOSSCarPlayTrip {
    var steps: [NavOSSCarPlayRouteStep] = []
    for (index, (start, end)) in zip(corners, corners.dropFirst()).enumerated() {
      let length = hypot(end.0 - start.0, end.1 - start.1)
      steps.append(
        NavOSSCarPlayRouteStep(
          distanceMeters: length, durationSeconds: length / 15,
          geometry: carPlay(Trace.route([start, end])),
          instruction: "Leg \(index)", maneuverType: index == 0 ? "depart" : "turn",
          roadName: "Road \(index)"
        )
      )
    }
    let last = corners[corners.count - 1]
    steps.append(
      NavOSSCarPlayRouteStep(
        distanceMeters: 0, durationSeconds: 0, geometry: carPlay(Trace.route([last, last])),
        instruction: "Arrive", maneuverType: "arrive", roadName: ""
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
      geometry: carPlay(Trace.route(corners)), id: "invariants", steps: steps
    )
  }
}
