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
  /// the start, long enough to have driven there. Reappearing there a second later is not the
  /// loop driven: no progress, off route by the third fix, no arrival.
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
      let isPossible = clock != .everySecond
      var index = 1
      var last = outage.currentSnapshot()
      for x in stride(from: 1_020.0, through: 20, by: -20) {
        last = try outage.updateLocation(
          Trace.sample(x: x, y: 0, courseDegrees: 270, speed: 20, time: clock.time(index))
        )
        index += 1
        if isPossible, index > 2 {
          XCTAssertFalse(last.isOffRoute, "\(clock)")
          XCTAssertEqual(along(last, outage), 11_980 - (x - 20), accuracy: 15, "\(clock)")
        } else if !isPossible {
          XCTAssertEqual(along(last, outage), 100, accuracy: 1, "\(clock)")
          XCTAssertEqual(last.isOffRoute, index > 3, "\(clock), fix \(index - 1)")
        }
      }
      last = try outage.updateLocation(Trace.sample(x: 20, y: 0, speed: 0, time: clock.time(index)))
      XCTAssertEqual(last.phase, isPossible ? .arrived : .tracking, "\(clock)")
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

  /// The same after a short gap in fixes: reappearing 300 m back on the outbound carriageway,
  /// heading back. The return carriageway fits and agrees with the heading, but 20 s is not
  /// enough to have driven to the far end and back: this is a U-turn.
  func testReversingThroughAShortGapOnADividedRoadIsNotTheReturnCarriageway() throws {
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
          time: 60 + Double(index))
      )
      XCTAssertEqual(along(snapshot, core), along(before, core), accuracy: 1)
    }
    XCTAssertTrue(snapshot.isOffRoute)
  }

  /// After a gap long enough to have driven to the far end and back, a vehicle moving the other
  /// way beside the return carriageway is on it: heading at speed tells the two apart. Arrival
  /// still waits for it to be seen moving on.
  func testHeadingTellsTheCarriagewaysApartAfterAGapLongEnoughToHaveTurnedRound() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route([(0, 0), (2_000, 0), (2_000, 12), (0, 12)]))
    for second in 0...40 {
      try core.updateLocation(
        Trace.sample(
          x: Double(second) * 15, y: 0, courseDegrees: 90, speed: 15, time: Double(second))
      )
    }
    let back = try core.updateLocation(
      Trace.sample(x: 200, y: 6, courseDegrees: 270, speed: 15, time: 400)
    )
    XCTAssertFalse(back.isOffRoute)
    XCTAssertEqual(along(back, core), 3_812, accuracy: 5)
    var time = 401.0
    var snapshot = back
    for x in stride(from: 185.0, through: 0, by: -15) + [0, 0] {
      snapshot = try core.updateLocation(
        Trace.sample(x: x, y: 12, courseDegrees: 270, speed: x > 0 ? 15 : 0, time: time)
      )
      time += 1
      XCTAssertFalse(snapshot.isOffRoute)
    }
    XCTAssertEqual(snapshot.phase, .arrived)
  }

  /// Review of 3da587c, over carriageways 12 to 200 m apart and gaps of 20 to 360 s. The
  /// vehicle is seen 600 m out at 15 m/s, then fixes stop. Two things can have happened:
  ///   - It turned round on the outbound pavement and drives back along it (the wrong way). The
  ///     return carriageway beside it is a later pass that reported speed explains reaching
  ///     only after about 140 s. Until then the fixes are never matched there: progress stays,
  ///     wrong way is off route by the third fix, no arrival. Where the carriageways are too far
  ///     apart for the fix to fit the return, the same at every gap. Where reported speed does
  ///     explain the return and it is within GPS error of the fix, the two cannot be told apart;
  ///     progress is still never beyond what reported speed explains.
  ///   - It kept driving the route (slowing for the end) and reappears where it really is, on
  ///     either carriageway or at the far end. That is followed from the first fix and arrives.
  func testADividedOutAndBackReachesTheReturnOnlyAsFastAsReportedSpeed() throws {
    let speed = 15.0
    let length = 2_000.0
    let fittingMeters = 35.0 + 5
    var wrongWayHeld = 0
    for separation in [12.0, 25, 40, 60, 100, 200] {
      let corners = [(0, 0), (length, 0), (length, separation), (0, separation)]
      let total = 2 * length + separation
      for gap in [20.0, 45, 75, 100, 120, 140, 180, 240, 360] {
        let context = "separation \(separation), gap \(gap)"
        func outbound() throws -> NavigationCore {
          let core = NavigationCore()
          try core.setRoute(Trace.route(corners))
          for second in 0...40 {
            try core.updateLocation(
              Trace.sample(
                x: Double(second) * speed, y: 0, courseDegrees: 90, speed: speed,
                time: Double(second))
            )
          }
          XCTAssertEqual(along(core.currentSnapshot(), core), 600, accuracy: 1, context)
          return core
        }

        // Wrong way, on the outbound pavement.
        let wrongWay = try outbound()
        var snapshot = wrongWay.currentSnapshot()
        var everExplained = false
        for index in 0..<3 {
          let x = 200 - Double(index) * speed
          let elapsed = gap + Double(index)
          snapshot = try wrongWay.updateLocation(
            Trace.sample(x: x, y: 0, courseDegrees: 270, speed: speed, time: 40 + elapsed)
          )
          let progress = along(snapshot, wrongWay)
          let explainedMeters = 1.5 * speed * elapsed + 25 + 5
          // The first place on the return carriageway that the fix fits (GPS error reaches
          // that far back along it).
          let fitsBackMeters = (fittingMeters * fittingMeters - separation * separation)
            .squareRoot()
          let returnAdvance = total - x - 600 - (separation <= fittingMeters ? fitsBackMeters : 0)
          let isReturnExplained = separation <= fittingMeters && returnAdvance <= explainedMeters
          everExplained = everExplained || isReturnExplained
          XCTAssertNotEqual(snapshot.phase, .arrived, "\(context), fix \(index)")
          XCTAssertLessThanOrEqual(progress, 600 + explainedMeters, "\(context), fix \(index)")
          if !everExplained {
            XCTAssertEqual(progress, 600, accuracy: 1, "\(context), fix \(index)")
          }
        }
        if !everExplained {
          wrongWayHeld += 1
          XCTAssertTrue(snapshot.isOffRoute, context)
        } else {
          XCTAssertGreaterThanOrEqual(gap, 140, "the review's 75 s case must be held: \(context)")
        }

        // Kept driving the route.
        let genuine = try outbound()
        let travelled = min(600 + speed * gap, total - 300)
        let drive = Trace.positions(along: corners, every: speed).filter {
          $0.alongMeters >= travelled
        }
        var time = 40 + gap
        snapshot = genuine.currentSnapshot()
        for (index, position) in drive.enumerated() {
          snapshot = try genuine.updateLocation(
            Trace.sample(
              x: position.x, y: position.y, courseDegrees: position.courseDegrees, speed: speed,
              time: time)
          )
          time += 1
          XCTAssertFalse(snapshot.isOffRoute, "\(context), driven fix \(index)")
          XCTAssertEqual(
            along(snapshot, genuine), position.alongMeters, accuracy: 15,
            "\(context), driven fix \(index)"
          )
        }
        for _ in 0..<2 {
          snapshot = try genuine.updateLocation(
            Trace.sample(x: 0, y: separation, speed: 0, time: time)
          )
          time += 1
        }
        XCTAssertEqual(snapshot.phase, .arrived, context)
      }
    }
    // Every gap at 60 m and wider, and every gap up to 120 s on narrower roads.
    XCTAssertGreaterThanOrEqual(wrongWayHeld, 3 * 9 + 3 * 5)
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

  /// Off route, two far fixes a kilometre apart each look like a return to the route, long
  /// enough later to have driven to either. They do not agree, so neither is believed; a third
  /// that agrees with the second is.
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
    for (second, y) in [(400, 0.0), (401, 1_000)] {
      let outlier = try core.updateLocation(
        Trace.sample(x: 2_000, y: y, speed: 15, time: Double(second))
      )
      XCTAssertTrue(outlier.isOffRoute)
      XCTAssertNil(outlier.matchedCoordinate)
      XCTAssertEqual(along(outlier, core), along(before, core), accuracy: 1)
    }
    let confirmed = try core.updateLocation(
      Trace.sample(x: 2_000, y: 985, courseDegrees: 180, speed: 15, time: 402)
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
    // Slightly behind the confirmed position the outbound segment still counts, from the
    // confirmed position on: the vehicle has not gone to the far end and come back.
    for y in [2_990.0, 2_900, 2_500] {
      XCTAssertEqual(
        try XCTUnwrap(core.rejoinBaseAlongMeters(near: Trace.coordinate(60, y))), 3_000,
        accuracy: 1, "y \(y)"
      )
    }
    let rejoin = try XCTUnwrap(
      navigationKeepRouteRejoinAlongMeters(
        fixAlongMeters: base, routeLengthMeters: try XCTUnwrap(core.routeLengthMeters))
    )
    let point = Trace.local(try XCTUnwrap(core.routePoint(alongMeters: rejoin)))
    XCTAssertEqual(point.x, 0, accuracy: 1)
    XCTAssertEqual(point.y, 3_800, accuracy: 1)
  }

  /// The vehicle is far along a long out-and-back from where it was last confirmed, beside both
  /// carriageways, with the turnaround out of the grid's range. Both legs are within reach of
  /// its displacement; the base stays on the one that comes first along the route.
  func testKeepRouteRejoinBaseStaysOnTheFirstLegWhenBothAreWithinReach() throws {
    let core = NavigationCore()
    let corners: [(Double, Double)] = [(0, 0), (0, 20_000), (40, 20_000), (40, 0)]
    try core.setRoute(corners.map { Trace.coordinate($0.0, $0.1) })
    try core.updateLocation(Trace.sample(x: 0, y: 0, courseDegrees: 0, speed: 20, time: 0))
    let base = try XCTUnwrap(core.rejoinBaseAlongMeters(near: Trace.coordinate(60, 18_000)))
    XCTAssertEqual(base, 18_000, accuracy: 20)
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
    // Stopping 40 m on from a moving fix is further than the two speeds explain: the first
    // fix there is held, the second confirms it.
    for earlier in [3.0, 2, 1, 0] {
      try core.updateLocation(
        Trace.sample(
          x: shape.parked.x, y: shape.parked.y, speed: speed, time: time.map { $0 - earlier })
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
  /// accepted fix and not explained by the road near it is believed on its second fix, when
  /// the elapsed time makes it possible. When it does not (seconds after the vehicle was parked
  /// kilometres back), it is not progress: off route on the third fix, from which the trip is
  /// rerouted from the position.
  func testSustainedFarPositionsAreBelievedOnGeneratedRoutesWhenPossible() throws {
    var random = Trace.Noise(seed: 0x5EED_0004)
    var believedCases = 0
    var impossibleCases = 0
    for shape in shapes(seed: 0x5EED_0005, count: 12) {
      let positions = Trace.positions(along: shape.corners, every: 10)
      for clock in [Clock.everySecond, .longGap, .veryLongGap] {
        for _ in 0..<5 {
          let index = Int(abs(random.next(amplitude: 1)) * Double(positions.count - 4))
          let target = positions[index]
          let next = positions[index + 1]
          let third = positions[index + 2]
          guard target.alongMeters > shape.parkedAlong + 700,
            hypot(target.x - shape.parked.x, target.y - shape.parked.y) > 500,
            target.courseDegrees == next.courseDegrees,
            next.courseDegrees == third.courseDegrees
          else { continue }
          // Somewhere the route passes only once: the expected match is unambiguous.
          let passes = positions.filter {
            hypot($0.x - target.x, $0.y - target.y) < 60
              && abs($0.alongMeters - target.alongMeters) > 150
          }
          guard passes.isEmpty else { continue }
          let core = try park(shape, speed: 0, time: clock.time(0))
          let total = try XCTUnwrap(core.routeLengthMeters)
          let held = try core.updateLocation(
            Trace.sample(
              x: target.x, y: target.y, courseDegrees: target.courseDegrees, speed: 10,
              time: clock.time(1))
          )
          let context = "\(shape.name), \(clock), target \(target.alongMeters)"
          XCTAssertEqual(held.routeProgress * total, shape.parkedAlong, accuracy: 5, context)
          let second = try core.updateLocation(
            Trace.sample(
              x: next.x, y: next.y, courseDegrees: next.courseDegrees, speed: 10,
              time: clock.time(2))
          )
          // The speed ceiling over the time since the last accepted fix.
          let possibleMeters = (clock.time(2)! - clock.time(0)!) * 45 + 30
          if next.alongMeters - shape.parkedAlong <= possibleMeters {
            believedCases += 1
            XCTAssertFalse(second.isOffRoute, context)
            XCTAssertEqual(second.routeProgress * total, next.alongMeters, accuracy: 15, context)
          } else {
            impossibleCases += 1
            XCTAssertEqual(second.routeProgress * total, shape.parkedAlong, accuracy: 5, context)
            let recovering = try core.updateLocation(
              Trace.sample(
                x: third.x, y: third.y, courseDegrees: third.courseDegrees, speed: 10,
                time: clock.time(3))
            )
            XCTAssertTrue(recovering.isOffRoute, context)
            XCTAssertEqual(recovering.phase, .tracking, context)
            XCTAssertEqual(
              recovering.routeProgress * total, shape.parkedAlong, accuracy: 5, context
            )
            XCTAssertNil(recovering.matchedCoordinate, context)
          }
        }
      }
    }
    XCTAssertGreaterThan(believedCases, 40)
    XCTAssertGreaterThan(impossibleCases, 20)
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

  // MARK: Generated drives

  /// Routes that pass their own neighbourhood again, each as the corners of its legs.
  private func revisitingRoutes(seed: UInt64, count: Int) -> [(name: String, corners: [(Double, Double)])] {
    var random = Trace.Noise(seed: seed)
    func pick(_ low: Double, _ high: Double) -> Double {
      ((low + high) / 2 + random.next(amplitude: (high - low) / 2)).rounded()
    }
    var routes: [(String, [(Double, Double)])] = []
    for _ in 0..<count {
      // A short loop, 100 to 500 m round, ending beside its start.
      let side = pick(25, 120)
      let gap = pick(8, 30)
      routes.append(
        ("short loop \(side) gap \(gap)", [(0, 0), (0, side), (side, side), (side, 0), (gap, 0)])
      )
      // An out-and-back, carriageways 12 to 250 m apart.
      let length = pick(300, 2_500)
      let separation = pick(12, 250)
      routes.append(
        (
          "out-and-back \(length) separation \(separation)",
          [(0, 0), (length, 0), (length, separation), (0, separation)]
        )
      )
      // A parkade spiral: the same square driven three times, then out.
      let ramp = pick(20, 40)
      var spiral: [(Double, Double)] = [(0, -pick(150, 400)), (0, 0)]
      for _ in 0..<3 {
        spiral += [(0, ramp), (ramp, ramp), (ramp, 0), (0, 0)]
      }
      spiral.append((-pick(150, 400), 0))
      routes.append(("spiral \(ramp)", spiral))
      // A self-crossing.
      let reach = pick(400, 2_000)
      let rise = pick(200, 1_200)
      routes.append(
        (
          "self-crossing \(reach) rise \(rise)",
          [(0, 0), (reach, 0), (reach, rise), (reach / 2, rise), (reach / 2, -rise)]
        )
      )
      // A long way round that ends near where it started.
      let width = pick(800, 3_000)
      let height = pick(800, 3_000)
      routes.append(
        (
          "loop \(width)x\(height)",
          [(0, 0), (0, height), (width, height), (width, 0), (pick(10, 60), 0)]
        )
      )
    }
    return routes
  }

  /// What a generated drive does to the fixes of a vehicle that follows the route.
  private enum Disturbance: CaseIterable {
    case none
    /// Fixes stop for a while; the vehicle keeps driving (short gaps) or waits (long ones).
    case gap
    /// One fix somewhere else on the route.
    case singleOutlier
    /// The same fix delivered several times, timestamp included.
    case repeatedSample
    /// Two fixes with the same timestamp in different places.
    case duplicatedTimestamp
    /// One impossible speed reading.
    case badSpeed
    /// Two consecutive fixes displaced by the same 50 to 300 m.
    case biasedPair
  }

  /// Drives every generated route from start to finish with one disturbance each, and checks
  /// what must hold whatever the fixes say:
  ///   - progress is never ahead of where the vehicle is by more than GPS error explains;
  ///   - the trip does not end before the vehicle is at the destination;
  ///   - undisturbed, the vehicle is followed all the way and arrives.
  func testGeneratedDrivesNeverGetAheadOfTheVehicle() throws {
    var random = Trace.Noise(seed: 0xD21E_0001)
    var drives = 0
    var arrivals = 0
    for (name, corners) in revisitingRoutes(seed: 0xD21E_0002, count: 10) {
      let speed = name.hasPrefix("spiral") || name.hasPrefix("short") ? 5.0 : 15.0
      let truth = Trace.positions(along: corners, every: speed)
      let total = truth[truth.count - 1].alongMeters
      for disturbance in Disturbance.allCases {
        for gapSeconds in disturbance == .gap ? [1.0, 7, 40, 300, 700, 7_200] : [0.0] {
          drives += 1
          let core = NavigationCore()
          try core.setRoute(Trace.route(corners))
          let at = 2 + Int(abs(random.next(amplitude: 1)) * Double(truth.count - 6))
          let bias = (
            random.next(amplitude: 1) >= 0 ? 1.0 : -1.0,
            50 + abs(random.next(amplitude: 250))
          )
          let biasAngle = random.next(amplitude: .pi)
          let outlier = truth[Int(abs(random.next(amplitude: 1)) * Double(truth.count - 1))]
          var time = 0.0
          var index = 0
          var maximumErrorMeters = 0.0
          var wasDisturbed = false
          var sawOffRoute = false
          var arrived = false
          let context = "\(name), \(disturbance), gap \(gapSeconds), at \(at)"

          func feed(
            _ x: Double, _ y: Double, course: Double?, speed: Double?, time: TimeInterval,
            truthAlong: Double
          ) throws {
            let snapshot = try core.updateLocation(
              Trace.sample(x: x, y: y, courseDegrees: course, speed: speed, time: time)
            )
            sawOffRoute = sawOffRoute || snapshot.isOffRoute
            if snapshot.phase == .arrived {
              arrived = true
              XCTAssertLessThanOrEqual(
                total - truthAlong, 60 + maximumErrorMeters, "arrived early: \(context)"
              )
            } else {
              XCTAssertLessThanOrEqual(
                snapshot.routeProgress * total,
                truthAlong + 200 + 1.5 * maximumErrorMeters,
                "ahead of the vehicle: \(context)"
              )
            }
          }

          while index < truth.count, !arrived {
            let position = truth[index]
            if index == at {
              wasDisturbed = disturbance != .none
              switch disturbance {
              case .none:
                break
              case .gap:
                time += gapSeconds
                // The vehicle keeps driving through a short gap and waits through a long one.
                if gapSeconds <= 40 {
                  index = min(truth.count - 1, index + Int(gapSeconds))
                }
              case .singleOutlier:
                maximumErrorMeters = 0
                try feed(
                  outlier.x, outlier.y, course: nil, speed: 0, time: time,
                  truthAlong: position.alongMeters)
                time += 1
              case .repeatedSample:
                for _ in 0..<4 {
                  try feed(
                    outlier.x, outlier.y, course: nil, speed: 0, time: time,
                    truthAlong: position.alongMeters)
                }
                time += 1
              case .duplicatedTimestamp:
                try feed(
                  outlier.x, outlier.y, course: nil, speed: 0, time: time,
                  truthAlong: position.alongMeters)
                try feed(
                  position.x, position.y, course: position.courseDegrees, speed: speed,
                  time: time, truthAlong: position.alongMeters)
                time += 1
              case .badSpeed:
                try feed(
                  position.x, position.y, course: position.courseDegrees, speed: 100,
                  time: time, truthAlong: position.alongMeters)
                time += 1
              case .biasedPair:
                maximumErrorMeters = bias.1
                for _ in 0..<2 {
                  try feed(
                    position.x + bias.1 * cos(biasAngle), position.y + bias.1 * sin(biasAngle),
                    course: nil, speed: 0, time: time, truthAlong: position.alongMeters)
                  time += 1
                }
              }
            }
            let current = truth[index]
            try feed(
              current.x + random.next(amplitude: 2), current.y + random.next(amplitude: 2),
              course: current.courseDegrees, speed: speed, time: time,
              truthAlong: current.alongMeters)
            time += 1
            index += 1
          }
          // Parked at the destination.
          let last = truth[truth.count - 1]
          for _ in 0..<3 where !arrived {
            try feed(last.x, last.y, course: nil, speed: 0, time: time, truthAlong: total)
            time += 1
          }
          if !wasDisturbed {
            XCTAssertFalse(sawOffRoute, "left the route undisturbed: \(context)")
            XCTAssertTrue(arrived, "did not arrive undisturbed: \(context)")
          }
          arrivals += arrived ? 1 : 0
        }
      }
    }
    XCTAssertGreaterThan(drives, 500)
    // Most disturbed drives are still followed to the end; the rest end in a reroute.
    XCTAssertGreaterThan(Double(arrivals), 0.6 * Double(drives))
    print("GENERATED_DRIVES drives=\(drives) arrivals=\(arrivals)")
  }

  /// Brings `core` to `parked` over the 60 m before it, as a vehicle driving there. Where the
  /// route passes that place more than once the first fix may be placed on another pass (the
  /// first fix of a route is placed where it scores best); such a case is left out.
  private func approach(
    _ core: NavigationCore,
    corners: [(Double, Double)],
    truth: [Trace.Position],
    parked: Trace.Position
  ) throws -> Bool {
    try core.setRoute(Trace.route(corners))
    var time = -30.0
    for position in truth
    where position.alongMeters <= parked.alongMeters
      && position.alongMeters >= parked.alongMeters - 60
    {
      try core.updateLocation(
        Trace.sample(
          x: position.x, y: position.y, courseDegrees: position.courseDegrees, speed: 5,
          time: time)
      )
      time += 1
    }
    let total = core.routeLengthMeters ?? 0
    return abs(core.currentSnapshot().routeProgress * total - parked.alongMeters) < 10
  }

  /// A vehicle that stands still on a generated route, with fixes that land anywhere within a
  /// city block of it (on other passes of the route where there are any), timestamped in every
  /// way live fixes can be, with no speed, a standstill or an impossible speed: the trip does
  /// not end, and progress is never wrong by more than the fixes themselves are.
  ///
  /// Not covered, because it is not decidable: fixes that report a believable speed while they
  /// move round a loop smaller than their own error are, to any matcher, a vehicle driving it.
  func testAParkedVehicleStaysOnItsPassOnGeneratedRoutes() throws {
    var random = Trace.Noise(seed: 0xD21E_0003)
    var cases = 0
    for (name, corners) in revisitingRoutes(seed: 0xD21E_0004, count: 10) {
      let truth = Trace.positions(along: corners, every: 5)
      let total = truth[truth.count - 1].alongMeters
      for _ in 0..<6 {
        // Parked somewhere with at least 80 m of route left.
        let candidates = truth.filter { $0.alongMeters < total - 80 }
        let parked = candidates[Int(abs(random.next(amplitude: 1)) * Double(candidates.count - 1))]
        // Other places on the route within 300 m of the vehicle, and a point off it.
        let nearby = truth.filter {
          let distance = hypot($0.x - parked.x, $0.y - parked.y)
          return distance > 20 && distance <= 290
        }
        // Anywhere within 290 m, the most a position is taken to be wrong by.
        let bearing = random.next(amplitude: .pi)
        let distance = 50 + abs(random.next(amplitude: 240))
        var lures: [(Double, Double)] = [
          (parked.x + distance * cos(bearing), parked.y + distance * sin(bearing))
        ]
        for _ in 0..<3 where !nearby.isEmpty {
          let lure = nearby[Int(abs(random.next(amplitude: 1)) * Double(nearby.count - 1))]
          lures.append((lure.x, lure.y))
        }
        for clock in Clock.allCases where clock != .untimed {
          for speed in [0.0, nil, 100] as [Double?] {
            for lure in lures {
              cases += 1
              let core = NavigationCore()
              try core.setRoute(Trace.route(corners))
              guard try approach(core, corners: corners, truth: truth, parked: parked) else {
                continue
              }
              try core.updateLocation(
                Trace.sample(x: parked.x, y: parked.y, speed: 0, time: clock.time(0))
              )
              let home = (parked.x, parked.y)
              for (index, place) in [lure, lure, lure, home, lure, home, home].enumerated() {
                let snapshot = try core.updateLocation(
                  Trace.sample(x: place.0, y: place.1, speed: speed, time: clock.time(index + 1))
                )
                let context = "\(name) at \(parked.alongMeters), \(clock), "
                  + "speed \(String(describing: speed)), lure \(lure), fix \(index)"
                XCTAssertEqual(snapshot.phase, .tracking, context)
                // Wrong by no more than the fixes are: a fix this far from the vehicle can
                // account for this much route, and no more.
                let offset = hypot(lure.0 - parked.x, lure.1 - parked.y)
                XCTAssertLessThanOrEqual(
                  abs(snapshot.routeProgress * total - parked.alongMeters), 1.5 * offset + 60,
                  context
                )
              }
            }
          }
        }
      }
    }
    XCTAssertGreaterThan(cases, 2_000)
  }

  /// Random fixes within a city block of a parked vehicle, singly and in agreeing pairs, on
  /// other parts of the route and off it, however they are timestamped: the trip never ends
  /// unless the destination itself is within reach of that error along the vehicle's own road,
  /// or the fixes reach round the whole route (a loop smaller than their own error).
  func testRandomFixesAroundAParkedVehicleNeverEndTheTrip() throws {
    var random = Trace.Noise(seed: 0xD21E_0005)
    func unit() -> Double { abs(random.next(amplitude: 1)) }
    var cases = 0
    for (name, corners) in revisitingRoutes(seed: 0xD21E_0006, count: 60) {
      let truth = Trace.positions(along: corners, every: 5)
      let total = truth[truth.count - 1].alongMeters
      let places = truth.filter { $0.alongMeters < total - 40 }
      for _ in 0..<12 {
        let parked = places[Int(unit() * Double(places.count - 1))]
        let radius = [60.0, 150, 290][Int(unit() * 2.99)]
        let nearby = truth.filter {
          let distance = hypot($0.x - parked.x, $0.y - parked.y)
          return distance > 5 && distance <= radius
        }
        let speed: Double? = [0.0, nil, 100][Int(unit() * 2.99)]
        // 0: every second. 1: all with one timestamp. 2: after a 12-minute gap. 3: every 3 s.
        let clock = Int(unit() * 3.99)
        let core = NavigationCore()
        guard try approach(core, corners: corners, truth: truth, parked: parked) else {
          continue
        }
        try core.updateLocation(Trace.sample(x: parked.x, y: parked.y, speed: 0, time: 0))
        cases += 1
        var fixes: [(Double, Double)] = []
        for _ in 0..<(1 + Int(unit() * 6)) {
          let kind = unit()
          if kind < 0.45, !nearby.isEmpty {
            let place = nearby[Int(unit() * Double(nearby.count - 1))]
            fixes.append((place.x, place.y))
          } else if kind < 0.8 {
            let bearing = random.next(amplitude: .pi)
            let distance = unit() * radius
            fixes.append((parked.x + distance * cos(bearing), parked.y + distance * sin(bearing)))
          } else {
            fixes.append((parked.x, parked.y))
          }
          if unit() < 0.5, let last = fixes.last {
            fixes.append(last)
          }
        }
        fixes += Array(repeating: (parked.x, parked.y), count: 3)
        var now = clock == 2 ? 700.0 : 1.0
        var furthest = 0.0
        // How far the route reaches from where the vehicle stands.
        let extent = truth.map { hypot($0.x - parked.x, $0.y - parked.y) }.max() ?? 0
        for fix in fixes {
          furthest = max(furthest, hypot(fix.0 - parked.x, fix.1 - parked.y))
          let snapshot = try core.updateLocation(
            Trace.sample(x: fix.0, y: fix.1, speed: speed, time: now)
          )
          if clock != 1 {
            now += clock == 3 ? 3 : 1
          }
          if snapshot.phase == .arrived {
            // Fixes that reach round the whole route are, to any matcher, a drive round it.
            if extent <= furthest + 45 {
              break
            }
            XCTAssertLessThanOrEqual(
              total - parked.alongMeters, 1.5 * furthest + 60,
              "\(name) parked at \(parked.alongMeters), speed \(String(describing: speed)), "
                + "clock \(clock), fixes \(fixes)"
            )
            break
          }
        }
      }
    }
    XCTAssertGreaterThan(cases, 3_000)
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
