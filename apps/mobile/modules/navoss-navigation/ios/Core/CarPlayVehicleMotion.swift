import Foundation

// MARK: - Vehicle motion
//
// Where the CarPlay map draws the vehicle on each display-link frame, between the fixes the
// navigation service (guidance) or the map's own location manager (free drive) delivers. The map
// view controller owns the display link and the camera; this owns the drawn position, so the same
// code runs on the head unit and in the host-side replay tests.
//
// The vehicle is drawn with a continuous velocity. Each fix says where the car was and how fast it
// was going; from it the vehicle is expected to carry on at that speed (along the route in
// guidance, along its course in free drive), and the drawn vehicle tracks that expectation with a
// critically damped spring. The next fix then corrects position and speed instead of restarting an
// animation, so the car neither stops at each fix nor changes speed in a step when one arrives.
//
// What keeps it honest:
// - A fix that says the car is stopped stops the drawn vehicle at once, and holds it there while
//   later stopped fixes wander within GPS noise; it moves on only when two fresh fixes agree on a
//   new place (see `stillMove`).
// - The expectation runs at full speed for `navOSSCarPlayExtrapolationFullSpeedSeconds` after a
//   fix, eases to a stop over `navOSSCarPlayExtrapolationEaseOutSeconds`, and then waits: a tunnel
//   or a lost signal does not drive the car on.
// - In guidance it never runs past the end of the route or through a turn
//   (`navOSSCarPlayTurnVertexDegrees`) ahead of the latest fix, and never backwards along it.

/// Away from the road, how long the drawn course takes to turn to a new fix's course: about one
/// fix interval, so the arrow turns steadily through a bend reported in one-second steps.
public let navOSSCarPlayCourseEaseSeconds = 1.0

/// Time constant of the follow camera's heading easing, in seconds.
public let navOSSCarPlayCameraHeadingTimeConstantSeconds = 0.5

/// How long after a fix the vehicle keeps going at that fix's speed. Fixes normally arrive every
/// second with a couple of hundred milliseconds of jitter.
public let navOSSCarPlayExtrapolationFullSpeedSeconds = 1.3
/// After that, how long it takes to slow to a stop if no fix has come.
public let navOSSCarPlayExtrapolationEaseOutSeconds = 0.7
/// A fix slower than this is a stopped car.
public let navOSSCarPlayStoppedSpeedMetersPerSecond = 0.5
/// A stopped car's fixes wander by GPS noise; within this distance of the drawn vehicle (or of each
/// other) they are the same place.
public let navOSSCarPlayStoppedHoldMeters = 4.0
/// Natural rate of the spring that pulls the drawn vehicle onto the expected track, per second.
/// Higher follows corrections faster but passes more GPS noise into the drawn speed.
public let navOSSCarPlayTrackingRatePerSecond = 3.0
/// Beyond this distance from the expected track the vehicle is drawn where the fix puts it instead
/// of gliding there (a reroute, a restored trip, a long gap).
public let navOSSCarPlaySnapMinimumMeters = 30.0
/// The same bound as seconds of travel at the fix's speed, when that is further.
public let navOSSCarPlaySnapSeconds = 2.5

/// Distance travelled and speed, as multiples of the fix's speed, `seconds` after a fix.
func navOSSCarPlayExtrapolation(afterSeconds seconds: Double) -> (seconds: Double, speedFactor: Double) {
  let elapsed = max(0, seconds)
  let fullSpeed = navOSSCarPlayExtrapolationFullSpeedSeconds
  guard elapsed > fullSpeed else { return (elapsed, 1) }
  let easeOut = navOSSCarPlayExtrapolationEaseOutSeconds
  let slowing = min(elapsed - fullSpeed, easeOut)
  return (fullSpeed + slowing - slowing * slowing / (2 * easeOut), 1 - slowing / easeOut)
}

/// Seconds of travel at a fix's speed the extrapolation covers in all: the bound on how far the
/// vehicle is drawn beyond the latest fix.
public let navOSSCarPlayExtrapolationReachSeconds =
  navOSSCarPlayExtrapolationFullSpeedSeconds + navOSSCarPlayExtrapolationEaseOutSeconds / 2

/// The fastest the vehicle may go with `room` metres left before the extrapolation's bound, braking
/// as the extrapolation itself does.
func navOSSCarPlayBrakingSpeed(room: Double, fixSpeed: Double) -> Double {
  let braking = fixSpeed / navOSSCarPlayExtrapolationEaseOutSeconds
  return (2 * braking * max(0, room)).squareRoot()
}

