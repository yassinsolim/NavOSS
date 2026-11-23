import Foundation
import XCTest

@testable import NavOSSNavigationCore

final class CarPlayFreeDriveTests: XCTestCase {
  private let here = NavOSSCarPlayCoordinate(latitude: 51.0447, longitude: -114.0719)

  private func fix(
    course: Double = -1,
    courseAccuracy: Double = 5,
    speed: Double = 0,
    accuracy: Double = 8,
    age: TimeInterval = 0.5
  ) -> NavOSSCarPlayFreeDriveFix {
    NavOSSCarPlayFreeDriveFix(
      coordinate: here, courseDegrees: course, courseAccuracyDegrees: courseAccuracy,
      speedMetersPerSecond: speed, horizontalAccuracyMeters: accuracy, ageSeconds: age)
  }

  /// Feeds fixes the way the CarPlay map does: only a trusted course is remembered.
  private func headings(
    for fixes: [NavOSSCarPlayFreeDriveFix],
    compass: Double? = nil
  ) -> [NavOSSCarPlayFreeDriveHeading] {
    var lastCourse: Double?
    return fixes.map { fix in
      if let course = navOSSCarPlayFreeDriveCourseDegrees(fix) { lastCourse = course }
      return navOSSCarPlayFreeDriveHeading(
        fix: fix, lastCourseDegrees: lastCourse, compassHeadingDegrees: compass)
    }
  }

  // MARK: Heading fallback chain

  func testMovingUsesTheFixOwnCourse() {
    let heading = navOSSCarPlayFreeDriveHeading(
      fix: fix(course: 87, speed: 13), lastCourseDegrees: 10, compassHeadingDegrees: 200)
    XCTAssertEqual(heading, NavOSSCarPlayFreeDriveHeading(degrees: 87, source: .course))
  }

  /// A stopped car's GPS course wanders; the arrow must hold the direction it arrived in.
  func testStoppingHoldsTheLastCourseThroughNoisyStoppedCourses() {
    let drive = [
      fix(course: 2, speed: 11), fix(course: 0, speed: 8), fix(course: 359, speed: 4),
      fix(course: 141, speed: 0.4), fix(course: 268, speed: 0.1), fix(course: 33, speed: 0),
      fix(course: -1, speed: -1),
    ]
    let result = headings(for: drive, compass: 120)
    XCTAssertEqual(result.map(\.degrees), [2, 0, 359, 359, 359, 359, 359])
    XCTAssertEqual(
      result.map(\.source),
      [.course, .course, .course, .lastCourse, .lastCourse, .lastCourse, .lastCourse])
  }

  func testCrawlingBelowTheCourseSpeedDoesNotTurnTheArrow() {
    let result = headings(for: [fix(course: 90, speed: 6), fix(course: 170, speed: 2.4)])
    XCTAssertEqual(result.map(\.degrees), [90, 90])
    XCTAssertEqual(result.last?.source, .lastCourse)
  }

  func testACourseRatedPoorByCoreLocationIsNotTrusted() {
    XCTAssertNil(navOSSCarPlayFreeDriveCourseDegrees(fix(course: 45, courseAccuracy: 60, speed: 9)))
    // CoreLocation reports -1 when it has no estimate of course accuracy; speed still gates it.
    XCTAssertEqual(
      navOSSCarPlayFreeDriveCourseDegrees(fix(course: 45, courseAccuracy: -1, speed: 9)), 45)
    XCTAssertNil(navOSSCarPlayFreeDriveCourseDegrees(fix(course: -1, speed: 9)))
    XCTAssertNil(navOSSCarPlayFreeDriveCourseDegrees(fix(course: 360, speed: 9)))
    XCTAssertNil(navOSSCarPlayFreeDriveCourseDegrees(fix(course: .nan, speed: 9)))
  }

  /// First open, parked: no course has been seen, so the compass points the arrow.
  func testCompassPointsTheArrowOnlyBeforeAnyCourse() {
    XCTAssertEqual(
      navOSSCarPlayFreeDriveHeading(
        fix: fix(course: 300, speed: 0), lastCourseDegrees: nil, compassHeadingDegrees: 47),
      NavOSSCarPlayFreeDriveHeading(degrees: 47, source: .compass))
    // Once the car has moved, the phone's compass (which says how the phone faces) yields.
    XCTAssertEqual(
      headings(for: [fix(course: 180, speed: 10), fix(speed: 0)], compass: 47).map(\.degrees),
      [180, 180])
  }

  func testWithNothingKnownTheMarkerPointsNowhereRatherThanNorth() {
    let heading = navOSSCarPlayFreeDriveHeading(
      fix: fix(course: 12, speed: 0.2), lastCourseDegrees: nil, compassHeadingDegrees: nil)
    XCTAssertEqual(heading, NavOSSCarPlayFreeDriveHeading(degrees: nil, source: .none))
    XCTAssertNil(
      navOSSCarPlayFreeDriveHeading(
        fix: fix(), lastCourseDegrees: -1, compassHeadingDegrees: 400
      ).degrees)
  }

  // MARK: Live position

