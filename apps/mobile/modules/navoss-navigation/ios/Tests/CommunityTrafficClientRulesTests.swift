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
  /// A response already received: cancelling the waiting task does not stop it arriving.
  private let ignoresCancellation: Bool

  init(ignoresCancellation: Bool = false) {
    self.ignoresCancellation = ignoresCancellation
  }

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
    } onCancel: { [ignoresCancellation] in
      guard !ignoresCancellation else { return }
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

final class Locked<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: Value
  init(_ value: Value) { stored = value }
  var value: Value {
    get { lock.withLock { stored } }
    set { lock.withLock { stored = newValue } }
  }
}

/// A permit from a gate that is open (sharing on, navigating).
func openTrafficPermit() -> NavOSSTrafficUploadPermit {
  let gate = NavOSSTrafficUploadGate()
  gate.setSwitch(true)
  gate.setNavigating(true)
  return gate.open()!
}

/// Whether a request could still be created under `permit` right now.
func admits(_ permit: NavOSSTrafficUploadPermit?) -> Bool {
  guard let permit else { return false }
  let id = UUID()
  defer { permit.finish(id) }
  return permit.start(id) { {} }
}

final class Flag: @unchecked Sendable {
  private let lock = NSLock()
  private var raised = false
  var isRaised: Bool { lock.withLock { raised } }
  func raise() { lock.withLock { raised = true } }
}