public struct NavOSSCarPlayVehicleMotion: Sendable {
  /// The route the vehicle follows while `followsRoad` is set (guidance).
  public var routePath = NavOSSCarPlayRoutePath([]) {
    didSet { needsResolve = true; trackIsStale = true }
  }
  /// Guidance follows the carriageway; free drive has no road to follow and must not be snapped
  /// onto a previewed one.
  public var followsRoad = false {
    didSet {
      if followsRoad != oldValue { needsResolve = true; trackIsStale = true }
    }
  }
  /// The latest fix.
  public private(set) var target: NavOSSCarPlayPosition?
  /// Where the vehicle was last drawn.
  public private(set) var drawn: NavOSSCarPlayPosition?
  /// When the latest fix arrived, on the caller's clock.
  public private(set) var lastTargetAt: Double?

  private enum Track {
    /// Along `routePath`: distance from its start and speed along it.
    case road(distanceMeters: Double, speed: Double)
    /// Free of any road: velocity east and north, in m/s.
    case plane(east: Double, north: Double)
  }

  /// The latest fix, resolved against the road.
  private struct Anchor {
    var at: Double
    var speed: Double
    /// Road: distance of the fix along the route, and the furthest the vehicle may be drawn.
    var distanceMeters: Double?
    var limitMeters: Double
    /// How far the vehicle may be drawn past the fix (or past where it was drawn when the fix came,
    /// if that was further on), in metres along the road or the course.
    var reachMeters = 0.0
    /// How hard the fixes say the car is braking, m/s² (0 when it is not): the run-on slows with it.
    var deceleration = 0.0
    /// The speed the vehicle may catch up with the fix at: the run-on's, or for a fresh fix that is
    /// not carried on (off the route), the speed it reports. It is never carried past that fix.
    var glideSpeed = 0.0
    /// Plane: where the fix is, and the course it travels in radians (nil: it is not
    /// extrapolated).
    var coordinate: NavOSSCarPlayCoordinate
    var courseRadians: Double?
  }

  private var track: Track?
  private var anchor: Anchor?
  private var needsResolve = false
  /// The drawn distance along the route no longer refers to `routePath` (new route, new mode).
  private var trackIsStale = true
  /// The vehicle stands where a fresh stopped fix put or held it, until a fix says it moves again.
  /// A held position's stop is not one: it only freezes the vehicle.
  private var standsOnStoppedFix = false
  /// The previous fresh fix that said the car stands (or could not say it moves), while it stands.
  private var previousStillFix: NavOSSCarPlayCoordinate?
  /// The latest position is a fresh observation of the car (see `receive`).
  private var targetIsObservation = false
  /// Along the road: the furthest the fixes so far allow the vehicle (see `resolve`).
  private var roadBound: Double?
  /// A standing vehicle is gliding to where agreeing stopped fixes put it, backwards along the road
  /// if need be (a correction, not driving).
  private var glidesStanding = false
  private var lastFrameAt: Double?
  /// The run-on of the previous accepted fix, to tell whether the car is braking.
  private var previousRunOn: NavOSSCarPlayRunOn?
  private var courseFrom: Double?
  private var courseStartedAt = 0.0

  public init() {}

  /// A published position, received at `now` on the frame clock while the wall clock reads
  /// `wallClock` (seconds since the reference date, the clock fixes are stamped with). A
  /// republished one (the same place, speed, course and fix, only the compass moved) changes
  /// nothing about where the vehicle is going.
  ///
  /// Only a position with `runOn` (an accepted real fix with a reported speed) is carried on, and
  /// only for the time left since that fix was taken: a cached fix, a held or dead-reckoned
  /// publication, or one replayed when a scene connects gets no fresh window.
  public mutating func receive(_ position: NavOSSCarPlayPosition, at now: Double, wallClock: Double) {
    // The same fix again (only the compass moved): identified by when it was taken, or, without
    // that, by everything else it says.
    if let target, target.source == position.source, target.coordinate == position.coordinate,
      target.capturedAt != nil || position.capturedAt != nil
        ? target.capturedAt == position.capturedAt
        : target.speedMetersPerSecond == position.speedMetersPerSecond
          && target.courseDegrees == position.courseDegrees && target.runOn == position.runOn
    {
      self.target = position
      return
    }
    // A fresh observation of where the car is: a fix, taken no longer ago than the run-on lasts
    // and not in the future. Held, dead-reckoned, cached and future-dated positions are not.
    targetIsObservation =
      position.source == .fix
      && position.capturedAt.map {
        let age = wallClock - $0
        return age >= 0
          && age <= navOSSCarPlayExtrapolationFullSpeedSeconds + navOSSCarPlayExtrapolationEaseOutSeconds
      } != false
    courseFrom = drawn?.courseDegrees
    courseStartedAt = now
    target = position
    lastTargetAt = now
    var at = now
    var runOnSpeed = 0.0
    if let runOn = position.runOn {
      // A fix stamped after now (the clock was set back since) has no age that can be trusted: it
      // is placed, not carried on.
      let age = wallClock - runOn.fixTimestamp
      at = now - max(0, age)
      if age >= 0,
        age < navOSSCarPlayExtrapolationFullSpeedSeconds + navOSSCarPlayExtrapolationEaseOutSeconds,
        runOn.speedMetersPerSecond >= navOSSCarPlayStoppedSpeedMetersPerSecond
      {
        runOnSpeed = runOn.speedMetersPerSecond
      }
    }
    var deceleration = 0.0
    if let runOn = position.runOn {
      if let previous = previousRunOn {
        let interval = runOn.fixTimestamp - previous.fixTimestamp
        if interval >= 0.3, interval <= 2.5 {
          deceleration = max(0, (previous.speedMetersPerSecond - runOn.speedMetersPerSecond) / interval)
        }
      }
      previousRunOn = runOn
    }
    var glideSpeed = runOnSpeed
    if glideSpeed == 0, targetIsObservation, let speed = position.speedMetersPerSecond, speed.isFinite,
      speed >= navOSSCarPlayStoppedSpeedMetersPerSecond, speed <= maximumPlausibleSpeedMetersPerSecond
    {
      glideSpeed = speed
    }
    anchor = Anchor(
      at: at, speed: runOnSpeed, distanceMeters: nil, limitMeters: 0, deceleration: deceleration,
      glideSpeed: glideSpeed, coordinate: position.coordinate, courseRadians: nil)
    needsResolve = true
    if drawn == nil {
      drawn = position
    }
  }