  func testOnlyALiveFixBecomesTheVehicle() {
    XCTAssertNotNil(
      navOSSCarPlayFreeDrivePosition(fix: fix(), lastCourseDegrees: nil, compassHeadingDegrees: nil))
    for stale in [fix(age: 15.5), fix(age: 600), fix(age: -10), fix(accuracy: 150), fix(accuracy: -1)]
    {
      XCTAssertNil(
        navOSSCarPlayFreeDrivePosition(
          fix: stale, lastCourseDegrees: 90, compassHeadingDegrees: 90),
        "\(stale) must not be drawn as the vehicle")
    }
    let invalid = NavOSSCarPlayFreeDriveFix(
      coordinate: NavOSSCarPlayCoordinate(latitude: 91, longitude: 0), courseDegrees: -1,
      courseAccuracyDegrees: -1, speedMetersPerSecond: 0, horizontalAccuracyMeters: 5,
      ageSeconds: 0)
    XCTAssertNil(
      navOSSCarPlayFreeDrivePosition(fix: invalid, lastCourseDegrees: nil, compassHeadingDegrees: nil))
  }

  func testLivePositionCarriesTheResolvedHeadingCompassAndSpeed() {
    let moving = navOSSCarPlayFreeDrivePosition(
      fix: fix(course: 75, speed: 12), lastCourseDegrees: 10, compassHeadingDegrees: 30)
    XCTAssertEqual(
      moving,
      NavOSSCarPlayPosition(
        coordinate: here, courseDegrees: 75, compassHeadingDegrees: 30, speedMetersPerSecond: 12))
    let unknownSpeed = navOSSCarPlayFreeDrivePosition(
      fix: fix(speed: -1), lastCourseDegrees: nil, compassHeadingDegrees: nil)
    XCTAssertEqual(
      unknownSpeed,
      NavOSSCarPlayPosition(coordinate: here, courseDegrees: nil, speedMetersPerSecond: nil))
  }

  func testTheVehicleIsHiddenOnceItsFixWouldBeStale() {
    XCTAssertEqual(navOSSCarPlayFreeDriveSecondsUntilStale(ageSeconds: 0.5), 14.5)
    XCTAssertEqual(navOSSCarPlayFreeDriveSecondsUntilStale(ageSeconds: 30), 0)
  }

  // MARK: Motion

  func testTheVehicleGlidesOnlyBetweenRecentFixes() {
    XCTAssertTrue(
      navOSSCarPlayFreeDriveAnimatesToFix(hasDrawnPosition: true, secondsSincePreviousFix: 1))
    XCTAssertTrue(
      navOSSCarPlayFreeDriveAnimatesToFix(hasDrawnPosition: true, secondsSincePreviousFix: 3))
    // A first fix or one after a gap is drawn where it is, not animated from old data.
    XCTAssertFalse(
      navOSSCarPlayFreeDriveAnimatesToFix(hasDrawnPosition: false, secondsSincePreviousFix: 1))
    XCTAssertFalse(
      navOSSCarPlayFreeDriveAnimatesToFix(hasDrawnPosition: true, secondsSincePreviousFix: 3.5))
    XCTAssertFalse(
      navOSSCarPlayFreeDriveAnimatesToFix(hasDrawnPosition: true, secondsSincePreviousFix: nil))
  }

  /// Pressing Go must not move the view: free drive uses the guidance camera with nothing coming
  /// up, which a maneuver kilometres away is.
  func testFreeDriveCameraMatchesGuidanceWithNothingComingUp() {
    for speed in [nil, 0, 8.3, 13.9, 27.8, 45] as [Double?] {
      let freeDrive = navOSSCarPlayFreeDriveCameraTarget(speedMetersPerSecond: speed)
      XCTAssertEqual(
        freeDrive,
        navOSSCarPlayCameraTarget(speedMetersPerSecond: speed, distanceToManeuverMeters: 5_000))
      XCTAssertGreaterThanOrEqual(freeDrive.pitchDegrees, 50)
    }
    XCTAssertEqual(
      navOSSCarPlayFreeDriveCameraTarget(speedMetersPerSecond: 0).viewingDistanceMeters, 280)
  }

  // MARK: Marker and follow rules

  func testFreeDriveDrawsTheVehicleOnlyWhenIdleRequestedAndLive() {
    XCTAssertTrue(
      navOSSShouldShowFreeDriveVehicle(
        hasActiveGuidance: false, requestsUserLocation: true, hasLiveFix: true))
    // Guidance draws its own matched vehicle with the same marker: never two.
    XCTAssertFalse(
      navOSSShouldShowFreeDriveVehicle(
        hasActiveGuidance: true, requestsUserLocation: true, hasLiveFix: true))
    XCTAssertFalse(
      navOSSShouldShowFreeDriveVehicle(
        hasActiveGuidance: false, requestsUserLocation: false, hasLiveFix: true))
    // No live fix: the map may centre on a fallback coordinate but draws no vehicle.
    XCTAssertFalse(
      navOSSShouldShowFreeDriveVehicle(
        hasActiveGuidance: false, requestsUserLocation: true, hasLiveFix: false))
  }

  /// The driver pans: the camera stops following but the vehicle stays drawn and keeps moving.
  /// Recenter follows again. Guidance takes the camera over.
  func testPanningPausesFollowingUntilRecenterWhileTheVehicleStaysDrawn() {
    var followEnabled = true
    func follows(guidance: Bool = false) -> Bool {
      navOSSShouldFollowIdleCarPlayLocation(
        hasActiveGuidance: guidance, idleFollowEnabled: followEnabled, requestsUserLocation: true)
    }
    XCTAssertTrue(follows())
    followEnabled = false  // pan
    XCTAssertFalse(follows())
    XCTAssertTrue(
      navOSSShouldShowFreeDriveVehicle(
        hasActiveGuidance: false, requestsUserLocation: true, hasLiveFix: true))
    followEnabled = true  // recenter
    XCTAssertTrue(follows())
    XCTAssertFalse(follows(guidance: true))
  }
}
