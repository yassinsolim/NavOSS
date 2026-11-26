import Foundation
import XCTest

@testable import NavOSSNavigationCore

/// Randomized sequences of every kind of publication the CarPlay map receives, checked against the
/// rules the drawn vehicle must keep whatever the order: example tests each cover one combination
/// of publication kind and drawn state, and the bugs found in review were the combinations none of
/// them happened to cover.
final class CarPlayMotionInvariantTests: XCTestCase {
  /// North 400 m, a right-angle right turn, east 400 m to the destination.
  private let route = ReplayRoad([(0, 0), (0, 400), (400, 400)])
  private let turnAt = 400.0
  private var destination: Double { route.length }
  private let frameRate = 30.0
  /// What the navigation core lets an accepted fix run on to: short of the next maneuver (by the
  /// session's dead-reckoning margin) and of arrival, never behind the fix itself.
  private func coreLimit(along: Double) -> Double {
    var limit = destination * arrivalProgressThreshold
    if along < turnAt { limit = min(limit, turnAt - NavigationSession.deadReckoningManeuverMarginMeters) }
    return max(along, limit)
  }

  private enum Kind: CaseIterable {
    case accepted, stopped, offRoute, held, clock, compass, cached, future
  }

  private struct Publication {
    let position: NavOSSCarPlayPosition
    let kind: Kind
    let time: Double
  }

  private struct Run {
    var motion = NavOSSCarPlayVehicleMotion()
    var time = 0.0
    /// The furthest along the route the drawn vehicle may be from what it has been told so far.
    var allowedAlong = 0.0
    var lastPublicationAt = 0.0
    var failures: [String] = []
    /// Where along the full route the active route starts (a reroute from a point on it).
    var routeStart = 0.0
    /// Free drive: no route to follow and no route limits to check.
    var freeDrive = false
  }

  private func point(_ x: Double, _ y: Double) -> NavOSSCarPlayCoordinate {
    ReplayPlane.coordinate(x, y)
  }

  /// A point `offset` metres to the left of the route at `along` (off it when 50 m).
  private func routePoint(_ along: Double, offset: Double = 0) -> (NavOSSCarPlayCoordinate, Double) {
    let p = route.point(at: along)
    let left = (p.bearing + 270) * .pi / 180
    return (point(p.x + offset * sin(left), p.y + offset * cos(left)), p.bearing)
  }

  private func drawnPoint(_ run: Run) -> (x: Double, y: Double)? {
    run.motion.drawn.map { ReplayPlane.point($0.coordinate) }
  }

  /// Advances frames up to `end`, checking that the vehicle never passes what it was allowed.
  private func advance(_ run: inout Run, to end: Double, seed: UInt64, phase: String) -> [Bool] {
    var moving: [Bool] = []
    while run.time + 1 / frameRate <= end + 1e-9 {
      run.time += 1 / frameRate
      moving.append(run.motion.advance(to: run.time))
      guard !run.freeDrive, let drawn = drawnPoint(run) else { continue }
      let nearest = route.nearest(drawn.x, drawn.y)
      if nearest.offset < 0.5, nearest.along > run.allowedAlong + 0.2 {
        run.failures.append(
          "seed \(seed) \(phase) t=\(run.time): drawn \(nearest.along) m along, allowed \(run.allowedAlong)")
      }
    }
    return moving
  }

