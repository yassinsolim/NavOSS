import Foundation

@testable import NavOSSNavigationCore

// Replays a drive through `NavOSSCarPlayVehicleMotion` the way the CarPlay map feeds it: fixes at
// realistic, jittery times with GPS noise, and a 60 fps display link in between. Each frame records
// where the vehicle is drawn and where the follow camera points, measured against the true drive.

/// Deterministic generator (SplitMix64), so a replay is the same on every run and every machine.
struct ReplayRandom {
  private var state: UInt64
  init(seed: UInt64) { state = seed }
  mutating func next() -> Double {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    z ^= z >> 31
    return Double(z >> 11) / Double(1 << 53)
  }
  mutating func uniform(_ low: Double, _ high: Double) -> Double { low + (high - low) * next() }
  mutating func normal() -> Double {
    let u = max(1e-12, next())
    return sqrt(-2 * log(u)) * cos(2 * .pi * next())
  }
}

/// Local plane around Calgary in metres (x east, y north), with the same metre conversion as the
/// route helpers.
enum ReplayPlane {
  static let originLatitude = 51.04
  static let originLongitude = -114.07
  static let latitudeScale = 111_320.0
  static var longitudeScale: Double { latitudeScale * cos(originLatitude * .pi / 180) }

  static func coordinate(_ x: Double, _ y: Double) -> NavOSSCarPlayCoordinate {
    NavOSSCarPlayCoordinate(
      latitude: originLatitude + y / latitudeScale,
      longitude: originLongitude + x / longitudeScale)
  }

  static func point(_ coordinate: NavOSSCarPlayCoordinate) -> (x: Double, y: Double) {
    (
      (coordinate.longitude - originLongitude) * longitudeScale,
      (coordinate.latitude - originLatitude) * latitudeScale
    )
  }
}

/// A road as a planar polyline, measured along its length.
struct ReplayRoad {
  let points: [(x: Double, y: Double)]
  let cumulative: [Double]

  init(_ points: [(x: Double, y: Double)]) {
    self.points = points
    var lengths = [0.0]
    for index in points.indices.dropFirst() {
      lengths.append(
        lengths[index - 1]
          + hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y))
    }
    cumulative = lengths
  }

  var length: Double { cumulative.last ?? 0 }
  var geometry: [NavOSSCarPlayCoordinate] { points.map { ReplayPlane.coordinate($0.x, $0.y) } }

  /// The point `distance` along the road and the road's bearing there (degrees from north).
  func point(at distance: Double) -> (x: Double, y: Double, bearing: Double) {
    let clamped = min(max(distance, 0), length)
    var index = 0
    while index < points.count - 2, cumulative[index + 1] < clamped { index += 1 }
    let start = points[index]
    let end = points[index + 1]
    let segment = max(1e-9, cumulative[index + 1] - cumulative[index])
    let fraction = (clamped - cumulative[index]) / segment
    var bearing = atan2(end.x - start.x, end.y - start.y) * 180 / .pi
    if bearing < 0 { bearing += 360 }
    return (
      start.x + (end.x - start.x) * fraction, start.y + (end.y - start.y) * fraction, bearing
    )
  }

  /// Distance from a point to the nearest part of the road, and how far along the road that is.
  func nearest(_ x: Double, _ y: Double) -> (offset: Double, along: Double) {
    var best = (offset: Double.infinity, along: 0.0)
    for index in points.indices.dropLast() {
      let start = points[index]
      let end = points[index + 1]
      let dx = end.x - start.x
      let dy = end.y - start.y
      let squared = dx * dx + dy * dy
      let fraction = squared == 0 ? 0 : min(1, max(0, ((x - start.x) * dx + (y - start.y) * dy) / squared))
      let offset = hypot(start.x + fraction * dx - x, start.y + fraction * dy - y)
      if offset < best.offset {
        best = (offset, cumulative[index] + (cumulative[index + 1] - cumulative[index]) * fraction)
      }
    }
    return best
  }
}

/// Speed over time as phases of constant acceleration.
struct ReplayProfile {
  /// (seconds, acceleration in m/s²)
  let phases: [(duration: Double, acceleration: Double)]
  let initialSpeed: Double