  /// Free drive's compass turned the vehicle before any course was seen: turn in place. The
  /// position is unchanged, so the fix cadence is left alone.
  public mutating func turn(to position: NavOSSCarPlayPosition, at now: Double) {
    courseFrom = drawn?.courseDegrees ?? position.courseDegrees
    courseStartedAt = now
    target = position
  }

  /// Forgets the vehicle: the next fix is drawn where it is.
  public mutating func reset() {
    target = nil
    drawn = nil
    lastTargetAt = nil
    track = nil
    anchor = nil
    lastFrameAt = nil
    courseFrom = nil
    previousRunOn = nil
    trackIsStale = true
    standsOnStoppedFix = false
    previousStillFix = nil
    glidesStanding = false
    targetIsObservation = false
    roadBound = nil
  }

  /// A fix that says the car is stopped, or cannot say it moves: it is never carried on.
  private var targetHolds: Bool {
    guard let speed = target?.speedMetersPerSecond, speed.isFinite, speed >= 0 else { return true }
    return speed < navOSSCarPlayStoppedSpeedMetersPerSecond
  }

  /// A fix that says the car is stopped.
  private var targetIsStopped: Bool {
    guard let speed = target?.speedMetersPerSecond, speed.isFinite, speed >= 0 else { return false }
    return speed < navOSSCarPlayStoppedSpeedMetersPerSecond
  }

  private enum StillMove {
    /// Stays where it is drawn, stopped.
    case stay
    /// Glides there and stops.
    case glide
    /// Is put there at once, stopped.
    case place
  }

  /// What a fix that holds (`targetHolds`) does to a vehicle drawn `distance` metres from it,
  /// moving at `drawnSpeed`. The hold resists GPS wander, not movement: a held position never moves
  /// the vehicle, nor does a fix within the noise of where it is drawn. A moving vehicle told it
  /// stopped elsewhere is put there at once; one drawn standing glides there. Once a fresh stopped
  /// fix has put it down, it moves only when two fresh fixes in a row agree on a new place (queue
  /// creep, or a correction), and glides there.
  private func stillMove(distanceFromDrawn distance: Double, drawnSpeed: Double) -> StillMove {
    guard let target else { return .stay }
    if target.source == .arrival {
      return distance <= 0.5 ? .stay : distance > navOSSCarPlaySnapMinimumMeters ? .place : .glide
    }
    if !targetIsObservation || distance <= navOSSCarPlayStoppedHoldMeters { return .stay }
    // Too far to glide in a moment (a correction after a gap): put there.
    if distance > navOSSCarPlaySnapMinimumMeters { return .place }
    guard standsOnStoppedFix else {
      return targetIsStopped && drawnSpeed >= navOSSCarPlayStoppedSpeedMetersPerSecond
        ? .place : .glide
    }
    let agrees = previousStillFix.map {
      let offset = navOSSCarPlayOffsetMeters(from: $0, to: target.coordinate)
      return hypot(offset.east, offset.north) <= navOSSCarPlayStoppedHoldMeters
    } == true
    return agrees ? .glide : .stay
  }

