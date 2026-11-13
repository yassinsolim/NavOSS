import Foundation

/// What the uploader needs from the network; `NavOSSCommunityClient` in the app, a fake in tests.
public protocol NavOSSTrafficTransport: Sendable {
  func trafficStatus() async throws -> NavOSSTrafficStatus
  func trafficCredential() async throws -> NavOSSTrafficCredential
  func uploadProbes(_ batch: NavOSSTrafficProbeBatch, credential: String) async
    -> NavOSSTrafficUploadOutcome
}

extension NavOSSCommunityClient: NavOSSTrafficTransport {}

/// What "Share traffic speeds" is doing, for the phone and CarPlay to show calmly.
public enum NavOSSTrafficSharingState: Equatable, Sendable {
  /// The switch is off (the default).
  case off
  /// On, waiting for turn-by-turn navigation.
  case ready
  /// Checking the server and asking for an upload credential.
  case starting
  /// Uploading during this trip.
  case sharing
  /// The server answered 503: nothing is collected until `until`.
  case paused(until: Date)
  /// A new installation contributes from the next day; nothing is collected before `until`.
  case startsLater(until: Date)
  /// Not for this trip: the server is not accepting, rate-limited this installation, or this
  /// device cannot attest.
  case unavailable(reason: Reason)

  public enum Reason: String, Sendable {
    case notAccepting = "not-accepting"
    case rateLimited = "rate-limited"
    case unsupported
    case rejected
    case offline
  }
}

