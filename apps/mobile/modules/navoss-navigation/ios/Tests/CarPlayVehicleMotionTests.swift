import Foundation
import XCTest

@testable import NavOSSNavigationCore

final class CarPlayVehicleMotionTests: XCTestCase {
  /// Replays every scenario in every mode and, when `NAVOSS_MOTION_REPORT` names a file, writes the
  /// numbers there as JSON. This measures; the behaviour is pinned by the tests below.
  func testMotionReplayReport() throws {
    var report: [String: [String: Double]] = [:]
    for scenario in ReplayScenarios.all {
      for mode in [ReplayMode.guidance, .guidanceWithCompass, .guidanceWithHeldAndClock, .freeDrive] {
        let frames = MotionReplay.run(scenario, mode: mode)
        XCTAssertFalse(frames.isEmpty, "\(scenario.name) \(mode.rawValue)")
        report["\(scenario.name) \(mode.rawValue)"] = ReplayMetrics(frames, road: scenario.road).json
      }
    }
    guard let path = ProcessInfo.processInfo.environment["NAVOSS_MOTION_REPORT"] else { return }
    let data = try JSONSerialization.data(
      withJSONObject: report, options: [.sortedKeys, .prettyPrinted])
    try data.write(to: URL(fileURLWithPath: path))
  }
}

// MARK: - Behaviour

extension CarPlayVehicleMotionTests {
  /// A publication at `time` of a fix `distance` along `road`. By default it is an accepted real
  /// fix taken at `time` (`runOn`); `accepted: false` is a held, rejected or dead-reckoned one.
  private func fix(
    _ road: ReplayRoad, at distance: Double, speed: Double?, time: Double,
    accepted: Bool = true, takenAt: Double? = nil, limitProgress: Double? = nil
  ) -> ReplayFix {
    let point = road.point(at: distance)
    let runOn =
      accepted
      ? speed.map {
        NavOSSCarPlayRunOn(
          fixTimestamp: takenAt ?? time, speedMetersPerSecond: $0, limitProgress: limitProgress)
      } : nil
    return ReplayFix(
      time: time,
      position: NavOSSCarPlayPosition(
        coordinate: ReplayPlane.coordinate(point.x, point.y), courseDegrees: point.bearing,
        speedMetersPerSecond: speed, runOn: runOn, isHeld: !accepted),
      isRepublish: !accepted)
  }

  /// Drives `fixes` through the motion at 60 fps and returns, per frame, the time, the drawn
  /// point's distance along `road`, its offset from the road, and its drawn course.
  private func drive(
    _ fixes: [ReplayFix], road: ReplayRoad, followsRoad: Bool = true, until end: Double
  ) -> [(time: Double, along: Double, offset: Double, course: Double?, moving: Bool)] {
    var motion = NavOSSCarPlayVehicleMotion()
    motion.followsRoad = followsRoad
    motion.routePath = NavOSSCarPlayRoutePath(followsRoad ? road.geometry : [])
    var next = 0
    var frames: [(Double, Double, Double, Double?, Bool)] = []
    for index in 0...Int(end * 60) {
      let time = Double(index) / 60
      while next < fixes.count, fixes[next].time <= time {
        motion.receive(fixes[next].position, at: fixes[next].time, wallClock: fixes[next].time)
        next += 1
      }
      guard motion.target != nil else { continue }
      let moving = motion.advance(to: time)
      guard let drawn = motion.drawn else { continue }
      let point = ReplayPlane.point(drawn.coordinate)
      let nearest = road.nearest(point.x, point.y)
      frames.append((time, nearest.along, nearest.offset, drawn.courseDegrees, moving))
    }
    return frames
  }