actor RuleTransport: NavOSSTrafficTransport {
  var accepting = true
  var credentialResults: [Result<NavOSSTrafficCredential, NavOSSCommunityFailure>] = []
  var uploadResults: [NavOSSTrafficUploadOutcome] = []
  private(set) var statusRequests = 0
  private(set) var credentialRequests = 0
  /// Bodies that reached the server.
  private(set) var transmitted: [Data] = []
  /// Uploads the uploader asked for, whether or not a request was created.
  private(set) var uploadAttempts = 0
  /// Requests created (started on the network), whatever became of them.
  private(set) var requestsCreated = 0
  /// Holds a created request on the wire until released (a stalled network).
  nonisolated let gate: StallGate?
  /// Holds an upload before its request is created (queued, not started).
  nonisolated let beforeRequest: StallGate?
  /// Holds the status answer (anonymous) until released.
  nonisolated let statusGate: StallGate?
  /// Holds credential answers already on their way (see `stallCredentials(from:)`).
  nonisolated let credentialGate = StallGate(ignoresCancellation: true)
  private var stallCredentialsFrom = Int.max
  /// The permit of the latest upload handed over, and whether its request was cancelled, for
  /// checks made right after a synchronous call returns.
  nonisolated let heldPermit = Locked<NavOSSTrafficUploadPermit?>(nil)
  nonisolated let requestCancelled = Locked<Flag?>(nil)
  let clock: Clock

  init(
    clock: Clock, stall: Bool = false, holdBeforeRequest: Bool = false, holdStatus: Bool = false
  ) {
    self.clock = clock
    statusGate = holdStatus ? StallGate() : nil
    gate = stall ? StallGate() : nil
    beforeRequest = holdBeforeRequest ? StallGate() : nil
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
    if let statusGate { await statusGate.wait() }
    return NavOSSTrafficStatus(mode: .live, accepting: accepting, rules: NavOSSTrafficProbeRules())
  }

  /// Holds credential answers from the `stallCredentialsFrom`-th request on until released.
  func stallCredentials(from request: Int) {
    stallCredentialsFrom = request
  }

  func trafficCredential(
    permit: NavOSSTrafficUploadPermit
  ) async throws -> NavOSSTrafficCredential {
    // Like `NavOSSCommunityClient`: the identity-bearing request exists only under the permit.
    let id = UUID()
    guard permit.start(id, { {} }) else { throw NavOSSCommunityFailure.network }
    defer { permit.finish(id) }
    credentialRequests += 1
    if credentialRequests >= stallCredentialsFrom { await credentialGate.wait() }
    let result: Result<NavOSSTrafficCredential, NavOSSCommunityFailure> =
      credentialResults.isEmpty
      ? .success(
        NavOSSTrafficCredential(
          expiresAt: clock.value.addingTimeInterval(7_200), value: "c\(credentialRequests)"))
      : credentialResults.removeFirst()
    return try result.get()
  }

  func uploadProbes(
    _ batch: NavOSSTrafficProbeBatch, credential: String, permit: NavOSSTrafficUploadPermit
  ) async -> NavOSSTrafficUploadOutcome {
    uploadAttempts += 1
    let body = try? batch.requestBody(credential: credential)
    heldPermit.value = permit
    if let beforeRequest { await beforeRequest.wait() }
    // Like `NavOSSCommunityClient`: the request exists only if the permit still admits it, and
    // a cancelled request never finishes sending.
    let cancelled = Flag()
    let id = UUID()
    guard permit.start(id, { { cancelled.raise() } }) else { return .dropped }
    requestCancelled.value = cancelled
    requestsCreated += 1
    if let gate { await gate.wait() }
    permit.finish(id)
    guard !cancelled.isRaised, let body else { return .dropped }
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
  private var centers: [ObjectIdentifier: NotificationCenter] = [:]

  private func notificationCenter(of store: NavOSSCommunityPreferencesStore) -> NotificationCenter {
    centers[ObjectIdentifier(store)]!
  }

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
    _ transport: RuleTransport, clock: Clock, sharing: Bool = true,
    embargo: NavOSSTrafficEmbargoStore = NavOSSTrafficEmbargoStore()
  ) -> (NavOSSCommunityService, NavOSSCommunityPreferencesStore) {
    let defaults = UserDefaults(suiteName: "traffic-rules-\(UUID().uuidString)")!
    // Preferences and the service share one center, as they share `.default` in the app.
    let center = NotificationCenter()
    let preferences = NavOSSCommunityPreferencesStore(defaults: defaults, notificationCenter: center)
    centers[ObjectIdentifier(preferences)] = center
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
      trafficEmbargo: embargo, now: { clock.value })
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

  func testResetCommunityIdentityTurnsSharingOffAndStopsTheTrip() async throws {
    let clock = Clock(start)
    let transport = RuleTransport(clock: clock)
    let embargo = NavOSSTrafficEmbargoStore()
    let (service, preferences) = makeService(transport, clock: clock, embargo: embargo)
    preferences.setSharesRoadReports(true)
    service.navigationDidStart(trip())
    let sharing = await eventually { service.trafficSharingState() == .sharing }
    XCTAssertTrue(sharing)
    // A 403 deadline from earlier: it dates the old installation's registration.
    embargo.save(start.addingTimeInterval(-60))
    try await service.resetIdentity()
    XCTAssertNil(embargo.load(), "Reset forgets the stored credential deadline")
    await settle()
    XCTAssertFalse(preferences.load().sharesTrafficSpeeds, "traffic sharing needs a new opt-in")
    XCTAssertFalse(preferences.load().sharesRoadReports, "report sharing needs a new opt-in")
    XCTAssertEqual(service.trafficSharingState(), .off)
    let credentials = await transport.credentialRequests
    XCTAssertEqual(credentials, 1, "no new credential after the reset")
    service.navigationDidEnd()
  }

  func testAServerThatIsNotAcceptingTurnsTheSwitchOff() async {
    let clock = Clock(start)
    let transport = RuleTransport(clock: clock)
    await transport.configure(accepting: false)
    let (service, preferences) = makeService(transport, clock: clock)
    service.navigationDidStart(trip())
    let off = await eventually { !preferences.load().sharesTrafficSpeeds }
    XCTAssertTrue(off, "a switch the server cannot honour does not stay on in hiding")
    let state = await eventually { service.trafficSharingState() == .off }
    XCTAssertTrue(state)
    service.navigationDidEnd()
  }

  func testADeviceThatCannotAttestTurnsTheSwitchOff() async {
    let clock = Clock(start)
    let transport = RuleTransport(clock: clock)
    await transport.configure(credentials: [.failure(.attestationUnsupported)])
    let (service, preferences) = makeService(transport, clock: clock)
    service.navigationDidStart(trip())
    let off = await eventually { !preferences.load().sharesTrafficSpeeds }
    XCTAssertTrue(off)
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

  func testARestoredTripSharesNothingButTheNextTripDoes() async {
    let clock = Clock(start)
    let transport = RuleTransport(clock: clock)
    let (service, _) = makeService(transport, clock: clock)
    // A stop visited before a reroute and a relaunch is no longer in the saved route, so the
    // restored trip cannot rebuild the zones the original trip had.
    let replacement = trip()
    service.navigationDidStart(replacement, restored: true)
    let refused = await eventually { service.trafficSharingState() == .unavailable(reason: .rejected) }
    XCTAssertTrue(refused)
    for fix in drive(from: start, count: 100) {
      clock.value = fix.timestamp
      service.navigationDidReceiveFix(fix)
    }
    await settle()
    let statuses = await transport.statusRequests
    let credentials = await transport.credentialRequests
    XCTAssertEqual(statuses, 0, "a restored trip does not even ask the server")
    XCTAssertEqual(credentials, 0)
    service.navigationDidEnd()

    service.navigationDidStart(trip(waypoints: [east(6_000)]))
    let sharing = await eventually { service.trafficSharingState() == .sharing }
    XCTAssertTrue(sharing, "a trip started on this launch shares as before")
    service.navigationDidEnd()
  }

  // MARK: Off and end are immediate (through the synchronous calls the phone and CarPlay make)

  /// Feeds the uploader until one batch is handed to the transport, which holds it before
  /// creating the request (queued, not started).
  private func queueOneUpload(
    _ service: NavOSSCommunityService, _ transport: RuleTransport, clock: Clock
  ) async -> Bool {
    for fix in drive(from: start) {
      clock.value = fix.timestamp
      await service.traffic?.ingest(fix)
      let held = await eventually(timeout: 0.02) {
        (transport.beforeRequest ?? transport.gate)?.waiting == 1
      }
      if held { return true }
    }
    return false
  }

  /// Keeps the uploader's ordered work waiting until released.
  private func holdUploaderBack(_ service: NavOSSCommunityService) -> StallGate {
    let lag = StallGate()
    service.traffic?.ordered.run { await lag.wait() }
    return lag
  }

  private func sharingService(
    _ transport: RuleTransport, clock: Clock
  ) async -> (NavOSSCommunityService, NavOSSCommunityPreferencesStore) {
    let (service, preferences) = makeService(transport, clock: clock)
    service.navigationDidStart(trip())
    _ = await eventually { service.trafficSharingState() == .sharing }
    return (service, preferences)
  }

  func testOnceTheSwitchIsOffAQueuedUploadIsNeverStarted() async {
    let clock = Clock(start)
    let transport = RuleTransport(clock: clock, holdBeforeRequest: true)
    let (service, preferences) = await sharingService(transport, clock: clock)
    let queued = await queueOneUpload(service, transport, clock: clock)
    XCTAssertTrue(queued)
    // The uploader has not caught up yet: only the synchronous part of the call can act.
    let lag = holdUploaderBack(service)
    preferences.setSharesTrafficSpeeds(false)
    // The setter has returned: from this instant no request may be created.
    XCTAssertFalse(admits(transport.heldPermit.value), "the gate is closed when the setter returns")
    lag.release()
    transport.beforeRequest?.release()
    await service.traffic?.settled()
    await settle()
    let created = await transport.requestsCreated
    XCTAssertEqual(created, 0, "no request is created after the switch is off")
    service.navigationDidEnd()
  }

  func testOnceNavigationEndsAQueuedUploadIsNeverStarted() async {
    let clock = Clock(start)
    let transport = RuleTransport(clock: clock, holdBeforeRequest: true)
    let (service, _) = await sharingService(transport, clock: clock)
    let queued = await queueOneUpload(service, transport, clock: clock)
    XCTAssertTrue(queued)
    // The uploader has not caught up yet: only the synchronous part of the call can act.
    let lag = holdUploaderBack(service)
    service.navigationDidEnd()
    XCTAssertFalse(admits(transport.heldPermit.value), "the gate is closed when the end returns")
    lag.release()
    transport.beforeRequest?.release()
    await service.traffic?.settled()
    await settle()
    let created = await transport.requestsCreated
    XCTAssertEqual(created, 0, "no request is created after navigation ended")
  }

  func testOffThenOnStillDiscardsTheOldBatchAndCredential() async {
    let clock = Clock(start)
    let transport = RuleTransport(clock: clock, holdBeforeRequest: true)
    let (service, preferences) = await sharingService(transport, clock: clock)
    let queued = await queueOneUpload(service, transport, clock: clock)
    XCTAssertTrue(queued)
    // The uploader has not caught up yet: only the synchronous part of the call can act.
    let lag = holdUploaderBack(service)
    preferences.setSharesTrafficSpeeds(false)
    preferences.setSharesTrafficSpeeds(true)
    XCTAssertFalse(admits(transport.heldPermit.value), "the old batch's permit died with the off")
    lag.release()
    transport.beforeRequest?.release()
    await service.traffic?.settled()
    let sharing = await eventually { service.trafficSharingState() == .sharing }
    XCTAssertTrue(sharing, "on again")
    let created = await transport.requestsCreated
    let credentials = await transport.credentialRequests
    XCTAssertEqual(created, 0, "the batch from before the off is never sent")
    XCTAssertEqual(credentials, 2, "the old credential is dropped; a new one is requested")
    service.navigationDidEnd()
  }

  func testAnOffDeliveredAfterTheOnThatFollowedItStillDiscardsTheOldBatch() async {
    let clock = Clock(start)
    let transport = RuleTransport(clock: clock, holdBeforeRequest: true)
    let (service, preferences) = await sharingService(transport, clock: clock)
    let queued = await queueOneUpload(service, transport, clock: clock)
    XCTAssertTrue(queued)
    // The uploader has not caught up yet: only the synchronous part of the call can act.
    let lag = holdUploaderBack(service)
    // Two threads wrote off then on; the notifications arrive on, then off.
    let written = preferences.trafficSharing().sequence
    let center = notificationCenter(of: preferences)
    center.post(
      name: .navOSSCommunityPreferencesDidChange, object: preferences,
      userInfo: [
        NavOSSCommunityPreferencesStore.trafficValueKey: true,
        NavOSSCommunityPreferencesStore.trafficSequenceKey: written + 2,
      ])
    center.post(
      name: .navOSSCommunityPreferencesDidChange, object: preferences,
      userInfo: [
        NavOSSCommunityPreferencesStore.trafficValueKey: false,
        NavOSSCommunityPreferencesStore.trafficSequenceKey: written + 1,
      ])
    XCTAssertFalse(admits(transport.heldPermit.value), "the old batch's permit died with the off")
    lag.release()
    transport.beforeRequest?.release()
    await service.traffic?.settled()
    let sharing = await eventually { service.trafficSharingState() == .sharing }
    XCTAssertTrue(sharing, "the latest write (on) wins")
    let created = await transport.requestsCreated
    let credentials = await transport.credentialRequests
    XCTAssertEqual(created, 0, "the batch from before the off is never sent")
    XCTAssertEqual(credentials, 2)
    service.navigationDidEnd()
  }

  func testTurningSharingOffCancelsARequestAlreadyOnTheWire() async {
    let clock = Clock(start)
    let transport = RuleTransport(clock: clock, stall: true)
    let (service, preferences) = await sharingService(transport, clock: clock)
    let queued = await queueOneUpload(service, transport, clock: clock)
    XCTAssertTrue(queued)
    // The uploader has not caught up yet: only the synchronous part of the call can act.
    let lag = holdUploaderBack(service)
    preferences.setSharesTrafficSpeeds(false)
    XCTAssertEqual(
      transport.requestCancelled.value?.isRaised, true, "cancelled before the setter returned")
    lag.release()
    transport.gate?.release()
    await settle()
    let transmitted = await transport.transmitted
    XCTAssertEqual(transmitted, [], "the request in flight was cancelled when the setter returned")
    service.navigationDidEnd()
  }

  // MARK: Credential requests are gated too; Reset cannot be undone by a late 403

  func testEndingNavigationWhileTheStatusIsPendingSendsNoCredentialRequest() async {
    let clock = Clock(start)
    let transport = RuleTransport(clock: clock, holdStatus: true)
    let (service, _) = makeService(transport, clock: clock)
    service.navigationDidStart(trip())
    let asking = await eventually { transport.statusGate?.waiting == 1 }
    XCTAssertTrue(asking, "the status request is pending")
    service.navigationDidEnd()
    transport.statusGate?.release()
    await service.traffic?.settled()
    await settle()
    let credentials = await transport.credentialRequests
    XCTAssertEqual(credentials, 0, "no identity-bearing request after navigation ended")
  }

  func testSwitchingOffWhileTheStatusIsPendingSendsNoCredentialRequest() async {
    let clock = Clock(start)
    let transport = RuleTransport(clock: clock, holdStatus: true)
    let (service, preferences) = makeService(transport, clock: clock)
    service.navigationDidStart(trip())
    let asking = await eventually { transport.statusGate?.waiting == 1 }
    XCTAssertTrue(asking, "the status request is pending")
    preferences.setSharesTrafficSpeeds(false)
    transport.statusGate?.release()
    await service.traffic?.settled()
    await settle()
    let credentials = await transport.credentialRequests
    XCTAssertEqual(credentials, 0, "no identity-bearing request after sharing was turned off")
    service.navigationDidEnd()
  }

  func testA403FromBeforeResetDoesNotComeBackAfterIt() async throws {
    let clock = Clock(start)
    let transport = RuleTransport(clock: clock)
    // The second batch is refused (401); the replacement credential's answer is held, then 403.
    await transport.configure(
      credentials: [
        .success(NavOSSTrafficCredential(expiresAt: start.addingTimeInterval(7_200), value: "c1")),
        .failure(.installationTooNew(retryAfterSeconds: 3_600)),
      ],
      uploads: [.unauthorized])
    await transport.stallCredentials(from: 2)
    let embargo = NavOSSTrafficEmbargoStore()
    let (service, _) = makeService(transport, clock: clock, embargo: embargo)
    service.navigationDidStart(trip())
    _ = await eventually { service.trafficSharingState() == .sharing }
    var refreshing = false
    for fix in drive(from: start) where !refreshing {
      clock.value = fix.timestamp
      await service.traffic?.ingest(fix)
      refreshing = await eventually(timeout: 0.02) { transport.credentialGate.waiting == 1 }
    }
    XCTAssertTrue(refreshing, "a 401 refresh is waiting for its answer")
    try await service.resetIdentity()
    transport.credentialGate.release()  // the old installation's 403 arrives after Reset
    await settle()
    XCTAssertNil(embargo.load(), "a deadline from before Reset is not written back")
    service.navigationDidEnd()
  }

  // MARK: A 503 on the credential request pauses; it does not withdraw consent

  func testACredentialOutagePausesSharingAndKeepsTheDriversChoice() async {
    let clock = Clock(start)
    let transport = RuleTransport(clock: clock)
    await transport.configure(credentials: [.failure(.serviceUnavailable(retryAfterSeconds: 300))])
    let (service, preferences) = makeService(transport, clock: clock)
    service.navigationDidStart(trip())
    let paused = await eventually {
      service.trafficSharingState() == .paused(until: self.start.addingTimeInterval(300))
    }
    XCTAssertTrue(paused, "shown as paused")
    XCTAssertTrue(preferences.load().sharesTrafficSpeeds, "a five-minute outage is not an opt-out")
    var firstUpload: Date?
    for fix in drive(from: start, count: 600) {
      clock.value = fix.timestamp
      await service.traffic?.ingest(fix)
      await service.traffic?.drain()
      if firstUpload == nil, await transport.transmitted.count == 1 { firstUpload = fix.timestamp }
    }
    guard let firstUpload else { return XCTFail("sharing resumes after the pause") }
    XCTAssertGreaterThanOrEqual(firstUpload.timeIntervalSince(start), 300)
    let credentials = await transport.credentialRequests
    XCTAssertEqual(credentials, 2, "one new credential after the pause")
    XCTAssertEqual(service.trafficSharingState(), .sharing)
    service.navigationDidEnd()
  }
}

final class CommunityTrafficEmbargoTests: XCTestCase {
  private let start = Date()

  func testA403ThatArrivesAfterTheTripEndedStillHoldsBackTheNextTrip() async {
    let clock = Clock(start)
    let embargo = NavOSSTrafficEmbargoStore()
    let transport = SlowCredentialTransport()
    let session = NavOSSTrafficSharingSession(
      transport: transport, now: { clock.value }, embargo: embargo)
    await session.setEnabled(true)
    let starting = Task { await session.startTrip(protectedPoints: [origin]) }
    let asked = await eventually { transport.gate.waiting == 1 }
    XCTAssertTrue(asked, "the credential request is waiting for its answer")
    await session.endTrip()
    transport.gate.release()  // the answer: 403, retry-after one hour
    await starting.value
    XCTAssertEqual(embargo.load(), start.addingTimeInterval(3_600))
    clock.value = start.addingTimeInterval(600)
    await session.startTrip(protectedPoints: [origin])
    let requests = await transport.credentialRequests
    XCTAssertEqual(requests, 1, "the next trip does not ask before retry-after")
    let state = await session.state
    XCTAssertEqual(state, .startsLater(until: start.addingTimeInterval(3_600)))
  }

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
  private func client() -> NavOSSCommunityClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CommunityStubProtocol.self]
    return NavOSSCommunityClient(
      baseURL: URL(string: "http://127.0.0.1:3001")!,
      provider: NavOSSUnavailableAttestationProvider(),
      store: NavOSSCommunityMemorySecretStore(),
      session: URLSession(configuration: configuration), discovery: NavOSSRoutesEndpointDiscovery())
  }

  private func batch() throws -> NavOSSTrafficProbeBatch {
    var collector = NavOSSTrafficProbeCollector(
      rules: NavOSSTrafficProbeRules(), protectedPoints: [origin])
    var batches: [NavOSSTrafficProbeBatch] = []
    for fix in drive(from: Date()) where batches.isEmpty {
      batches += collector.ingest(fix)
    }
    return try XCTUnwrap(batches.first, "a batch to send")
  }

  private func openGate() throws -> (NavOSSTrafficUploadGate, NavOSSTrafficUploadPermit) {
    let gate = NavOSSTrafficUploadGate()
    gate.setSwitch(true)
    gate.setNavigating(true)
    return (gate, try XCTUnwrap(gate.open()))
  }

  override func tearDown() {
    CommunityStubProtocol.delay = nil
    super.tearDown()
  }

  func testNoRequestIsCreatedWithAPermitFromAClosedGate() async throws {
    CommunityStubProtocol.sent = []
    CommunityStubProtocol.handler = { _ in (202, ["status": "accepted"], [:]) }
    let client = client()
    let (gate, permit) = try openGate()
    gate.setSwitch(false)
    let outcome = await client.uploadProbes(try batch(), credential: "credential", permit: permit)
    XCTAssertEqual(outcome, .dropped)
    try? await Task.sleep(nanoseconds: 100_000_000)
    XCTAssertFalse(CommunityStubProtocol.sent.contains { $0.path == "/v2/traffic/probes" })
    // Reopening does not revive an old permit.
    gate.setSwitch(true)
    let again = await client.uploadProbes(try batch(), credential: "credential", permit: permit)
    XCTAssertEqual(again, .dropped)
    XCTAssertFalse(CommunityStubProtocol.sent.contains { $0.path == "/v2/traffic/probes" })
  }

  func testACredentialIsNeverRequestedWithIdentityUnderAClosedGate() async throws {
    CommunityStubProtocol.sent = []
    CommunityStubProtocol.started = []
    CommunityStubProtocol.handler = { sent in
      switch sent.path {
      case "/v2/community/challenges": return (200, ["challenge": "Y2hhbGxlbmdlLWNoYWxsZW5nZS0xMjM0"], [:])
      case "/v2/community/installations": return (201, ["status": "registered"], [:])
      default: return (200, ["credential": "c", "expiresAt": "2099-01-01T00:00:00.000Z"], [:])
      }
    }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CommunityStubProtocol.self]
    let store = NavOSSCommunityMemorySecretStore()
    let client = NavOSSCommunityClient(
      baseURL: URL(string: "http://127.0.0.1:3001")!,
      provider: NavOSSDevelopmentAttestationProvider(
        teamId: "ABCDE12345", bundleId: "org.navoss.mobile", store: store),
      store: store,
      session: URLSession(configuration: configuration), discovery: NavOSSRoutesEndpointDiscovery())
    let (gate, permit) = try openGate()
    gate.setNavigating(false)
    do {
      _ = try await client.trafficCredential(permit: permit)
      XCTFail("no credential after the gate closed")
    } catch {}
    try? await Task.sleep(nanoseconds: 100_000_000)
    let identityBearing = CommunityStubProtocol.started.filter {
      $0 == "/v2/community/installations" || $0 == "/v2/traffic/credentials"
    }
    XCTAssertEqual(identityBearing, [], "neither registration nor the asserted request was sent")
  }

  func testARegisteredInstallationSendsNoAssertedRequestUnderAClosedGate() async throws {
    CommunityStubProtocol.sent = []
    CommunityStubProtocol.handler = { sent in
      switch sent.path {
      case "/v2/community/challenges": return (200, ["challenge": "Y2hhbGxlbmdlLWNoYWxsZW5nZS0xMjM0"], [:])
      case "/v2/community/installations": return (201, ["status": "registered"], [:])
      default: return (200, ["credential": "c", "expiresAt": "2099-01-01T00:00:00.000Z"], [:])
      }
    }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CommunityStubProtocol.self]
    let store = NavOSSCommunityMemorySecretStore()
    let client = NavOSSCommunityClient(
      baseURL: URL(string: "http://127.0.0.1:3001")!,
      provider: NavOSSDevelopmentAttestationProvider(
        teamId: "ABCDE12345", bundleId: "org.navoss.mobile", store: store),
      store: store,
      session: URLSession(configuration: configuration), discovery: NavOSSRoutesEndpointDiscovery())
    // Registered and issued once while sharing.
    _ = try await client.trafficCredential(permit: openTrafficPermit())
    let (gate, permit) = try openGate()
    gate.setSwitch(false)
    CommunityStubProtocol.started = []
    do {
      _ = try await client.trafficCredential(permit: permit)
      XCTFail("no credential after the gate closed")
    } catch {}
    try? await Task.sleep(nanoseconds: 100_000_000)
    XCTAssertFalse(
      CommunityStubProtocol.started.contains("/v2/traffic/credentials"),
      "the asserted request carrying the key identifier was not sent")
  }

  func testClosingTheGateCancelsARequestInFlight() async throws {
    CommunityStubProtocol.sent = []
    CommunityStubProtocol.handler = { _ in (202, ["status": "accepted"], [:]) }
    CommunityStubProtocol.delay = { _ in 1 }
    CommunityStubProtocol.started = []
    let client = client()
    let (gate, permit) = try openGate()
    let batch = try batch()
    let upload = Task { await client.uploadProbes(batch, credential: "credential", permit: permit) }
    let started = await eventually { CommunityStubProtocol.started.contains("/v2/traffic/probes") }
    XCTAssertTrue(started)
    gate.setNavigating(false)
    let outcome = await upload.value
    XCTAssertEqual(outcome, .dropped, "the response is never delivered: the request was cancelled")
  }
}

/// The first credential request waits for `gate`, then answers 403 with a one-hour retry-after.
actor SlowCredentialTransport: NavOSSTrafficTransport {
  nonisolated let gate = StallGate()
  private(set) var credentialRequests = 0

  func trafficStatus() async throws -> NavOSSTrafficStatus {
    NavOSSTrafficStatus(mode: .live, accepting: true, rules: NavOSSTrafficProbeRules())
  }

  func trafficCredential(
    permit: NavOSSTrafficUploadPermit
  ) async throws -> NavOSSTrafficCredential {
    let id = UUID()
    guard permit.start(id, { {} }) else { throw NavOSSCommunityFailure.network }
    defer { permit.finish(id) }
    credentialRequests += 1
    await gate.wait()
    throw NavOSSCommunityFailure.installationTooNew(retryAfterSeconds: 3_600)
  }

  func uploadProbes(
    _ batch: NavOSSTrafficProbeBatch, credential: String, permit: NavOSSTrafficUploadPermit
  ) async -> NavOSSTrafficUploadOutcome {
    .dropped
  }
}
