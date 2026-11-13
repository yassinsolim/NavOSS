import Foundation
import XCTest

@testable import NavOSSNavigationCore

/// What it takes to move progress onto another pass of the route, and to arrive. Each test is a
/// reproduction from the reviews of the far-jump change, or the liveness case that the rule
/// closing it must keep working. The rules are the matching invariants in `NavigationCore.swift`.
final class NavigationMatcherEvidenceTests: XCTestCase {
  private typealias Trace = NavigationTrace

  private func along(_ snapshot: NavigationSnapshot, _ core: NavigationCore) -> Double {
    snapshot.routeProgress * (core.routeLengthMeters ?? 0)
  }

  private static func carPlay(_ coordinates: [NavigationCoordinate]) -> [NavOSSCarPlayCoordinate] {
    coordinates.map { NavOSSCarPlayCoordinate(latitude: $0.latitude, longitude: $0.longitude) }
  }

  private static func trip(_ corners: [(Double, Double)], id: String = "evidence")
    -> NavOSSCarPlayTrip
  {
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
      geometry: carPlay(Trace.route(corners)), id: id, steps: steps
    )
  }

  private static let dividedRoad: [(Double, Double)] = [
    (0, 0), (0, 3_000), (200, 3_000), (200, 0),
  ]

  // MARK: Short loops: the multipath margin is not a way round a loop

  /// A 300 m out-and-back that ends 20 m from its start. Parked at the start with fixes that
  /// carry no speed, one fix biased 44 m lands on the last leg, 300 m of route away.
  func testOneBiasedFixCannotFinishAShortOutAndBack() throws {
    let session = NavigationSession()
    try session.start(Self.trip([(0, 0), (0, 140), (20, 140), (20, 0)]))
    _ = try session.updateLocation(Trace.sample(x: 0, y: 0, time: 0))
    let biased = try session.updateLocation(Trace.sample(x: 44, y: 0, time: 1))
    XCTAssertEqual(biased.snapshot.routeProgress, 0)
    for second in 2...6 {
      let genuine = try session.updateLocation(Trace.sample(x: 0, y: 0, time: Double(second)))
      XCTAssertEqual(genuine.snapshot.phase, .tracking)
      XCTAssertEqual(genuine.guidance?.stepIndex, 0)
    }
  }

  /// A 140 m loop, with a reported standstill: the whole loop is inside the multipath margin.
  func testReportedStandstillCannotFinishA140MetreLoop() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route([(0, 0), (0, 60), (20, 60), (20, 0)]))
    try core.updateLocation(Trace.sample(x: 0, y: 0, speed: 0, time: 0))
    for (index, x) in [44.0, 0, 0, 44, 44, 0, 0].enumerated() {
      let snapshot = try core.updateLocation(
        Trace.sample(x: x, y: 0, speed: 0, time: Double(index + 1))
      )
      XCTAssertEqual(snapshot.phase, .tracking, "fix \(index)")
      XCTAssertEqual(snapshot.routeProgress, 0, "fix \(index)")
    }
  }

  /// The same loop driven is finished.
  func testAShortLoopThatIsDrivenArrives() throws {
    let corners: [(Double, Double)] = [(0, 0), (0, 60), (20, 60), (20, 0)]
    let core = NavigationCore()
    try core.setRoute(Trace.route(corners))
    var time = 0.0
    var snapshot = core.currentSnapshot()
    let positions = Trace.positions(along: corners, every: 5)
    for position in positions + [positions[positions.count - 1], positions[positions.count - 1]] {
      snapshot = try core.updateLocation(
        Trace.sample(
          x: position.x, y: position.y, courseDegrees: position.courseDegrees, speed: 5,
          time: time)
      )
      time += 1
      if snapshot.phase == .tracking {
        XCTAssertFalse(snapshot.isOffRoute)
        XCTAssertEqual(along(snapshot, core), position.alongMeters, accuracy: 8)
      }
    }
    XCTAssertEqual(snapshot.phase, .arrived)
  }

  // MARK: Off-route recovery

  /// Off route, then two agreeing fixes on a later leg while driving it the wrong way. The
  /// position is confirmed; the fix is still a departure, and recovery does not publish it.
  func testRecoveryDoesNotPublishAFixThatIsADeparture() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route(Self.dividedRoad))
    try core.updateLocation(Trace.sample(x: 0, y: 200, courseDegrees: 0, speed: 15, time: 0))
    for (time, x) in [(5.0, 80.0), (6.0, 100.0), (7.0, 120.0)] {
      try core.updateLocation(
        Trace.sample(x: x, y: 200, courseDegrees: 90, speed: 20, time: time)
      )
    }
    let before = core.currentSnapshot()
    XCTAssertTrue(before.isOffRoute)
    for (time, y) in [(51.0, 1_000.0), (52.0, 1_020.0), (53.0, 1_040.0)] {
      let wrongWay = try core.updateLocation(
        Trace.sample(x: 200, y: y, courseDegrees: 0, speed: 20, time: time)
      )
      XCTAssertTrue(wrongWay.isOffRoute)
      XCTAssertNil(wrongWay.matchedCoordinate)
      XCTAssertNil(wrongWay.matchedCourseDegrees)
      XCTAssertEqual(wrongWay.routeProgress, before.routeProgress)
    }
  }

  /// The same leg driven the right way is recovered on the second fix.
  func testRecoveryOnALaterLegDrivenTheRightWay() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route(Self.dividedRoad))
    try core.updateLocation(Trace.sample(x: 0, y: 200, courseDegrees: 0, speed: 15, time: 0))
    for (time, x) in [(5.0, 80.0), (6.0, 100.0), (7.0, 120.0)] {
      try core.updateLocation(
        Trace.sample(x: x, y: 200, courseDegrees: 90, speed: 20, time: time)
      )
    }
    let held = try core.updateLocation(
      Trace.sample(x: 200, y: 2_000, courseDegrees: 180, speed: 20, time: 300)
    )
    XCTAssertTrue(held.isOffRoute)
    let recovered = try core.updateLocation(
      Trace.sample(x: 200, y: 1_980, courseDegrees: 180, speed: 20, time: 301)
    )
    XCTAssertFalse(recovered.isOffRoute)
    XCTAssertEqual(along(recovered, core), 4_220, accuracy: 5)
  }

  // MARK: Confirming a held fix

  /// One captured position delivered three times is one fix. The service's own acceptance
  /// predicate lets a repeated timestamp through.
  func testTheSameSampleDeliveredAgainDoesNotConfirmItself() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route(Self.dividedRoad))
    try core.updateLocation(Trace.sample(x: 0, y: 0, speed: 0, time: 0))
    // 500 m away, so that position alone could confirm it.
    let outlier = Trace.sample(x: 200, y: 460, speed: 0, time: 1)
    XCTAssertTrue(
      navOSSShouldAcceptNavigationLocation(
        candidateTimestamp: try XCTUnwrap(outlier.timestamp),
        latestTimestamp: try XCTUnwrap(outlier.timestamp), nowTimestamp: Trace.time(1))
    )
    for delivery in 0..<4 {
      let snapshot = try core.updateLocation(outlier)
      XCTAssertEqual(snapshot.routeProgress, 0, "delivery \(delivery)")
      XCTAssertEqual(snapshot.phase, .tracking)
    }
    // A fresh fix in the same place does confirm it.
    let fresh = try core.updateLocation(Trace.sample(x: 200, y: 460, speed: 0, time: 2))
    XCTAssertEqual(along(fresh, core), 5_740, accuracy: 5)
  }

  /// A held fix goes stale: a fix twenty minutes later is a first fix again, wherever it is.
  func testAFixLongAfterAHeldOneDoesNotConfirmIt() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route(Self.dividedRoad))
    try core.updateLocation(Trace.sample(x: 0, y: 0, speed: 0, time: 0))
    let first = try core.updateLocation(Trace.sample(x: 200, y: 460, speed: 0, time: 1))
    XCTAssertEqual(first.routeProgress, 0)
    for y in [1_500.0, 460] {
      let core = NavigationCore()
      try core.setRoute(Trace.route(Self.dividedRoad))
      try core.updateLocation(Trace.sample(x: 0, y: 0, speed: 0, time: 0))
      try core.updateLocation(Trace.sample(x: 200, y: 460, speed: 0, time: 1))
      let later = try core.updateLocation(Trace.sample(x: 200, y: y, speed: 0, time: 1_201))
      XCTAssertEqual(later.routeProgress, 0, "y \(y)")
      XCTAssertEqual(later.phase, .tracking)
    }
  }

  // MARK: Dead reckoning

  /// A held fix supplies neither the time nor the speed dead reckoning extrapolates from, even
  /// when it carries the same timestamp as the accepted fix before it.
  func testDeadReckoningExtrapolatesOnlyFromTheAcceptedFix() throws {
    let stopped = NavigationCore()
    try stopped.setRoute(Trace.route([(0, 0), (0, 5_000)]))
    try stopped.updateLocation(Trace.sample(x: 0, y: 0, speed: 0, time: 0))
    let held = try stopped.updateLocation(
      Trace.sample(x: 0, y: 1_000, courseDegrees: 0, speed: 10, time: 0)
    )
    XCTAssertEqual(held.routeProgress, 0)
    XCTAssertNil(stopped.deadReckon(at: Trace.time(3)))

    let moving = NavigationCore()
    try moving.setRoute(Trace.route([(0, 0), (0, 5_000)]))
    try moving.updateLocation(Trace.sample(x: 0, y: 0, courseDegrees: 0, speed: 10, time: 0))
    try moving.updateLocation(Trace.sample(x: 0, y: 10, courseDegrees: 0, speed: 10, time: 1))
    XCTAssertEqual(
      try XCTUnwrap(moving.deadReckon(at: Trace.time(4))).routeProgress * 5_000, 40, accuracy: 1
    )
    // An outlier reporting 30 m/s is held: nothing is extrapolated from it or past it.
    try moving.updateLocation(Trace.sample(x: 0, y: 2_000, courseDegrees: 0, speed: 30, time: 2))
    XCTAssertNil(moving.deadReckon(at: Trace.time(5)))
    // The next accepted fix is the anchor again, with its own speed.
    try moving.updateLocation(Trace.sample(x: 0, y: 30, courseDegrees: 0, speed: 10, time: 3))
    XCTAssertEqual(
      try XCTUnwrap(moving.deadReckon(at: Trace.time(6))).routeProgress * 5_000, 60, accuracy: 1
    )
  }

  // MARK: Possible travel is not travel

  private static let loopPastItsOwnStart: [(Double, Double)] = [
    (0, 0), (0, 1_000), (1_000, 1_000), (1_000, 300), (20, 300),
  ]

  /// Last seen moving at 200 m; five minutes later, stopped in a queue at 300 m, where the
  /// route's last leg ends 20 m away. Speed times time covers the loop; nothing shows it was
  /// driven. The earlier leg is kept, however long the vehicle stands there.
  func testAGapThatCouldHaveCoveredTheLoopDoesNotFinishIt() throws {
    let session = NavigationSession()
    try session.start(Self.trip(Self.loopPastItsOwnStart))
    _ = try session.updateLocation(
      Trace.sample(x: 0, y: 200, courseDegrees: 0, speed: 20, time: 0)
    )
    for second in 300...306 {
      let stopped = try session.updateLocation(
        Trace.sample(x: 0, y: 300, speed: 0, time: Double(second))
      )
      XCTAssertEqual(stopped.snapshot.phase, .tracking)
      XCTAssertEqual(stopped.guidance?.stepIndex, 0)
      // 100 m on from a standstill reading is held for one fix, then followed.
      XCTAssertEqual(
        stopped.snapshot.routeProgress * 3_680, second == 300 ? 200 : 300, accuracy: 5
      )
    }
  }

  /// The same queue with the fix biased onto the last leg, where the first leg no longer fits.
  func testABiasedFixAfterAGapDoesNotFinishTheLoopEither() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route(Self.loopPastItsOwnStart))
    try core.updateLocation(Trace.sample(x: 0, y: 200, courseDegrees: 0, speed: 20, time: 0))
    for (index, x) in [44.0, 44, 0, 0, 44, 0].enumerated() {
      let snapshot = try core.updateLocation(
        Trace.sample(x: x, y: 300, speed: 0, time: 300 + Double(index))
      )
      XCTAssertEqual(snapshot.phase, .tracking)
      XCTAssertLessThan(along(snapshot, core), 400)
    }
  }

  /// And crawling in that queue, still heading up the first leg, with speeds reported on both
  /// sides of the gap that would cover the loop: a fix 44 m to the side is not the last leg.
  func testReportedMotionDoesNotMoveAVehicleOntoAPassBesideIt() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route(Self.loopPastItsOwnStart))
    try core.updateLocation(Trace.sample(x: 0, y: 200, courseDegrees: 0, speed: 20, time: 0))
    for (index, x) in [44.0, 44, 44].enumerated() {
      let snapshot = try core.updateLocation(
        Trace.sample(
          x: x, y: 300 + Double(index) * 20, courseDegrees: 0, speed: 20,
          time: 300 + Double(index))
      )
      XCTAssertEqual(snapshot.phase, .tracking)
      XCTAssertLessThan(along(snapshot, core), 400)
    }
  }

  /// Driving on from the queue is followed: the loop is finished by being driven.
  func testTheLoopIsFinishedByDrivingItAfterTheGap() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route(Self.loopPastItsOwnStart))
    try core.updateLocation(Trace.sample(x: 0, y: 200, courseDegrees: 0, speed: 20, time: 0))
    try core.updateLocation(Trace.sample(x: 0, y: 300, speed: 0, time: 300))
    var time = 301.0
    var snapshot = core.currentSnapshot()
    let positions = Trace.positions(along: Self.loopPastItsOwnStart, every: 20)
      .filter { $0.alongMeters > 300 }
    for position in positions + [positions[positions.count - 1], positions[positions.count - 1]] {
      snapshot = try core.updateLocation(
        Trace.sample(
          x: position.x, y: position.y, courseDegrees: position.courseDegrees, speed: 20,
          time: time)
      )
      time += 1
      XCTAssertFalse(snapshot.isOffRoute)
    }
    XCTAssertEqual(snapshot.phase, .arrived)
  }

  // MARK: A position one block away

  /// Parked at the start; three fresh, identical fixes 200 m away, on the end of the route.
  /// 200 m is within what GPS gets wrong in a street canyon, so they are not another place.
  func testFixesOneBlockAwayDoNotMoveProgressToTheEndOfTheRoute() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route(Self.dividedRoad))
    try core.updateLocation(Trace.sample(x: 0, y: 0, speed: 0, time: 0))
    for second in 1...8 {
      let snapshot = try core.updateLocation(
        Trace.sample(x: 200, y: 0, speed: 0, time: Double(second))
      )
      XCTAssertEqual(snapshot.phase, .tracking)
      XCTAssertEqual(snapshot.routeProgress, 0)
    }
  }

  /// Further away than GPS gets wrong, two fresh fixes are believed, but standing there is not
  /// arriving: that needs the vehicle to be seen moving along the route.
  func testAJumpOntoTheDestinationDoesNotArriveUntilTheVehicleMoves() throws {
    let corners: [(Double, Double)] = [(0, 0), (0, 3_000), (400, 3_000), (400, 0)]
    let core = NavigationCore()
    try core.setRoute(Trace.route(corners))
    try core.updateLocation(Trace.sample(x: 0, y: 0, speed: 0, time: 0))
    var snapshot = core.currentSnapshot()
    for second in 1...10 {
      snapshot = try core.updateLocation(
        Trace.sample(x: 400, y: 0, speed: 0, time: Double(second))
      )
      XCTAssertEqual(snapshot.phase, .tracking, "fix \(second)")
    }
    XCTAssertEqual(along(snapshot, core), 6_400, accuracy: 5)

    // 28 m short of the destination, then fixes on it: further along, but not far enough on
    // the ground to be a vehicle that moved rather than a fix that wandered.
    let wandering = NavigationCore()
    try wandering.setRoute(Trace.route(corners))
    try wandering.updateLocation(Trace.sample(x: 0, y: 0, speed: 0, time: 0))
    for (second, y) in [(1.0, 28.0), (2, 28), (3, 2), (4, 2), (5, 2), (6, 2)] {
      snapshot = try wandering.updateLocation(
        Trace.sample(x: 400, y: y, speed: 0, time: second)
      )
      XCTAssertEqual(snapshot.phase, .tracking, "fix \(second)")
    }

    // The same jump 100 m short of the destination, then driven in.
    let driven = NavigationCore()
    try driven.setRoute(Trace.route(corners))
    try driven.updateLocation(Trace.sample(x: 0, y: 0, speed: 0, time: 0))
    var time = 1.0
    for y in stride(from: 100.0, through: 0, by: -10) + [0, 0] {
      snapshot = try driven.updateLocation(
        Trace.sample(x: 400, y: y, courseDegrees: 180, speed: y > 0 ? 10 : 0, time: time)
      )
      time += 1
    }
    XCTAssertEqual(snapshot.phase, .arrived)
  }

  // MARK: Heading at speed

  private static let switchback: [(Double, Double)] = [(0, 0), (600, 0), (600, 60), (0, 60)]

  /// Round a switchback through an eight-second gap: 60 m from the road before the bend, moving,
  /// heading the way the road after it runs. One fix.
  func testAMovingVehicleIsFollowedRoundASwitchbackThroughAShortGap() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route(Self.switchback))
    for second in 0...5 {
      try core.updateLocation(
        Trace.sample(
          x: 400 + Double(second) * 20, y: 0, courseDegrees: 90, speed: 20, time: Double(second))
      )
    }
    let after = try core.updateLocation(
      Trace.sample(x: 480, y: 60, courseDegrees: 270, speed: 20, time: 13)
    )
    XCTAssertFalse(after.isOffRoute)
    XCTAssertEqual(along(after, core), 780, accuracy: 5)
  }

  /// A course that comes with an impossible speed is as bad a reading as the speed.
  func testAHeadingReportedWithAnImpossibleSpeedIsNotFollowed() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route(Self.switchback))
    for second in 0...5 {
      try core.updateLocation(
        Trace.sample(
          x: 400 + Double(second) * 20, y: 0, courseDegrees: 90, speed: 20, time: Double(second))
      )
    }
    let after = try core.updateLocation(
      Trace.sample(x: 480, y: 60, courseDegrees: 270, speed: 100, time: 13)
    )
    XCTAssertEqual(along(after, core), 500, accuracy: 1)
  }

  /// The same position from a vehicle that is not moving says nothing about which road it is
  /// on: it is a fix 60 m off the road the vehicle was on.
  func testAStationaryFixBesideASwitchbackIsNotTheRoadAfterIt() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route(Self.switchback))
    try core.updateLocation(Trace.sample(x: 500, y: 0, speed: 0, time: 0))
    for second in 1...2 {
      let snapshot = try core.updateLocation(
        Trace.sample(x: 480, y: 60, speed: 0, time: Double(second))
      )
      XCTAssertEqual(along(snapshot, core), 500, accuracy: 1)
      XCTAssertFalse(snapshot.isOffRoute)
    }
    let third = try core.updateLocation(Trace.sample(x: 480, y: 60, speed: 0, time: 3))
    XCTAssertTrue(third.isOffRoute)
    XCTAssertEqual(along(third, core), 500, accuracy: 1)
  }

  // MARK: Reported speed

  /// One reading of 100 m/s is a bad reading, not a fast car.
  func testAnImpossibleReportedSpeedIsNotEvidenceOfTravel() throws {
    let horseshoe: [(Double, Double)] = [(0, 0), (0, 6_000), (2_000, 6_000), (2_000, 0)]
    for speed in [100.0, 46, 44] {
      let core = NavigationCore()
      try core.setRoute(Trace.route(horseshoe))
      try core.updateLocation(Trace.sample(x: 0, y: 0, speed: 0, time: 0))
      let bad = try core.updateLocation(
        Trace.sample(x: 2_000, y: 500, courseDegrees: 180, speed: speed, time: 180)
      )
      XCTAssertEqual(bad.routeProgress, 0, "speed \(speed)")
      XCTAssertFalse(bad.isOffRoute)
      XCTAssertNil(core.deadReckon(at: Trace.time(183)))
    }
  }

  /// Without a reported speed the multipath margin stands in for one, but never for more than
  /// a vehicle can cover in the time: 150 m on in one second is held.
  func testWithoutSpeedAFixBeyondTheSpeedCeilingIsHeld() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route([(0, 0), (0, 5_000)]))
    try core.updateLocation(Trace.sample(x: 0, y: 0, time: 0))
    let near = try core.updateLocation(Trace.sample(x: 0, y: 60, time: 1))
    XCTAssertEqual(along(near, core), 60, accuracy: 1, "60 m in a second is within the ceiling")
    let far = try core.updateLocation(Trace.sample(x: 0, y: 210, time: 2))
    XCTAssertEqual(along(far, core), 60, accuracy: 1)
    let confirmed = try core.updateLocation(Trace.sample(x: 0, y: 215, time: 3))
    XCTAssertEqual(along(confirmed, core), 215, accuracy: 1)
  }

  /// The speed that explains travel is the accepted fix's, not that of a fix that was held.
  func testAHeldFixDoesNotLendItsSpeedToTheNextOne() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route([(0, 0), (0, 5_000)]))
    try core.updateLocation(Trace.sample(x: 0, y: 0, courseDegrees: 0, speed: 10, time: 0))
    try core.updateLocation(Trace.sample(x: 0, y: 10, courseDegrees: 0, speed: 10, time: 1))
    // Held: 2 km on, reporting 40 m/s.
    try core.updateLocation(Trace.sample(x: 0, y: 2_000, courseDegrees: 0, speed: 40, time: 2))
    // 130 m on from the accepted fix, two seconds after it, reporting 40 m/s and no course: the
    // accepted fix was doing 10, which explains 60 m.
    let next = try core.updateLocation(Trace.sample(x: 0, y: 140, speed: 40, time: 3))
    XCTAssertEqual(along(next, core), 10, accuracy: 1)
  }

  /// Speeds reported on both sides of a gap do explain the distance between them.
  func testReportedSpeedOnBothSidesOfAGapExplainsTheDistance() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route([(0, 0), (0, 6_000), (2_000, 6_000), (2_000, 0)]))
    try core.updateLocation(Trace.sample(x: 0, y: 100, courseDegrees: 0, speed: 25, time: 0))
    let after = try core.updateLocation(
      Trace.sample(x: 1_000, y: 6_000, courseDegrees: 90, speed: 25, time: 290)
    )
    XCTAssertFalse(after.isOffRoute)
    XCTAssertEqual(along(after, core), 7_000, accuracy: 5)
  }

  // MARK: The first fix, and resuming a trip

  private static let longLoop: [(Double, Double)] = [
    (0, 0), (0, 3_000), (3_000, 3_000), (3_000, 0), (20, 0),
  ]

  /// The first fix of a route, at the point where the route both starts and ends.
  func testTheFirstFixTakesTheEarliestPassThatFits() throws {
    for x in [0.0, 10, 20, 30] {
      let core = NavigationCore()
      try core.setRoute(Trace.route(Self.longLoop))
      var snapshot = try core.updateLocation(Trace.sample(x: x, y: 0, speed: 0, time: 0))
      XCTAssertLessThan(along(snapshot, core), 40, "x \(x)")
      for second in 1...3 {
        snapshot = try core.updateLocation(
          Trace.sample(x: x, y: 0, speed: 0, time: Double(second))
        )
      }
      XCTAssertEqual(snapshot.phase, .tracking, "x \(x)")
    }
  }

  /// A first fix from a vehicle already moving along the last leg is placed on the last leg,
  /// as heading always chose between two carriageways. It does not end the trip: stopping
  /// there is not arriving, driving on in is.
  func testTheFirstFixFollowsTheHeadingOfAMovingVehicleButDoesNotArrive() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route(Self.longLoop))
    var snapshot = try core.updateLocation(
      Trace.sample(x: 25, y: 0, courseDegrees: 270, speed: 10, time: 0)
    )
    XCTAssertEqual(along(snapshot, core), 11_975, accuracy: 5)
    for second in 1...5 {
      snapshot = try core.updateLocation(
        Trace.sample(x: 20, y: 0, speed: 0, time: Double(second))
      )
      XCTAssertEqual(snapshot.phase, .tracking)
    }

    let driven = NavigationCore()
    try driven.setRoute(Trace.route(Self.longLoop))
    var time = 0.0
    for x in stride(from: 120.0, through: 20, by: -10) + [20, 20] {
      snapshot = try driven.updateLocation(
        Trace.sample(x: x, y: 0, courseDegrees: 270, speed: x > 20 ? 10 : 0, time: time)
      )
      time += 1
    }
    XCTAssertEqual(snapshot.phase, .arrived)
  }

  /// A trip saved at its start and restored through the real store: a fix on the loop's end
  /// point is a fix 20 m from where the trip was, not the end of the trip.
  func testARestoredTripResumesFromItsSavedProgress() throws {
    let suite = "NavOSSMatcherEvidence.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let store = NavOSSActiveTripStore(defaults: defaults)
    let original = Self.trip(Self.longLoop)
    store.save(original)
    XCTAssertNil(store.loadProgress(for: original), "nothing saved yet, as from an older build")

    // Without saved progress the first fix is placed on the earliest pass.
    let unsaved = NavigationSession()
    try unsaved.start(try XCTUnwrap(store.load()), resume: store.loadProgress(for: original))
    for second in 1...3 {
      let update = try unsaved.updateLocation(
        Trace.sample(x: 20, y: 0, speed: 0, time: Double(second))
      )
      XCTAssertEqual(update.snapshot.phase, .tracking)
      XCTAssertLessThan(update.snapshot.routeProgress, 0.01)
    }

    // Saved half way round, on the far side: the restored trip is there, not at the start.
    store.saveProgress(alongMeters: 7_500, for: original)
    let restoredTrip = try XCTUnwrap(store.load())
    let resume = try XCTUnwrap(store.loadProgress(for: restoredTrip))
    XCTAssertEqual(resume.alongMeters, 7_500)
    let restored = NavigationSession()
    let started = try restored.start(restoredTrip, resume: resume)
    XCTAssertEqual(started.snapshot.routeProgress * 11_980, 7_500, accuracy: 5)
    XCTAssertEqual(started.guidance?.stepIndex, 2)
    let first = try restored.updateLocation(
      Trace.sample(x: 3_000, y: 1_480, courseDegrees: 180, speed: 10, time: 5)
    )
    XCTAssertFalse(first.snapshot.isOffRoute)
    XCTAssertEqual(first.snapshot.routeProgress * 11_980, 7_520, accuracy: 5)

    // A first fix off the route on a resumed trip is a departure with no matched position: the
    // rejected projection is published only as the very first placement of a fresh route.
    let astray = NavigationSession()
    try astray.start(restoredTrip, resume: resume)
    let off = try astray.updateLocation(Trace.sample(x: 2_800, y: 1_500, speed: 0, time: 5))
    XCTAssertFalse(off.snapshot.isOffRoute)
    XCTAssertNil(off.snapshot.matchedCoordinate)
    XCTAssertEqual(off.snapshot.routeProgress * 11_980, 7_500, accuracy: 5)

    // Saved near the end, restored at the start/end point: still not an arrival from a fix
    // that also fits the start, and not a return to the start either.
    store.saveProgress(alongMeters: 11_900, for: original)
    let nearEnd = NavigationSession()
    try nearEnd.start(restoredTrip, resume: store.loadProgress(for: restoredTrip))
    var update = nearEnd.currentUpdate()
    for (second, x) in [(1.0, 80.0), (2, 60), (3, 40), (4, 20), (5, 20), (6, 20)] {
      update = try nearEnd.updateLocation(
        Trace.sample(x: x, y: 0, courseDegrees: x > 20 ? 270 : nil, speed: x > 20 ? 20 : 0,
          time: second)
      )
    }
    XCTAssertEqual(update.snapshot.phase, .arrived)

    // Another trip's progress, and a replaced route, do not carry over.
    XCTAssertNil(store.loadProgress(for: Self.trip(Self.longLoop, id: "other")))
    store.save(original)
    XCTAssertNil(store.loadProgress(for: original))
    store.saveProgress(alongMeters: 100, for: original)
    store.clear()
    XCTAssertNil(store.loadProgress(for: original))
  }

  // MARK: Untimed input is for replays

  func testLiveIngestionRefusesAFixWithoutACaptureTime() throws {
    XCTAssertThrowsError(try navOSSLiveNavigationFix(Trace.sample(x: 0, y: 0))) { error in
      XCTAssertEqual(error as? NavigationCoreError, .untimedLiveFix)
    }
    let timed = Trace.sample(x: 0, y: 0, time: 0)
    XCTAssertEqual(try navOSSLiveNavigationFix(timed), timed)
  }
}