  private func receive(_ run: inout Run, _ publication: Publication) {
    let drawnAlong = drawnPoint(run).map { route.nearest($0.x, $0.y) }
    let point = ReplayPlane.point(publication.position.coordinate)
    let nearest = route.nearest(point.x, point.y)
    // Only a fresh accepted fix (moving or stopped) may take the car further along: held,
    // clock, compass, cached, future-dated and off-route positions never raise the limit.
    let fresh = publication.position.runOn.map {
      let age = publication.time - $0.fixTimestamp
      return age >= 0 && age <= 2
    } == true
    if run.motion.drawn == nil, nearest.offset < 1 {
      // The first position is drawn where it is, whatever it is: there is nothing else to draw.
      run.allowedAlong = max(run.allowedAlong, nearest.along)
    }
    if run.freeDrive, nearest.offset < 1, fresh,
      publication.kind == .accepted || publication.kind == .stopped,
      let runOn = publication.position.runOn
    {
      // Received in free drive: no route limits, only its own run-on (it may be resolved on the
      // route once guidance resumes).
      let from = max(nearest.along, drawnAlong.map { $0.offset < 0.5 ? $0.along : 0 } ?? 0)
      run.allowedAlong = max(
        run.allowedAlong,
        from + runOn.speedMetersPerSecond * navOSSCarPlayExtrapolationReachSeconds + 0.5)
    }
    if !run.freeDrive, nearest.offset < 1, fresh,
      publication.kind == .accepted || publication.kind == .stopped
    {
      run.allowedAlong = max(run.allowedAlong, nearest.along)
      if let runOn = publication.position.runOn, publication.kind == .accepted {
        let from = max(nearest.along, drawnAlong.map { $0.offset < 0.5 ? $0.along : 0 } ?? 0)
        run.allowedAlong = max(
          run.allowedAlong,
          min(
            from + runOn.speedMetersPerSecond * navOSSCarPlayExtrapolationReachSeconds + 0.5,
            coreLimit(along: nearest.along)))
      }
    }
    run.motion.receive(publication.position, at: publication.time, wallClock: publication.time)
    run.lastPublicationAt = publication.time
  }

  /// A random drive: mostly accepted fixes, with every other kind mixed in, at jittered and
  /// sometimes long or very short intervals.
  private func randomDrive(_ run: inout Run, random: inout ReplayRandom, seed: UInt64) {
    var truthAlong = random.uniform(0, 300)
    var truthSpeed = random.uniform(0, 20)
    var last: NavOSSCarPlayPosition?
    var lastAccepted: (along: Double, speed: Double, time: Double, coordinate: NavOSSCarPlayCoordinate)?
    for _ in 0..<30 {
      // Now and then a new route (the same road again, or the rest of it from behind the car), or
      // a switch to free drive and back.
      let change = random.next()
      if change < 0.05, !run.freeDrive {
        let drawnAlong = drawnPoint(run).map { route.nearest($0.x, $0.y).along } ?? 0
        // A new route starts where the car was last matched, or behind it.
        let lastMatched = min(drawnAlong, truthAlong, lastAccepted?.along ?? 0)
        run.routeStart = random.next() < 0.5 ? 0 : max(0, lastMatched - random.uniform(0, 40))
        let geometry = activeGeometry(from: run.routeStart)
        run.motion.routePath = NavOSSCarPlayRoutePath(geometry)
      } else if change < 0.09 {
        setFreeDrive(&run, !run.freeDrive)
      }
      let draw = random.next()
      let gap = draw < 0.1 ? random.uniform(2, 3.5) : draw < 0.25 ? random.uniform(0.1, 0.4) : random.uniform(0.8, 1.2)
      let time = run.time + gap
      truthSpeed = random.next() < 0.15 ? 0 : min(20, max(0, truthSpeed + 3 * random.normal()))
      truthAlong = min(destination - 10, truthAlong + truthSpeed * gap)
      let weights: [(Kind, Double)] = [
        (.accepted, 0.45), (.stopped, 0.1), (.offRoute, 0.08), (.held, 0.1), (.clock, 0.07),
        (.compass, 0.12), (.cached, 0.04), (.future, 0.04),
      ]
      var pick = random.next()
      var kind = Kind.accepted
      for (candidate, weight) in weights {
        if pick < weight { kind = candidate; break }
        pick -= weight
      }
      let position: NavOSSCarPlayPosition
      switch kind {
      case .accepted, .stopped, .cached, .future:
        let along = min(destination, max(0, truthAlong + random.uniform(-2, 2)))
        let speed = kind == .stopped ? 0 : truthSpeed
        let taken = kind == .cached ? time - random.uniform(5, 30) : kind == .future ? time + random.uniform(5, 3_600) : time
        let (coordinate, bearing) = routePoint(along)
        position = NavOSSCarPlayPosition(
          coordinate: coordinate, courseDegrees: bearing, speedMetersPerSecond: speed,
          runOn: NavOSSCarPlayRunOn(
            fixTimestamp: taken, speedMetersPerSecond: speed,
            limitProgress: run.freeDrive
              ? nil
              : (coreLimit(along: along) - run.routeStart) / (destination - run.routeStart)),
          source: .fix(capturedAt: taken))
        if kind == .accepted || kind == .stopped {
          lastAccepted = (along, speed, time, coordinate)
        }
      case .offRoute:
        let (coordinate, bearing) = routePoint(truthAlong, offset: 50)
        position = NavOSSCarPlayPosition(
          coordinate: coordinate, courseDegrees: bearing, speedMetersPerSecond: truthSpeed,
          source: .fix(capturedAt: time))
      case .held:
        let (coordinate, bearing) =
          lastAccepted.map { ($0.coordinate, routePoint($0.along).1) } ?? routePoint(truthAlong)
        position = NavOSSCarPlayPosition(
          coordinate: coordinate, courseDegrees: bearing,
          speedMetersPerSecond: random.uniform(0, 20), source: .held(capturedAt: time))
      case .clock:
        guard let accepted = lastAccepted else { continue }
        let along = min(
          coreLimit(along: accepted.along), accepted.along + accepted.speed * (time - accepted.time))
        let (coordinate, bearing) = routePoint(along)
        position = NavOSSCarPlayPosition(
          coordinate: coordinate, courseDegrees: bearing,
          speedMetersPerSecond: accepted.speed, source: .held(capturedAt: nil))
      case .compass:
        guard let last else { continue }
        position = navOSSCarPlayPositionApplyingCompassHeading(random.uniform(0, 359), to: last)!
      }
      _ = advance(&run, to: time, seed: seed, phase: "drive")
      receive(&run, Publication(position: position, kind: kind, time: time))
      last = position
    }
  }

