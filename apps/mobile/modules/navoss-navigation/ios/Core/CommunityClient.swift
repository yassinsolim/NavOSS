import CryptoKit
import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// Why a community request did not succeed, in terms a presenter can act on. Server messages are
/// matched by the `title` of the problem response (`apps/api/src/community-routes.ts`).
public enum NavOSSCommunityFailure: Error, Equatable, Sendable {
  /// No App Attest on this device or build. Reading still works; writing never will.
  case attestationUnsupported
  /// The installation registered recently; the server issues no traffic credential before then.
  case installationTooNew(retryAfterSeconds: Int?)
  case rateLimited(retryAfterSeconds: Int?)
  case serviceUnavailable(retryAfterSeconds: Int?)
  case outOfCoverage
  case tooFar
  case notFound
  case duplicateVote
  case selfVote
  /// Attestation, replay, development key under `enforce`, or impossible travel.
  case rejected
  case invalidRequest
  /// The local key can no longer sign (restored or migrated device), so the server could not be
  /// told to delete the installation. The local identity has been forgotten.
  case identityUnavailable
  /// Shared reports are not switched on by the driver, or the place is near home/the trip ends
  /// and was not explicitly confirmed. Nothing was sent.
  case notShared
  case nearPrivatePlace
  case network
  case invalidResponse
}

public enum NavOSSCommunityReportState: String, Codable, Sendable {
  case confirmed
  case unconfirmed
}

/// A published community report: grid-snapped position, five-minute times, never reporter
/// identity. It is never official data and never changes a route.
public struct NavOSSCommunityReport: Codable, Equatable, Sendable {
  public let confirmations: Int
  public let coordinate: NavOSSCarPlayCoordinate
  public let expiresAt: Date
  public let id: String
  public let reportedAt: Date
  public let state: NavOSSCommunityReportState
  public let type: NavOSSCarPlayReportType

  public init(
    confirmations: Int,
    coordinate: NavOSSCarPlayCoordinate,
    expiresAt: Date,
    id: String,
    reportedAt: Date,
    state: NavOSSCommunityReportState,
    type: NavOSSCarPlayReportType
  ) {
    self.confirmations = confirmations
    self.coordinate = coordinate
    self.expiresAt = expiresAt
    self.id = id
    self.reportedAt = reportedAt
    self.state = state
    self.type = type
  }
}

public struct NavOSSCommunityBounds: Equatable, Sendable {
  public let east: Double
  public let north: Double
  public let south: Double
  public let west: Double

  public init(east: Double, north: Double, south: Double, west: Double) {
    self.east = east
    self.north = north
    self.south = south
    self.west = west
  }

  public var isValid: Bool {
    [east, north, south, west].allSatisfy(\.isFinite) && north > south && east > west
      && south >= -90 && north <= 90 && west >= -180 && east <= 180
  }

  func contains(_ coordinate: NavOSSCarPlayCoordinate) -> Bool {
    coordinate.latitude >= south && coordinate.latitude <= north
      && coordinate.longitude >= west && coordinate.longitude <= east
  }

  func contains(_ other: NavOSSCommunityBounds) -> Bool {
    other.south >= south && other.north <= north && other.west >= west && other.east <= east
  }
}

public struct NavOSSCommunityReportPage: Equatable, Sendable {
  public let generatedAt: Date
  public let publication: String
  public let reports: [NavOSSCommunityReport]
}

public struct NavOSSCommunitySubmission: Equatable, Sendable {
  public let expiresAt: Date
  public let merged: Bool
  public let reportId: String
}

public struct NavOSSCommunityFeatures: Equatable, Sendable {
  public let communityReports: Bool
}

public struct NavOSSTrafficCredential: Equatable, Sendable {
  public let expiresAt: Date
  public let value: String
}

/// `GET /v2/traffic/status`: the mode and rules, never counts.
public struct NavOSSTrafficStatus: Equatable, Sendable {
  public enum Mode: String, Sendable {
    case off
    case collecting
    case live
  }

  public let mode: Mode
  public let accepting: Bool
  public let rules: NavOSSTrafficProbeRules
}