  var duration: Double { phases.reduce(0) { $0 + $1.duration } }

  /// Distance travelled and speed at `time`.
  func state(at time: Double) -> (distance: Double, speed: Double) {
    var remaining = max(0, time)
    var distance = 0.0
    var speed = initialSpeed
    for phase in phases {
      let step = min(remaining, phase.duration)
      distance += speed * step + 0.5 * phase.acceleration * step * step
      speed = max(0, speed + phase.acceleration * step)
      remaining -= step
      if remaining <= 0 { break }
    }
    distance += speed * remaining
    return (distance, speed)
  }
}

struct ReplayScenario {
  let name: String
  /// The road the car drives.
  let road: ReplayRoad
  let profile: ReplayProfile
  let seed: UInt64
  /// The route guidance follows, when the car leaves it; nil: the car drives the route.
  var route: ReplayRoad? = nil

  var guidanceRoute: ReplayRoad { route ?? road }
}

enum ReplayMode: String {
  /// Guidance: the matched position on the route, the route's bearing as course, GPS speed.
  case guidance
  /// Guidance with the service republishing the same matched fix whenever the compass moves 3°.
  case guidanceWithCompass = "guidance+compass"
  /// Free drive: the raw fix, its course only above 2.5 m/s (else the last one), GPS speed.
  case freeDrive = "free-drive"
  /// Guidance with what else the navigation service publishes: about one fix in ten rejected by
  /// the matcher (published as the previous matched position with the new fix's speed and no
  /// run-on), and in gaps of 2.5 s or more the clock's dead-reckoned positions once a second.
  case guidanceWithHeldAndClock = "guidance+held+clock"
}

struct ReplayFrame {
  let time: Double
  let truthX: Double
  let truthY: Double
  let truthSpeed: Double
  let drawnX: Double
  let drawnY: Double
  let drawnSpeed: Double
  let cameraHeading: Double
  /// Seconds since the latest new fix arrived.
  let sinceFix: Double
  /// Whether the latest fix reported the vehicle stopped.
  let fixStopped: Bool
  /// Whether `advance` said another frame would move the vehicle (the display link keeps running).
  let moving: Bool
  /// After the last publication of the drive: the true car still moves, nothing says so.
  let afterLastFix: Bool
}

struct ReplayFix {
  /// When it is published and received; the wall clock then reads the same.
  let time: Double
  let position: NavOSSCarPlayPosition
  /// A compass-only, held or dead-reckoned publication, not a new accepted fix.
  let isRepublish: Bool
}

enum MotionReplay {
  static let frameRate = 60.0
  /// Beyond this distance from the route a fix is off it: published raw.
  static let offRouteMeters = 30.0

  /// Fix times one second apart with ±200 ms jitter and, with `gaps`, now and then a 2–3 s gap.
  static func fixTimes(duration: Double, gaps: Bool, random: inout ReplayRandom) -> [Double] {
    var times: [Double] = [0]
    while let last = times.last, last < duration {
      var interval = random.uniform(0.8, 1.2)
      if random.next() < 0.08, gaps { interval += random.uniform(1, 2) }
      times.append(last + interval)
    }
    return times.filter { $0 <= duration }
  }