  /// The route from `start` metres along it to the destination.
  private func activeGeometry(from start: Double) -> [NavOSSCarPlayCoordinate] {
    guard start > 0 else { return route.geometry }
    let first = route.point(at: start)
    let rest = route.points.enumerated().filter { route.cumulative[$0.offset] > start }.map(\.element)
    return ([(first.x, first.y)] + rest).map { ReplayPlane.coordinate($0.x, $0.y) }
  }

  private func setFreeDrive(_ run: inout Run, _ freeDrive: Bool) {
    run.freeDrive = freeDrive
    run.motion.followsRoad = !freeDrive
    run.motion.routePath = NavOSSCarPlayRoutePath(freeDrive ? [] : activeGeometry(from: run.routeStart))
    if !freeDrive, let drawn = drawnPoint(run) {
      // Back in guidance wherever free drive left the car.
      run.allowedAlong = max(run.allowedAlong, route.nearest(drawn.x, drawn.y).along)
    }
  }

  /// No publications for a while: the render loop must stop within 12 s of the last one (the
  /// longest glide is 30 m at 3 m/s).
  private func checkSettles(_ run: inout Run, seed: UInt64, phase: String) {
    let since = run.lastPublicationAt
    _ = advance(&run, to: since + 12, seed: seed, phase: phase)
    let after = advance(&run, to: since + 14, seed: seed, phase: phase)
    if after.contains(true) {
      run.failures.append("seed \(seed) \(phase): render loop still running 12 s after the last publication")
    }
  }

