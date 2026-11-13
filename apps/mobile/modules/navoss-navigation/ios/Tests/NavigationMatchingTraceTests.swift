import Foundation
import XCTest

@testable import NavOSSNavigationCore

/// Drive traces against the matcher. Each scenario is one that a nearest-segment matcher gets
/// wrong in practice; the assertions are what the driver would see go wrong.
final class NavigationMatchingTraceTests: XCTestCase {
  private typealias Trace = NavigationTrace

  private func along(_ snapshot: NavigationSnapshot, _ core: NavigationCore) -> Double {
    snapshot.routeProgress * (core.routeLengthMeters ?? 0)
  }

  /// The route runs east, loops round, and later runs east again 35 m north on a parallel
  /// frontage road. GPS biased north sits closer to the later road for the whole first pass.
  func testParallelLaterRoadDoesNotStealTheMatch() throws {
    let core = NavigationCore()
    try core.setRoute(
      Trace.route([(0, 0), (2_000, 0), (2_000, 400), (-500, 400), (-500, 35), (2_500, 35)])
    )
    var time = 0.0
    var previousAlong = 0.0
    for position in Trace.positions(along: [(0, 0), (1_900, 0)], every: 25) {
      let bias = position.alongMeters < 50 ? 0 : 19.0
      let snapshot = try core.updateLocation(
        Trace.sample(
          x: position.x,
          y: position.y + bias,
          courseDegrees: 90,
          accuracy: 8,
          speed: 25,
          time: time
        )
      )
      time += 1
      let matchedAlong = along(snapshot, core)
      XCTAssertFalse(snapshot.isOffRoute, "biased GPS on the first pass is still on route")
      XCTAssertEqual(matchedAlong, position.alongMeters, accuracy: 30)
      XCTAssertGreaterThanOrEqual(matchedAlong, previousAlong - 1)
      let matched = Trace.local(try XCTUnwrap(snapshot.matchedCoordinate))
      XCTAssertEqual(matched.y, 0, accuracy: 1, "matched onto the frontage road")
      previousAlong = matchedAlong
    }
  }

  /// The route passes under a bridge and later crosses over it. Without a usable course both
  /// passes look identical at the crossing point; continuity must pick the right one each time.
  func testOverpassCrossingMatchesTheCorrectPassEachTime() throws {
    let core = NavigationCore()
    let corners: [(Double, Double)] = [
      (0, 0), (1_000, 0), (1_000, 300), (500, 300), (500, -300), (500, -1_000),
    ]
    try core.setRoute(Trace.route(corners))
    var noise = Trace.Noise(seed: 7)
    var time = 0.0
    var crossings: [(pathAlong: Double, matchedAlong: Double)] = []
    for position in Trace.positions(along: corners, every: 15) {
      let snapshot = try core.updateLocation(
        Trace.sample(
          x: position.x + noise.next(amplitude: 5),
          y: position.y + noise.next(amplitude: 5),
          courseDegrees: nil,
          accuracy: 6,
          speed: 15,
          time: time
        )
      )
      time += 1
      XCTAssertFalse(snapshot.isOffRoute)
      XCTAssertEqual(along(snapshot, core), position.alongMeters, accuracy: 25)
      // Both passes over the crossing point (500, 0): along 500 m and along 2,100 m.
      if abs(position.alongMeters - 500) < 8 || abs(position.alongMeters - 2_100) < 8 {
        crossings.append((position.alongMeters, along(snapshot, core)))
      }
    }
    XCTAssertEqual(crossings.count, 2, "the trace drives through the crossing twice")
    for crossing in crossings {
      XCTAssertEqual(crossing.matchedAlong, crossing.pathAlong, accuracy: 25)
    }
  }

  /// Out along one carriageway and back along the other, 12 m apart, with noisy fixes and no
  /// course: progress never jumps between legs and the trip arrives.
  func testOutAndBackKeepsEachLegAndArrives() throws {
    let core = NavigationCore()
    let corners: [(Double, Double)] = [(0, 0), (1_500, 0), (1_500, 12), (0, 12)]
    try core.setRoute(Trace.route(corners))
    var noise = Trace.Noise(seed: 11)
    var time = 0.0
    var highest = 0.0
    var last = try core.updateLocation(Trace.sample(x: 0, y: 0, speed: 12, time: time))
    for position in Trace.positions(along: corners, every: 12).dropFirst() {
      time += 1
      last = try core.updateLocation(
        Trace.sample(
          x: position.x + noise.next(amplitude: 6),
          y: position.y + noise.next(amplitude: 6),
          accuracy: 6,
          speed: 12,
          time: time
        )
      )
      if last.phase == .arrived { break }
      XCTAssertFalse(last.isOffRoute)
      let matchedAlong = along(last, core)
      XCTAssertGreaterThan(matchedAlong, highest - 20, "progress jumped back to the other leg")
      XCTAssertLessThan(matchedAlong, position.alongMeters + 40, "progress jumped ahead")
      highest = max(highest, matchedAlong)
    }
    for _ in 0..<2 {
      time += 1
      last = try core.updateLocation(Trace.sample(x: 0, y: 12, accuracy: 5, speed: 0, time: time))
    }
    XCTAssertEqual(last.phase, .arrived)
  }