  /// Build 85 drew the vehicle from one fix to the next over the previous fix interval, so a fix
  /// arriving a little later than the last one left the car standing on the map until it came,
  /// and a compass turn (which republishes the same fix) restarted that animation and stood it
  /// still for most of every second. A moving car must be drawn moving.
  func testMovingVehicleIsNeverDrawnStandingBetweenFixes() {
    let scenario = ReplayScenarios.straight("city", speed: 14, seed: 5)
    for mode in [ReplayMode.guidance, .guidanceWithCompass, .freeDrive] {
      let fixes = MotionReplay.fixes(for: scenario, mode: mode, gaps: false)
      let metrics = ReplayMetrics(
        MotionReplay.run(scenario, mode: mode, fixes: fixes), road: scenario.road)
      XCTAssertEqual(metrics.standingWhileMovingShare, 0, "\(mode.rawValue)")
    }
  }

  /// Each fix restarted the animation at a new speed (distance over the last interval), so the
  /// drawn speed jumped at every fix: up to 24 m/s from one frame to the next at 50 km/h.
  func testDrawnSpeedDoesNotStepWhenAFixArrives() {
    let scenario = ReplayScenarios.straight("city", speed: 14, seed: 5)
    for mode in [ReplayMode.guidance, .guidanceWithCompass, .freeDrive] {
      let fixes = MotionReplay.fixes(for: scenario, mode: mode, gaps: false)
      let metrics = ReplayMetrics(
        MotionReplay.run(scenario, mode: mode, fixes: fixes), road: scenario.road)
      // 0.5 m/s per frame is 30 m/s², about three times the hardest braking a car can do.
      XCTAssertLessThan(metrics.speedStepMax, 0.5, "\(mode.rawValue)")
    }
  }

  /// A fix that says the car stopped stops the drawn vehicle at once, and stopped fixes wandering
  /// within GPS noise do not creep it along. Build 85 kept gliding toward the stop for a whole
  /// fix interval and then slid about with each stopped fix.
  func testStoppedFixStopsTheVehicleAtOnceAndHoldsIt() {
    let road = ReplayRoad([(0, 0), (0, 500)])
    var fixes = (0...5).map { fix(road, at: 14 * Double($0), speed: 14, time: Double($0)) }
    // Braked hard: stopped 74 m in, reported at 6 s, then 3 m of GPS wander either way.
    fixes.append(fix(road, at: 74, speed: 0, time: 6))
    for (index, wander) in [2.5, -2.0, 3.0, -1.5].enumerated() {
      fixes.append(fix(road, at: 74 + wander, speed: 0, time: 7 + Double(index)))
    }
    let frames = drive(fixes, road: road, until: 11)
    let stopped = frames.filter { $0.time > 6 + 1.0 / 60 }
    for (previous, frame) in zip(stopped, stopped.dropFirst()) {
      XCTAssertLessThan(
        abs(frame.along - previous.along) * 60, 0.3, "drawn moving at \(frame.time) s after the stop")
    }
  }

  /// When fixes stop (a tunnel, lost GPS), the vehicle carries on at its speed only briefly,
  /// eases to a stop and waits, and never past the end of the route. Build 85 stopped dead at
  /// the last fix, so a fix 200 ms late already froze the car.
  func testExtrapolationKeepsMovingBrieflyThenStopsAndNeverPassesTheRouteEnd() {
    let road = ReplayRoad([(0, 0), (0, 2_000)])
    let fixes = (0...5).map { fix(road, at: 20 * Double($0), speed: 20, time: Double($0)) }
    let frames = drive(fixes, road: road, until: 12)
    func along(at time: Double) -> Double {
      frames.min { abs($0.time - time) < abs($1.time - time) }!.along
    }
    // Still going at speed 1.2 s after the last fix: a fix that is merely late.
    XCTAssertGreaterThan((along(at: 6.2) - along(at: 6.1)) * 10, 15)
    // Bounded: no further than 1.65 s of travel past the last fix, and standing by 3 s.
    XCTAssertLessThan(along(at: 12), 100 + 20 * 1.65 + 1)
    XCTAssertEqual(along(at: 12), along(at: 8), accuracy: 0.01)

    // A route ending 10 m past the last fix: the vehicle stops at its end, never beyond.
    let short = ReplayRoad([(0, 0), (0, 110)])
    let shortFixes = (0...5).map { fix(short, at: 20 * Double($0), speed: 20, time: Double($0)) }
    let shortFrames = drive(shortFixes, road: short, until: 9)
    XCTAssertLessThanOrEqual(shortFrames.map(\.along).max() ?? .infinity, 110 + 1e-6)
    XCTAssertGreaterThan(shortFrames.last?.along ?? 0, 109)
  }

