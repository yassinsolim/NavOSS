import Foundation
import XCTest

@testable import NavOSSNavigationCore

/// The written client rules (docs/architecture/community-traffic.md, "Client rules") against
/// the uploader and the service that drives it: consent, cancellation, trip-scoped
/// restrictions and restored trips.

/// Holds uploads until released. Like `URLSession`, a cancelled upload never finishes sending.
final class StallGate: @unchecked Sendable {
  private let lock = NSLock()
  private var waiters: [UUID: CheckedContinuation<Void, Never>] = [:]
  private var cancelled: Set<UUID> = []
  private var released = false

  var waiting: Int { lock.withLock { waiters.count } }

  func wait() async {
    let id = UUID()
    await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        let resumeNow: Bool = lock.withLock {
          if released || cancelled.contains(id) { return true }
          waiters[id] = continuation
          return false
        }
        if resumeNow { continuation.resume() }
      }
    } onCancel: {
      let continuation: CheckedContinuation<Void, Never>? = lock.withLock {
        cancelled.insert(id)
        return waiters.removeValue(forKey: id)
      }
      continuation?.resume()
    }
  }

  func release() {
    let all: [CheckedContinuation<Void, Never>] = lock.withLock {
      released = true
      defer { waiters = [:] }
      return Array(waiters.values)
    }
    all.forEach { $0.resume() }
  }
}

actor RuleTransport: NavOSSTrafficTransport {
  var accepting = true
  var credentialResults: [Result<NavOSSTrafficCredential, NavOSSCommunityFailure>] = []
  var uploadResults: [NavOSSTrafficUploadOutcome] = []
  private(set) var statusRequests = 0
  private(set) var credentialRequests = 0
  /// Bodies that reached the server.
  private(set) var transmitted: [Data] = []
  /// Uploads attempted, including those that never finished sending.
  private(set) var uploadAttempts = 0
  nonisolated let gate: StallGate?
  let clock: Clock

  init(clock: Clock, stall: Bool = false) {
    self.clock = clock
    gate = stall ? StallGate() : nil
  }

  func configure(
    accepting: Bool = true,
    credentials: [Result<NavOSSTrafficCredential, NavOSSCommunityFailure>] = [],
    uploads: [NavOSSTrafficUploadOutcome] = []
  ) {
    self.accepting = accepting
    credentialResults = credentials
    uploadResults = uploads
  }

  func trafficStatus() async throws -> NavOSSTrafficStatus {
    statusRequests += 1
    return NavOSSTrafficStatus(mode: .live, accepting: accepting, rules: NavOSSTrafficProbeRules())
  }

  func trafficCredential() async throws -> NavOSSTrafficCredential {
    credentialRequests += 1
    let result: Result<NavOSSTrafficCredential, NavOSSCommunityFailure> =
      credentialResults.isEmpty
      ? .success(
        NavOSSTrafficCredential(
          expiresAt: clock.value.addingTimeInterval(7_200), value: "c\(credentialRequests)"))
      : credentialResults.removeFirst()
    return try result.get()
  }

  func uploadProbes(_ batch: NavOSSTrafficProbeBatch, credential: String) async
    -> NavOSSTrafficUploadOutcome
  {
    uploadAttempts += 1
    let body = try? batch.requestBody(credential: credential)
    if let gate { await gate.wait() }
    guard !Task.isCancelled, let body else { return .dropped }
    transmitted.append(body)
    return uploadResults.isEmpty ? .accepted : uploadResults.removeFirst()
  }
}

private let origin = NavOSSCarPlayCoordinate(latitude: 51.0447, longitude: -114.2)

/// `meters` east of `origin`.
private func east(_ meters: Double) -> NavOSSCarPlayCoordinate {
  NavOSSCarPlayCoordinate(
    latitude: origin.latitude,
    longitude: origin.longitude
      + meters / (navigationMetersPerDegreeLatitude * cos(origin.latitude * .pi / 180)))
}

/// A straight drive east at 15 m/s, one accurate fix every 2 s.
private func drive(from start: Date, count: Int = 400, offset: Int = 0) -> [NavOSSTrafficFix] {
  (offset..<(offset + count)).map { index in
    NavOSSTrafficFix(
      coordinate: east(Double(index) * 30), horizontalAccuracyMeters: 5,
      timestamp: start.addingTimeInterval(Double(index) * 2))
  }
}

private func eventually(
  timeout: TimeInterval = 2, _ condition: @escaping () async -> Bool
) async -> Bool {
  let deadline = Date().addingTimeInterval(timeout)
  while Date() < deadline {
    if await condition() { return true }
    try? await Task.sleep(nanoseconds: 2_000_000)
  }
  return await condition()
}

