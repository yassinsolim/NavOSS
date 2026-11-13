import Foundation
import XCTest

@testable import NavOSSNavigationCore

final class CommunityReportsTests: XCTestCase {
  private let now = Date(timeIntervalSince1970: 1_794_506_640)

  private func report(
    _ id: String,
    _ latitude: Double,
    _ longitude: Double,
    type: NavOSSCarPlayReportType = .pothole,
    expiresIn: TimeInterval = 3_600
  ) -> NavOSSCommunityReport {
    NavOSSCommunityReport(
      confirmations: 0,
      coordinate: NavOSSCarPlayCoordinate(latitude: latitude, longitude: longitude),
      expiresAt: now.addingTimeInterval(expiresIn),
      id: id,
      reportedAt: now.addingTimeInterval(-300),
      state: .unconfirmed,
      type: type
    )
  }

  // MARK: Cache

  func testCacheRefetchesStaleOrUncoveredAreasButNeverFasterThanTheFloor() {
    var cache = NavOSSCommunityReportCache()
    let area = NavOSSCommunityBounds(east: -114.0, north: 51.1, south: 51.0, west: -114.1)
    XCTAssertTrue(cache.needsFetch(area, now: now))
    cache.markFetching(now: now)
    cache.store([report("a", 51.05, -114.05)], for: area, now: now)
    let inside = NavOSSCommunityBounds(east: -114.02, north: 51.08, south: 51.02, west: -114.08)
    XCTAssertFalse(cache.needsFetch(inside, now: now.addingTimeInterval(60)))
    let outside = NavOSSCommunityBounds(east: -113.9, north: 51.1, south: 51.0, west: -114.0)
    XCTAssertFalse(cache.needsFetch(outside, now: now.addingTimeInterval(5)), "rate floor")
    XCTAssertTrue(cache.needsFetch(outside, now: now.addingTimeInterval(30)))
    XCTAssertTrue(cache.needsFetch(inside, now: now.addingTimeInterval(121)))
  }

  func testAFreshAnswerReplacesWhatWasKnownInsideItsArea() {
    var cache = NavOSSCommunityReportCache()
    let area = NavOSSCommunityBounds(east: -114.0, north: 51.1, south: 51.0, west: -114.1)
    cache.store([report("a", 51.05, -114.05), report("far", 52.0, -113.0)], for: area, now: now)
    XCTAssertEqual(cache.active(now: now).map(\.id), ["a"], "outside the asked area is dropped by the server's filter")
    let other = NavOSSCommunityBounds(east: -112.9, north: 52.1, south: 51.9, west: -113.1)
    cache.store([report("far", 52.0, -113.0)], for: other, now: now)
    cache.store([report("b", 51.06, -114.06)], for: area, now: now.addingTimeInterval(30))
    XCTAssertEqual(cache.active(now: now).map(\.id), ["b", "far"])
    XCTAssertEqual(cache.active(now: now.addingTimeInterval(7_200)).map(\.id), [], "expired")
  }

  // MARK: Corridor

  func testCorridorCoversTheRouteAheadWithinTheServerLimit() throws {
    let geometry = (0...200).map {
      NavOSSCarPlayCoordinate(latitude: 51.0 + Double($0) * 0.005, longitude: -114.0)
    }
    let bounds = try XCTUnwrap(navOSSCommunityCorridorBounds(routeGeometry: geometry, routeProgress: 0.5))
    XCTAssertLessThanOrEqual(bounds.north - bounds.south, 0.5)
    XCTAssertLessThanOrEqual(bounds.east - bounds.west, 0.5)
    // Starts at the vehicle (halfway, 51.5) and not behind it.
    XCTAssertEqual(bounds.south, 51.5 - 0.005 - 0.01, accuracy: 0.006)
    XCTAssertGreaterThan(bounds.north, 51.6)
    XCTAssertNil(navOSSCommunityCorridorBounds(routeGeometry: [geometry[0]], routeProgress: 0))
  }

  // MARK: Monitor