  static func fixes(for scenario: ReplayScenario, mode: ReplayMode, gaps: Bool = true) -> [ReplayFix] {
    var random = ReplayRandom(seed: scenario.seed)
    let route = scenario.guidanceRoute
    let road = scenario.road
    let times = fixTimes(duration: scenario.profile.duration, gaps: gaps, random: &random)
    // GPS error is correlated from one second to the next: AR(1), 3 m standard deviation.
    let sigma = 3.0
    let rho = 0.8
    var errorX = random.normal() * sigma
    var errorY = random.normal() * sigma
    var lastCourse: Double?
    var fixes: [ReplayFix] = []
    for time in times {
      errorX = rho * errorX + sqrt(1 - rho * rho) * sigma * random.normal()
      errorY = rho * errorY + sqrt(1 - rho * rho) * sigma * random.normal()
      let state = scenario.profile.state(at: time)
      let truth = road.point(at: state.distance)
      let rawX = truth.x + errorX
      let rawY = truth.y + errorY
      let speed = state.speed == 0 ? 0 : max(0, state.speed + 0.2 * random.normal())
      let runOn = NavOSSCarPlayRunOn(fixTimestamp: time, speedMetersPerSecond: speed)
      let position: NavOSSCarPlayPosition
      switch mode {
      case .guidance, .guidanceWithCompass, .guidanceWithHeldAndClock:
        if mode == .guidanceWithHeldAndClock, let previous = fixes.last(where: { !$0.isRepublish }) {
          // The clock's dead reckoning through a gap: from the last accepted fix at its speed,
          // once a second from 2.5 s, with no run-on of its own.
          let gap = time - previous.time
          if gap >= 3.5, let previousSpeed = previous.position.runOn?.speedMetersPerSecond,
            previousSpeed >= 3
          {
            let start = ReplayPlane.point(previous.position.coordinate)
            let startAlong = route.nearest(start.x, start.y).along
            var at = previous.time + 2.5
            while at < time {
              let point = route.point(at: startAlong + min(400, previousSpeed * (at - previous.time)))
              fixes.append(
                ReplayFix(
                  time: at,
                  position: NavOSSCarPlayPosition(
                    coordinate: ReplayPlane.coordinate(point.x, point.y),
                    courseDegrees: point.bearing, speedMetersPerSecond: previousSpeed,
                    isHeld: true),
                  isRepublish: true))
              at += 1
            }
          }
          if random.next() < 0.1 {
            // Rejected by the matcher: the previous matched position, this fix's speed.
            fixes.append(
              ReplayFix(
                time: time,
                position: NavOSSCarPlayPosition(
                  coordinate: previous.position.coordinate,
                  courseDegrees: previous.position.courseDegrees,
                  compassHeadingDegrees: truth.bearing, speedMetersPerSecond: speed,
                  isHeld: true),
                isRepublish: true))
            continue
          }
        }
        let nearest = route.nearest(rawX, rawY)
        if nearest.offset > Self.offRouteMeters {
          // Off the route: the raw fix, fresh, with its own speed, never carried on.
          position = NavOSSCarPlayPosition(
            coordinate: ReplayPlane.coordinate(rawX, rawY),
            courseDegrees: speed >= navOSSCarPlayFreeDriveCourseMinimumSpeedMetersPerSecond
              ? truth.bearing : fixes.last?.position.courseDegrees,
            compassHeadingDegrees: truth.bearing,
            speedMetersPerSecond: speed)
          fixes.append(ReplayFix(time: time, position: position, isRepublish: false))
          continue
        }
        let matched = route.point(at: nearest.along)
        position = NavOSSCarPlayPosition(
          coordinate: ReplayPlane.coordinate(matched.x, matched.y),
          courseDegrees: matched.bearing,
          compassHeadingDegrees: truth.bearing,
          speedMetersPerSecond: speed,
          runOn: runOn)
      case .freeDrive:
        if speed >= navOSSCarPlayFreeDriveCourseMinimumSpeedMetersPerSecond {
          var course = truth.bearing + 3 * random.normal()
          course = (course + 360).truncatingRemainder(dividingBy: 360)
          lastCourse = course
        }
        position = NavOSSCarPlayPosition(
          coordinate: ReplayPlane.coordinate(rawX, rawY),
          courseDegrees: lastCourse,
          speedMetersPerSecond: speed,
          runOn: runOn)
      }
      fixes.append(ReplayFix(time: time, position: position, isRepublish: false))
      if mode == .guidanceWithCompass {
        // A phone in a moving car turns its compass by 3° several times a second; each turn
        // republishes the unchanged matched fix with the new compass heading.
        var republishAt = time + random.uniform(0.1, 0.5)
        var compass = position.compassHeadingDegrees ?? 0
        while republishAt < time + 0.8 {
          compass = (compass + random.uniform(-6, 6) + 360).truncatingRemainder(dividingBy: 360)
          fixes.append(
            ReplayFix(
              time: republishAt,
              position: NavOSSCarPlayPosition(
                coordinate: position.coordinate, courseDegrees: position.courseDegrees,
                compassHeadingDegrees: compass,
                speedMetersPerSecond: position.speedMetersPerSecond, runOn: position.runOn),
              isRepublish: true))
          republishAt += random.uniform(0.2, 0.6)
        }
      }
    }
    return fixes.sorted { $0.time < $1.time }
  }