  /// Approaching a right-angle turn with fixes arriving late, the vehicle keeps moving along the
  /// road, never turns the corner before a fix shows the car has, stays on the carriageway, and
  /// the arrow turns gradually with the road.
  func testCornerFollowsTheRoadAndWaitsForAFixBeyondTheTurn() {
    let road = ReplayRoad([(0, 0), (0, 100), (200, 100)])
    // 8 m/s, a fix every 1.2 s; the fix at 12 s is the first past the corner.
    let fixes = (0...14).map { index in
      fix(road, at: 8 * 1.2 * Double(index), speed: 8, time: 1.2 * Double(index))
    }
    let frames = drive(fixes, road: road, until: 18)
    let cornerFixTime = fixes.first { $0.time > 0 && 8 * $0.time > 100 }!.time
    for frame in frames where frame.time > 1 {
      XCTAssertLessThan(frame.offset, 0.5, "off the road at \(frame.time) s")
      if frame.time < cornerFixTime {
        XCTAssertLessThanOrEqual(frame.along, 100 + 1e-6, "round the corner before a fix at \(frame.time) s")
      }
    }
    // Moving at every frame of the approach until it reaches the corner to wait for that fix.
    let approach = frames.filter { $0.time > 1 && $0.along < 99 }
    for (previous, frame) in zip(approach, approach.dropFirst()) {
      XCTAssertGreaterThan((frame.along - previous.along) * 60, 3, "standing at \(frame.time) s")
    }
    for (previous, frame) in zip(frames, frames.dropFirst()) {
      guard let from = previous.course, let to = frame.course else { continue }
      let turn = abs((to - from + 540).truncatingRemainder(dividingBy: 360) - 180)
      XCTAssertLessThan(turn, 6, "arrow snapped at \(frame.time) s")
    }
    XCTAssertGreaterThan(frames.last?.along ?? 0, 134)
  }

  // MARK: When the vehicle may run on

  /// Losing GPS before a shallow fork (no vertex steep enough to count as a turn): the navigation
  /// core stops its own prediction 15 m before the maneuver it has not seen taken, so the map must
  /// stop there too rather than draw the car down a ramp the driver may not have taken.
  func testRunOnStopsWhereTheCoreStopsBeforeAnUnconfirmedManeuver() {
    let road = ReplayRoad([(0, 0), (0, 2_000)])
    let limit = 84.0 + 5
    let fixes = (0...3).map {
      fix(road, at: 28 * Double($0), speed: 28, time: Double($0), limitProgress: limit / 2_000)
    }
    let frames = drive(fixes, road: road, until: 8)
    XCTAssertLessThanOrEqual(frames.map(\.along).max() ?? .infinity, limit + 0.05)
    XCTAssertGreaterThan(frames.last?.along ?? 0, limit - 0.5)
  }

  /// At a red light a fix rejected by the matcher (multipath) is published as the held matched
  /// position with the new raw speed. That is not a car moving: the stopped car stays put.
  func testHeldFixNeverStartsAStoppedCar() {
    let road = ReplayRoad([(0, 0), (0, 500)])
    var fixes = (0...3).map { fix(road, at: 74, speed: 0, time: Double($0)) }
    fixes.append(fix(road, at: 74, speed: 5, time: 4, accepted: false))
    let frames = drive(fixes, road: road, until: 8).filter { $0.time > 1 }
    for frame in frames {
      XCTAssertEqual(frame.along, 74, accuracy: 0.05, "the held car moved at \(frame.time) s")
    }
  }

