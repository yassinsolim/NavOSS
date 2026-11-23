import Foundation

/// Carries the API client's requests to the host and its answers back (see "HTTP" in
/// docs/architecture/android-core.md).
final class NavOSSCoreHTTP: @unchecked Sendable {
  private typealias Continuation = CheckedContinuation<NavOSSHTTPResponse, Error>

  /// Where a request stands between the core and the host. The host is never called with
  /// `lock` held; these states are what keeps `httpRequest` and `cancelHttpRequest` in order
  /// for one id all the same: a request is cancelled at the host only after it was given to
  /// it, and one cancelled before that is never given.
  private enum Pending {
    /// Cancelled before its continuation was registered.
    case cancelled
    /// Registered, not yet shown to the host. Cancelling it here drops it.
    case registered(Continuation)
    /// `httpRequest` is being called. A cancel now makes it `abandoned`.
    case publishing(Continuation)
    /// Cancelled while `httpRequest` was being called; its continuation was resumed. The
    /// publisher cancels it at the host as soon as `httpRequest` returns.
    case abandoned
    /// The host has it and has not answered.
    case published(Continuation)
  }

  private let bridge: NavOSSCoreHostBridge
  private let lock = NSLock()
  private var nextId: Int64 = 1
  private var pending: [Int64: Pending] = [:]
  /// Requests the host holds that were cancelled where the host could not be called (a task
  /// is cancelled with the engine lock held). Told to the host by `flushHostCancellations`.
  private var hostCancellations: [Int64] = []
  private var closed = false
  #if DEBUG
    /// Tests: runs after a request is registered and before the host is given it.
    var willPublish: ((Int64) -> Void)?
    /// Tests: runs once a registered request was given to the host or dropped.
    var didPublish: ((Int64) -> Void)?
  #endif

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
    // A cancel that arrives as the answer does finds nothing and leaves its mark; remove it.
    defer {
      lock.withLock {
        if case .cancelled = pending[id] { pending[id] = nil }
      }
    }
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        let registered = lock.withLock {
          if case .cancelled = pending[id] {
            pending[id] = nil
            continuation.resume(throwing: CancellationError())
            return false
          }
          guard !closed else {
            continuation.resume(throwing: NavOSSHTTPUnreachable())
            return false
          }
          pending[id] = .registered(continuation)
          return true
        }
        guard registered else { return }
        #if DEBUG
          willPublish?(id)
        #endif
        publish(id, request)
        #if DEBUG
          didPublish?(id)
        #endif
      }
    } onCancel: {
      cancel(id)
    }
  }

  /// Gives a registered request to the host, unless it was cancelled meanwhile. One delivery
  /// covers `httpRequest` and the cancel of a request abandoned during it, so `close()` waits
  /// for both.
  private func publish(_ id: Int64, _ request: NavOSSHTTPRequest) {
    let delivered: Void? = bridge.deliver { host in
      let publishes = lock.withLock {
        guard case .registered(let continuation) = pending[id] else { return false }
        pending[id] = .publishing(continuation)
        return true
      }
      guard publishes else { return }
      host.httpRequest(id: id, json: Self.requestJSON(request))
      let abandoned = lock.withLock {
        switch pending[id] {
        case .publishing(let continuation):
          pending[id] = .published(continuation)
          return false
        case .abandoned:
          pending[id] = nil
          return true
        case .cancelled, .registered, .published, nil:
          // `nil`: the host answered from inside `httpRequest`.
          return false
        }
      }
      if abandoned { host.cancelHTTPRequest(id: id) }
    }
    guard delivered == nil else { return }
    // Closed before the host saw it.
    let continuation: Continuation? = lock.withLock {
      guard case .registered(let continuation) = pending[id] else { return nil }
      pending[id] = nil
      return continuation
    }
    continuation?.resume(throwing: NavOSSHTTPUnreachable())
  }

  /// The request's task was cancelled. Runs wherever the task was cancelled, which for a
  /// reroute is inside the engine with its lock held, so the host is not called from here:
  /// a host blocked on another thread's core call would never return.
  private func cancel(_ id: Int64) {
    let (continuation, tellsHost): (Continuation?, Bool) = lock.withLock {
      switch pending[id] {
      case nil:
        pending[id] = .cancelled
        return (nil, false)
      case .registered(let continuation):
        pending[id] = nil
        return (continuation, false)
      case .publishing(let continuation):
        pending[id] = .abandoned
        return (continuation, false)
      case .published(let continuation):
        pending[id] = nil
        hostCancellations.append(id)
        return (continuation, true)
      case .cancelled, .abandoned:
        return (nil, false)
      }
    }
    continuation?.resume(throwing: CancellationError())
    if tellsHost {
      Task.detached { [weak self] in self?.flushHostCancellations() }
    }
  }

  /// Tells the host about the requests cancelled since the last call. Never with a lock held.
  private func flushHostCancellations() {
    let ids: [Int64] = lock.withLock {
      defer { hostCancellations.removeAll() }
      return hostCancellations
    }
    for id in ids {
      bridge.deliver { $0.cancelHTTPRequest(id: id) }
    }
  }

  /// The host's answer to request `id`. Unknown, cancelled or repeated ids are ignored.
  func complete(id: Int64, responseJSON: String) {
    let continuation: Continuation? = lock.withLock {
      switch pending[id] {
      case .publishing(let continuation), .published(let continuation):
        pending[id] = nil
        return continuation
      case .cancelled, .registered, .abandoned, nil:
        return nil
      }
    }
    guard let continuation else { return }
    switch Self.response(responseJSON) {
    case .success(let response): continuation.resume(returning: response)
    case .failure(let error): continuation.resume(throwing: error)
    }
  }

  /// `close()`: cancels at the host every request it holds, fails them as cancelled, and
  /// fails every later one as unreachable. Call before the host is revoked.
  func close() {
    let continuations: [Continuation] = lock.withLock {
      closed = true
      var continuations: [Continuation] = []
      for (id, entry) in pending {
        switch entry {
        case .registered(let continuation):
          pending[id] = nil
          continuations.append(continuation)
        case .publishing(let continuation):
          pending[id] = .abandoned
          continuations.append(continuation)
        case .published(let continuation):
          pending[id] = nil
          hostCancellations.append(id)
          continuations.append(continuation)
        case .cancelled, .abandoned:
          break
        }
      }
      return continuations
    }
    for continuation in continuations {
      continuation.resume(throwing: CancellationError())
    }
    flushHostCancellations()
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

  /// `{"status", "body"}` or `{"error"}`. Anything else is treated as unreachable, except an
  /// answer above `navOSSCoreMaximumJSONBytes`, which is an invalid response.
  static func response(_ json: String) -> Result<NavOSSHTTPResponse, Error> {
    // The host bounds what it reads from the network; an answer above the boundary's own
    // ceiling is refused unread, as an answer that makes no sense.
    guard json.utf8.count <= navOSSCoreMaximumJSONBytes else {
      return .failure(NavOSSNavigationAPIError.invalidResponse)
    }
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