  /// Runs the replay: fixes in order, a frame every 1/60 s, the camera eased like `follow`.
  static func run(
    _ scenario: ReplayScenario,
    mode: ReplayMode,
    fixes overrideFixes: [ReplayFix]? = nil,
    until endTime: Double? = nil
  ) -> [ReplayFrame] {
    let fixes = overrideFixes ?? self.fixes(for: scenario, mode: mode)
    var motion = NavOSSCarPlayVehicleMotion()
    let followsRoad = mode != .freeDrive
    motion.followsRoad = followsRoad
    motion.routePath = NavOSSCarPlayRoutePath(followsRoad ? scenario.guidanceRoute.geometry : [])
    var frames: [ReplayFrame] = []
    var nextFix = 0
    var cameraHeading = Double.nan
    var lastCourse: Double?
    var previous: (x: Double, y: Double)?
    var lastNewFixAt = 0.0
    var lastFixStopped = false
    let lastFixTime = fixes.last?.time ?? 0
    // Long enough after the last publication for the vehicle to come to rest.
    let end = endTime ?? lastFixTime + 5
    let dt = 1 / frameRate
    var frameIndex = 0
    while true {
      let time = Double(frameIndex) * dt
      if time > end { break }
      while nextFix < fixes.count, fixes[nextFix].time <= time {
        let fix = fixes[nextFix]
        motion.receive(fix.position, at: fix.time, wallClock: fix.time)
        if !fix.isRepublish {
          lastNewFixAt = fix.time
        }
        lastFixStopped = (fix.position.speedMetersPerSecond ?? 1) < 0.5
        nextFix += 1
      }
      frameIndex += 1
      guard motion.target != nil else { continue }
      let moving = motion.advance(to: time)
      guard let drawn = motion.drawn else { continue }
      let point = ReplayPlane.point(drawn.coordinate)
      let speed = previous.map { hypot(point.x - $0.x, point.y - $0.y) / dt } ?? 0
      previous = (point.x, point.y)
      if let course = drawn.courseDegrees { lastCourse = course }
      let targetHeading = lastCourse ?? (cameraHeading.isFinite ? cameraHeading : 0)
      cameraHeading =
        cameraHeading.isFinite
        ? navOSSCarPlaySmoothedBearing(
          cameraHeading, toward: targetHeading, elapsedSeconds: dt,
          timeConstantSeconds: navOSSCarPlayCameraHeadingTimeConstantSeconds)
        : targetHeading
      let truthState = scenario.profile.state(at: time)
      let truth = scenario.road.point(at: truthState.distance)
      frames.append(
        ReplayFrame(
          time: time, truthX: truth.x, truthY: truth.y, truthSpeed: truthState.speed,
          drawnX: point.x, drawnY: point.y, drawnSpeed: speed, cameraHeading: cameraHeading,
          sinceFix: time - lastNewFixAt, fixStopped: lastFixStopped, moving: moving,
          afterLastFix: time > lastFixTime + 0.5))
    }
    return frames
  }
}

