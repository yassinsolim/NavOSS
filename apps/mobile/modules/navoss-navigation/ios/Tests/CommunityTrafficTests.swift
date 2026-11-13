import Foundation
import XCTest

@testable import NavOSSNavigationCore

final class CommunityTrafficTests: XCTestCase {
  private let rules = NavOSSTrafficProbeRules()
  private let start = Date(timeIntervalSince1970: 1_794_500_000)

  // MARK: Helpers

  private func coordinate(_ latitude: Double, _ longitude: Double) -> NavOSSCarPlayCoordinate {
    NavOSSCarPlayCoordinate(latitude: latitude, longitude: longitude)
  }

  /// Moves `meters` from `origin` on `bearing` (small distances, local flat earth).
  private func offset(
    _ origin: NavOSSCarPlayCoordinate,
    north: Double,
    east: Double
  ) -> NavOSSCarPlayCoordinate {
    coordinate(
      origin.latitude + north / navigationMetersPerDegreeLatitude,
      origin.longitude
        + east / (navigationMetersPerDegreeLatitude * cos(origin.latitude * .pi / 180))
    )
  }

  private func distance(_ a: NavOSSCarPlayCoordinate, _ b: NavOSSCarPlayCoordinate) -> Double {
    navigationDistanceMeters(
      from: NavigationCoordinate(latitude: a.latitude, longitude: a.longitude),
      to: NavigationCoordinate(latitude: b.latitude, longitude: b.longitude)
    )
  }

  /// A fix every `interval` seconds at `speed` m/s along `path`, with optional stops.
  private func drive(
    _ path: [NavOSSCarPlayCoordinate],
    speed: Double = 14,
    interval: Double = 2,
    accuracy: Double = 6,
    startingAt time: Date? = nil
  ) -> [NavOSSTrafficFix] {
    var fixes: [NavOSSTrafficFix] = []
    var clock = time ?? start
    var carry = 0.0
    for index in 1..<path.count {
      let from = path[index - 1]
      let to = path[index]
      let length = distance(from, to)
      var along = carry
      while along < length {
        let share = along / length
        fixes.append(
          NavOSSTrafficFix(
            coordinate: coordinate(
              from.latitude + (to.latitude - from.latitude) * share,
              from.longitude + (to.longitude - from.longitude) * share
            ),
            horizontalAccuracyMeters: accuracy,
            timestamp: clock
          )
        )
        clock = clock.addingTimeInterval(interval)
        along += speed * interval
      }
      carry = along - length
    }
    fixes.append(
      NavOSSTrafficFix(coordinate: path[path.count - 1], horizontalAccuracyMeters: accuracy, timestamp: clock)
    )
    return fixes
  }

  private func run(
    _ fixes: [NavOSSTrafficFix],
    protectedPoints: [NavOSSCarPlayCoordinate]
  ) -> [NavOSSTrafficProbeBatch] {
    var collector = NavOSSTrafficProbeCollector(rules: rules, protectedPoints: protectedPoints)
    var batches: [NavOSSTrafficProbeBatch] = []
    for fix in fixes {
      batches += collector.ingest(fix)
    }
    collector.finish()
    return batches
  }

  private func emitted(_ batches: [NavOSSTrafficProbeBatch]) -> [NavOSSCarPlayCoordinate] {
    batches.flatMap { $0.points.map { coordinate($0.latitude, $0.longitude) } }
  }

