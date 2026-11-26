import Foundation

// MARK: - Free drive
//
// With no destination the CarPlay map still shows the vehicle like guidance does: the same marker,
// pointing the way the car is going, followed by the same close, tilted camera. The position comes
// from the map's own location manager, never from shared trip state, and these rules decide what
// it may draw.

/// One location sample as CoreLocation reported it. CoreLocation marks an unknown course, course
/// accuracy or speed with a negative value; those are passed through unchanged.
public struct NavOSSCarPlayFreeDriveFix: Equatable, Sendable {
  public let coordinate: NavOSSCarPlayCoordinate
  public let courseDegrees: Double
  public let courseAccuracyDegrees: Double
  public let speedMetersPerSecond: Double
  public let horizontalAccuracyMeters: Double
  public let ageSeconds: TimeInterval
  /// When the fix was taken, in seconds since the reference date; without it the vehicle is never
  /// carried on past the fix.
  public let timestamp: TimeInterval?

  public init(
    coordinate: NavOSSCarPlayCoordinate,
    courseDegrees: Double,
    courseAccuracyDegrees: Double,
    speedMetersPerSecond: Double,
    horizontalAccuracyMeters: Double,
    ageSeconds: TimeInterval,
    timestamp: TimeInterval? = nil
  ) {
    self.coordinate = coordinate
    self.courseDegrees = courseDegrees
    self.courseAccuracyDegrees = courseAccuracyDegrees
    self.speedMetersPerSecond = speedMetersPerSecond
    self.horizontalAccuracyMeters = horizontalAccuracyMeters
    self.ageSeconds = ageSeconds
    self.timestamp = timestamp
  }
}

/// Below this speed (9 km/h) GPS course is mostly noise: a stopped car's reported course wanders
/// through every direction, which would spin the arrow at a red light.
public let navOSSCarPlayFreeDriveCourseMinimumSpeedMetersPerSecond = 2.5
/// A course CoreLocation itself rates worse than this is not trusted.
public let navOSSCarPlayFreeDriveCourseMaximumAccuracyDegrees = 45.0
/// Beyond this gap between two fixes the vehicle jumps to the new one rather than gliding there:
/// gliding across a long gap would draw a path nobody measured. Fixes normally arrive every second,
/// and the drawn vehicle stops carrying on about two seconds after the latest one.
public let navOSSCarPlayFreeDriveMaximumAnimatedGapSeconds = 3.0

/// The direction of travel a fix proves on its own: a valid course while moving fast enough that
/// the course means something, and CoreLocation does not rate it as poor.
public func navOSSCarPlayFreeDriveCourseDegrees(_ fix: NavOSSCarPlayFreeDriveFix) -> Double? {
  guard fix.courseDegrees.isFinite, (0..<360).contains(fix.courseDegrees),
    fix.speedMetersPerSecond.isFinite,
    fix.speedMetersPerSecond >= navOSSCarPlayFreeDriveCourseMinimumSpeedMetersPerSecond
  else { return nil }
  if fix.courseAccuracyDegrees.isFinite, fix.courseAccuracyDegrees >= 0,
    fix.courseAccuracyDegrees > navOSSCarPlayFreeDriveCourseMaximumAccuracyDegrees
  {
    return nil
  }
  return fix.courseDegrees
}

/// Where a free-drive bearing came from, most to least trusted.
public enum NavOSSCarPlayFreeDriveHeadingSource: Equatable, Sendable {
  /// This fix's own GPS course while moving.
  case course
  /// The last trusted course, held while stopped or crawling.
  case lastCourse
  /// The phone's compass, only before any course has been seen.
  case compass
  /// Nothing known: the marker must not point anywhere.
  case none
}

public struct NavOSSCarPlayFreeDriveHeading: Equatable, Sendable {
  public let degrees: Double?
  public let source: NavOSSCarPlayFreeDriveHeadingSource
}

/// The marker's direction of travel, in order: this fix's course while moving; the last trusted
/// course when stopped; the compass if no course has been seen yet; otherwise none, which draws the
/// non-directional marker. It never defaults to north.
///
/// The compass yields to any course once one has been seen: it reports which way the phone faces,
/// which in a cradle or a cup holder is not necessarily which way the car faces.
public func navOSSCarPlayFreeDriveHeading(
  fix: NavOSSCarPlayFreeDriveFix,
  lastCourseDegrees: Double?,
  compassHeadingDegrees: Double?
) -> NavOSSCarPlayFreeDriveHeading {
  if let course = navOSSCarPlayFreeDriveCourseDegrees(fix) {
    return NavOSSCarPlayFreeDriveHeading(degrees: course, source: .course)
  }
  if let last = navOSSCarPlayValidBearing(lastCourseDegrees) {
    return NavOSSCarPlayFreeDriveHeading(degrees: last, source: .lastCourse)
  }
  if let compass = navOSSCarPlayValidBearing(compassHeadingDegrees) {
    return NavOSSCarPlayFreeDriveHeading(degrees: compass, source: .compass)
  }
  return NavOSSCarPlayFreeDriveHeading(degrees: nil, source: .none)
}