/// Lets queued tasks run without waiting for a condition.
private func settle() async {
  try? await Task.sleep(nanoseconds: 50_000_000)
}

final class CommunityTrafficUploadCancellationTests: XCTestCase {
  private let start = Date()

  /// Feeds fixes until an upload is stalled in the transport.
  private func driveUntilStalled(
    _ session: NavOSSTrafficSharingSession, _ transport: RuleTransport, clock: Clock
  ) async -> Bool {
    for fix in drive(from: start) {
      clock.value = fix.timestamp
      await session.ingest(fix)
      if await eventually(timeout: 0.02, { transport.gate?.waiting == 1 }) { return true }
    }
    return false
  }

  private func stalledSession() async -> (NavOSSTrafficSharingSession, RuleTransport, Clock) {
    let clock = Clock(start)
    let transport = RuleTransport(clock: clock, stall: true)
    let session = NavOSSTrafficSharingSession(transport: transport, now: { clock.value })
    await session.setEnabled(true)
    await session.startTrip(protectedPoints: [origin])
    return (session, transport, clock)
  }

  func testEndingNavigationCancelsAStalledUploadSoItsBatchIsNeverSent() async {
    let (session, transport, clock) = await stalledSession()
    let stalled = await driveUntilStalled(session, transport, clock: clock)
    XCTAssertTrue(stalled, "an upload is in flight")
    await session.endTrip()
    // The network recovers only after navigation ended.
    transport.gate?.release()
    await settle()
    let transmitted = await transport.transmitted
    XCTAssertEqual(transmitted, [], "no body is sent after the trip ended")
  }

  func testSwitchingSharingOffCancelsAStalledUploadSoItsBatchIsNeverSent() async {
    let (session, transport, clock) = await stalledSession()
    let stalled = await driveUntilStalled(session, transport, clock: clock)
    XCTAssertTrue(stalled, "an upload is in flight")
    await session.setEnabled(false)
    transport.gate?.release()
    await settle()
    let transmitted = await transport.transmitted
    XCTAssertEqual(transmitted, [], "no body is sent after sharing was switched off")
  }
}

final class CommunityTrafficTripRestrictionTests: XCTestCase {
  private let start = Date()

  func testAServiceUnavailablePauseOutlastsSharingTogglesAndANewTrip() async {
    let clock = Clock(start)
    let transport = RuleTransport(clock: clock)
    await transport.configure(uploads: [.unavailable])
    let session = NavOSSTrafficSharingSession(transport: transport, now: { clock.value })
    await session.setEnabled(true)
    await session.startTrip(protectedPoints: [origin])
    var pausedAt: Date?
    var resumedAt: Date?
    for fix in drive(from: start, count: 600) {
      clock.value = fix.timestamp
      await session.ingest(fix)
      await session.drain()
      let sent = await transport.transmitted.count
      if sent == 1, pausedAt == nil {
        pausedAt = fix.timestamp
        // Toggled off and on, and even a new navigation start, inside the five minutes.
        await session.setEnabled(false)
        await session.setEnabled(true)
        await session.startTrip(protectedPoints: [origin])
      }
      if sent == 2, resumedAt == nil { resumedAt = fix.timestamp }
    }
    guard let pausedAt else { return XCTFail("the first batch was sent") }
    guard let resumedAt else { return XCTFail("sharing resumes once the pause is over") }
    XCTAssertGreaterThanOrEqual(resumedAt.timeIntervalSince(pausedAt), 300)
  }

  func testARateLimitHoldsForTheRestOfTheTripWhateverTheSwitchDoes() async {
    let clock = Clock(start)
    let transport = RuleTransport(clock: clock)
    await transport.configure(uploads: [.rateLimited])
    let session = NavOSSTrafficSharingSession(transport: transport, now: { clock.value })
    await session.setEnabled(true)
    await session.startTrip(protectedPoints: [origin])
    var toggled = false
    for fix in drive(from: start, count: 600) {
      clock.value = fix.timestamp
      await session.ingest(fix)
      await session.drain()
      if !toggled, await transport.transmitted.count == 1 {
        toggled = true
        await session.setEnabled(false)
        await session.setEnabled(true)
      }
    }
    XCTAssertTrue(toggled)
    let sent = await transport.transmitted.count
    let credentials = await transport.credentialRequests
    let state = await session.state
    XCTAssertEqual(sent, 1, "nothing more is sent on this trip")
    XCTAssertEqual(credentials, 1, "no new credential on this trip")
    XCTAssertEqual(state, .unavailable(reason: .rateLimited))

    // A genuinely new navigation trip may share again.
    await session.endTrip()
    await session.startTrip(protectedPoints: [origin])
    let next = await session.state
    XCTAssertEqual(next, .sharing)
  }
}

