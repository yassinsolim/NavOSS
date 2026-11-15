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
