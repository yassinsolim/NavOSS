import Foundation
import XCTest

@testable import NavOSSNavigationCore

final class CarPlayVehicleMotionTests: XCTestCase {
  /// Replays every scenario in every mode and, when `NAVOSS_MOTION_REPORT` names a file, writes the
  /// numbers there as JSON. This measures; the behaviour is pinned by the tests below.
  func testMotionReplayReport() throws {
    var report: [String: [String: Double]] = [:]
    for scenario in ReplayScenarios.all {
      for mode in [ReplayMode.guidance, .guidanceWithCompass, .freeDrive] {
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
  private func fix(
    _ road: ReplayRoad, at distance: Double, speed: Double, time: Double
  ) -> ReplayFix {
    let point = road.point(at: distance)
    return ReplayFix(
      time: time,
      position: NavOSSCarPlayPosition(
        coordinate: ReplayPlane.coordinate(point.x, point.y), courseDegrees: point.bearing,
        speedMetersPerSecond: speed),
      isRepublish: false)
  }

  /// Drives `fixes` through the motion at 60 fps and returns, per frame, the time, the drawn
  /// point's distance along `road`, its offset from the road, and its drawn course.
  private func drive(
    _ fixes: [ReplayFix], road: ReplayRoad, followsRoad: Bool = true, until end: Double
  ) -> [(time: Double, along: Double, offset: Double, course: Double?)] {
    var motion = NavOSSCarPlayVehicleMotion()
    motion.followsRoad = followsRoad
    motion.routePath = NavOSSCarPlayRoutePath(followsRoad ? road.geometry : [])
    var next = 0
    var frames: [(Double, Double, Double, Double?)] = []
    for index in 0...Int(end * 60) {
      let time = Double(index) / 60
      while next < fixes.count, fixes[next].time <= time {
        motion.receive(fixes[next].position, at: fixes[next].time)
        next += 1
      }
      guard motion.target != nil else { continue }
      motion.advance(to: time)
      guard let drawn = motion.drawn else { continue }
      let point = ReplayPlane.point(drawn.coordinate)
      let nearest = road.nearest(point.x, point.y)
      frames.append((time, nearest.along, nearest.offset, drawn.courseDegrees))
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
}