  /// Places the vehicle for a frame at `now`. Returns whether it is still moving, that is whether
  /// another frame would draw it somewhere else.
  @discardableResult
  public mutating func advance(to now: Double) -> Bool {
    guard let target else { return false }
    if needsResolve {
      resolve(now: now)
    }
    guard let anchor else { return false }
    // A display link that was stopped (the vehicle had settled) restarts with one frame's step,
    // not a jump across the time it was idle.
    let sinceLastFrame = now - (lastFrameAt ?? now)
    let elapsed = sinceLastFrame > 0.25 ? 1.0 / 60 : max(0, sinceLastFrame)
    lastFrameAt = now
    switch track {
    case .road(var distance, var speed):
      var time = now - elapsed
      let steps = max(1, Int((elapsed * 120).rounded(.up)))
      let step = elapsed / Double(steps)
      for _ in 0..<steps {
        time += step
        let expected = roadExpectation(anchor, at: time)
        if glidesStanding {
          let error = expected.distance - distance
          let wanted =
            (error < 0 ? -1.0 : 1.0)
            * min(
              navOSSCarPlayCatchUpSpeed(0),
              (2 * navOSSCarPlayMaximumTrackingAcceleration * abs(error)).squareRoot())
          let change = navOSSCarPlayMaximumTrackingAcceleration * step
          speed += max(-change, min(change, wanted - speed))
          if abs(error) <= max(abs(speed) * step, 0.005) {
            // Arrived: stand there rather than hunt around it.
            distance = expected.distance
            speed = 0
          } else {
            distance += speed * step
          }
          continue
        }
        let previousSpeed = speed
        speed = trackedSpeed(
          speed, position: distance, toward: expected, step: step, fixSpeed: anchor.glideSpeed)
        // Brake into the end of the route or a turn ahead of the fix rather than stop dead.
        let room = max(0, anchor.limitMeters - distance)
        speed = max(0, min(speed, (2 * navOSSCarPlayMaximumTrackingAcceleration * room).squareRoot()))
        // Never further than the fix's own speed carries it (`navOSSCarPlayExtrapolation`), and a
        // fix that is not carried on is glided to and stopped at, braking no harder than the
        // tracking limit.
        if anchor.speed == 0 {
          let stopping =
            (2 * navOSSCarPlayMaximumTrackingAcceleration * max(0, expected.distance - distance))
            .squareRoot()
          speed = min(
            speed, max(stopping, previousSpeed - navOSSCarPlayMaximumTrackingAcceleration * step))
        } else {
          speed = min(
            speed, navOSSCarPlayBrakingSpeed(room: anchor.reachMeters - distance, fixSpeed: anchor.speed))
        }
        distance += speed * step
        if distance >= anchor.limitMeters {
          distance = anchor.limitMeters
          speed = 0
        }
      }
      let settled = roadExpectation(anchor, at: now)
      if !glidesStanding, settled.speed == 0, abs(speed) < 0.05,
        abs(settled.distance - distance) < 0.05
      {
        // At rest where it was going: stop rather than creep the last centimetres for seconds.
        speed = 0
        distance = max(distance, min(settled.distance, anchor.limitMeters))
      }
      track = .road(distanceMeters: distance, speed: speed)
      let point = routePath.pointAlongRoad(atDistance: distance)
      drawn = NavOSSCarPlayPosition(
        coordinate: point?.coordinate ?? target.coordinate,
        courseDegrees: point?.bearingDegrees ?? target.courseDegrees,
        compassHeadingDegrees: target.compassHeadingDegrees,
        speedMetersPerSecond: target.speedMetersPerSecond
      )
      let expected = roadExpectation(anchor, at: now)
      // The vehicle never reverses along the road (except to glide a standing vehicle), so a target
      // behind it is not one it can reach.
      if glidesStanding { return abs(speed) > 0.01 || abs(expected.distance - distance) > 0.01 }
      return speed > 0.01 || expected.distance - distance > 0.01 || expected.speed > 0
    case .plane(var east, var north):
      let current = drawn?.coordinate ?? anchor.coordinate
      var offset = navOSSCarPlayOffsetMeters(from: anchor.coordinate, to: current)
      var time = now - elapsed
      let steps = max(1, Int((elapsed * 120).rounded(.up)))
      let step = elapsed / Double(steps)
      let rate = navOSSCarPlayTrackingRatePerSecond
      for _ in 0..<steps {
        time += step
        let expected = planeExpectation(anchor, at: time)
        let previousSpeed = hypot(east, north)
        var error = (east: expected.east - offset.east, north: expected.north - offset.north)
        if let course = anchor.courseRadians {
          // Behind the vehicle along its course is out of reach (it never reverses): only the
          // sideways part of the error is corrected.
          let behind = min(0, error.east * sin(course) + error.north * cos(course))
          error = (error.east - behind * sin(course), error.north - behind * cos(course))
        }
        var accelerationEast =
          rate * rate * error.east + 2 * rate * (expected.velocityEast - east)
        var accelerationNorth =
          rate * rate * error.north + 2 * rate * (expected.velocityNorth - north)
        let expectedSpeed = hypot(expected.velocityEast, expected.velocityNorth)
        if expectedSpeed > 0 {
          // Speeding up and slowing down along the track is limited like on the road; steering
          // back onto it sideways is not, or a car leaving a bend would drift wide of it.
          let direction = (
            east: expected.velocityEast / expectedSpeed, north: expected.velocityNorth / expectedSpeed
          )
          let alongAcceleration =
            accelerationEast * direction.east + accelerationNorth * direction.north
          let limited = navOSSCarPlayLimitedAcceleration(
            alongAcceleration,
            limit: navOSSCarPlayAccelerationLimit(
              behindMeters: (expected.east - offset.east) * direction.east
                + (expected.north - offset.north) * direction.north,
              fixSpeed: anchor.glideSpeed))
          accelerationEast += (limited - alongAcceleration) * direction.east
          accelerationNorth += (limited - alongAcceleration) * direction.north
        } else {
          let acceleration = hypot(accelerationEast, accelerationNorth)
          let limited = min(navOSSCarPlayMaximumTrackingAcceleration, acceleration)
          if acceleration > limited {
            accelerationEast *= limited / acceleration
            accelerationNorth *= limited / acceleration
          }
        }
        east += accelerationEast * step
        north += accelerationNorth * step
        // Never drawn standing (or reversing) while the fixes say it moves; see `trackedSpeed`.
        if expectedSpeed > 0 {
          let direction = (
            east: expected.velocityEast / expectedSpeed, north: expected.velocityNorth / expectedSpeed
          )
          let along = east * direction.east + north * direction.north
          let floor = min(
            expectedSpeed * navOSSCarPlayMinimumSpeedShare,
            along + navOSSCarPlayMaximumTrackingAcceleration * step)
          if along < floor {
            east += (floor - along) * direction.east
            north += (floor - along) * direction.north
          }
        }
        if let course = anchor.courseRadians {
          // Never further along the course than the fix's own speed carries it, and never
          // backwards along it.
          let direction = (east: sin(course), north: cos(course))
          let travelled = offset.east * direction.east + offset.north * direction.north
          let along = east * direction.east + north * direction.north
          let allowed = navOSSCarPlayBrakingSpeed(
            room: anchor.reachMeters - travelled, fixSpeed: anchor.speed)
          let limited = min(max(0, along), allowed)
          east += (limited - along) * direction.east
          north += (limited - along) * direction.north
        }
        var ceiling = max(
          navOSSCarPlayCatchUpSpeed(anchor.glideSpeed),
          previousSpeed - navOSSCarPlayMaximumTrackingAcceleration * step)
        if anchor.courseRadians == nil {
          // Not carried on: glided to and stopped at, braking in time rather than circling it.
          let remaining = hypot(expected.east - offset.east, expected.north - offset.north)
          let stopping = (2 * navOSSCarPlayMaximumTrackingAcceleration * remaining).squareRoot()
          ceiling = min(
            ceiling,
            max(stopping, previousSpeed - navOSSCarPlayMaximumTrackingAcceleration * step))
        }
        let speed = hypot(east, north)
        if speed > ceiling {
          east *= ceiling / speed
          north *= ceiling / speed
        }
        offset.east += east * step
        offset.north += north * step
      }
      let settled = planeExpectation(anchor, at: now)
      if hypot(settled.velocityEast, settled.velocityNorth) == 0, hypot(east, north) < 0.05,
        hypot(settled.east - offset.east, settled.north - offset.north) < 0.05
      {
        // At rest where it was going: stop rather than creep the last centimetres for seconds.
        east = 0
        north = 0
        offset = (settled.east, settled.north)
      }
      track = .plane(east: east, north: north)
      let progress = min(1, max(0, (now - courseStartedAt) / navOSSCarPlayCourseEaseSeconds))
      drawn = NavOSSCarPlayPosition(
        coordinate: navOSSCarPlayOffsetCoordinate(anchor.coordinate, by: offset),
        // Free drive draws only the bearing its own heading chain resolved for the target fix, so
        // a bearing guidance or an earlier compass reading left behind is dropped, not kept.
        courseDegrees: followsRoad
          ? navOSSCarPlayInterpolatedCourse(from: courseFrom, to: target.courseDegrees, progress: progress)
          : navOSSCarPlayFreeDriveDrawnCourse(
            fromDegrees: courseFrom, toDegrees: target.courseDegrees, progress: progress),
        compassHeadingDegrees: target.compassHeadingDegrees,
        speedMetersPerSecond: target.speedMetersPerSecond
      )
      let expected = planeExpectation(anchor, at: now)
      // Along a course the vehicle never reverses, so a target behind it is not one it can reach.
      var error = (east: expected.east - offset.east, north: expected.north - offset.north)
      if let course = anchor.courseRadians {
        let behind = min(0, error.east * sin(course) + error.north * cos(course))
        error = (error.east - behind * sin(course), error.north - behind * cos(course))
      }
      return hypot(east, north) > 0.01 || hypot(error.east, error.north) > 0.01
        || hypot(expected.velocityEast, expected.velocityNorth) > 0
        || (progress < 1 && courseFrom != target.courseDegrees)
    case nil:
      return false
    }
  }

