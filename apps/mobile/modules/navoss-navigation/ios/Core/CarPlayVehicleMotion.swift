import Foundation

// MARK: - Vehicle motion
//
// Where the CarPlay map draws the vehicle on each display-link frame, between the fixes the
// navigation service (guidance) or the map's own location manager (free drive) delivers. The map
// view controller owns the display link and the camera; this owns the drawn position, so the same
// code runs on the head unit and in the host-side replay tests.

/// Time constant of the follow camera's heading easing, in seconds.
public let navOSSCarPlayCameraHeadingTimeConstantSeconds = 0.5

public struct NavOSSCarPlayVehicleMotion: Sendable {
  /// The route the vehicle follows while `followsRoad` is set (guidance).
  public var routePath = NavOSSCarPlayRoutePath([]) {
    didSet { spanIsStale = true }
  }
  /// Guidance follows the carriageway between fixes; free drive has no road to follow and must
  /// not be snapped onto a previewed one.
  public var followsRoad = false {
    didSet { if followsRoad != oldValue { spanIsStale = true } }
  }
  /// The latest fix.
  public private(set) var target: NavOSSCarPlayPosition?
  /// Where the vehicle was last drawn.
  public private(set) var drawn: NavOSSCarPlayPosition?
  /// When the latest fix arrived, on the caller's clock.
  public private(set) var lastTargetAt: Double?

  private var from: NavOSSCarPlayPosition?
  private var startedAt = 0.0
  private var duration = navOSSCarPlayDefaultInterpolationSeconds
  private var span: NavOSSCarPlayPathSpan?
  private var spanIsStale = true

  public init() {}

  /// A new fix: the vehicle animates from where it is drawn to the fix over about the last fix
  /// interval.
  public mutating func receive(_ position: NavOSSCarPlayPosition, at now: Double) {
    from = drawn ?? target ?? position
    target = position
    spanIsStale = true
    duration = navOSSCarPlayInterpolationSeconds(sinceLastTargetSeconds: lastTargetAt.map { now - $0 })
    lastTargetAt = now
    startedAt = now
    if drawn == nil {
      drawn = position
    }
  }

  /// Free drive's compass turned the vehicle before any course was seen: turn in place over a
  /// short span. The position is unchanged, so the fix cadence is left alone.
  public mutating func turn(to position: NavOSSCarPlayPosition, at now: Double) {
    from = drawn ?? position
    target = position
    startedAt = now
    duration = navOSSCarPlayMinimumInterpolationSeconds
  }

  /// Forgets the vehicle: the next fix is drawn where it is.
  public mutating func reset() {
    target = nil
    drawn = nil
    from = nil
    lastTargetAt = nil
  }

  /// Places the vehicle for a frame at `now`. Returns whether it is still moving, that is whether
  /// another frame would draw it somewhere else.
  @discardableResult
  public mutating func advance(to now: Double) -> Bool {
    guard let target, let start = from else { return false }
    let progress = min(1, max(0, (now - startedAt) / duration))
    // Follow the carriageway between the two fixes where the road can describe the movement, so
    // the vehicle rounds a corner instead of cutting the chord across it and then snapping back.
    // The span between the two fixes is resolved once per fix (O(route)); a frame only places the
    // vehicle along it.
    if spanIsStale {
      spanIsStale = false
      span =
        followsRoad
        ? navOSSCarPlayPathSpan(from: start.coordinate, to: target.coordinate, along: routePath)
        : nil
    }
    let roadPath = span?.position(at: progress)
    drawn = NavOSSCarPlayPosition(
      coordinate: roadPath?.coordinate
        ?? NavOSSCarPlayCoordinate(
          latitude: start.coordinate.latitude
            + (target.coordinate.latitude - start.coordinate.latitude) * progress,
          longitude: start.coordinate.longitude
            + (target.coordinate.longitude - start.coordinate.longitude) * progress
        ),
      // The road's own bearing turns the arrow through the bend as the vehicle travels it. Course
      // reported between two fixes only changes once the turn is already over.
      // Free drive draws only the bearing its own heading chain resolved for the target fix, so
      // a bearing guidance or an earlier compass reading left behind is dropped, not kept.
      courseDegrees: roadPath?.bearingDegrees
        ?? (followsRoad
          ? navOSSCarPlayInterpolatedCourse(
            from: start.courseDegrees, to: target.courseDegrees, progress: progress)
          : navOSSCarPlayFreeDriveDrawnCourse(
            fromDegrees: start.courseDegrees, toDegrees: target.courseDegrees, progress: progress)),
      compassHeadingDegrees: target.compassHeadingDegrees,
      speedMetersPerSecond: target.speedMetersPerSecond
    )
    return progress < 1
  }
}

private func navOSSCarPlayInterpolatedCourse(from: Double?, to: Double?, progress: Double) -> Double? {
  guard let target = to else { return from }
  guard let start = from else { return target }
  let delta = (target - start + 540).truncatingRemainder(dividingBy: 360) - 180
  return (start + delta * progress + 360).truncatingRemainder(dividingBy: 360)
}