/// The numbers reported per scenario.
struct ReplayMetrics {
  let frames: Int
  /// Share of frames where the vehicle truly moves faster than 1 m/s but is drawn standing
  /// (under 0.3 m/s).
  let standingWhileMovingShare: Double
  /// The same, counting only frames within 1.3 s of a fix: standing there is a stall between
  /// fixes, not the bounded wait for a fix that is seconds late.
  let standingBetweenFixesShare: Double
  /// Frame-to-frame change of drawn speed, m/s per frame at 60 fps.
  let speedStepP99: Double
  let speedStepMax: Double
  /// Camera heading rate, degrees per second.
  let headingRateP99: Double
  let headingRateMax: Double
  /// Distance between drawn and true position, metres.
  let lagMean: Double
  let lagMax: Double
  /// Farthest the drawn vehicle strays from the road, metres.
  let offRoadMax: Double
  /// Drawn travel while the latest fix says stopped, from 0.1 s after that fix, metres.
  let movementWhileStopped: Double
  /// Share of frames, a second or more after a fix saying the car is stopped, in which the render
  /// loop still wants another frame.
  let parkedStillRunningShare: Double
  /// Seconds from the last publication until the render loop settles for good (99: never).
  let settleAfterLastFixSeconds: Double

  init(_ frames: [ReplayFrame], road: ReplayRoad, warmUpSeconds: Double = 3) {
    let parked = frames.filter { $0.fixStopped && $0.sinceFix >= 1 && !$0.afterLastFix }
    parkedStillRunningShare =
      parked.isEmpty ? 0 : Double(parked.filter(\.moving).count) / Double(parked.count)
    let lastFixTime = (frames.first { $0.afterLastFix }?.time ?? frames.last?.time ?? 0) - 0.5
    if let lastMoving = frames.last(where: \.moving) {
      settleAfterLastFixSeconds =
        lastMoving.time == frames.last?.time ? 99 : max(0, lastMoving.time - lastFixTime)
    } else {
      settleAfterLastFixSeconds = 0
    }
    let measured = frames.filter { $0.time >= warmUpSeconds && !$0.afterLastFix }
    self.frames = measured.count
    let moving = measured.filter { $0.truthSpeed > 1 }
    standingWhileMovingShare =
      moving.isEmpty ? 0 : Double(moving.filter { $0.drawnSpeed < 0.3 }.count) / Double(moving.count)
    let regular = moving.filter { $0.sinceFix <= navOSSCarPlayExtrapolationFullSpeedSeconds }
    standingBetweenFixesShare =
      regular.isEmpty ? 0 : Double(regular.filter { $0.drawnSpeed < 0.3 }.count) / Double(regular.count)
    var steps: [Double] = []
    var rates: [Double] = []
    var stoppedTravel = 0.0
    for (previous, frame) in zip(measured, measured.dropFirst()) {
      steps.append(abs(frame.drawnSpeed - previous.drawnSpeed))
      let delta = abs(
        (frame.cameraHeading - previous.cameraHeading + 540).truncatingRemainder(dividingBy: 360)
          - 180)
      rates.append(delta / (frame.time - previous.time))
      if frame.fixStopped, frame.sinceFix >= 0.1 {
        stoppedTravel += hypot(frame.drawnX - previous.drawnX, frame.drawnY - previous.drawnY)
      }
    }
    func percentile(_ values: [Double], _ p: Double) -> Double {
      let sorted = values.sorted()
      guard !sorted.isEmpty else { return 0 }
      return sorted[min(sorted.count - 1, Int((Double(sorted.count - 1) * p).rounded()))]
    }
    speedStepP99 = percentile(steps, 0.99)
    speedStepMax = steps.max() ?? 0
    headingRateP99 = percentile(rates, 0.99)
    headingRateMax = rates.max() ?? 0
    let lags = measured.map { hypot($0.drawnX - $0.truthX, $0.drawnY - $0.truthY) }
    lagMean = lags.isEmpty ? 0 : lags.reduce(0, +) / Double(lags.count)
    lagMax = lags.max() ?? 0
    offRoadMax = measured.map { road.nearest($0.drawnX, $0.drawnY).offset }.max() ?? 0
    movementWhileStopped = stoppedTravel
  }