  /// A straight 5 km route east along 51.0447 with one maneuver at 3 km.
  private let routeStart = NavOSSCarPlayCoordinate(latitude: 51.0447, longitude: -114.2)
  private var metersPerDegreeLongitude: Double {
    navigationMetersPerDegreeLatitude * cos(51.0447 * .pi / 180)
  }

  private func point(_ meters: Double, north: Double = 0) -> NavOSSCarPlayCoordinate {
    NavOSSCarPlayCoordinate(
      latitude: 51.0447 + north / navigationMetersPerDegreeLatitude,
      longitude: -114.2 + meters / metersPerDegreeLongitude
    )
  }

  private func monitor(reports: [NavOSSCommunityReport]) -> NavigationCommunityReportMonitor {
    var monitor = NavigationCommunityReportMonitor()
    monitor.setReports(reports)
    monitor.startTrip(
      geometry: stride(from: 0.0, through: 5_000, by: 250).map { point($0) },
      maneuverCoordinates: [point(3_000)]
    )
    return monitor
  }

  private func reportAt(_ meters: Double, id: String, north: Double = 10) -> NavOSSCommunityReport {
    let coordinate = point(meters, north: north)
    return report(id, coordinate.latitude, coordinate.longitude)
  }

  func testAlertsOnceForAReportAheadOnTheRouteAndIgnoresOneOffIt() {
    var monitor = monitor(reports: [
      reportAt(1_500, id: "on"), reportAt(1_200, id: "off", north: 150),
    ])
    var alerts: [String] = []
    for along in stride(from: 0.0, through: 2_000, by: 20) {
      if let alert = monitor.update(alongMeters: along, isTracking: true, now: along) {
        alerts.append(alert.reportId)
        XCTAssertLessThanOrEqual(alert.distanceAheadMeters, 800)
      }
    }
    XCTAssertEqual(alerts, ["on"])
  }

  func testAsksStillThereOnlyAfterPassingAndNeverNearAManeuver() {
    // One report well clear of the maneuver at 3 km, one just before it, one just after it.
    var monitor = monitor(reports: [
      reportAt(1_000, id: "clear"), reportAt(2_700, id: "before-turn"),
      reportAt(3_050, id: "after-turn"),
    ])
    var prompts: [(id: String, along: Double)] = []
    var time = 0.0
    for along in stride(from: 0.0, through: 5_000, by: 10) {
      time += 400  // enough time between fixes that the prompt interval never hides one
      _ = monitor.update(alongMeters: along, isTracking: true, now: time)
      if let prompt = monitor.stillTherePrompt, prompts.last?.id != prompt.reportId {
        prompts.append((prompt.reportId, along))
        monitor.resolvePrompt(reportId: prompt.reportId)
      }
    }
    XCTAssertEqual(prompts.map(\.id), ["clear", "after-turn"])
    for prompt in prompts {
      // After the report and away from the maneuver.
      XCTAssertFalse((2_500..<3_150).contains(prompt.along), "\(prompt)")
    }
    XCTAssertGreaterThanOrEqual(prompts[0].along, 1_060)
  }

  func testNoPromptForTheInstallationsOwnReportsOrTwiceForOneReport() {
    var monitor = monitor(reports: [reportAt(1_000, id: "mine"), reportAt(1_800, id: "theirs")])
    monitor.markOwn("mine")
    var asked: [String] = []
    var time = 0.0
    for along in stride(from: 0.0, through: 2_500, by: 10) {
      time += 400
      _ = monitor.update(alongMeters: along, isTracking: true, now: time)
      if let prompt = monitor.stillTherePrompt, asked.last != prompt.reportId {
        asked.append(prompt.reportId)
      }
    }
    XCTAssertEqual(asked, ["theirs"])
  }

  func testGoingBackwardsNeverMakesAReportPassed() {
    var backwardsMonitor = self.monitor(reports: [reportAt(1_000, id: "r")])
    _ = backwardsMonitor.update(alongMeters: 900, isTracking: true, now: 0)
    _ = backwardsMonitor.update(alongMeters: 850, isTracking: true, now: 1)
    XCTAssertNil(backwardsMonitor.stillTherePrompt)
  }