  /// Resolves the latest fix against the road (O(route) once per fix or new route; frames are
  /// O(log route)) and decides whether the drawn vehicle glides or is placed.
  private mutating func resolve(now: Double) {
    needsResolve = false
    guard let target, var anchor else { return }
    // The first fix (or the first after `reset`) starts at its own speed rather than from rest.
    let hasTrack = track != nil
    // A vehicle drawn standing is moved only by observations (or arrival), whatever speed a held,
    // dead-reckoned, cached or future-dated position reports.
    var drawnSpeed = 0.0
    switch track {
    case .road(_, let speed): drawnSpeed = abs(speed)
    case .plane(let east, let north): drawnSpeed = hypot(east, north)
    case nil: break
    }
    let holds =
      targetHolds || target.source == .arrival
      || (!targetIsObservation && drawnSpeed < navOSSCarPlayStoppedSpeedMetersPerSecond)
    glidesStanding = false
    defer {
      // Only observations (and arrival) say whether the car stands; other positions leave it.
      if target.source == .arrival || targetIsObservation {
        let fresh = holds
        standsOnStoppedFix = fresh
        previousStillFix = fresh ? target.coordinate : nil
      }
    }
    var fixDistance =
      followsRoad && routePath.geometry.count >= 2
      ? routePath.distanceAlong(target.coordinate, maxOffsetMeters: navOSSCarPlayPathInterpolationMaxOffsetMeters)
      : nil
    // A vehicle drawn off the road (it stopped off the route) that this position may not move is
    // decided where it is drawn, not snapped back onto the road.
    if fixDistance != nil, holds, hasTrack, let drawn,
      routePath.distanceAlong(
        drawn.coordinate, maxOffsetMeters: navOSSCarPlayPathInterpolationMaxOffsetMeters) == nil
    {
      fixDistance = nil
    }
    if let fixDistance {
      // Drawn distance along this route: kept while the route is unchanged, otherwise measured
      // once from where the vehicle is drawn.
      var current: (distance: Double, speed: Double)?
      if case .road(let distance, let speed) = track, !trackIsStale {
        current = (distance, speed)
      } else if let drawn,
        let distance = routePath.distanceAlong(
          drawn.coordinate, maxOffsetMeters: navOSSCarPlayPathInterpolationMaxOffsetMeters)
      {
        var speed = 0.0
        if case .plane(let east, let north) = track { speed = hypot(east, north) }
        current = (distance, speed)
      }
      if !hasTrack { current = nil }
      var distance = fixDistance
      var still: StillMove?
      if holds {
        anchor.speed = 0
        if let current {
          still = stillMove(
            distanceFromDrawn: abs(current.distance - fixDistance), drawnSpeed: current.speed)
          let standing = current.speed < navOSSCarPlayStoppedSpeedMetersPerSecond
          // Along the road a moving vehicle never reverses: a place behind it is put, not glided to.
          if still == .glide, !standing, fixDistance < current.distance { still = .place }
          glidesStanding = still == .glide && standing
          if still == .stay { distance = current.distance }
        } else {
          still = .place
        }
      }
      // Never past the end of the route, a turn the fixes have not shown taken (a fix on the turn
      // itself has not), or where the navigation core would stop its own prediction.
      var limit = min(routePath.lengthMeters, routePath.nextTurn(atOrAfter: fixDistance) ?? .infinity)
      if let progress = target.runOn?.limitProgress {
        limit = min(limit, progress * routePath.lengthMeters)
      }
      anchor.distanceMeters = distance
      anchor.limitMeters = max(distance, limit)
      anchor.reachMeters =
        max(distance, current?.distance ?? distance)
        + anchor.speed * navOSSCarPlayExtrapolationReachSeconds
      // How far the fixes so far let the vehicle go. A position that is not carried on (held,
      // off the core's prediction, stopped) never extends it: a car still moving when it arrives
      // brakes within what the last run-on allowed.
      if anchor.speed > 0 || current == nil || roadBound == nil {
        roadBound = anchor.speed > 0 ? min(anchor.limitMeters, anchor.reachMeters) : distance
      }
      let bound = max(distance, roadBound ?? distance)
      roadBound = bound
      // A run-on brakes into its own reach; anything else brakes into the bound.
      if anchor.speed == 0 { anchor.limitMeters = max(distance, min(anchor.limitMeters, bound)) }
      anchor.courseRadians = nil
      self.anchor = anchor
      let expected = roadExpectation(anchor, at: now)
      if let still, let current, still != .place {
        track = .road(distanceMeters: current.distance, speed: still == .stay ? 0 : current.speed)
      } else if still != nil {
        track = .road(distanceMeters: distance, speed: 0)
      } else if let current,
        abs(expected.distance - current.distance) <= navOSSCarPlaySnapLimit(speed: max(anchor.speed, target.speedMetersPerSecond ?? 0))
      {
        track = .road(distanceMeters: current.distance, speed: current.speed)
      } else {
        track = .road(distanceMeters: expected.distance, speed: expected.speed)
      }
      trackIsStale = false
      return
    }
    // No road to follow: free drive, or a guidance fix too far from the route to be on it.
    anchor.distanceMeters = nil
    anchor.coordinate = target.coordinate
    var velocity: (east: Double, north: Double) = (0, 0)
    switch track {
    case .plane(let east, let north):
      velocity = (east, north)
    case .road(_, let roadSpeed):
      if let course = drawn?.courseDegrees {
        velocity = (roadSpeed * sin(course * .pi / 180), roadSpeed * cos(course * .pi / 180))
      }
    case nil:
      break
    }
    var still: StillMove?
    if holds {
      anchor.speed = 0
      if hasTrack, let drawn {
        let offset = navOSSCarPlayOffsetMeters(from: target.coordinate, to: drawn.coordinate)
        still = stillMove(
          distanceFromDrawn: hypot(offset.east, offset.north), drawnSpeed: hypot(velocity.east, velocity.north))
        if still == .stay { anchor.coordinate = drawn.coordinate }
      } else {
        still = .place
      }
      if still != .glide { velocity = (0, 0) }
    }
    anchor.courseRadians = nil
    if anchor.speed > 0, let course = navOSSCarPlayValidCourse(target.courseDegrees) {
      anchor.courseRadians = course * .pi / 180
      let drawnAhead = drawn.map { drawn -> Double in
        let offset = navOSSCarPlayOffsetMeters(from: anchor.coordinate, to: drawn.coordinate)
        return offset.east * sin(course * .pi / 180) + offset.north * cos(course * .pi / 180)
      }
      anchor.reachMeters =
        max(0, hasTrack ? drawnAhead ?? 0 : 0)
        + anchor.speed * navOSSCarPlayExtrapolationReachSeconds
    }
    self.anchor = anchor
    track = .plane(east: velocity.east, north: velocity.north)
    trackIsStale = true
    let expected = planeExpectation(anchor, at: now)
    let current = drawn.map { navOSSCarPlayOffsetMeters(from: anchor.coordinate, to: $0.coordinate) }
    if !hasTrack || current == nil || still == .place
      || hypot(expected.east - current!.east, expected.north - current!.north)
        > navOSSCarPlaySnapLimit(speed: max(anchor.speed, target.speedMetersPerSecond ?? 0))
    {
      drawn = NavOSSCarPlayPosition(
        coordinate: navOSSCarPlayOffsetCoordinate(anchor.coordinate, by: (expected.east, expected.north)),
        courseDegrees: target.courseDegrees,
        compassHeadingDegrees: target.compassHeadingDegrees,
        speedMetersPerSecond: target.speedMetersPerSecond)
      track = .plane(east: expected.velocityEast, north: expected.velocityNorth)
    }
  }