/// Uploads community-traffic probes during one turn-by-turn trip at a time, following the
/// server contract exactly: status first, one credential held in memory and refreshed shortly
/// before expiry, batches sent once in order and never retried or stored; 401 → one new
/// credential, 429 → stop for the trip, 503 → pause five minutes, 400 → drop.
public actor NavOSSTrafficSharingSession {
  public static let credentialRefreshMarginSeconds: TimeInterval = 300
  public static let unavailablePauseSeconds: TimeInterval = 300
  /// A trip may replace its credential after a 401 at most this often.
  static let maximumCredentialRefreshesPerTrip = 3

  private var collector: NavOSSTrafficProbeCollector?
  private var credential: NavOSSTrafficCredential?
  private var credentialRefreshes = 0
  private let now: @Sendable () -> Date
  private let onStateChange: @Sendable (NavOSSTrafficSharingState) -> Void
  private var pausedUntil: Date?
  private var queue: [NavOSSTrafficProbeBatch] = []
  private var startsLaterUntil: Date?
  private var trafficNotOffered = false
  public private(set) var state: NavOSSTrafficSharingState = .off
  private let transport: NavOSSTrafficTransport
  private var trip: UInt64 = 0
  private var uploading = false
  /// How many uploads ended in each outcome this process: counts only, never content.
  public private(set) var outcomeCounts: [String: Int] = [:]

  public init(
    transport: NavOSSTrafficTransport,
    now: @escaping @Sendable () -> Date = { Date() },
    onStateChange: @escaping @Sendable (NavOSSTrafficSharingState) -> Void = { _ in }
  ) {
    self.transport = transport
    self.now = now
    self.onStateChange = onStateChange
  }

  public func setEnabled(_ enabled: Bool) {
    if !enabled {
      endTrip()
      set(.off)
    } else if state == .off {
      set(.ready)
    }
  }

  /// Turn-by-turn guidance started (or the switch was turned on during guidance).
  /// `protectedPoints` are the route origin, destination and stops.
  public func startTrip(protectedPoints: [NavOSSCarPlayCoordinate]) async {
    guard state != .off else { return }
    endTrip()
    trip &+= 1
    let current = trip
    let started = now()
    if let startsLaterUntil, started < startsLaterUntil {
      set(.startsLater(until: startsLaterUntil))
      return
    }
    // A server that answered 404 (no community traffic) is not asked again this launch.
    if trafficNotOffered {
      set(.unavailable(reason: .notAccepting))
      return
    }
    set(.starting)
    let status: NavOSSTrafficStatus
    do {
      status = try await transport.trafficStatus()
    } catch NavOSSCommunityFailure.notFound {
      // A server without community traffic (an older API) answers 404: not available, quietly.
      trafficNotOffered = true
      if trip == current { set(.unavailable(reason: .notAccepting)) }
      return
    } catch {
      if trip == current { set(.unavailable(reason: .offline)) }
      return
    }
    guard trip == current else { return }
    guard status.accepting, status.rules.schemaVersion == 1 else {
      set(.unavailable(reason: .notAccepting))
      return
    }
    // Collect from the first fix so the trip's start is trimmed even while the credential is
    // requested; anything completed before a credential exists is dropped.
    collector = NavOSSTrafficProbeCollector(rules: status.rules, protectedPoints: protectedPoints)
    guard await refreshCredential(trip: current), trip == current else { return }
    set(.sharing)
  }

  public func protect(_ coordinates: [NavOSSCarPlayCoordinate]) {
    collector?.protect(coordinates)
  }

  /// Arrival, cancellation, or the switch turned off. Held-back fixes and the open batch are
  /// discarded and the credential forgotten.
  public func endTrip() {
    trip &+= 1
    collector?.finish()
    collector = nil
    credential = nil
    credentialRefreshes = 0
    queue.removeAll()
    pausedUntil = nil
    switch state {
    case .off, .startsLater: break
    default: set(.ready)
    }
  }

  public func ingest(_ fix: NavOSSTrafficFix) {
    guard var collector else { return }
    let batches = collector.ingest(fix)
    self.collector = collector
    enqueue(batches)
  }

  public func tick() {
    guard var collector else { return }
    let batches = collector.tick(now: now())
    self.collector = collector
    enqueue(batches)
  }

  /// Waits for queued uploads (tests and the simulator harness).
  public func drain() async {
    while uploading || !queue.isEmpty {
      await Task.yield()
      if !uploading, !queue.isEmpty { await upload(trip: trip) }
    }
  }

  private func enqueue(_ batches: [NavOSSTrafficProbeBatch]) {
    guard !batches.isEmpty else { return }
    let current = now()
    if let pausedUntil {
      guard current >= pausedUntil else { return }
      self.pausedUntil = nil
      set(.sharing)
    }
    guard state == .sharing else { return }
    queue.append(contentsOf: batches)
    if !uploading {
      let current = trip
      Task { await self.upload(trip: current) }
    }
  }

  private func upload(trip current: UInt64) async {
    guard !uploading else { return }
    uploading = true
    defer { uploading = false }
    while trip == current, !queue.isEmpty {
      let batch = queue.removeFirst()
      // Never send a batch the server would refuse as stale.
      guard now().timeIntervalSince(batch.capturedAt) < 590 else {
        record(.dropped)
        continue
      }
      if let credential,
        credential.expiresAt.timeIntervalSince(now()) < Self.credentialRefreshMarginSeconds
      {
        guard await refreshCredential(trip: current) else { return }
      }
      guard trip == current, let credential else { return }
      let outcome = await transport.uploadProbes(batch, credential: credential.value)
      record(outcome)
      guard trip == current else { return }
      switch outcome {
      case .accepted, .dropped:
        continue
      case .unauthorized:
        // One new credential, then continue with the next batch; this batch is gone.
        credentialRefreshes += 1
        guard credentialRefreshes <= Self.maximumCredentialRefreshesPerTrip,
          await refreshCredential(trip: current)
        else {
          if trip == current { stop(.rejected) }
          return
        }
      case .rateLimited:
        stop(.rateLimited)
        return
      case .unavailable:
        queue.removeAll()
        let until = now().addingTimeInterval(Self.unavailablePauseSeconds)
        pausedUntil = until
        set(.paused(until: until))
        return
      }
    }
  }

  /// Requests a credential; on failure sets the trip's state and returns false.
  private func refreshCredential(trip current: UInt64) async -> Bool {
    do {
      let issued = try await transport.trafficCredential()
      guard trip == current else { return false }
      credential = issued
      return true
    } catch let failure as NavOSSCommunityFailure {
      guard trip == current else { return false }
      switch failure {
      case let .installationTooNew(retryAfter):
        let until = now().addingTimeInterval(TimeInterval(retryAfter ?? 24 * 60 * 60))
        startsLaterUntil = until
        collector = nil
        set(.startsLater(until: until))
      case .attestationUnsupported:
        stop(.unsupported)
      case .rateLimited:
        stop(.rateLimited)
      case .serviceUnavailable:
        stop(.notAccepting)
      case .network:
        stop(.offline)
      default:
        stop(.rejected)
      }
      return false
    } catch {
      if trip == current { stop(.rejected) }
      return false
    }
  }

  private func record(_ outcome: NavOSSTrafficUploadOutcome) {
    outcomeCounts["\(outcome)", default: 0] += 1
  }

  private func stop(_ reason: NavOSSTrafficSharingState.Reason) {
    collector?.finish()
    collector = nil
    credential = nil
    queue.removeAll()
    set(.unavailable(reason: reason))
  }

  private func set(_ state: NavOSSTrafficSharingState) {
    guard self.state != state else { return }
    self.state = state
    onStateChange(state)
  }
}