  var json: [String: Double] {
    func round(_ value: Double, _ places: Double = 100) -> Double { (value * places).rounded() / places }
    return [
      "frames": Double(frames),
      "standingWhileMovingPct": round(standingWhileMovingShare * 100, 10),
      "standingBetweenFixesPct": round(standingBetweenFixesShare * 100, 10),
      "speedStepP99": round(speedStepP99),
      "speedStepMax": round(speedStepMax),
      "headingRateP99": round(headingRateP99, 10),
      "headingRateMax": round(headingRateMax, 10),
      "lagMean": round(lagMean, 10),
      "lagMax": round(lagMax, 10),
      "offRoadMax": round(offRoadMax),
      "movementWhileStopped": round(movementWhileStopped),
      "parkedStillRunningPct": round(parkedStillRunningShare * 100, 10),
      "settleAfterLastFixSeconds": round(settleAfterLastFixSeconds),
    ]
  }
}

enum ReplayScenarios {
  static func straight(_ name: String, speed: Double, seed: UInt64) -> ReplayScenario {
    ReplayScenario(
      name: name, road: ReplayRoad([(0, 0), (0, speed * 70 + 100)]),
      profile: ReplayProfile(phases: [(60, 0)], initialSpeed: speed), seed: seed)
  }

  /// City speed, braking to 18 km/h for a right-angle right turn, then away again.
  static var corner: ReplayScenario {
    // 140 m at 14 m/s, 42.75 m braking to 5 m/s, the corner 15 m into 30 m at 5 m/s.
    let cornerAt = 140 + 42.75 + 15
    return ReplayScenario(
      name: "corner-90", road: ReplayRoad([(0, 0), (0, cornerAt), (500, cornerAt)]),
      profile: ReplayProfile(
        phases: [(10, 0), (4.5, -2), (6, 0), (4.5, 2), (15, 0)], initialSpeed: 14), seed: 11)
  }

  /// A single-lane roundabout (15 m radius) entered from the south and left west, three quarters
  /// round, anticlockwise as in Canada.
  static var roundabout: ReplayScenario {
    var points: [(x: Double, y: Double)] = [(0, -215)]
    for step in 0...27 {
      let angle = (-90.0 + Double(step) * 10) * .pi / 180
      points.append((15 * cos(angle), 15 * sin(angle)))
    }
    points.append((-215, 0))
    // 12 m/s, braking to 7 m/s for the ring, then away.
    return ReplayScenario(
      name: "roundabout", road: ReplayRoad(points),
      profile: ReplayProfile(
        phases: [(12, 0), (2.5, -2), (11, 0), (3, 1.7), (12, 0)], initialSpeed: 12), seed: 23)
  }

  /// City speed, braking to a red light, 8 s stopped, pulling away.
  static var stopAndGo: ReplayScenario {
    ReplayScenario(
      name: "stop-and-go", road: ReplayRoad([(0, 0), (0, 900)]),
      profile: ReplayProfile(
        phases: [(10, 0), (5.6, -2.5), (8, 0), (7, 2), (12, 0)], initialSpeed: 14), seed: 37)
  }

  /// Stopped in a queue, then creeping 15 m forward at walking pace and stopping again, then away.
  static var queueCreep: ReplayScenario {
    ReplayScenario(
      name: "queue-creep", road: ReplayRoad([(0, 0), (0, 900)]),
      profile: ReplayProfile(
        phases: [(8, 0), (5.6, -2.5), (6, 0), (3, 1), (2, 0), (3, -1), (8, 0), (7, 2), (8, 0)],
        initialSpeed: 14),
      seed: 41)
  }

  /// A missed turn: the route turns right 60 m ahead, the driver carries straight on and stops
  /// about 65 m past the turn, off the route, then drives on.
  static var offRouteStop: ReplayScenario {
    ReplayScenario(
      name: "off-route-stop", road: ReplayRoad([(0, 0), (0, 600)]),
      profile: ReplayProfile(
        phases: [(8, 0), (4.8, -2.5), (8, 0), (6, 2), (6, 0)], initialSpeed: 12),
      seed: 43, route: ReplayRoad([(0, 0), (0, 60), (600, 60)]))
  }

  static var all: [ReplayScenario] {
    [
      straight("straight-crawl-7kmh", speed: 2, seed: 3),
      straight("straight-city-50kmh", speed: 14, seed: 5),
      straight("straight-highway-100kmh", speed: 28, seed: 7),
      corner, roundabout, stopAndGo, queueCreep, offRouteStop,
    ]
  }
}