  /// A fix projected exactly onto a right-angle corner has not shown which way the car left it:
  /// the vehicle waits at the corner until a fix beyond it.
  func testFixOnATurnVertexHoldsTheVehicleAtTheTurn() {
    let road = ReplayRoad([(0, 0), (0, 100), (100, 100)])
    let fixes = (0...3).map { fix(road, at: 76 + 8 * Double($0), speed: 8, time: Double($0)) }
    let frames = drive(fixes, road: road, until: 6)
    XCTAssertLessThanOrEqual(frames.map(\.along).max() ?? .infinity, 100 + 0.05)
  }

  /// The run-on time counts from when the fix was taken: a cached fix published 8 s late, and the
  /// clock's dead-reckoned positions in a gap, give the car no fresh run-on; a compass republish of
  /// the last fix does not renew it either.
  func testRunOnTimeCountsFromTheFixNotFromItsPublication() {
    let road = ReplayRoad([(0, 0), (0, 2_000)])
    // A fix taken at 2 s, published (a scene connecting, a cached location) at 10 s.
    let cached = drive([fix(road, at: 100, speed: 20, time: 10, takenAt: 2)], road: road, until: 14)
    XCTAssertLessThanOrEqual(cached.map(\.along).max() ?? .infinity, 100 + 0.05)

    // Accepted fixes to 3 s, then the clock's dead reckoning at 5.5 s and 6.5 s.
    var gap = (0...3).map { fix(road, at: 20 * Double($0), speed: 20, time: Double($0)) }
    gap.append(fix(road, at: 60 + 20 * 2.5, speed: 20, time: 5.5, accepted: false))
    gap.append(fix(road, at: 60 + 20 * 3.5, speed: 20, time: 6.5, accepted: false))
    let reckoned = drive(gap, road: road, until: 11)
    XCTAssertLessThanOrEqual(reckoned.map(\.along).max() ?? .infinity, 130 + 0.05)

    // The last fix at 2 s, then the compass republishes it until 5 s.
    var compass = (0...2).map { fix(road, at: 20 * Double($0), speed: 20, time: Double($0)) }
    let last = compass[2].position
    for (index, time) in stride(from: 2.3, through: 5, by: 0.3).enumerated() {
      compass.append(
        ReplayFix(
          time: time,
          position: NavOSSCarPlayPosition(
            coordinate: last.coordinate, courseDegrees: last.courseDegrees,
            compassHeadingDegrees: Double(index * 7 % 360),
            speedMetersPerSecond: last.speedMetersPerSecond, runOn: last.runOn),
          isRepublish: true))
    }
    let republished = drive(compass, road: road, until: 8)
    XCTAssertLessThanOrEqual(
      republished.map(\.along).max() ?? .infinity,
      40 + 20 * navOSSCarPlayExtrapolationReachSeconds + 1)
  }

  /// A moving car told it stopped further away than GPS noise is put there at once (never driven
  /// there, never left short because it cannot reverse), and the render loop then stops.
  func testStoppedFixAwayFromTheDrawnCarPlacesItThereAndSettles() {
    let road = ReplayRoad([(0, 0), (0, 500)])
    var fixes = (0...3).map { fix(road, at: 10 * Double($0), speed: 10, time: Double($0)) }
    fixes.append(fix(road, at: 25, speed: 0, time: 3.4))  // behind the drawn car
    let frames = drive(fixes, road: road, until: 6)
    for frame in frames where frame.time >= 3.4 {
      XCTAssertEqual(frame.along, 25, accuracy: 0.05, "not placed at the stop at \(frame.time) s")
    }
    for frame in frames where frame.time > 3.9 {
      XCTAssertFalse(frame.moving, "render loop still running at \(frame.time) s")
    }
  }