  /// Every batch is one the strict server schema accepts.
  private func assertValid(_ batches: [NavOSSTrafficProbeBatch], file: StaticString = #filePath, line: UInt = #line) {
    for batch in batches {
      XCTAssertGreaterThanOrEqual(batch.points.count, rules.minPoints, file: file, line: line)
      XCTAssertLessThanOrEqual(batch.points.count, rules.maxPoints, file: file, line: line)
      XCTAssertEqual(batch.points.first?.offsetSeconds, 0, file: file, line: line)
      XCTAssertLessThanOrEqual(batch.points.last?.offsetSeconds ?? 0, rules.maxBatchSeconds, file: file, line: line)
      for (previous, next) in zip(batch.points, batch.points.dropFirst()) {
        let gap = next.offsetSeconds - previous.offsetSeconds
        XCTAssertTrue((1...rules.maxGapSeconds).contains(gap), "gap \(gap)", file: file, line: line)
      }
      XCTAssertEqual(batch.capturedAt.timeIntervalSince1970.truncatingRemainder(dividingBy: 60), 0, file: file, line: line)
      XCTAssertLessThanOrEqual(batch.capturedAt, batch.firstPointAt, file: file, line: line)
      XCTAssertGreaterThan(batch.capturedAt, batch.firstPointAt.addingTimeInterval(-60), file: file, line: line)
      for point in batch.points {
        XCTAssertEqual(point.latitude, navOSSRoundedToFiveDecimals(point.latitude), file: file, line: line)
        XCTAssertEqual(point.longitude, navOSSRoundedToFiveDecimals(point.longitude), file: file, line: line)
      }
    }
  }

  private func assertNothingWithin(
    _ meters: Double,
    of zones: [NavOSSCarPlayCoordinate],
    in batches: [NavOSSTrafficProbeBatch],
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    for point in emitted(batches) {
      for zone in zones {
        XCTAssertGreaterThanOrEqual(distance(point, zone), meters, file: file, line: line)
      }
    }
  }

  private let origin = NavOSSCarPlayCoordinate(latitude: 51.0447, longitude: -114.0719)

  // MARK: Trimming

  func testStraightTripTrimsBothEndsAndProducesValidBatches() {
    let destination = offset(origin, north: 0, east: 8_000)
    let batches = run(drive([origin, destination]), protectedPoints: [origin, destination])
    assertValid(batches)
    XCTAssertGreaterThan(batches.count, 5)
    assertNothingWithin(400, of: [origin, destination], in: batches)
    // Something between the trims was shared.
    let points = emitted(batches)
    XCTAssertTrue(points.contains { distance($0, origin) < 1_000 })
    XCTAssertTrue(points.contains { distance($0, destination) < 1_000 })
  }

  func testTheRealEndOfATripIsHeldBackEvenWhenItIsNotTheDestination() {
    let destination = offset(origin, north: 0, east: 20_000)
    // The driver stops navigating 6 km in, far from the planned destination.
    let actualEnd = offset(origin, north: 0, east: 6_000)
    let batches = run(drive([origin, actualEnd]), protectedPoints: [origin, destination])
    assertValid(batches)
    assertNothingWithin(400, of: [actualEnd], in: batches)
  }

  func testLoopTripReturningToItsOriginNeverSharesTheOriginZone() {
    // A square loop of 3 km sides that starts and ends at the origin.
    let path = [
      origin,
      offset(origin, north: 3_000, east: 0),
      offset(origin, north: 3_000, east: 3_000),
      offset(origin, north: 0, east: 3_000),
      origin,
    ]
    let batches = run(drive(path), protectedPoints: [origin, origin])
    assertValid(batches)
    XCTAssertFalse(batches.isEmpty)
    assertNothingWithin(400, of: [origin], in: batches)
  }

  func testOutAndBackTripProtectsTheTurnaroundStopAndTheHomeEnd() {
    let stop = offset(origin, north: 5_000, east: 1_000)
    let path = [origin, stop, origin]
    let batches = run(drive(path), protectedPoints: [origin, stop, origin])
    assertValid(batches)
    XCTAssertFalse(batches.isEmpty)
    assertNothingWithin(400, of: [origin, stop], in: batches)
  }

  func testATripThatPassesItsStartAgainMidwayNeverSharesItThere() {
    // Leaves westward, turns, drives back east straight through the start and beyond.
    let west = offset(origin, north: 0, east: -4_000)
    let east = offset(origin, north: 50, east: 6_000)
    let batches = run(drive([origin, west, east]), protectedPoints: [origin, east])
    assertValid(batches)
    XCTAssertFalse(batches.isEmpty)
    assertNothingWithin(400, of: [origin, east], in: batches)
  }