  /// Distance and speed the car is expected to cover `seconds` after the fix: the extrapolation,
  /// or less when the fixes show it braking and it would stop sooner at that rate.
  private func run(_ anchor: Anchor, afterSeconds seconds: Double) -> (distance: Double, speed: Double) {
    let run = navOSSCarPlayExtrapolation(afterSeconds: seconds)
    var distance = anchor.speed * run.seconds
    var speed = anchor.speed * run.speedFactor
    if anchor.deceleration > 0 {
      let braking = min(max(0, seconds), anchor.speed / anchor.deceleration)
      let brakingDistance = anchor.speed * braking - anchor.deceleration * braking * braking / 2
      if brakingDistance < distance {
        distance = brakingDistance
        speed = min(speed, max(0, anchor.speed - anchor.deceleration * max(0, seconds)))
      }
    }
    return (distance, speed)
  }

  private func roadExpectation(_ anchor: Anchor, at time: Double) -> (distance: Double, speed: Double) {
    let start = anchor.distanceMeters ?? 0
    let run = run(anchor, afterSeconds: time - anchor.at)
    let distance = start + run.distance
    guard distance < anchor.limitMeters else { return (anchor.limitMeters, 0) }
    return (distance, run.speed)
  }

  private func planeExpectation(_ anchor: Anchor, at time: Double)
    -> (east: Double, north: Double, velocityEast: Double, velocityNorth: Double)
  {
    guard let course = anchor.courseRadians else { return (0, 0, 0, 0) }
    let run = run(anchor, afterSeconds: time - anchor.at)
    let distance = run.distance
    let speed = run.speed
    return (sin(course) * distance, cos(course) * distance, sin(course) * speed, cos(course) * speed)
  }

