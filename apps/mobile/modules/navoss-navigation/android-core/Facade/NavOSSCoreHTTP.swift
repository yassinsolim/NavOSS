import Foundation

/// Carries the API client's requests to the host and its answers back (see "HTTP" in
/// docs/architecture/android-core.md).
final class NavOSSCoreHTTP: @unchecked Sendable {
  private enum Pending {
    case waiting(CheckedContinuation<NavOSSHTTPResponse, Error>)
    /// Cancelled before its continuation was registered.
    case cancelled
  }

  private let bridge: NavOSSCoreHostBridge
  private let lock = NSLock()
  private var nextId: Int64 = 1
  private var pending: [Int64: Pending] = [:]
  private var closed = false

  init(bridge: NavOSSCoreHostBridge) {
    self.bridge = bridge
  }

  var transport: NavOSSHTTPTransport {
    { [weak self] request in
      guard let self else { throw NavOSSHTTPUnreachable() }
      return try await self.send(request)
    }
  }

  private func send(_ request: NavOSSHTTPRequest) async throws -> NavOSSHTTPResponse {
    let id = lock.withLock {
      defer { nextId += 1 }
      return nextId
    }
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        let host: NavOSSCoreHost? = lock.withLock {
          if case .cancelled = pending[id] {
            pending[id] = nil
            continuation.resume(throwing: CancellationError())
            return nil
          }
          guard !closed, let host = bridge.current else {
            continuation.resume(throwing: NavOSSHTTPUnreachable())
            return nil
          }
          pending[id] = .waiting(continuation)
          return host
        }
        host?.httpRequest(id: id, json: Self.requestJSON(request))
      }
    } onCancel: {
      let continuation: CheckedContinuation<NavOSSHTTPResponse, Error>? = lock.withLock {
        switch pending[id] {
        case .waiting(let continuation):
          pending[id] = nil
          return continuation
        case .cancelled:
          return nil
        case nil:
          pending[id] = .cancelled
          return nil
        }
      }
      if let continuation {
        continuation.resume(throwing: CancellationError())
        bridge.current?.cancelHTTPRequest(id: id)
      }
    }
  }

  /// The host's answer to request `id`. Unknown, cancelled or repeated ids are ignored.
  func complete(id: Int64, responseJSON: String) {
    let continuation: CheckedContinuation<NavOSSHTTPResponse, Error>? = lock.withLock {
      guard case .waiting(let continuation) = pending[id] else { return nil }
      pending[id] = nil
      return continuation
    }
    guard let continuation else { return }
    switch Self.response(responseJSON) {
    case .success(let response): continuation.resume(returning: response)
    case .failure(let error): continuation.resume(throwing: error)
    }
  }

  /// `close()`: fails every pending request as cancelled, and every later one as unreachable.
  func cancelAll() {
    let continuations: [CheckedContinuation<NavOSSHTTPResponse, Error>] = lock.withLock {
      closed = true
      let waiting = pending.values.compactMap { entry -> CheckedContinuation<NavOSSHTTPResponse, Error>? in
        if case .waiting(let continuation) = entry { return continuation }
        return nil
      }
      pending.removeAll()
      return waiting
    }
    for continuation in continuations {
      continuation.resume(throwing: CancellationError())
    }
  }

  static func requestJSON(_ request: NavOSSHTTPRequest) -> String {
    var payload: [String: NavOSSCoreJSON] = [
      "headers": .object(request.headers.mapValues { .string($0) }),
      "method": .string(request.method),
      "timeoutMs": .double(request.timeout * 1_000),
      "url": .string(request.url.absoluteString),
    ]
    if let body = request.body {
      payload["body"] = .string(String(decoding: body, as: UTF8.self))
    }
    return NavOSSCoreJSON.object(payload).encodedString()
  }

  private struct ResponseRecord: Decodable {
    let status: Int?
    let body: String?
    let error: String?
  }

  /// `{"status", "body"}` or `{"error"}`. Anything else is treated as unreachable.
  static func response(_ json: String) -> Result<NavOSSHTTPResponse, Error> {
    guard let record = try? JSONDecoder().decode(ResponseRecord.self, from: Data(json.utf8)) else {
      return .failure(NavOSSHTTPUnreachable())
    }
    if record.error == "cancelled" {
      return .failure(CancellationError())
    }
    guard record.error == nil, let status = record.status else {
      return .failure(NavOSSHTTPUnreachable())
    }
    return .success(NavOSSHTTPResponse(statusCode: status, body: Data((record.body ?? "").utf8)))
  }
}