  func testTheFirstFixIsProtectedWhenTheRouteOriginIsElsewhere() {
    // The route was planned from home, but the fixes begin 2 km away (the phone was off).
    let firstFix = offset(origin, north: 2_000, east: 0)
    let destination = offset(firstFix, north: 0, east: 7_000)
    let batches = run(drive([firstFix, destination]), protectedPoints: [origin, destination])
    assertValid(batches)
    assertNothingWithin(400, of: [firstFix, origin, destination], in: batches)
  }

  func testTheFirstFixStaysProtectedWhenTheTripLoopsBackPastIt() {
    // Fixes begin away from the planned origin, circle the block, and pass the first fix again.
    let firstFix = offset(origin, north: 2_000, east: 0)
    let path = [
      firstFix,
      offset(firstFix, north: 1_500, east: 0),
      offset(firstFix, north: 1_500, east: 1_500),
      offset(firstFix, north: -1_500, east: 1_500),
      offset(firstFix, north: -1_500, east: 100),
      offset(firstFix, north: 3_000, east: 100),
    ]
    let destination = offset(firstFix, north: 6_000, east: 100)
    let batches = run(drive(path + [destination]), protectedPoints: [origin, destination])
    assertValid(batches)
    XCTAssertFalse(batches.isEmpty)
    assertNothingWithin(400, of: [firstFix], in: batches)
  }

  func testAStopAddedMidTripProtectsFixesStillHeldBack() {
    let destination = offset(origin, north: 0, east: 9_000)
    let stop = offset(origin, north: 0, east: 5_000)
    let fixes = drive([origin, destination])
    var collector = NavOSSTrafficProbeCollector(rules: rules, protectedPoints: [origin, destination])
    var batches: [NavOSSTrafficProbeBatch] = []
    for fix in fixes {
      // The driver adds the stop while about 300 m short of it.
      if abs(distance(fix.coordinate, stop) - 300) < 15, fix.coordinate.longitude < stop.longitude {
        collector.protect([stop])
      }
      batches += collector.ingest(fix)
    }
    assertValid(batches)
    assertNothingWithin(400, of: [stop], in: batches)
  }

  func testRandomTripsNeverEmitAPointInsideAnyTrimZone() {
    var generator = SeededGenerator(seed: 0x4e61764f5353)
    for _ in 0..<40 {
      var path = [origin]
      for _ in 0..<Int.random(in: 2...6, using: &generator) {
        path.append(
          offset(
            path[path.count - 1],
            north: Double.random(in: -4_000...4_000, using: &generator),
            east: Double.random(in: -4_000...4_000, using: &generator)
          )
        )
      }
      if Bool.random(using: &generator) { path.append(origin) }
      let destination = path[path.count - 1]
      let stops = Array(path.dropFirst().dropLast().shuffled(using: &generator).prefix(2))
      let zones = [origin, destination] + stops
      let batches = run(
        drive(path, speed: Double.random(in: 5...30, using: &generator)),
        protectedPoints: zones
      )
      assertValid(batches)
      assertNothingWithin(400, of: zones + [path[path.count - 1]], in: batches)
    }
  }

  func testServerAdvertisingASmallerTrimIsNotObeyed() {
    XCTAssertEqual(NavOSSTrafficProbeRules(tripEndTrimMeters: 100).tripEndTrimMeters, 400)
    XCTAssertEqual(NavOSSTrafficProbeRules(tripEndTrimMeters: 600).tripEndTrimMeters, 600)
  }

  // MARK: Sampling and batching

