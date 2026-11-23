import Foundation
import XCTest

@testable import NavOSSNavigationCore

/// The snapshot's `rawCourseDegrees`: the course of the real fix behind it, when that fix proves
/// the direction of travel. Off route the matched course is gone; without this the phone kept
/// the map and the vehicle on the last matched course while the car drove another way.
final class NavigationRawCourseTests: XCTestCase {
  private typealias Trace = NavigationTrace

  /// North along x = 0 for 5 km.
  private func northboundCore() throws -> NavigationCore {
    let core = NavigationCore()
    try core.setRoute(Trace.route([(0, 0), (0, 5_000)]))
    return core
  }

  /// Matched heading north, then 12 m/s west off the route until it is confirmed off route.
  private func driveOffRoute(
    _ core: NavigationCore, courseDegrees: Double?, speed: Double?
  ) throws -> NavigationSnapshot {
    try core.updateLocation(Trace.sample(x: 0, y: 0, courseDegrees: 0, speed: 12, time: 0))
    try core.updateLocation(Trace.sample(x: 0, y: 12, courseDegrees: 0, speed: 12, time: 1))
    var snapshot = core.currentSnapshot()
    for second in 1...8 {
      snapshot = try core.updateLocation(
        Trace.sample(
          x: -12 * Double(second) - 30, y: 12, courseDegrees: courseDegrees, speed: speed,
          time: 1 + Double(second)))
    }
    XCTAssertTrue(snapshot.isOffRoute)
    XCTAssertNil(snapshot.matchedCourseDegrees, "off route there is no matched course")
    return snapshot
  }

  func testTheRuleIsAFiniteBearingAtTheSpeedFloorOrFaster() {
    XCTAssertEqual(navOSSTrustworthyCourseDegrees(0, speedMetersPerSecond: 2), 0)
    XCTAssertEqual(navOSSTrustworthyCourseDegrees(359.9, speedMetersPerSecond: 30), 359.9)
    XCTAssertNil(navOSSTrustworthyCourseDegrees(90, speedMetersPerSecond: 1.99))
    XCTAssertNil(navOSSTrustworthyCourseDegrees(90, speedMetersPerSecond: nil))
    XCTAssertNil(navOSSTrustworthyCourseDegrees(90, speedMetersPerSecond: .nan))
    XCTAssertNil(navOSSTrustworthyCourseDegrees(90, speedMetersPerSecond: .infinity))
    XCTAssertNil(navOSSTrustworthyCourseDegrees(nil, speedMetersPerSecond: 12))
    for invalid: Double in [-1, 360, .nan, .infinity, -.infinity] {
      XCTAssertNil(navOSSTrustworthyCourseDegrees(invalid, speedMetersPerSecond: 12), "\(invalid)")
    }
  }

  /// The defect: last matched course north, the car driving west off route.
  func testOffRouteSnapshotCarriesTheFixCourseWhileMoving() throws {
    let snapshot = try driveOffRoute(try northboundCore(), courseDegrees: 270, speed: 12)
    XCTAssertEqual(snapshot.rawCourseDegrees, 270)
  }

  func testOffRouteSnapshotHasNoRawCourseWithoutOneTheFixProves() throws {
    for (course, speed, label) in [
      (nil, 12, "no course"), (270, nil, "no speed"), (270, 1.9, "below the speed floor"),
      (270, 0, "stopped"),
    ] as [(Double?, Double?, String)] {
      let snapshot = try driveOffRoute(try northboundCore(), courseDegrees: course, speed: speed)
      XCTAssertNil(snapshot.rawCourseDegrees, label)
    }
  }

  /// A matched snapshot keeps the road's course; the fix's own course rides along beside it.
  func testMatchedSnapshotKeepsTheRoadCourse() throws {
    let core = try northboundCore()
    try core.updateLocation(Trace.sample(x: 0, y: 0, courseDegrees: 4, speed: 12, time: 0))
    let matched = try core.updateLocation(
      Trace.sample(x: 0, y: 12, courseDegrees: 4, speed: 12, time: 1))
    XCTAssertFalse(matched.isOffRoute)
    XCTAssertEqual(try XCTUnwrap(matched.matchedCourseDegrees), 0, accuracy: 0.5)
    XCTAssertEqual(matched.rawCourseDegrees, 4)
  }

  func testDeadReckonedSnapshotHasNoRawCourse() throws {
    let core = try northboundCore()
    try core.updateLocation(Trace.sample(x: 0, y: 0, courseDegrees: 0, speed: 10, time: 0))
    let real = try core.updateLocation(
      Trace.sample(x: 0, y: 10, courseDegrees: 0, speed: 10, time: 1))
    XCTAssertEqual(real.rawCourseDegrees, 0)
    let reckoned = try XCTUnwrap(core.deadReckon(at: Trace.time(4)))
    XCTAssertTrue(reckoned.isDeadReckoning)
    XCTAssertNotNil(reckoned.matchedCourseDegrees)
    XCTAssertNil(reckoned.rawCourseDegrees)
  }

  func testArrivedSnapshotHasNoRawCourse() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route([(0, 0), (0, 1_000)]))
    try core.updateLocation(Trace.sample(x: 0, y: 980, courseDegrees: 0, speed: 3, time: 0))
    try core.updateLocation(Trace.sample(x: 0, y: 995, courseDegrees: 0, speed: 3, time: 5))
    var arrived = core.currentSnapshot()
    for second in 6...10 where arrived.phase != .arrived {
      arrived = try core.updateLocation(
        Trace.sample(x: 0, y: 998, courseDegrees: 0, speed: 3, time: Double(second)))
    }
    XCTAssertEqual(arrived.phase, .arrived)
    XCTAssertNil(arrived.rawCourseDegrees)
  }

  func testSnapshotsWithoutAFixHaveNoRawCourse() throws {
    let core = NavigationCore()
    XCTAssertNil(core.currentSnapshot().rawCourseDegrees)
    XCTAssertNil(try core.setRoute(Trace.route([(0, 0), (0, 1_000)])).rawCourseDegrees)
    XCTAssertNil(core.clearRoute().rawCourseDegrees)
  }
}