  func testRandomPublicationSequencesKeepTheRules() {
    var failures: [String] = []
    var found: [String: Int] = [:]
    for seed in UInt64(1)...300 {
      var random = ReplayRandom(seed: seed)
      var run = Run()
      run.motion.followsRoad = true
      run.motion.routePath = NavOSSCarPlayRoutePath(route.geometry)
      randomDrive(&run, random: &random, seed: seed)
      if run.freeDrive { setFreeDrive(&run, false) }

      if seed % 3 == 0 {
        // (5) Arrival ends at the destination.
        let (coordinate, bearing) = routePoint(destination)
        let at = run.time + 1
        _ = advance(&run, to: at, seed: seed, phase: "arrival")
        receive(
          &run,
          Publication(
            position: NavOSSCarPlayPosition(
              coordinate: coordinate, courseDegrees: bearing, speedMetersPerSecond: 0,
              source: .arrival),
            kind: .held, time: at))
        run.allowedAlong = destination
        _ = advance(&run, to: at + 15, seed: seed, phase: "arrival")
        if let drawn = drawnPoint(run) {
          let end = route.point(at: destination)
          let off = hypot(drawn.x - end.x, drawn.y - end.y)
          if off > 0.5 { run.failures.append("seed \(seed) arrival: \(off) m from the destination"); found["arrival", default: 0] += 1 }
        }
        checkSettles(&run, seed: seed, phase: "arrival")
        failures += run.failures
        continue
      }

      if seed % 2 == 0 {
        // (4) Settles; then (1) publications that are not observations never move it.
        checkSettles(&run, seed: seed, phase: "settle")
        guard let standing = drawnPoint(run) else { continue }
        var last = run.motion.target
        for index in 0..<8 {
          let at = run.time + random.uniform(0.2, 1.5)
          let along = random.uniform(0, destination)
          let (coordinate, bearing) = routePoint(along)
          let kinds: [Kind] = [.held, .clock, .compass, .cached, .future]
          let kind = kinds[index % kinds.count]
          let speed = random.uniform(0, 20)
          let position: NavOSSCarPlayPosition
          switch kind {
          case .compass:
            guard let previous = last else { continue }
            position = navOSSCarPlayPositionApplyingCompassHeading(random.uniform(0, 359), to: previous)!
          case .cached, .future:
            let taken = kind == .cached ? at - random.uniform(5, 30) : at + random.uniform(5, 3_600)
            position = NavOSSCarPlayPosition(
              coordinate: coordinate, courseDegrees: bearing, speedMetersPerSecond: speed,
              runOn: NavOSSCarPlayRunOn(fixTimestamp: taken, speedMetersPerSecond: speed),
              source: .fix(capturedAt: taken))
          default:
            position = NavOSSCarPlayPosition(
              coordinate: coordinate, courseDegrees: bearing, speedMetersPerSecond: speed,
              source: .held(capturedAt: kind == .held ? at : nil))
          }
          _ = advance(&run, to: at, seed: seed, phase: "not observations")
          run.motion.receive(position, at: at, wallClock: at)
          run.lastPublicationAt = at
          last = position
          _ = advance(&run, to: at + 0.3, seed: seed, phase: "not observations")
          if let drawn = drawnPoint(run), hypot(drawn.x - standing.x, drawn.y - standing.y) > 0.01 {
            run.failures.append("seed \(seed): a \(kind) publication moved the standing car")
            found["moved by \(kind)", default: 0] += 1
            break
          }
        }
      }

      // (2) Fresh fixes that keep agreeing on a place bring the car there, standing or moving, on
      // or off the route.
      let offRoute = random.next() < 0.3
      let drawnAlong = drawnPoint(run).map { route.nearest($0.x, $0.y).along } ?? 0
      let targetAlong = min(destination - 1, max(1, drawnAlong + random.uniform(-15, 15)))
      let (target, bearing) = routePoint(targetAlong, offset: offRoute ? 50 : 0)
      let targetPoint = ReplayPlane.point(target)
      run.allowedAlong = max(run.allowedAlong, targetAlong)
      for _ in 0..<12 {
        let at = run.time + random.uniform(0.8, 1.2)
        let jitter = (x: random.uniform(-1, 1), y: random.uniform(-1, 1))
        _ = advance(&run, to: at, seed: seed, phase: "agreeing")
        receive(
          &run,
          Publication(
            position: NavOSSCarPlayPosition(
              coordinate: ReplayPlane.coordinate(targetPoint.x + jitter.x, targetPoint.y + jitter.y),
              courseDegrees: bearing, speedMetersPerSecond: 0,
              runOn: offRoute ? nil : NavOSSCarPlayRunOn(fixTimestamp: at, speedMetersPerSecond: 0),
              source: .fix(capturedAt: at)),
            kind: .stopped, time: at))
      }
      _ = advance(&run, to: run.time + 0.5, seed: seed, phase: "agreeing")
      if let drawn = drawnPoint(run) {
        let off = hypot(drawn.x - targetPoint.x, drawn.y - targetPoint.y)
        // Within the stopped hold (GPS wander is not followed) plus the fixes' own spread.
        if off > navOSSCarPlayStoppedHoldMeters + 1.5 {
          run.failures.append(
            "seed \(seed): \(off) m from where 12 agreeing fixes put the car (\(offRoute ? "off" : "on") route)")
          found["not reaching agreeing fixes", default: 0] += 1
        }
      }
      checkSettles(&run, seed: seed, phase: "after agreeing")
      failures += run.failures
    }
    XCTAssertTrue(failures.isEmpty, "\(failures.count) violations, \(found): \(failures.prefix(12))")
  }
}