/// The service as the phone and CarPlay drive it: preference changes, reset, navigation hooks.
final class CommunityTrafficServiceRulesTests: XCTestCase {
  private let start = Date()

  private func trip(waypoints: [NavOSSCarPlayCoordinate] = []) -> NavOSSCarPlayTrip {
    let geometry = stride(from: 0.0, through: 12_000, by: 250).map { east($0) }
    let destination = NavOSSCarPlayDestination(
      category: nil, id: "d", label: "D", latitude: geometry.last!.latitude,
      longitude: geometry.last!.longitude, name: "D")
    return NavOSSCarPlayTrip(
      destination: destination,
      distanceMeters: 12_000,
      durationSeconds: 800,
      geometry: geometry,
      id: "trip",
      steps: [
        NavOSSCarPlayRouteStep(
          distanceMeters: 12_000, durationSeconds: 800, geometry: geometry,
          instruction: "Drive east.", maneuverType: "depart", roadName: "Test Road")
      ],
      waypoints: waypoints.isEmpty
        ? nil
        : waypoints.enumerated().map { index, point in
          NavOSSCarPlayDestination(
            category: nil, id: "w\(index)", label: "W", latitude: point.latitude,
            longitude: point.longitude, name: "W")
        }
    )
  }

  private func makeService(
    _ transport: RuleTransport, clock: Clock, sharing: Bool = true
  ) -> (NavOSSCommunityService, NavOSSCommunityPreferencesStore) {
    let defaults = UserDefaults(suiteName: "traffic-rules-\(UUID().uuidString)")!
    // Preferences and the service share one center, as they share `.default` in the app.
    let center = NotificationCenter()
    let preferences = NavOSSCommunityPreferencesStore(defaults: defaults, notificationCenter: center)
    if sharing { preferences.setSharesTrafficSpeeds(true) }
    // The client is only for reports; the uploader talks to `transport`. With no stored key,
    // reset has nothing to delete on the server.
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CommunityStubProtocol.self]
    CommunityStubProtocol.handler = { _ in (404, [:], [:]) }
    let client = NavOSSCommunityClient(
      baseURL: URL(string: "http://127.0.0.1:3001")!,
      provider: NavOSSUnavailableAttestationProvider(),
      store: NavOSSCommunityMemorySecretStore(),
      session: URLSession(configuration: configuration), discovery: NavOSSRoutesEndpointDiscovery())
    let service = NavOSSCommunityService(
      client: client, preferencesStore: preferences,
      alertStore: NavOSSCarPlayMapAlertStore(notificationCenter: NotificationCenter()),
      notificationCenter: center, trafficTransport: transport,
      trafficEmbargo: NavOSSTrafficEmbargoStore(), now: { clock.value })
    return (service, preferences)
  }

  func testPreferenceChangesNeverLiftARateLimitForTheRestOfTheTrip() async {
    let clock = Clock(start)
    let transport = RuleTransport(clock: clock)
    await transport.configure(credentials: [.failure(.rateLimited(retryAfterSeconds: 600))])
    let (service, preferences) = makeService(transport, clock: clock)
    service.navigationDidStart(trip())
    let limited = await eventually { service.trafficSharingState() == .unavailable(reason: .rateLimited) }
    XCTAssertTrue(limited)
    preferences.setAnnouncesRoadReports(false)
    preferences.setSharesRoadReports(true)
    preferences.setSharesTrafficSpeeds(false)
    preferences.setSharesTrafficSpeeds(true)
    await settle()
    let credentials = await transport.credentialRequests
    let statuses = await transport.statusRequests
    XCTAssertEqual(credentials, 1, "no credential is requested again on this trip")
    XCTAssertEqual(statuses, 1, "the uploader is not restarted on this trip")
    XCTAssertEqual(service.trafficSharingState(), .unavailable(reason: .rateLimited))
    service.navigationDidEnd()
  }

  func testAfterInstallationTooNewNothingIsCollectedForTheRestOfTheTrip() async {
    let clock = Clock(start)
    let transport = RuleTransport(clock: clock)
    await transport.configure(credentials: [.failure(.installationTooNew(retryAfterSeconds: 60))])
    let (service, preferences) = makeService(transport, clock: clock)
    service.navigationDidStart(trip())
    let later = await eventually {
      service.trafficSharingState() == .startsLater(until: self.start.addingTimeInterval(60))
    }
    XCTAssertTrue(later)
    // The retry-after has passed, but this is still the same trip.
    clock.value = start.addingTimeInterval(120)
    preferences.setAnnouncesRoadReports(false)
    preferences.setSharesTrafficSpeeds(false)
    preferences.setSharesTrafficSpeeds(true)
    await settle()
    let credentials = await transport.credentialRequests
    XCTAssertEqual(credentials, 1, "nothing more on this trip")
    service.navigationDidEnd()
  }

  func testTurningSharingOnDuringGuidanceSharesForTheRestOfThatTrip() async {
    let clock = Clock(start)
    let transport = RuleTransport(clock: clock)
    let (service, preferences) = makeService(transport, clock: clock, sharing: false)
    service.navigationDidStart(trip())
    await settle()
    let before = await transport.statusRequests
    XCTAssertEqual(before, 0, "nothing is asked while the switch is off")
    preferences.setSharesTrafficSpeeds(true)
    let sharing = await eventually { service.trafficSharingState() == .sharing }
    XCTAssertTrue(sharing)
    service.navigationDidEnd()
  }
}

