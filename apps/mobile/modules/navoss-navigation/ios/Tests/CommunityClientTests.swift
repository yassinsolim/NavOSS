import CryptoKit
import Foundation
import XCTest

@testable import NavOSSNavigationCore

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// Serves canned responses and records what the client sent.
final class CommunityStubProtocol: URLProtocol {
  struct Sent {
    let body: [String: Any]?
    let method: String
    let path: String
    let query: String?
  }

  nonisolated(unsafe) static var handler: ((Sent) -> (Int, Any, [String: String]))?
  /// Network delay per request; the handler (the "server") sees requests in delivery order.
  nonisolated(unsafe) static var delay: ((Sent) -> Double)?
  nonisolated(unsafe) static var sent: [Sent] = []

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    var bodyData = request.httpBody
    if bodyData == nil, let stream = request.httpBodyStream {
      stream.open()
      var data = Data()
      var buffer = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count <= 0 { break }
        data.append(buffer, count: count)
      }
      stream.close()
      bodyData = data
    }
    let sent = Sent(
      body: bodyData.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] },
      method: request.httpMethod ?? "GET",
      path: request.url?.path ?? "",
      query: request.url?.query
    )
    let deliver = { [self] in
      Self.deliver(sent, to: self)
    }
    if let seconds = Self.delay?(sent), seconds > 0 {
      DispatchQueue.global().asyncAfter(deadline: .now() + seconds, execute: deliver)
    } else {
      deliver()
    }
  }

  private static let serverLock = NSLock()

  private static func deliver(_ sent: Sent, to stub: CommunityStubProtocol) {
    let (status, body, headers) = serverLock.withLock { () -> (Int, Any, [String: String]) in
      Self.sent.append(sent)
      return Self.handler?(sent) ?? (500, [:], [:])
    }
    let request = stub.request
    let client = stub.client
    let data = (try? JSONSerialization.data(withJSONObject: body)) ?? Data()
    let response = HTTPURLResponse(
      url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
    client?.urlProtocol(stub, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(stub, didLoad: data)
    client?.urlProtocolDidFinishLoading(stub)
  }

  override func stopLoading() {}
}

final class CommunityClientTests: XCTestCase {
  private let teamId = "ABCDE12345"
  private let bundleId = "org.navoss.mobile"
  private var store = NavOSSCommunityMemorySecretStore()
  /// Public keys the "server" registered, by key id.
  private var registered: [String: P256.Signing.PublicKey] = [:]
  private var counters: [String: UInt32] = [:]

  override func setUp() {
    reset()
  }

  private func reset() {
    store = NavOSSCommunityMemorySecretStore()
    registered = [:]
    counters = [:]
    CommunityStubProtocol.sent = []
    CommunityStubProtocol.handler = nil
  }

  private func makeClient(
    provider: NavOSSCommunityAttestationProvider? = nil
  ) -> NavOSSCommunityClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CommunityStubProtocol.self]
    return NavOSSCommunityClient(
      baseURL: URL(string: "http://127.0.0.1:3001")!,
      provider: provider
        ?? NavOSSDevelopmentAttestationProvider(teamId: teamId, bundleId: bundleId, store: store),
      store: store,
      session: URLSession(configuration: configuration)
    )
  }

  private func challenge(_ index: Int) -> String {
    Data(SHA256.hash(data: Data("challenge-\(index)".utf8))).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  private func problem(_ status: Int, _ title: String) -> (Int, Any, [String: String]) {
    (status, ["code": "x", "detail": "x", "requestId": "r", "status": status, "title": title], [:])
  }

  /// Verifies a development assertion the way the server does: CBOR shape, RP id hash, strictly
  /// increasing counter, and ECDSA P-256/SHA-256 over SHA-256(authData ‖ SHA-256(clientData)).
  private func verify(_ assertion: [String: Any], clientData: String) -> Bool {
    guard let keyId = assertion["keyId"] as? String,
      let key = registered[keyId],
      let encoded = (assertion["assertion"] as? String).flatMap({ Data(base64Encoded: $0) })
    else { return false }
    let bytes = [UInt8](encoded)
    // a2 69 "signature" (58 len | 40+len) sig 71 "authenticatorData" 58 25 authData
    guard bytes.first == 0xa2 else { return false }
    var index = 1
    func text() -> String? {
      let length = Int(bytes[index] & 0x1f)
      index += 1
      defer { index += length }
      return String(bytes: bytes[index..<(index + length)], encoding: .utf8)
    }
    func blob() -> Data {
      var length = Int(bytes[index] & 0x1f)
      index += 1
      if length == 24 {
        length = Int(bytes[index])
        index += 1
      }
      defer { index += length }
      return Data(bytes[index..<(index + length)])
    }
    guard text() == "signature" else { return false }
    let signature = blob()
    guard text() == "authenticatorData" else { return false }
    let authenticatorData = blob()
    guard authenticatorData.count == 37,
      authenticatorData.prefix(32) == Data(SHA256.hash(data: Data("\(teamId).\(bundleId)".utf8)))
    else { return false }
    let counter = authenticatorData.suffix(4).reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
    guard counter > counters[keyId, default: 0] else { return false }
    counters[keyId] = counter
    var signed = authenticatorData
    signed.append(Data(SHA256.hash(data: Data(clientData.utf8))))
    let nonce = Data(SHA256.hash(data: signed))
    guard let parsed = try? P256.Signing.ECDSASignature(derRepresentation: signature) else {
      return false
    }
    return key.isValidSignature(parsed, for: nonce)
  }

  /// A minimal honest server for registration, challenges and report writes.
  private func serve(
    unknownInstallationOnce: Bool = false,
    challengeFailures: Int = 0
  ) {
    var challengeIndex = 0
    var issued: [String] = []
    var rejectNextWrite = unknownInstallationOnce
    var remainingChallengeFailures = challengeFailures
    CommunityStubProtocol.handler = { [unowned self] sent in
      switch (sent.method, sent.path) {
      case ("POST", "/v2/community/challenges"):
        challengeIndex += 1
        issued.append(challenge(challengeIndex))
        return (200, ["challenge": issued.last!, "expiresAt": "2026-11-12T18:09:00.000Z"], [:])
      case ("POST", "/v2/community/installations"):
        let body = sent.body ?? [:]
        guard body["kind"] as? String == "development",
          let keyId = body["keyId"] as? String,
          let der = (body["publicKey"] as? String).flatMap({ Data(base64Encoded: $0) }),
          let key = try? P256.Signing.PublicKey(derRepresentation: der),
          Data(SHA256.hash(data: key.x963Representation)).base64EncodedString() == keyId
        else { return problem(403, "Attestation rejected") }
        registered[keyId] = key
        return (201, ["registeredAt": "2026-11-12T18:04:00.000Z", "status": "registered", "trust": "untrusted"], [:])
      case ("POST", "/v2/community/reports"):
        let body = sent.body ?? [:]
        let assertion = body["assertion"] as? [String: Any] ?? [:]
        if rejectNextWrite {
          rejectNextWrite = false
          registered.removeAll()
          return problem(401, "Unknown installation")
        }
        if remainingChallengeFailures > 0 {
          remainingChallengeFailures -= 1
          return problem(401, "Invalid challenge")
        }
        let coordinate = body["coordinate"] as? [String: Double] ?? [:]
        let clientData = navOSSCommunityAssertionClientData(
          challenge: assertion["challenge"] as? String ?? "",
          operation: .submitReport(
            type: NavOSSCarPlayReportType(rawValue: body["type"] as? String ?? "") ?? .pothole,
            coordinate: NavOSSCarPlayCoordinate(
              latitude: coordinate["latitude"] ?? 0, longitude: coordinate["longitude"] ?? 0),
            heading: body["heading"] as? Int
          )
        )
        guard verify(assertion, clientData: clientData) else {
          return problem(403, "Attestation rejected")
        }
        return (
          201,
          [
            "expiresAt": "2026-11-12T20:05:00.000Z",
            "reportId": "2f1a3c55-4b7e-4f8e-9f0e-0f1d2c3b4a59",
            "status": "accepted",
          ],
          [:]
        )
      default:
        return problem(404, "Not found")
      }
    }
  }

  private let calgary = NavOSSCarPlayCoordinate(latitude: 51.0447, longitude: -114.0719)

  func testRegistersOnceThenSignsEachWriteTheWayTheServerVerifies() async throws {
    serve()
    let client = makeClient()
    let first = try await client.submitReport(type: .pothole, coordinate: calgary, heading: 93)
    XCTAssertEqual(first.reportId, "2f1a3c55-4b7e-4f8e-9f0e-0f1d2c3b4a59")
    XCTAssertFalse(first.merged)
    _ = try await client.submitReport(type: .roadClosure, coordinate: calgary, heading: nil)
    let paths = CommunityStubProtocol.sent.map { "\($0.method) \($0.path)" }
    XCTAssertEqual(
      paths,
      [
        "POST /v2/community/challenges", "POST /v2/community/installations",
        "POST /v2/community/challenges", "POST /v2/community/reports",
        "POST /v2/community/challenges", "POST /v2/community/reports",
      ]
    )
    let stored = await client.hasIdentity
    XCTAssertTrue(stored)
    // Only the key id is persisted by the client (plus the DEBUG development key itself).
    XCTAssertNotNil(store.data(for: NavOSSCommunityClient.keyIdAccount))
  }

  func testUnknownInstallationReRegistersWithANewKeyAndRetriesOnce() async throws {
    serve(unknownInstallationOnce: true)
    let client = makeClient()
    _ = try await client.submitReport(type: .construction, coordinate: calgary, heading: nil)
    let registrations = CommunityStubProtocol.sent.filter { $0.path == "/v2/community/installations" }
    XCTAssertEqual(registrations.count, 2)
    XCTAssertNotEqual(registrations[0].body?["keyId"] as? String, registrations[1].body?["keyId"] as? String)
    XCTAssertEqual(
      String(data: store.data(for: NavOSSCommunityClient.keyIdAccount)!, encoding: .utf8),
      registrations[1].body?["keyId"] as? String
    )
  }

  func testAUsedChallengeIsRetriedOnceThenReported() async throws {
    serve(challengeFailures: 1)
    _ = try await makeClient().submitReport(type: .pothole, coordinate: calgary, heading: nil)
    reset()
    serve(challengeFailures: 2)
    do {
      _ = try await makeClient().submitReport(type: .pothole, coordinate: calgary, heading: nil)
      XCTFail("expected rejection")
    } catch {
      XCTAssertEqual(error as? NavOSSCommunityFailure, .rejected)
    }
  }

  func testUnsupportedDeviceCanReadButNotWrite() async throws {
    CommunityStubProtocol.handler = { sent in
      if sent.path == "/v2/community/reports", sent.method == "GET" {
        return (
          200,
          [
            "generatedAt": "2026-11-12T18:04:00.000Z",
            "publication": "attested",
            "reports": [
              [
                "confirmations": 0, "coordinate": ["latitude": 51.0445, "longitude": -114.072],
                "expiresAt": "2026-11-12T20:05:00.000Z", "id": "2f1a3c55-4b7e-4f8e-9f0e-0f1d2c3b4a59",
                "reportedAt": "2026-11-12T18:00:00.000Z", "source": "navoss-community",
                "state": "unconfirmed", "type": "pothole",
              ],
              [
                "confirmations": 2, "coordinate": ["latitude": 51.0455, "longitude": -114.071],
                "expiresAt": "2026-11-12T20:05:00.000Z", "id": "3f1a3c55-4b7e-4f8e-9f0e-0f1d2c3b4a59",
                "reportedAt": "2026-11-12T18:00:00.000Z", "source": "navoss-community",
                "state": "confirmed", "type": "type-from-a-newer-server",
              ],
            ],
          ],
          [:]
        )
      }
      return (500, [:], [:])
    }
    let client = makeClient(provider: NavOSSUnavailableAttestationProvider())
    XCTAssertFalse(client.canWrite)
    let page = try await client.reports(
      in: NavOSSCommunityBounds(east: -114.0, north: 51.1, south: 51.0, west: -114.1))
    XCTAssertEqual(page.reports.map(\.type), [.pothole])
    XCTAssertEqual(CommunityStubProtocol.sent.first?.query, "south=51.0&west=-114.1&north=51.1&east=-114.0")
    do {
      _ = try await client.submitReport(type: .pothole, coordinate: calgary, heading: nil)
      XCTFail("expected unsupported")
    } catch {
      XCTAssertEqual(error as? NavOSSCommunityFailure, .attestationUnsupported)
    }
    // Nothing was attempted against write endpoints.
    XCTAssertFalse(CommunityStubProtocol.sent.contains { $0.method == "POST" })
  }

  func testDeletingTheInstallationForgetsTheKeyAndAFreshOneRegistersNext() async throws {
    serve()
    let client = makeClient()
    _ = try await client.submitReport(type: .pothole, coordinate: calgary, heading: nil)
    let handler = CommunityStubProtocol.handler
    CommunityStubProtocol.handler = { sent in
      if sent.method == "DELETE", sent.path == "/v2/community/installations" {
        return (200, ["status": "deleted"], [:])
      }
      return handler!(sent)
    }
    try await client.deleteInstallation()
    XCTAssertNil(store.data(for: NavOSSCommunityClient.keyIdAccount))
    let before = CommunityStubProtocol.sent.count
    try await client.deleteInstallation()
    XCTAssertEqual(CommunityStubProtocol.sent.count, before, "no identity, nothing to delete")
  }

  func testInstallationTooNewForTrafficCarriesRetryAfter() async throws {
    serve()
    let handler = CommunityStubProtocol.handler
    CommunityStubProtocol.handler = { sent in
      if sent.path == "/v2/traffic/credentials" {
        return (
          403,
          ["code": "forbidden", "detail": "x", "requestId": "r", "status": 403, "title": "Installation too new"],
          ["retry-after": "3600"]
        )
      }
      return handler!(sent)
    }
    do {
      _ = try await makeClient().trafficCredential()
      XCTFail("expected too new")
    } catch {
      XCTAssertEqual(error as? NavOSSCommunityFailure, .installationTooNew(retryAfterSeconds: 3600))
    }
  }

  func testProbeUploadMapsEveryContractStatus() async {
    let batch = NavOSSTrafficProbeBatch(
      capturedAt: Date(timeIntervalSince1970: 1_794_506_640),
      firstPointAt: Date(timeIntervalSince1970: 1_794_506_650),
      points: [NavOSSTrafficProbePoint(latitude: 51, longitude: -114, offsetSeconds: 0)],
      schemaVersion: 1
    )
    let client = makeClient()
    for (status, expected) in [
      (202, NavOSSTrafficUploadOutcome.accepted), (400, .dropped), (401, .unauthorized),
      (429, .rateLimited), (503, .unavailable),
    ] {
      CommunityStubProtocol.handler = { _ in (status, ["status": "accepted"], [:]) }
      let outcome = await client.uploadProbes(batch, credential: String(repeating: "a", count: 40))
      XCTAssertEqual(outcome, expected, "status \(status)")
    }
  }

  func testConcurrentWritesReachTheServerInCounterOrder() async throws {
    serve()
    let inner = CommunityStubProtocol.handler!
    // The network delivers writes with random delays, so overlapping writes arrive out of order;
    // the server rejects a lower assertion counter as a replay.
    CommunityStubProtocol.handler = inner
    CommunityStubProtocol.delay = { sent in
      sent.path == "/v2/community/reports" ? Double.random(in: 0...0.08) : 0
    }
    defer { CommunityStubProtocol.delay = nil }
    let client = makeClient()
    _ = try await client.submitReport(type: .pothole, coordinate: calgary, heading: nil)
    try await withThrowingTaskGroup(of: Void.self) { group in
      for _ in 0..<6 {
        group.addTask {
          _ = try await client.submitReport(type: .pothole, coordinate: self.calgary, heading: nil)
        }
      }
      try await group.waitForAll()
    }
  }

  func testResetWithADeadLocalKeyDoesNotClaimTheServerDeletedIt() async throws {
    serve()
    let store = self.store
    let client = makeClient()
    _ = try await client.submitReport(type: .pothole, coordinate: calgary, heading: nil)
    // The Keychain kept the key id but the signing key is gone (restore to another device).
    for account in ["development-key." + String(data: store.data(for: NavOSSCommunityClient.keyIdAccount)!, encoding: .utf8)!] {
      store.remove(account)
    }
    do {
      try await client.deleteInstallation()
      XCTFail("must not report success")
    } catch {
      XCTAssertEqual(error as? NavOSSCommunityFailure, .identityUnavailable)
    }
    XCTAssertFalse(CommunityStubProtocol.sent.contains { $0.method == "DELETE" })
    // Never stuck: the dead identity is forgotten and the next write registers a fresh key.
    XCTAssertNil(store.data(for: NavOSSCommunityClient.keyIdAccount))
    _ = try await client.submitReport(type: .pothole, coordinate: calgary, heading: nil)
  }

  func testAppleOutageRetriesTheSameKeyAfterADelayInsteadOfANewOne() async throws {
    final class FlakyAttest: NavOSSCommunityAttestationProvider, @unchecked Sendable {
      let inner: NavOSSDevelopmentAttestationProvider
      var generated = 0
      var failuresLeft = 1
      var attestedKeys: [String] = []
      init(inner: NavOSSDevelopmentAttestationProvider) { self.inner = inner }
      var isSupported: Bool { true }
      func generateKey() async throws -> String {
        generated += 1
        return try await inner.generateKey()
      }
      func registrationMaterial(keyId: String, clientDataHash: Data) async throws
        -> NavOSSCommunityRegistrationMaterial
      {
        attestedKeys.append(keyId)
        if failuresLeft > 0 {
          failuresLeft -= 1
          throw NavOSSCommunityAttestationError.serviceUnavailable
        }
        return try await inner.registrationMaterial(keyId: keyId, clientDataHash: clientDataHash)
      }
      func assertion(keyId: String, clientDataHash: Data) async throws -> Data {
        try await inner.assertion(keyId: keyId, clientDataHash: clientDataHash)
      }
      func discardKey(keyId: String) { inner.discardKey(keyId: keyId) }
    }
    serve()
    let flaky = FlakyAttest(
      inner: NavOSSDevelopmentAttestationProvider(teamId: teamId, bundleId: bundleId, store: store))
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CommunityStubProtocol.self]
    let client = NavOSSCommunityClient(
      baseURL: URL(string: "http://127.0.0.1:3001")!, provider: flaky, store: store,
      session: URLSession(configuration: configuration), attestationRetryDelaySeconds: 0.2)
    do {
      _ = try await client.submitReport(type: .pothole, coordinate: calgary, heading: nil)
      XCTFail("expected the outage")
    } catch {
      XCTAssertEqual(error as? NavOSSCommunityFailure, .serviceUnavailable(retryAfterSeconds: 0))
    }
    // Inside the delay nothing is tried again.
    do {
      _ = try await client.submitReport(type: .pothole, coordinate: calgary, heading: nil)
      XCTFail("expected the delay")
    } catch {}
    XCTAssertEqual(flaky.attestedKeys.count, 1)
    try await Task.sleep(nanoseconds: 300_000_000)
    _ = try await client.submitReport(type: .pothole, coordinate: calgary, heading: nil)
    XCTAssertEqual(flaky.generated, 1, "the same key is retried")
    XCTAssertEqual(Set(flaky.attestedKeys).count, 1)
  }
}