  func testSpokenAlertsNameEveryType() {
    for type in NavOSSCarPlayReportType.allCases {
      XCTAssertTrue(navOSSCommunityReportSpokenAlert(type).hasPrefix("Reported "))
    }
  }
}

// MARK: - Traffic sharing session

private actor FakeTrafficTransport: NavOSSTrafficTransport {
  var statusAccepting = true
  var credentialResults: [Result<NavOSSTrafficCredential, NavOSSCommunityFailure>] = []
  var uploadResults: [NavOSSTrafficUploadOutcome] = []
  private(set) var credentialRequests = 0
  private(set) var uploads: [String] = []
  let clock: Date

  init(clock: Date) {
    self.clock = clock
  }

  func configure(
    credentials: [Result<NavOSSTrafficCredential, NavOSSCommunityFailure>],
    uploads: [NavOSSTrafficUploadOutcome],
    accepting: Bool = true
  ) {
    credentialResults = credentials
    uploadResults = uploads
    statusAccepting = accepting
  }

  func trafficStatus() async throws -> NavOSSTrafficStatus {
    NavOSSTrafficStatus(mode: .live, accepting: statusAccepting, rules: NavOSSTrafficProbeRules())
  }

  func trafficCredential() async throws -> NavOSSTrafficCredential {
    credentialRequests += 1
    let result = credentialResults.isEmpty
      ? .success(NavOSSTrafficCredential(expiresAt: clock.addingTimeInterval(7_200), value: "c\(credentialRequests)"))
      : credentialResults.removeFirst()
    return try result.get()
  }

  func uploadProbes(_ batch: NavOSSTrafficProbeBatch, credential: String) async
    -> NavOSSTrafficUploadOutcome
  {
    uploads.append(credential)
    return uploadResults.isEmpty ? .accepted : uploadResults.removeFirst()
  }
}

final class CommunityTrafficSharingTests: XCTestCase {
  private let start = Date()

  private func fixes(count: Int) -> [NavOSSTrafficFix] {
    (0..<count).map { index in
      NavOSSTrafficFix(
        coordinate: NavOSSCarPlayCoordinate(
          latitude: 51.0447, longitude: -114.2 + Double(index) * 30 / 70_000),
        horizontalAccuracyMeters: 5,
        timestamp: start.addingTimeInterval(Double(index) * 2)
      )
    }
  }

  private func drive(
    _ session: NavOSSTrafficSharingSession,
    count: Int = 400
  ) async {
    for fix in fixes(count: count) {
      await session.ingest(fix)
      await session.drain()
    }
  }

  func testOffByDefaultAndNothingIsCollectedWhileOff() async {
    let transport = FakeTrafficTransport(clock: start)
    let session = NavOSSTrafficSharingSession(transport: transport, now: { [start] in start })
    await session.startTrip(protectedPoints: [])
    await drive(session)
    let state = await session.state
    XCTAssertEqual(state, .off)
    let requests = await transport.credentialRequests
    XCTAssertEqual(requests, 0)
  }

  func testSharesDuringATripWithOneCredential() async {
    let transport = FakeTrafficTransport(clock: start)
    let clock = Clock(start)
    let session = NavOSSTrafficSharingSession(transport: transport, now: { clock.value })
    await session.setEnabled(true)
    await session.startTrip(protectedPoints: [])
    let state = await session.state
    XCTAssertEqual(state, .sharing)
    for fix in fixes(count: 400) {
      clock.value = fix.timestamp
      await session.ingest(fix)
      await session.drain()
    }
    let uploads = await transport.uploads
    XCTAssertGreaterThan(uploads.count, 3)
    XCTAssertEqual(Set(uploads), ["c1"])
    await session.endTrip()
    let ended = await session.state
    XCTAssertEqual(ended, .ready)
  }

  func testUnauthorizedGetsOneNewCredentialAndContinuesWithTheNextBatch() async {
    let transport = FakeTrafficTransport(clock: start)
    await transport.configure(credentials: [], uploads: [.accepted, .unauthorized, .accepted])
    let clock = Clock(start)
    let session = NavOSSTrafficSharingSession(transport: transport, now: { clock.value })
    await session.setEnabled(true)
    await session.startTrip(protectedPoints: [])
    for fix in fixes(count: 400) {
      clock.value = fix.timestamp
      await session.ingest(fix)
      await session.drain()
    }
    let uploads = await transport.uploads
    XCTAssertEqual(Array(uploads.prefix(3)), ["c1", "c1", "c2"])
    let requests = await transport.credentialRequests
    XCTAssertEqual(requests, 2)
  }