  func testInaccurateFixesAreNeverUploaded() {
    let destination = offset(origin, north: 0, east: 8_000)
    var fixes = drive([origin, destination])
    // Every third fix is poor; mark them by a distinctive accuracy.
    fixes = fixes.enumerated().map { index, fix in
      index % 3 == 0
        ? NavOSSTrafficFix(coordinate: fix.coordinate, horizontalAccuracyMeters: 40, timestamp: fix.timestamp)
        : fix
    }
    let poor = Set(
      fixes.filter { $0.horizontalAccuracyMeters > 25 }.map {
        "\(navOSSFiveDecimals($0.coordinate.latitude)),\(navOSSFiveDecimals($0.coordinate.longitude))"
      }
    )
    let batches = run(fixes, protectedPoints: [origin, destination])
    assertValid(batches)
    XCTAssertFalse(batches.isEmpty)
    for point in emitted(batches) {
      XCTAssertFalse(poor.contains("\(navOSSFiveDecimals(point.latitude)),\(navOSSFiveDecimals(point.longitude))"))
    }
  }

  func testFixesFasterThanTheSampleIntervalAreThinned() {
    let destination = offset(origin, north: 0, east: 6_000)
    let batches = run(drive([origin, destination], interval: 0.5), protectedPoints: [origin, destination])
    assertValid(batches)
    for batch in batches {
      for (previous, next) in zip(batch.points, batch.points.dropFirst()) {
        XCTAssertGreaterThanOrEqual(next.offsetSeconds - previous.offsetSeconds, 1)
      }
      XCTAssertLessThanOrEqual(batch.points.count, 31)
    }
  }

  func testBatchesCloseAtTargetTimeAndDistance() {
    let destination = offset(origin, north: 0, east: 12_000)
    let batches = run(drive([origin, destination], speed: 20), protectedPoints: [origin, destination])
    assertValid(batches)
    // At 20 m/s, 600 m takes 30 s, so the 60 s target closes each batch at about 30 points.
    for batch in batches.dropLast() {
      XCTAssertGreaterThanOrEqual(batch.points.last?.offsetSeconds ?? 0, 60)
      XCTAssertLessThanOrEqual(batch.points.last?.offsetSeconds ?? 0, 62)
    }
  }

  func testAGapLongerThanFifteenSecondsSplitsTheBatch() {
    let destination = offset(origin, north: 0, east: 8_000)
    var fixes = drive([origin, destination])
    // A 40 s outage halfway (a tunnel).
    let middle = fixes.count / 2
    fixes = fixes.enumerated().compactMap { index, fix in
      if (middle..<(middle + 20)).contains(index) { return nil }
      return fix
    }
    let batches = run(fixes, protectedPoints: [origin, destination])
    assertValid(batches)
  }

  func testStoppedInTrafficNeverProducesAStaleBatch() {
    // 2 km at speed, 15 minutes crawling 1 m every 2 s, then 3 km at speed.
    let a = offset(origin, north: 0, east: 2_000)
    let b = offset(a, north: 0, east: 450)
    let c = offset(b, north: 0, east: 3_000)
    let fast1 = drive([origin, a])
    let crawl = drive([a, b], speed: 0.5, startingAt: fast1.last!.timestamp.addingTimeInterval(2))
    let fast2 = drive([b, c], startingAt: crawl.last!.timestamp.addingTimeInterval(2))
    var collector = NavOSSTrafficProbeCollector(rules: rules, protectedPoints: [origin, c])
    for fix in fast1 + crawl + fast2 {
      for batch in collector.ingest(fix) {
        // Emitted at `fix.timestamp`: the server refuses capturedAt older than ten minutes.
        XCTAssertLessThan(fix.timestamp.timeIntervalSince(batch.capturedAt), 9 * 60 + 30)
      }
      for batch in collector.tick(now: fix.timestamp.addingTimeInterval(1)) {
        XCTAssertLessThan(fix.timestamp.timeIntervalSince(batch.capturedAt), 9 * 60 + 30)
      }
    }
  }