  /// One spring step of the drawn speed toward the expected track, held below the catch-up speed.
  private func trackedSpeed(
    _ speed: Double,
    position: Double,
    toward expected: (distance: Double, speed: Double),
    step: Double,
    fixSpeed: Double
  ) -> Double {
    let rate = navOSSCarPlayTrackingRatePerSecond
    let limit = navOSSCarPlayAccelerationLimit(
      behindMeters: expected.distance - position, fixSpeed: fixSpeed)
    let acceleration = navOSSCarPlayLimitedAcceleration(
      rate * rate * (expected.distance - position) + 2 * rate * (expected.speed - speed),
      limit: limit)
    // A car the fixes say is moving is never drawn standing, even while a fix that landed behind
    // the drawn vehicle is being absorbed: it slows to half the expected speed and lets the car
    // catch up instead. Getting back up to that speed is limited like any other change.
    let floor = min(expected.speed * navOSSCarPlayMinimumSpeedShare, speed + limit * step)
    // The catch-up ceiling is reached by braking, not in one frame (a held position after a moving
    // fix has no speed of its own to catch up at).
    let ceiling = max(
      navOSSCarPlayCatchUpSpeed(fixSpeed), speed - navOSSCarPlayMaximumTrackingAcceleration * step)
    return min(ceiling, max(speed + acceleration * step, floor))
  }
}