/// The vehicle position free drive may draw for a fix, or nil when the fix is not live.
///
/// Live means the same freshness and accuracy a CarPlay route origin needs
/// (`navOSSNavigationRouteOrigin`: at most 15 s old and 100 m accurate), so an old cached fix can
/// never masquerade as the car's position.
public func navOSSCarPlayFreeDrivePosition(
  fix: NavOSSCarPlayFreeDriveFix,
  lastCourseDegrees: Double?,
  compassHeadingDegrees: Double?
) -> NavOSSCarPlayPosition? {
  guard fix.coordinate.isValid,
    navOSSNavigationRouteOrigin(
      coordinate: fix.coordinate,
      courseDegrees: fix.courseDegrees,
      speedMetersPerSecond: fix.speedMetersPerSecond,
      horizontalAccuracyMeters: fix.horizontalAccuracyMeters,
      ageSeconds: fix.ageSeconds
    ) != nil
  else { return nil }
  let heading = navOSSCarPlayFreeDriveHeading(
    fix: fix, lastCourseDegrees: lastCourseDegrees, compassHeadingDegrees: compassHeadingDegrees)
  let speed = fix.speedMetersPerSecond
  let validSpeed = speed.isFinite && speed >= 0 && speed <= 100 ? speed : nil
  var runOn: NavOSSCarPlayRunOn?
  if let timestamp = fix.timestamp, timestamp.isFinite, let validSpeed {
    runOn = NavOSSCarPlayRunOn(fixTimestamp: timestamp, speedMetersPerSecond: validSpeed)
  }
  return NavOSSCarPlayPosition(
    coordinate: fix.coordinate,
    courseDegrees: heading.degrees,
    compassHeadingDegrees: navOSSCarPlayValidBearing(compassHeadingDegrees),
    speedMetersPerSecond: validSpeed,
    // Carried on along its course only from the fix's own time and reported speed.
    runOn: runOn
  )
}

/// Seconds until a fix stops being live, after which free drive hides the vehicle.
public func navOSSCarPlayFreeDriveSecondsUntilStale(ageSeconds: TimeInterval) -> TimeInterval {
  max(0, 15 - ageSeconds)
}

/// Whether the vehicle may glide from where it is drawn to a new fix. A first fix, or one after a
/// long gap (a tunnel, a parked phone waking up), is drawn where it is instead.
public func navOSSCarPlayFreeDriveAnimatesToFix(
  hasDrawnPosition: Bool,
  secondsSincePreviousFix: Double?
) -> Bool {
  guard hasDrawnPosition, let secondsSincePreviousFix, secondsSincePreviousFix.isFinite,
    secondsSincePreviousFix >= 0
  else { return false }
  return secondsSincePreviousFix <= navOSSCarPlayFreeDriveMaximumAnimatedGapSeconds
}

/// The free-drive camera is the guidance camera with nothing coming up: the same distance across
/// and the same tilt for the same speed, so pressing Go does not move the view.
public func navOSSCarPlayFreeDriveCameraTarget(
  speedMetersPerSecond: Double?
) -> NavOSSCarPlayCameraTarget {
  navOSSCarPlayCameraTarget(
    speedMetersPerSecond: speedMetersPerSecond, distanceToManeuverMeters: nil)
}

/// Whether free drive draws the vehicle: never during guidance (guidance draws its own matched
/// vehicle with the same marker, so there is only ever one), only while the display asks for
/// location, and only with a live fix.
public func navOSSShouldShowFreeDriveVehicle(
  hasActiveGuidance: Bool,
  requestsUserLocation: Bool,
  hasLiveFix: Bool
) -> Bool {
  !hasActiveGuidance && requestsUserLocation && hasLiveFix
}

/// The bearing free drive draws between two fixes: eased from the drawn bearing toward the new
/// fix's free-drive heading the short way round, or none when that heading resolved to nothing.
/// A bearing free drive did not produce itself (the road bearing guidance drew before End, or a
/// compass reading that has since become invalid) is never kept: the marker turns
/// non-directional instead.
public func navOSSCarPlayFreeDriveDrawnCourse(
  fromDegrees: Double?,
  toDegrees: Double?,
  progress: Double
) -> Double? {
  guard let target = navOSSCarPlayValidBearing(toDegrees) else { return nil }
  guard let start = navOSSCarPlayValidBearing(fromDegrees) else { return target }
  let delta = (target - start + 540).truncatingRemainder(dividingBy: 360) - 180
  let fraction = min(1, max(0, progress))
  return (start + delta * fraction + 360).truncatingRemainder(dividingBy: 360)
}

private func navOSSCarPlayValidBearing(_ degrees: Double?) -> Double? {
  guard let degrees, degrees.isFinite, (0..<360).contains(degrees) else { return nil }
  return degrees
}