  /// A tunnel: fixes stop for 14 s at 20 m/s. The matched position keeps moving along the road
  /// instead of freezing, then the first fix after the tunnel is accepted at once.
  func testDeadReckonsThroughAShortGpsDropoutThenResumes() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route([(0, 0), (5_000, 0)]))
    for second in 0...30 {
      try core.updateLocation(
        Trace.sample(x: Double(second) * 20, y: 0, courseDegrees: 90, speed: 20, time: Double(second))
      )
    }
    XCTAssertNil(core.deadReckon(at: Trace.time(31)), "no extrapolation inside a normal interval")

    var previous = 600.0
    for second in 33...44 {
      let reckoned = try XCTUnwrap(core.deadReckon(at: Trace.time(Double(second))))
      XCTAssertTrue(reckoned.isDeadReckoning)
      XCTAssertFalse(reckoned.isOffRoute)
      let reckonedAlong = along(reckoned, core)
      XCTAssertEqual(reckonedAlong, 600 + Double(second - 30) * 20, accuracy: 1)
      XCTAssertGreaterThan(reckonedAlong, previous)
      previous = reckonedAlong
    }

    let resumed = try core.updateLocation(
      Trace.sample(x: 900, y: 0, courseDegrees: 90, speed: 20, time: 45)
    )
    XCTAssertFalse(resumed.isDeadReckoning)
    XCTAssertFalse(resumed.isOffRoute)
    XCTAssertEqual(along(resumed, core), 900, accuracy: 1)
  }

  func testDeadReckoningStopsAfterItsTimeLimitAndNeverReachesArrival() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route([(0, 0), (500, 0)]))
    for second in 0...20 {
      try core.updateLocation(
        Trace.sample(x: Double(second) * 20, y: 0, courseDegrees: 90, speed: 20, time: Double(second))
      )
    }
    let reckoned = try XCTUnwrap(core.deadReckon(at: Trace.time(30)))
    XCTAssertEqual(reckoned.phase, .tracking)
    XCTAssertLessThanOrEqual(reckoned.routeProgress, 0.98)
    XCTAssertNil(core.deadReckon(at: Trace.time(41)), "gap beyond the limit freezes honestly")
  }

  func testDeadReckoningNeedsAMovingVehicleOnRoute() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route([(0, 0), (2_000, 0)]))
    try core.updateLocation(Trace.sample(x: 100, y: 0, speed: 1, time: 0))
    XCTAssertNil(core.deadReckon(at: Trace.time(5)), "crawling vehicle: nothing to extrapolate")

    try core.updateLocation(Trace.sample(x: 120, y: 0, speed: 15, time: 6))
    XCTAssertNotNil(core.deadReckon(at: Trace.time(10)))

    // Untimed replay input never dead-reckons.
    let replay = NavigationCore()
    try replay.setRoute(Trace.route([(0, 0), (2_000, 0)]))
    try replay.updateLocation(Trace.sample(x: 100, y: 0, speed: 15))
    XCTAssertNil(replay.deadReckon(at: Trace.time(10)))
  }

  /// A 40 s outage at 20 m/s: the next fix is 800 m further on. The matcher must accept it
  /// rather than treat it as a jump.
  func testLongOutageJumpIsAcceptedWhenSpeedExplainsIt() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route([(0, 0), (5_000, 0)]))
    for second in 0...30 {
      try core.updateLocation(
        Trace.sample(x: Double(second) * 20, y: 0, courseDegrees: 90, speed: 20, time: Double(second))
      )
    }
    let resumed = try core.updateLocation(
      Trace.sample(x: 1_400, y: 0, courseDegrees: 90, speed: 20, time: 70)
    )
    XCTAssertFalse(resumed.isOffRoute)
    XCTAssertEqual(along(resumed, core), 1_400, accuracy: 1)
  }

  /// A single multipath fix lands on the route 400 m ahead of where a 15 m/s vehicle could be.
  /// It is held; the next real fix continues normally, and a jump that two fixes agree on is
  /// accepted.
  func testImplausibleSingleFixJumpIsHeldButAConfirmedOneIsAccepted() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route([(0, 0), (5_000, 0)]))
    for second in 0...10 {
      try core.updateLocation(
        Trace.sample(x: Double(second) * 15, y: 0, courseDegrees: 90, speed: 15, time: Double(second))
      )
    }
    let jump = try core.updateLocation(
      Trace.sample(x: 565, y: 0, courseDegrees: 90, speed: 15, time: 11)
    )
    XCTAssertEqual(along(jump, core), 150, accuracy: 1, "multipath fix must not move the puck")
    XCTAssertFalse(jump.isOffRoute)

    let next = try core.updateLocation(
      Trace.sample(x: 180, y: 0, courseDegrees: 90, speed: 15, time: 12)
    )
    XCTAssertEqual(along(next, core), 180, accuracy: 1)

    _ = try core.updateLocation(Trace.sample(x: 700, y: 0, courseDegrees: 90, speed: 15, time: 13))
    let confirmed = try core.updateLocation(
      Trace.sample(x: 715, y: 0, courseDegrees: 90, speed: 15, time: 14)
    )
    XCTAssertEqual(along(confirmed, core), 715, accuracy: 1)
  }

  /// A U-turn on the route becomes off-route as fast as hysteresis allows, without first
  /// rewinding progress through the backward-noise allowance.
  func testUTurnBecomesOffRouteWithoutRewindingProgress() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route([(0, 0), (3_000, 0)]))
    var time = 0.0
    for position in Trace.positions(along: [(0, 0), (1_000, 0)], every: 15) {
      try core.updateLocation(
        Trace.sample(x: position.x, y: 0, courseDegrees: 90, speed: 15, time: time)
      )
      time += 1
    }
    let before = core.currentSnapshot()
    var fixesAfterTurn = 0
    var snapshot = before
    for position in Trace.positions(along: [(990, 3), (0, 3)], every: 10) {
      time += 1
      fixesAfterTurn += 1
      snapshot = try core.updateLocation(
        Trace.sample(x: position.x, y: position.y, courseDegrees: 270, speed: 10, time: time)
      )
      XCTAssertGreaterThan(snapshot.routeProgress, before.routeProgress - 20 / 3_000)
      if snapshot.isOffRoute { break }
    }
    XCTAssertTrue(snapshot.isOffRoute)
    // Course plus speed reveal the reversal on the first fix; hysteresis still needs three.
    XCTAssertEqual(fixesAfterTurn, 3)
  }

  /// Per-fix cost must depend on the road near the vehicle, not on how long the route is.
  func testPerFixCostDoesNotScaleWithRouteLength() throws {
    func windingRoute(vertexCount: Int) -> [NavigationCoordinate] {
      (0..<vertexCount).map { index in
        let x = Double(index) * 5
        return Trace.coordinate(x, 200 * sin(x / 1_000))
      }
    }
    func drive(vertexCount: Int) throws -> (maximum: Int, mean: Double, first: Int) {
      let geometry = windingRoute(vertexCount: vertexCount)
      let core = NavigationCore()
      try core.setRoute(geometry)
      var counts: [Int] = []
      // 3 km at roughly 25 m/s, one fix per second.
      for (second, index) in stride(from: 0, to: 600, by: 5).enumerated() {
        try core.updateLocation(
          NavigationLocationSample(
            coordinate: geometry[index],
            horizontalAccuracyMeters: 5,
            speedMetersPerSecond: 25,
            timestamp: Trace.time(Double(second))
          )
        )
        counts.append(core.lastEvaluatedSegmentCount)
      }
      return (
        counts.max() ?? 0,
        Double(counts.reduce(0, +)) / Double(counts.count),
        counts.first ?? 0
      )
    }

    let short = try drive(vertexCount: 6_000)
    let long = try drive(vertexCount: 60_000)

    XCTAssertLessThan(short.maximum, 400)
    XCTAssertLessThan(long.maximum, 400, "a 300 km route must not cost more per fix")
    XCTAssertLessThan(long.mean, short.mean * 1.1 + 5)
    XCTAssertLessThan(long.first, 400, "the first fix uses the spatial grid, not a full scan")
  }

  /// The windowed, grid-backed search must find the same match as an exhaustive scan whenever
  /// there is no history to disagree with.
  func testFirstFixMatchesExhaustiveNearestSegment() throws {
    let geometry = Trace.route(
      [(0, 0), (800, 0), (800, 600), (-300, 600), (-300, -400), (1_200, -400)],
      spacing: 15
    )
    let polyline = try RoutePolyline(coordinates: geometry)
    var noise = Trace.Noise(seed: 3)
    for _ in 0..<200 {
      let probe = Trace.coordinate(noise.next(amplitude: 1_400), noise.next(amplitude: 900))
      let exhaustive = polyline.segments.indices
        .map { polyline.project(probe, ontoSegment: $0) }
        .min { $0.distanceMeters < $1.distanceMeters }!
      let core = NavigationCore()
      try core.setRoute(geometry)
      let snapshot = try core.updateLocation(NavigationLocationSample(
        coordinate: probe,
        horizontalAccuracyMeters: 5
      ))
      XCTAssertEqual(
        snapshot.distanceFromRouteMeters ?? -1,
        exhaustive.distanceMeters,
        accuracy: 0.001
      )
    }
  }
}