/// How the server answered one probe batch. The client never retries or stores a batch.
public enum NavOSSTrafficUploadOutcome: Equatable, Sendable {
  case accepted
  case dropped
  case unauthorized
  case rateLimited
  case unavailable
}

/// Client for `/v2/community/*` and `/v2/traffic/*`, shared by the phone and CarPlay. Writes are
/// asserted with App Attest (or, in DEBUG Simulator builds, a development key). Only the key id
/// is persisted, in the Keychain. Nothing here logs coordinates, key ids, or assertions.
public actor NavOSSCommunityClient {
  static let keyIdAccount = "app-attest-key-id"

  private let baseURL: URL
  private let decoder: JSONDecoder
  private let encoder = JSONEncoder()
  private let provider: NavOSSCommunityAttestationProvider
  private var registration: Task<String, Error>?
  /// A key Apple could not attest because its service was unavailable, kept for a retry.
  private var pendingAttestation: (keyId: String, retryAfter: Date)?
  private let attestationRetryDelaySeconds: TimeInterval
  /// One asserted write at a time, challenge to response, so assertion counters reach the server
  /// in order (it rejects a lower counter as a replay) and identity changes never interleave.
  private var writeBusy = false
  private var writeWaiters: [CheckedContinuation<Void, Never>] = []
  private let session: URLSession
  private let store: NavOSSCommunitySecretStore

  public init(
    baseURL: URL,
    provider: NavOSSCommunityAttestationProvider,
    store: NavOSSCommunitySecretStore,
    session: URLSession = .shared,
    attestationRetryDelaySeconds: TimeInterval = 60
  ) {
    self.attestationRetryDelaySeconds = attestationRetryDelaySeconds
    self.baseURL = baseURL
    self.provider = provider
    self.session = session
    self.store = store
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let value = try decoder.singleValueContainer().decode(String.self)
      guard let date = navOSSParseISODate(value) else {
        throw DecodingError.dataCorrupted(
          .init(codingPath: decoder.codingPath, debugDescription: "Invalid date")
        )
      }
      return date
    }
    self.decoder = decoder
  }

  public nonisolated var canWrite: Bool {
    provider.isSupported
  }

  /// Whether a key id is stored (the installation has registered at least once).
  public var hasIdentity: Bool {
    storedKeyId != nil
  }

  private var storedKeyId: String? {
    store.data(for: Self.keyIdAccount).flatMap { String(data: $0, encoding: .utf8) }
  }

  // MARK: Reads (no identity)

  public func features() async throws -> NavOSSCommunityFeatures {
    struct Response: Decodable {
      // Lenient like the rest of the native config: a missing or malformed flag means off.
      struct Features: Decodable {
        let communityReports: Bool?

        init(from decoder: Decoder) throws {
          let container = try decoder.container(keyedBy: CodingKeys.self)
          communityReports = try? container.decodeIfPresent(Bool.self, forKey: .communityReports)
        }

        private enum CodingKeys: String, CodingKey {
          case communityReports
        }
      }

      let features: Features?
    }
    let response: Response = try await send(request("GET", "/v2/config"))
    return NavOSSCommunityFeatures(communityReports: response.features?.communityReports ?? false)
  }

  public func reports(in bounds: NavOSSCommunityBounds) async throws -> NavOSSCommunityReportPage {
    struct Response: Decodable {
      let generatedAt: Date
      let publication: String
      let reports: [Report]
    }
    struct Report: Decodable {
      let confirmations: Int
      let coordinate: NavOSSCarPlayCoordinate
      let expiresAt: Date
      let id: String
      let reportedAt: Date
      let state: NavOSSCommunityReportState
      let type: String
    }
    guard bounds.isValid else { throw NavOSSCommunityFailure.invalidRequest }
    let query = [
      URLQueryItem(name: "south", value: String(bounds.south)),
      URLQueryItem(name: "west", value: String(bounds.west)),
      URLQueryItem(name: "north", value: String(bounds.north)),
      URLQueryItem(name: "east", value: String(bounds.east)),
    ]
    let response: Response = try await send(request("GET", "/v2/community/reports", query: query))
    return NavOSSCommunityReportPage(
      generatedAt: response.generatedAt,
      publication: response.publication,
      // A type this build does not know is skipped rather than drawn as something else.
      reports: response.reports.compactMap { report in
        NavOSSCarPlayReportType(rawValue: report.type).map {
          NavOSSCommunityReport(
            confirmations: report.confirmations,
            coordinate: report.coordinate,
            expiresAt: report.expiresAt,
            id: report.id,
            reportedAt: report.reportedAt,
            state: report.state,
            type: $0
          )
        }
      }
    )
  }

  public func trafficStatus() async throws -> NavOSSTrafficStatus {
    struct Response: Decodable {
      struct Probes: Decodable {
        let accepting: Bool
        let batchTargetMeters: Double
        let batchTargetSeconds: Double
        let maxBatchSeconds: Int
        let maxGapSeconds: Int
        let maxPoints: Int
        let minPoints: Int
        let sampleIntervalSeconds: Double
        let schemaVersion: Int
        let tripEndTrimMeters: Double
      }

      let mode: String
      let probes: Probes
    }
    let response: Response = try await send(request("GET", "/v2/traffic/status"))
    guard let mode = NavOSSTrafficStatus.Mode(rawValue: response.mode) else {
      throw NavOSSCommunityFailure.invalidResponse
    }
    let probes = response.probes
    return NavOSSTrafficStatus(
      mode: mode,
      accepting: probes.accepting && mode != .off,
      rules: NavOSSTrafficProbeRules(
        batchTargetMeters: probes.batchTargetMeters,
        batchTargetSeconds: probes.batchTargetSeconds,
        maxBatchSeconds: probes.maxBatchSeconds,
        maxGapSeconds: probes.maxGapSeconds,
        maxPoints: probes.maxPoints,
        minPoints: probes.minPoints,
        sampleIntervalSeconds: probes.sampleIntervalSeconds,
        schemaVersion: probes.schemaVersion,
        tripEndTrimMeters: probes.tripEndTrimMeters
      )
    )
  }

  // MARK: Writes (asserted)

  public func submitReport(
    type: NavOSSCarPlayReportType,
    coordinate: NavOSSCarPlayCoordinate,
    heading: Int?
  ) async throws -> NavOSSCommunitySubmission {
    struct Body: Encodable {
      let assertion: AssertionBody
      let coordinate: NavOSSCarPlayCoordinate
      let heading: Int?
      let type: String
    }
    struct Response: Decodable {
      let expiresAt: Date
      let reportId: String
      let status: String
    }
    guard coordinate.isValid else { throw NavOSSCommunityFailure.invalidRequest }
    let heading = heading.map { (($0 % 360) + 360) % 360 }
    let response: Response = try await asserted(
      .submitReport(type: type, coordinate: coordinate, heading: heading)
    ) { assertion in
      try self.request(
        "POST", "/v2/community/reports",
        body: Body(assertion: assertion, coordinate: coordinate, heading: heading, type: type.rawValue)
      )
    }
    return NavOSSCommunitySubmission(
      expiresAt: response.expiresAt,
      merged: response.status == "merged",
      reportId: response.reportId
    )
  }

  /// Records a vote; returns whether the report is still active afterwards.
  public func vote(
    reportId: String,
    vote: NavOSSCommunityVote,
    observedAt: NavOSSCarPlayCoordinate
  ) async throws -> Bool {
    struct Body: Encodable {
      let assertion: AssertionBody
      let observedAt: NavOSSCarPlayCoordinate
      let vote: String
    }
    struct Response: Decodable {
      let active: Bool
    }
    guard observedAt.isValid, let path = Self.reportPath(reportId, suffix: "/votes") else {
      throw NavOSSCommunityFailure.invalidRequest
    }
    let response: Response = try await asserted(
      .vote(reportId: reportId, vote: vote, observedAt: observedAt)
    ) { assertion in
      try self.request(
        "POST", path, body: Body(assertion: assertion, observedAt: observedAt, vote: vote.rawValue)
      )
    }
    return response.active
  }

  public func withdraw(reportId: String) async throws {
    guard let path = Self.reportPath(reportId, suffix: "") else {
      throw NavOSSCommunityFailure.invalidRequest
    }
    let _: Ignored = try await asserted(.deleteReport(reportId: reportId)) { assertion in
      try self.request("DELETE", path, body: AssertedBody(assertion: assertion))
    }
  }

  /// Deletes the installation with all its reports and votes on the server, then forgets the
  /// key locally. With no stored key there is nothing on the server to delete.
  public func deleteInstallation() async throws {
    guard let keyId = storedKeyId else { return }
    do {
      let _: Ignored = try await asserted(.deleteInstallation, reRegister: false) { assertion in
        try self.request(
          "DELETE", "/v2/community/installations", body: AssertedBody(assertion: assertion)
        )
      }
    } catch NavOSSCommunityFailure.attestationUnsupported {
      // A key the device can no longer use cannot sign anything either.
    } catch NavOSSCommunityFailure.notFound {
      // The server no longer knows this installation; there is nothing left to delete.
    }
    forget(keyId: keyId)
  }

  public func trafficCredential() async throws -> NavOSSTrafficCredential {
    struct Response: Decodable {
      let credential: String
      let expiresAt: Date
    }
    let response: Response = try await asserted(.trafficCredential) { assertion in
      try self.request("POST", "/v2/traffic/credentials", body: AssertedBody(assertion: assertion))
    }
    return NavOSSTrafficCredential(expiresAt: response.expiresAt, value: response.credential)
  }

  /// Sends one batch once. 202 accepted; 400 drop; 401 new credential; 429 stop; 503 pause.
  public func uploadProbes(_ batch: NavOSSTrafficProbeBatch, credential: String) async
    -> NavOSSTrafficUploadOutcome
  {
    guard let body = try? batch.requestBody(credential: credential),
      let request = try? rawRequest("POST", "/v2/traffic/probes", body: body)
    else {
      return .dropped
    }
    // A batch that did not arrive is dropped like any other: never retried or kept.
    guard let (_, response) = try? await session.data(for: request),
      let status = (response as? HTTPURLResponse)?.statusCode
    else {
      return .dropped
    }
    switch status {
    case 200..<300: return .accepted
    case 401: return .unauthorized
    case 429: return .rateLimited
    case 503: return .unavailable
    default: return .dropped
    }
  }

  // MARK: Registration and assertion

  private struct AssertionBody: Encodable {
    let assertion: String
    let challenge: String
    let keyId: String
  }

  private struct AssertedBody: Encodable {
    let assertion: AssertionBody
  }

  private struct Ignored: Decodable {}

  private func challenge() async throws -> String {
    struct Response: Decodable {
      let challenge: String
    }
    let response: Response = try await send(request("POST", "/v2/community/challenges"))
    return response.challenge
  }

  /// Registers once; concurrent writers share one registration.
  private func ensureRegistered() async throws -> String {
    if let keyId = storedKeyId { return keyId }
    if let registration { return try await registration.value }
    let task = Task { try await self.register() }
    registration = task
    defer { registration = nil }
    return try await task.value
  }

  private func register() async throws -> String {
    struct Body: Encodable {
      let attestationObject: String?
      let challenge: String
      let keyId: String
      let kind: String
      let publicKey: String?
    }
    guard provider.isSupported else { throw NavOSSCommunityFailure.attestationUnsupported }
    // After Apple's attestation service was unavailable, wait, then retry with the same key
    // (Apple's flow) instead of generating a new one.
    if let pending = pendingAttestation, Date() < pending.retryAfter {
      throw NavOSSCommunityFailure.serviceUnavailable(
        retryAfterSeconds: Int(pending.retryAfter.timeIntervalSinceNow.rounded(.up)))
    }
    let keyId: String
    if let pending = pendingAttestation {
      keyId = pending.keyId
    } else {
      keyId = try await mapped { try await self.provider.generateKey() }
    }
    pendingAttestation = nil
    do {
      let challenge = try await challenge()
      let material: NavOSSCommunityRegistrationMaterial
      do {
        material = try await provider.registrationMaterial(
          keyId: keyId,
          clientDataHash: navOSSSHA256(Data(challenge.utf8))
        )
      } catch NavOSSCommunityAttestationError.serviceUnavailable {
        pendingAttestation = (keyId, Date().addingTimeInterval(attestationRetryDelaySeconds))
        throw NavOSSCommunityFailure.serviceUnavailable(
          retryAfterSeconds: Int(attestationRetryDelaySeconds))
      } catch {
        _ = try await mapped { throw error }
        throw error
      }
      let body: Body
      switch material {
      case let .appAttest(attestationObject):
        body = Body(
          attestationObject: attestationObject.base64EncodedString(), challenge: challenge,
          keyId: keyId, kind: "app-attest", publicKey: nil)
      case let .development(publicKey):
        body = Body(
          attestationObject: nil, challenge: challenge, keyId: keyId, kind: "development",
          publicKey: publicKey.base64EncodedString())
      }
      let _: Ignored = try await send(request("POST", "/v2/community/installations", body: body))
      guard store.set(Data(keyId.utf8), for: Self.keyIdAccount) else {
        throw NavOSSCommunityFailure.rejected
      }
      return keyId
    } catch {
      if pendingAttestation?.keyId != keyId {
        provider.discardKey(keyId: keyId)
      }
      throw error
    }
  }

  private func forget(keyId: String) {
    store.remove(Self.keyIdAccount)
    provider.discardKey(keyId: keyId)
  }

  /// One asserted write with a fresh challenge. A 401 (used challenge or unknown installation)
  /// or an invalid local key is retried once; an unknown installation or invalid key first gets a
  /// new key and registration.
  private func asserted<Response: Decodable>(
    _ operation: NavOSSCommunityOperation,
    reRegister: Bool = true,
    makeRequest: (AssertionBody) throws -> URLRequest
  ) async throws -> Response {
    await acquireWrite()
    defer { releaseWrite() }
    var attempt = 0
    while true {
      attempt += 1
      var keyId: String?
      do {
        let registeredKeyId = try await ensureRegistered()
        keyId = registeredKeyId
        let challenge = try await challenge()
        let assertion = try await mapped {
          try await self.provider.assertion(
            keyId: registeredKeyId,
            clientDataHash: navOSSCommunityClientDataHash(challenge: challenge, operation: operation)
          )
        }
        return try await send(
          makeRequest(
            AssertionBody(
              assertion: assertion.base64EncodedString(), challenge: challenge,
              keyId: registeredKeyId)
          )
        )
      } catch let failure as RetryableFailure {
        if let keyId, failure != .usedChallenge {
          forget(keyId: keyId)
          guard reRegister else {
            // Server said it does not know us: truly gone. A dead local key: we could not ask.
            throw failure == .unknownInstallation
              ? NavOSSCommunityFailure.notFound : NavOSSCommunityFailure.identityUnavailable
          }
        }
        guard attempt == 1 else { throw NavOSSCommunityFailure.rejected }
      }
    }
  }

  private func acquireWrite() async {
    guard writeBusy else {
      writeBusy = true
      return
    }
    await withCheckedContinuation { writeWaiters.append($0) }
  }

  private func releaseWrite() {
    if writeWaiters.isEmpty {
      writeBusy = false
    } else {
      writeWaiters.removeFirst().resume()
    }
  }

  private enum RetryableFailure: Error {
    case invalidKey
    case unknownInstallation
    case usedChallenge
  }

  private func mapped<T>(_ work: () async throws -> T) async throws -> T {
    do {
      return try await work()
    } catch let error as NavOSSCommunityAttestationError {
      switch error {
      case .unsupported: throw NavOSSCommunityFailure.attestationUnsupported
      case .invalidKey: throw RetryableFailure.invalidKey
      case .serviceUnavailable: throw NavOSSCommunityFailure.serviceUnavailable(retryAfterSeconds: nil)
      case .failed: throw NavOSSCommunityFailure.rejected
      }
    }
  }

  // MARK: HTTP

  private static func reportPath(_ reportId: String, suffix: String) -> String? {
    guard UUID(uuidString: reportId) != nil else { return nil }
    return "/v2/community/reports/\(reportId)\(suffix)"
  }

  private func request(
    _ method: String,
    _ path: String,
    query: [URLQueryItem] = []
  ) throws -> URLRequest {
    try rawRequest(method, path, body: nil, query: query)
  }

  private func request<Body: Encodable>(
    _ method: String,
    _ path: String,
    body: Body
  ) throws -> URLRequest {
    try rawRequest(method, path, body: try encoder.encode(body))
  }

  private func rawRequest(
    _ method: String,
    _ path: String,
    body: Data?,
    query: [URLQueryItem] = []
  ) throws -> URLRequest {
    guard var components = URLComponents(
      url: baseURL.appendingPathComponent(String(path.dropFirst())),
      resolvingAgainstBaseURL: false
    ) else {
      throw NavOSSCommunityFailure.invalidRequest
    }
    if !query.isEmpty { components.queryItems = query }
    guard let url = components.url else { throw NavOSSCommunityFailure.invalidRequest }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.timeoutInterval = 15
    request.setValue("application/json", forHTTPHeaderField: "accept")
    if let body {
      request.httpBody = body
      request.setValue("application/json", forHTTPHeaderField: "content-type")
    }
    return request
  }

  private func send<Response: Decodable>(_ request: URLRequest) async throws -> Response {
    let data = try await sendData(request)
    do {
      return try decoder.decode(Response.self, from: data)
    } catch {
      throw NavOSSCommunityFailure.invalidResponse
    }
  }

  private func sendData(_ request: URLRequest) async throws -> Data {
    let data: Data
    let urlResponse: URLResponse
    do {
      (data, urlResponse) = try await session.data(for: request)
    } catch {
      throw NavOSSCommunityFailure.network
    }
    guard let response = urlResponse as? HTTPURLResponse else {
      throw NavOSSCommunityFailure.invalidResponse
    }
    if (200..<300).contains(response.statusCode) { return data }
    throw Self.failure(status: response.statusCode, data: data, response: response)
  }

  private static func failure(status: Int, data: Data, response: HTTPURLResponse) -> Error {
    struct Problem: Decodable {
      let title: String
    }
    let title = (try? JSONDecoder().decode(Problem.self, from: data))?.title ?? ""
    let retryAfter = response.value(forHTTPHeaderField: "retry-after").flatMap { Int($0) }
    switch status {
    case 400:
      switch title {
      case "Report outside coverage": return NavOSSCommunityFailure.outOfCoverage
      case "Vote too far from report": return NavOSSCommunityFailure.tooFar
      default: return NavOSSCommunityFailure.invalidRequest
      }
    case 401:
      return title == "Unknown installation"
        ? RetryableFailure.unknownInstallation : RetryableFailure.usedChallenge
    case 403:
      switch title {
      case "Installation too new":
        return NavOSSCommunityFailure.installationTooNew(retryAfterSeconds: retryAfter)
      case "Self-vote rejected": return NavOSSCommunityFailure.selfVote
      default: return NavOSSCommunityFailure.rejected
      }
    case 404: return NavOSSCommunityFailure.notFound
    case 409:
      return title == "Duplicate vote"
        ? NavOSSCommunityFailure.duplicateVote : NavOSSCommunityFailure.rejected
    case 429: return NavOSSCommunityFailure.rateLimited(retryAfterSeconds: retryAfter)
    case 500...: return NavOSSCommunityFailure.serviceUnavailable(retryAfterSeconds: retryAfter)
    default: return NavOSSCommunityFailure.invalidRequest
    }
  }
}

func navOSSParseISODate(_ value: String) -> Date? {
  let fractional = ISO8601DateFormatter()
  fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let date = fractional.date(from: value) { return date }
  return ISO8601DateFormatter().date(from: value)
}

func navOSSSHA256(_ data: Data) -> Data {
  Data(SHA256.hash(data: data))
}