  func testRateLimitStopsTheTripAndUnavailablePausesFiveMinutes() async {
    let transport = FakeTrafficTransport(clock: start)
    await transport.configure(credentials: [], uploads: [.rateLimited])
    let clock = Clock(start)
    let session = NavOSSTrafficSharingSession(transport: transport, now: { clock.value })
    await session.setEnabled(true)
    await session.startTrip(protectedPoints: [])
    for fix in fixes(count: 400) {
      clock.value = fix.timestamp
      await session.ingest(fix)
      await session.drain()
    }
    var uploads = await transport.uploads
    XCTAssertEqual(uploads.count, 1)
    var state = await session.state
    XCTAssertEqual(state, .unavailable(reason: .rateLimited))

    let paused = FakeTrafficTransport(clock: start)
    await paused.configure(credentials: [], uploads: [.unavailable])
    let session2 = NavOSSTrafficSharingSession(transport: paused, now: { clock.value })
    clock.value = start
    await session2.setEnabled(true)
    await session2.startTrip(protectedPoints: [])
    var firstUploadAt: Date?
    for fix in fixes(count: 400) {
      clock.value = fix.timestamp
      await session2.ingest(fix)
      await session2.drain()
      let count = await paused.uploads.count
      if count == 1, firstUploadAt == nil { firstUploadAt = fix.timestamp }
      if count == 2, let firstUploadAt {
        XCTAssertGreaterThanOrEqual(fix.timestamp.timeIntervalSince(firstUploadAt), 300)
      }
    }
    uploads = await paused.uploads
    XCTAssertGreaterThan(uploads.count, 1, "resumes after the pause")
    state = await session2.state
    XCTAssertEqual(state, .sharing)
  }

  func testInstallationTooNewCollectsNothingAndDoesNotAskAgainUntilRetryAfter() async {
    let transport = FakeTrafficTransport(clock: start)
    await transport.configure(credentials: [.failure(.installationTooNew(retryAfterSeconds: 3_600))], uploads: [])
    let clock = Clock(start)
    let session = NavOSSTrafficSharingSession(transport: transport, now: { clock.value })
    await session.setEnabled(true)
    await session.startTrip(protectedPoints: [])
    var state = await session.state
    XCTAssertEqual(state, .startsLater(until: start.addingTimeInterval(3_600)))
    await drive(session)
    await session.endTrip()
    clock.value = start.addingTimeInterval(1_800)
    await session.startTrip(protectedPoints: [])
    var requests = await transport.credentialRequests
    XCTAssertEqual(requests, 1, "not asked again before retry-after")
    let uploads = await transport.uploads
    XCTAssertEqual(uploads, [])
    clock.value = start.addingTimeInterval(3_601)
    await session.startTrip(protectedPoints: [])
    requests = await transport.credentialRequests
    XCTAssertEqual(requests, 2)
    state = await session.state
    XCTAssertEqual(state, .sharing)
  }

  func testServerNotAcceptingMeansNoCredentialAndNoUpload() async {
    let transport = FakeTrafficTransport(clock: start)
    await transport.configure(credentials: [], uploads: [], accepting: false)
    let session = NavOSSTrafficSharingSession(transport: transport, now: { [start] in start })
    await session.setEnabled(true)
    await session.startTrip(protectedPoints: [])
    await drive(session)
    let requests = await transport.credentialRequests
    XCTAssertEqual(requests, 0)
    let state = await session.state
    XCTAssertEqual(state, .unavailable(reason: .notAccepting))
  }
}

final class Clock: @unchecked Sendable {
  private let lock = NSLock()
  private var current: Date

  init(_ date: Date) {
    current = date
  }

  var value: Date {
    get { lock.withLock { current } }
    set { lock.withLock { current = newValue } }
  }
}