final class CommunityTrafficEmbargoTests: XCTestCase {
  private let start = Date()

  func testAnInstallationTooNewDeadlineSurvivesARelaunch() async {
    let clock = Clock(start)
    let embargo = NavOSSTrafficEmbargoStore(
      defaults: UserDefaults(suiteName: "traffic-embargo-\(UUID().uuidString)")!)
    let first = RuleTransport(clock: clock)
    await first.configure(credentials: [.failure(.installationTooNew(retryAfterSeconds: 3_600))])
    let before = NavOSSTrafficSharingSession(transport: first, now: { clock.value }, embargo: embargo)
    await before.setEnabled(true)
    await before.startTrip(protectedPoints: [origin])

    // Relaunched half an hour later: a new process, a new uploader, a new trip.
    clock.value = start.addingTimeInterval(1_800)
    let second = RuleTransport(clock: clock)
    let after = NavOSSTrafficSharingSession(transport: second, now: { clock.value }, embargo: embargo)
    await after.setEnabled(true)
    var state = await after.state
    XCTAssertEqual(state, .startsLater(until: start.addingTimeInterval(3_600)))
    await after.startTrip(protectedPoints: [origin])
    var requests = await second.credentialRequests
    let statuses = await second.statusRequests
    XCTAssertEqual(requests, 0, "not asked again before retry-after, even after a relaunch")
    XCTAssertEqual(statuses, 0)
    state = await after.state
    XCTAssertEqual(state, .startsLater(until: start.addingTimeInterval(3_600)))

    // The deadline passes during that trip: still nothing for the rest of it.
    clock.value = start.addingTimeInterval(3_700)
    await after.setEnabled(false)
    await after.setEnabled(true)
    requests = await second.credentialRequests
    XCTAssertEqual(requests, 0, "a 403 at the start of a trip holds for the whole trip")

    await after.endTrip()
    await after.startTrip(protectedPoints: [origin])
    requests = await second.credentialRequests
    XCTAssertEqual(requests, 1, "the next trip after the deadline asks again")
  }
}

final class CommunityTrafficClientCancellationTests: XCTestCase {
  func testACancelledUploadNeverReachesTheServer() async throws {
    CommunityStubProtocol.sent = []
    CommunityStubProtocol.handler = { _ in (202, ["status": "accepted"], [:]) }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CommunityStubProtocol.self]
    let client = NavOSSCommunityClient(
      baseURL: URL(string: "http://127.0.0.1:3001")!,
      provider: NavOSSUnavailableAttestationProvider(),
      store: NavOSSCommunityMemorySecretStore(),
      session: URLSession(configuration: configuration), discovery: NavOSSRoutesEndpointDiscovery())
    var collector = NavOSSTrafficProbeCollector(
      rules: NavOSSTrafficProbeRules(), protectedPoints: [origin])
    var batches: [NavOSSTrafficProbeBatch] = []
    for fix in drive(from: Date()) where batches.isEmpty {
      batches += collector.ingest(fix)
    }
    let batch = try XCTUnwrap(batches.first, "a batch to send")
    let task = Task { () -> NavOSSTrafficUploadOutcome in
      withUnsafeCurrentTask { $0?.cancel() }
      return await client.uploadProbes(batch, credential: "credential")
    }
    let outcome = await task.value
    XCTAssertEqual(outcome, .dropped)
    try? await Task.sleep(nanoseconds: 100_000_000)
    XCTAssertFalse(CommunityStubProtocol.sent.contains { $0.path == "/v2/traffic/probes" })
  }
}