  /// Queue creep: standing at a light, the car rolls 12 m forward and stops. At 851ae38 a standing
  /// car ignored every stopped fix within 15 m, so it stayed 12 m behind for good. The hold resists
  /// one wandering fix, not two that agree: the car then glides (never hops) to them. One lone
  /// fix far off does not move it.
  func testStandingCarFollowsAgreeingStoppedFixesByGliding() {
    let road = ReplayRoad([(0, 0), (0, 500)])
    let fixes = [
      fix(road, at: 100, speed: 0, time: 0), fix(road, at: 100, speed: 0, time: 1),
      fix(road, at: 125, speed: 0, time: 2),  // one wandering fix
      fix(road, at: 101, speed: 0, time: 3),
      fix(road, at: 112, speed: 0, time: 4), fix(road, at: 112.5, speed: 0, time: 5),
    ]
    let frames = drive(fixes, road: road, until: 12)
    for frame in frames where frame.time < 5 {
      XCTAssertEqual(frame.along, 100, accuracy: 0.05, "moved for one fix at \(frame.time) s")
    }
    XCTAssertEqual(frames.last?.along ?? 0, 112.5, accuracy: 0.1, "left behind the queue")
    XCTAssertFalse(frames.last?.moving ?? true)
    for (previous, frame) in zip(frames, frames.dropFirst()) {
      XCTAssertLessThan(frame.along - previous.along, 0.1, "hopped at \(frame.time) s")
    }
  }

  /// After a missed turn the driver stops 50 m off the route. The off-route position is a fresh
  /// raw fix without a run-on; at 851ae38 a stopped publication without a run-on froze the car on
  /// the old road for good. A fresh stopped fix places it.
  func testFreshStoppedFixOffTheRoutePlacesTheCar() {
    let road = ReplayRoad([(0, 0), (0, 500)])
    var fixes = (0...3).map { fix(road, at: 10 * Double($0), speed: 10, time: Double($0)) }
    let parked = ReplayPlane.coordinate(50, 35)
    fixes.append(
      ReplayFix(
        time: 4,
        position: NavOSSCarPlayPosition(
          coordinate: parked, courseDegrees: 90, speedMetersPerSecond: 0),
        isRepublish: false))
    var motion = NavOSSCarPlayVehicleMotion()
    motion.followsRoad = true
    motion.routePath = NavOSSCarPlayRoutePath(road.geometry)
    for index in 0...(8 * 60) {
      let time = Double(index) / 60
      for fix in fixes where fix.time > time - 1.0 / 60 && fix.time <= time {
        motion.receive(fix.position, at: fix.time, wallClock: fix.time)
      }
      motion.advance(to: time)
    }
    let drawn = ReplayPlane.point(try! XCTUnwrap(motion.drawn).coordinate)
    XCTAssertEqual(drawn.x, 50, accuracy: 0.5, "left on the old road")
    XCTAssertEqual(drawn.y, 35, accuracy: 0.5, "left on the old road")
  }

  /// A held stop only freezes the car. At 851ae38 it counted as a confirmed stop, so the accepted
  /// fix that followed, 13 m back, was ignored and the car stayed ahead of where it was.
  func testHeldStopIsCorrectedByTheNextAcceptedStop() {
    let road = ReplayRoad([(0, 0), (0, 500)])
    var fixes = (0...3).map { fix(road, at: 10 * Double($0), speed: 10, time: Double($0)) }
    fixes.append(fix(road, at: 20, speed: 0, time: 3.5, accepted: false))
    fixes.append(fix(road, at: 30, speed: 0, time: 4.5))
    let frames = drive(fixes, road: road, until: 7)
    let frozen = frames.first { $0.time >= 3.5 }?.along ?? 0
    XCTAssertGreaterThan(frozen, 34)
    XCTAssertEqual(frames.last?.along ?? 0, 30, accuracy: 0.05, "the accepted stop was ignored")
  }

  /// The phone's clock was set back (or a cached fix comes from a clock running ahead): a fix
  /// stamped in the future has no trustworthy age. At 851ae38 its age was taken as zero and it got
  /// a full fresh run-on; it must only be placed.
  func testFixFromTheFutureIsNotCarriedOn() {
    let road = ReplayRoad([(0, 0), (0, 1_000)])
    let future = fix(road, at: 100, speed: 20, time: 1, takenAt: 3_601)
    let frames = drive([future], road: road, until: 4)
    XCTAssertLessThanOrEqual(frames.map(\.along).max() ?? .infinity, 100 + 0.05)
  }