/// The drawn vehicle never goes slower than this share of the speed it is expected to go.
public let navOSSCarPlayMinimumSpeedShare = 0.5
/// The hardest the drawn vehicle speeds up or slows down while it follows the fixes, in m/s². A
/// fix that says the car stopped still stops it at once.
public let navOSSCarPlayMaximumTrackingAcceleration = 6.0

/// The limit on speeding up. A vehicle drawn behind where the fixes put the car (it stopped at the
/// end of the extrapolation while a fix was seconds late) may speed up as hard as the extrapolation
/// itself slows down, or it would fall ever further behind.
func navOSSCarPlayAccelerationLimit(behindMeters: Double, fixSpeed: Double) -> Double {
  guard behindMeters > navOSSCarPlayStoppedHoldMeters else {
    return navOSSCarPlayMaximumTrackingAcceleration
  }
  return max(
    navOSSCarPlayMaximumTrackingAcceleration, fixSpeed / navOSSCarPlayExtrapolationEaseOutSeconds)
}

func navOSSCarPlayLimitedAcceleration(_ acceleration: Double, limit: Double) -> Double {
  min(limit, max(-navOSSCarPlayMaximumTrackingAcceleration, acceleration))
}

/// The fastest the drawn vehicle may go while it catches up with a fix that came late: a little
/// faster than the car, never a dash.
func navOSSCarPlayCatchUpSpeed(_ fixSpeed: Double) -> Double {
  fixSpeed + max(3, 0.6 * fixSpeed)
}

private func navOSSCarPlaySnapLimit(speed: Double) -> Double {
  max(navOSSCarPlaySnapMinimumMeters, navOSSCarPlaySnapSeconds * speed)
}

private let navOSSCarPlayMetresPerDegreeLatitude = 111_320.0

/// Planar offset in metres (east, north) from `origin` to `coordinate`, with the same local metre
/// conversion as the route helpers.
func navOSSCarPlayOffsetMeters(
  from origin: NavOSSCarPlayCoordinate,
  to coordinate: NavOSSCarPlayCoordinate
) -> (east: Double, north: Double) {
  let longitudeScale = navOSSCarPlayMetresPerDegreeLatitude * cos(origin.latitude * .pi / 180)
  return (
    (coordinate.longitude - origin.longitude) * longitudeScale,
    (coordinate.latitude - origin.latitude) * navOSSCarPlayMetresPerDegreeLatitude
  )
}

func navOSSCarPlayOffsetCoordinate(
  _ origin: NavOSSCarPlayCoordinate,
  by offset: (east: Double, north: Double)
) -> NavOSSCarPlayCoordinate {
  let longitudeScale = navOSSCarPlayMetresPerDegreeLatitude * cos(origin.latitude * .pi / 180)
  return NavOSSCarPlayCoordinate(
    latitude: origin.latitude + offset.north / navOSSCarPlayMetresPerDegreeLatitude,
    longitude: origin.longitude + offset.east / longitudeScale
  )
}

private func navOSSCarPlayValidCourse(_ degrees: Double?) -> Double? {
  guard let degrees, degrees.isFinite, (0..<360).contains(degrees) else { return nil }
  return degrees
}

private func navOSSCarPlayInterpolatedCourse(from: Double?, to: Double?, progress: Double) -> Double? {
  guard let target = to else { return from }
  guard let start = from else { return target }
  let delta = (target - start + 540).truncatingRemainder(dividingBy: 360) - 180
  return (start + delta * progress + 360).truncatingRemainder(dividingBy: 360)
}