  func testAFullStopNeverLetsTheOpenBatchGoStale() {
    // 3 km at speed, eleven minutes parked in a jam (fixes keep arriving), then 3 km more.
    let a = offset(origin, north: 0, east: 3_000)
    let c = offset(a, north: 0, east: 3_000)
    let b = offset(a, north: 0, east: 700)
    // Crawling at walking pace: a fix is released minutes after it was taken.
    let fast1 = drive([origin, a]) + drive([a, b], speed: 1.4, startingAt: drive([origin, a]).last!.timestamp.addingTimeInterval(2))
    var clock = fast1.last!.timestamp
    var parked: [NavOSSTrafficFix] = []
    for _ in 0..<330 {
      clock = clock.addingTimeInterval(2)
      parked.append(NavOSSTrafficFix(coordinate: b, horizontalAccuracyMeters: 5, timestamp: clock))
    }
    let fast2 = drive([b, c], startingAt: clock.addingTimeInterval(2))
    var collector = NavOSSTrafficProbeCollector(rules: rules, protectedPoints: [origin, c])
    var emittedCount = 0
    for fix in fast1 + parked + fast2 {
      for batch in collector.ingest(fix) {
        emittedCount += 1
        XCTAssertLessThan(fix.timestamp.timeIntervalSince(batch.capturedAt), 9 * 60 + 30)
      }
    }
    XCTAssertGreaterThan(emittedCount, 0)
  }

  /// ±5 m jitter around `center`, one fix every 2 s.
  private func parked(
    at center: NavOSSCarPlayCoordinate, seconds: Double, from time: Date, seed: UInt64
  ) -> [NavOSSTrafficFix] {
    var generator = SeededGenerator(seed: seed)
    return stride(from: 2.0, through: seconds, by: 2).map {
      NavOSSTrafficFix(
        coordinate: offset(
          center, north: Double.random(in: -5...5, using: &generator),
          east: Double.random(in: -5...5, using: &generator)),
        horizontalAccuracyMeters: 5, timestamp: time.addingTimeInterval($0))
    }
  }

  func testParkedJitterNeverReleasesTheProtectedEndOfACancelledTrip() {
    let destination = offset(origin, north: 0, east: 20_000)
    let stop = offset(origin, north: 0, east: 5_000)
    let drove = drive([origin, stop])
    let fixes = drove + parked(at: stop, seconds: 600, from: drove.last!.timestamp, seed: 7)
    var collector = NavOSSTrafficProbeCollector(rules: rules, protectedPoints: [origin, destination])
    var batches: [NavOSSTrafficProbeBatch] = []
    for fix in fixes {
      batches += collector.ingest(fix)
      batches += collector.tick(now: fix.timestamp)
    }
    collector.finish()  // navigation cancelled while parked
    assertValid(batches)
    XCTAssertFalse(batches.isEmpty)
    assertNothingWithin(400, of: [stop], in: batches)
  }

  func testJitterAtTheOriginNeverSatisfiesTheStartTrim() {
    let destination = offset(origin, north: 0, east: 6_000)
    // Ten minutes of jitter in the driveway, then departure (the route origin is elsewhere, so
    // only the start trim measured on credible movement protects the driveway).
    let driveway = offset(origin, north: 1_000, east: 0)
    let waiting = parked(at: driveway, seconds: 600, from: Date(timeIntervalSince1970: 1_794_500_000), seed: 9)
    let leaving = drive([driveway, destination], startingAt: waiting.last!.timestamp.addingTimeInterval(2))
    var collector = NavOSSTrafficProbeCollector(rules: rules, protectedPoints: [destination])
    var batches: [NavOSSTrafficProbeBatch] = []
    for fix in waiting + leaving { batches += collector.ingest(fix) }
    assertValid(batches)
    XCTAssertFalse(batches.isEmpty)
    assertNothingWithin(400, of: [driveway], in: batches)
  }

  func testAStopAndGoQueueStillSendsItsStationarySamples() {
    let a = offset(origin, north: 0, east: 2_000)
    let destination = offset(a, north: 0, east: 4_000)
    let first = drive([origin, a])
    var clock = first.last!.timestamp
    var stopped: [NavOSSTrafficFix] = []
    for _ in 0..<20 {  // 40 s standing still in a queue
      clock = clock.addingTimeInterval(2)
      stopped.append(NavOSSTrafficFix(coordinate: a, horizontalAccuracyMeters: 5, timestamp: clock))
    }
    let second = drive([a, destination], startingAt: clock.addingTimeInterval(2))
    let batches = run(first + stopped + second, protectedPoints: [origin, destination])
    assertValid(batches)
    let rounded = coordinate(navOSSRoundedToFiveDecimals(a.latitude), navOSSRoundedToFiveDecimals(a.longitude))
    let standing = emitted(batches).filter { distance($0, rounded) < 1 }.count
    XCTAssertGreaterThanOrEqual(standing, 15, "stationary time is signal for the server")
  }