  /// Waiting at a light, the stopped fixes wander by GPS noise. 1661d58 put the vehicle at each one
  /// more than 4 m away: the parked car hopped 5-6 m now and then (replay, stop-and-go). Once
  /// standing, it stays within the parked wander; a stopped publication that is only the matcher
  /// holding an old position (no fix of its own) stops the car where it is drawn, rather than
  /// throwing it back to where it was seconds ago (13 m in the replay).
  func testStandingCarIgnoresStoppedFixWanderAndHeldPositions() {
    let road = ReplayRoad([(0, 0), (0, 500)])
    let waiting = [
      fix(road, at: 100, speed: 0, time: 0), fix(road, at: 106, speed: 0, time: 1),
      fix(road, at: 93, speed: 0, time: 2), fix(road, at: 108, speed: 0, time: 3),
    ]
    for frame in drive(waiting, road: road, until: 5) {
      XCTAssertEqual(frame.along, 100, accuracy: 0.05, "the waiting car hopped at \(frame.time) s")
    }

    var braking = (0...3).map { fix(road, at: 10 * Double($0), speed: 10, time: Double($0)) }
    // The car stops; the matcher rejects the fix and publishes the position it held at 2 s.
    braking.append(fix(road, at: 20, speed: 0, time: 3.5, accepted: false))
    let frames = drive(braking, road: road, until: 6)
    let stoppedAt = frames.first { $0.time >= 3.5 }?.along ?? 0
    XCTAssertGreaterThan(stoppedAt, 30, "thrown back to the held position")
    for frame in frames where frame.time >= 3.5 {
      XCTAssertEqual(frame.along, stoppedAt, accuracy: 0.05, "moved after stopping at \(frame.time) s")
    }
  }

  /// Parked, with no usable speed in the fixes, GPS wander of a few metres must not become a
  /// moving car, and the render loop settles.
  func testParkedFixesWithoutSpeedDoNotDriveTheCar() {
    let road = ReplayRoad([(0, 0), (0, 500)])
    let fixes = [50.0, 53, 50, 52.5, 50].enumerated().map {
      fix(road, at: $1, speed: nil, time: Double($0))
    }
    let frames = drive(fixes, road: road, until: 7)
    for frame in frames where frame.time > 0.1 {
      XCTAssertEqual(frame.along, 50, accuracy: 0.05, "the parked car moved at \(frame.time) s")
    }
    XCTAssertFalse(frames.last?.moving ?? true)
  }

  /// In every replay the render loop stops while parked at the light and soon after the last
  /// publication, instead of running for ever.
  func testRenderLoopSettlesWhenParkedAndAfterTheLastFix() {
    for scenario in ReplayScenarios.all {
      for mode in [ReplayMode.guidance, .guidanceWithHeldAndClock, .freeDrive] {
        let metrics = ReplayMetrics(MotionReplay.run(scenario, mode: mode), road: scenario.road)
        XCTAssertLessThan(metrics.settleAfterLastFixSeconds, 5, "\(scenario.name) \(mode.rawValue)")
        // Creeping in a queue and stopping off the route, the car legitimately glides to where
        // agreeing stopped fixes put it, so only a plain stop must leave the loop idle.
        if scenario.name != ReplayScenarios.queueCreep.name,
          scenario.name != ReplayScenarios.offRouteStop.name
        {
          XCTAssertLessThan(
            metrics.parkedStillRunningShare, 0.05, "\(scenario.name) \(mode.rawValue)")
        }
      }
    }
  }

  // MARK: What the navigation core lets CarPlay run on from

  private func runOnTrip() -> NavOSSCarPlayTrip {
    func carPlay(_ corners: [(Double, Double)]) -> [NavOSSCarPlayCoordinate] {
      NavigationTrace.route(corners).map {
        NavOSSCarPlayCoordinate(latitude: $0.latitude, longitude: $0.longitude)
      }
    }
    let end = NavigationTrace.coordinate(500, 1_000)
    return NavOSSCarPlayTrip(
      destination: NavOSSCarPlayDestination(
        id: "destination", label: "Destination", latitude: end.latitude,
        longitude: end.longitude, name: "Destination"),
      distanceMeters: 1_500, durationSeconds: 120,
      geometry: carPlay([(0, 0), (500, 0), (500, 1_000)]), id: "trip",
      steps: [
        NavOSSCarPlayRouteStep(
          distanceMeters: 500, durationSeconds: 40, geometry: carPlay([(0, 0), (500, 0)]),
          instruction: "Head east", maneuverType: "depart", roadName: "1 Ave"),
        NavOSSCarPlayRouteStep(
          distanceMeters: 1_000, durationSeconds: 80, geometry: carPlay([(500, 0), (500, 1_000)]),
          instruction: "Turn left", maneuverType: "turn", roadName: "2 St"),
      ])
  }