  func testAGPSJumpAndBackReleasesNothing() {
    let destination = offset(origin, north: 0, east: 20_000)
    let stop = offset(origin, north: 0, east: 3_000)
    let drove = drive([origin, stop])
    var clock = drove.last!.timestamp
    var parkedWithJumps: [NavOSSTrafficFix] = []
    var jumps: [NavOSSCarPlayCoordinate] = []
    for index in 0..<200 {
      clock = clock.addingTimeInterval(2)
      let jump = index % 10 == 5
      let position = jump ? offset(stop, north: 300, east: 0) : stop
      if jump { jumps.append(position) }
      parkedWithJumps.append(NavOSSTrafficFix(coordinate: position, horizontalAccuracyMeters: 8, timestamp: clock))
    }
    var collector = NavOSSTrafficProbeCollector(rules: rules, protectedPoints: [origin, destination])
    var batches: [NavOSSTrafficProbeBatch] = []
    for fix in drove + parkedWithJumps { batches += collector.ingest(fix) }
    collector.finish()
    assertValid(batches)
    assertNothingWithin(400, of: [stop], in: batches)
    assertNothingWithin(1, of: jumps, in: batches)
  }

  func testFinishingTheTripDiscardsEverythingHeldBack() {
    let destination = offset(origin, north: 0, east: 3_000)
    var collector = NavOSSTrafficProbeCollector(rules: rules, protectedPoints: [origin])
    let fixes = drive([origin, destination])
    for fix in fixes.prefix(fixes.count / 2) { _ = collector.ingest(fix) }
    collector.finish()
    var after: [NavOSSTrafficProbeBatch] = []
    for fix in fixes.suffix(fixes.count / 2) { after += collector.ingest(fix) }
    // After finish the collector starts over: its first fix is a new protected start.
    assertNothingWithin(400, of: [fixes[fixes.count - fixes.count / 2].coordinate], in: after)
  }

  func testRequestBodyIsExactlyTheStrictSchema() throws {
    let batch = NavOSSTrafficProbeBatch(
      capturedAt: Date(timeIntervalSince1970: 1_794_506_640),
      firstPointAt: Date(timeIntervalSince1970: 1_794_506_652),
      points: [
        NavOSSTrafficProbePoint(latitude: 51.04471, longitude: -114.06312, offsetSeconds: 0),
        NavOSSTrafficProbePoint(latitude: 51.0449, longitude: -114.0628, offsetSeconds: 2),
      ],
      schemaVersion: 1
    )
    let body = try batch.requestBody(credential: "abc_DEF-123")
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
    XCTAssertEqual(Set(object.keys), ["capturedAt", "credential", "points", "schemaVersion"])
    XCTAssertEqual(object["capturedAt"] as? String, "2026-11-12T18:04:00Z")
    XCTAssertEqual(String(decoding: body, as: UTF8.self).contains("[-114.06280,51.04490,2]"), true)
    XCTAssertThrowsError(try batch.requestBody(credential: "bad\"quote"))
  }
}

/// SplitMix64, so the random-trip test is reproducible.
struct SeededGenerator: RandomNumberGenerator {
  private var state: UInt64

  init(seed: UInt64) {
    state = seed
  }

  mutating func next() -> UInt64 {
    state &+= 0x9e37_79b9_7f4a_7c15
    var value = state
    value = (value ^ (value >> 30)) &* 0xbf58_476d_1ce4_e5b9
    value = (value ^ (value >> 27)) &* 0x94d0_49bb_1331_11eb
    return value ^ (value >> 31)
  }
}