  /// An accepted fix carries its own time and speed and the core's own limit (15 m before the
  /// next maneuver); a held (rejected) fix, a fix without a speed and a dead-reckoned update carry
  /// nothing, so CarPlay never runs on from them.
  func testOnlyAnAcceptedRealFixWithASpeedLetsCarPlayRunOn() throws {
    let session = NavigationSession()
    try session.start(runOnTrip())
    var accepted: NavigationSessionUpdate?
    for (index, x) in [100.0, 120, 140].enumerated() {
      accepted = try session.updateLocation(
        NavigationTrace.sample(x: x, y: 0, courseDegrees: 90, speed: 20, time: Double(index)))
    }
    let runOn = try XCTUnwrap(accepted?.carPlayRunOn)
    XCTAssertEqual(runOn.fixTimestamp, NavigationTrace.time(2))
    XCTAssertEqual(runOn.speedMetersPerSecond, 20)
    XCTAssertEqual((runOn.limitProgress ?? 0) * 1_500, 485, accuracy: 2)

    // 60 m back along the route: the matcher holds the previous position.
    let held = try session.updateLocation(
      NavigationTrace.sample(x: 80, y: 0, courseDegrees: 90, speed: 20, time: 3))
    XCTAssertFalse(session.acceptedLatestFix)
    XCTAssertNil(held.carPlayRunOn)
    XCTAssertTrue(held.carPlayPositionIsHeld)
    XCTAssertFalse(accepted?.carPlayPositionIsHeld ?? true)

    let noSpeed = NavigationSession()
    try noSpeed.start(runOnTrip())
    var unknown: NavigationSessionUpdate?
    for (index, x) in [100.0, 120, 140].enumerated() {
      unknown = try noSpeed.updateLocation(
        NavigationTrace.sample(x: x, y: 0, courseDegrees: 90, time: Double(index)))
    }
    XCTAssertNil(unknown?.carPlayRunOn)

    let reckoning = NavigationSession()
    try reckoning.start(runOnTrip())
    for (index, x) in [100.0, 120, 140].enumerated() {
      try reckoning.updateLocation(
        NavigationTrace.sample(x: x, y: 0, courseDegrees: 90, speed: 20, time: Double(index)))
    }
    let reckoned = try XCTUnwrap(reckoning.deadReckon(at: NavigationTrace.time(5)))
    XCTAssertTrue(reckoned.snapshot.isDeadReckoning)
    XCTAssertNil(reckoned.carPlayRunOn)
    XCTAssertTrue(reckoned.carPlayPositionIsHeld)
  }

  /// A parked car's on-route fix can be accepted with a bad speed reading. The core ignores
  /// readings above its 45 m/s ceiling; at 851ae38 CarPlay took the 70 m/s at face value and ran
  /// the parked car on 115 m. Run-on uses the speed the core kept, so there is none.
  func testABadSpeedReadingNeverLetsCarPlayRunOn() throws {
    let session = NavigationSession()
    try session.start(runOnTrip())
    for index in 0...2 {
      try session.updateLocation(
        NavigationTrace.sample(x: 100, y: 0, courseDegrees: 90, speed: 0, time: Double(index)))
    }
    let bad = try session.updateLocation(
      NavigationTrace.sample(x: 100.5, y: 0, courseDegrees: 90, speed: 70, time: 3))
    XCTAssertTrue(session.acceptedLatestFix)
    XCTAssertNil(bad.carPlayRunOn)
  }
}
