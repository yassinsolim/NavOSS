import Foundation

/// What the uploader needs from the network; `NavOSSCommunityClient` in the app, a fake in tests.
public protocol NavOSSTrafficTransport: Sendable {
  func trafficStatus() async throws -> NavOSSTrafficStatus
  func trafficCredential() async throws -> NavOSSTrafficCredential
  /// Sends `batch` once. The request must be created and started only through `permit`, which
  /// refuses once sharing was turned off or navigation ended and cancels it if that happens later.
  func uploadProbes(
    _ batch: NavOSSTrafficProbeBatch, credential: String, permit: NavOSSTrafficUploadPermit
  ) async -> NavOSSTrafficUploadOutcome
}

extension NavOSSCommunityClient: NavOSSTrafficTransport {}

/// The synchronous switch in front of every probe upload. The phone and CarPlay close it, under
/// its lock, before turning sharing off or ending navigation returns; a request is created only
/// while holding that same lock with a permit for the current opening, so no request is created
/// after the gate closed, and requests already started are cancelled by the close.
public final class NavOSSTrafficUploadGate: @unchecked Sendable {
  private let lock = NSLock()
  private var generation: UInt64 = 0
  private var inFlight: [UUID: @Sendable () -> Void] = [:]
  private var navigating = false
  private var opened: UInt64?
  private var switchOn = false

  public init() {}

  /// The driver's switch, as it changes. Off closes the gate.
  public func setSwitch(_ on: Bool) {
    let cancels: [@Sendable () -> Void] = lock.withLock {
      switchOn = on
      return on ? [] : closeLocked()
    }
    cancels.forEach { $0() }
  }

  /// Turn-by-turn navigation, as it starts and ends. Ending closes the gate.
  public func setNavigating(_ on: Bool) {
    let cancels: [@Sendable () -> Void] = lock.withLock {
      navigating = on
      return on ? [] : closeLocked()
    }
    cancels.forEach { $0() }
  }

  /// Invalidates every permit and cancels requests in flight.
  public func close() {
    let cancels = lock.withLock { closeLocked() }
    cancels.forEach { $0() }
  }

  /// A permit for a new collection, or nil while the switch is off or navigation is not active.
  func open() -> NavOSSTrafficUploadPermit? {
    lock.withLock {
      guard switchOn, navigating else { return nil }
      generation &+= 1
      opened = generation
      return NavOSSTrafficUploadPermit(gate: self, token: generation)
    }
  }

  fileprivate func start(_ id: UUID, token: UInt64, _ create: () -> @Sendable () -> Void) -> Bool {
    lock.withLock {
      guard opened == token, switchOn, navigating else { return false }
      inFlight[id] = create()
      return true
    }
  }

  fileprivate func finish(_ id: UUID) {
    _ = lock.withLock { inFlight.removeValue(forKey: id) }
  }

  private func closeLocked() -> [@Sendable () -> Void] {
    generation &+= 1
    opened = nil
    defer { inFlight = [:] }
    return Array(inFlight.values)
  }
}

/// Leave to send one batch, valid until the gate it came from closes.
public struct NavOSSTrafficUploadPermit: Sendable {
  fileprivate let gate: NavOSSTrafficUploadGate
  fileprivate let token: UInt64

  /// Creates and starts the request under the gate's lock if the permit is still valid.
  /// `create` starts it and returns how to cancel it. Call `finish(id)` when it completes.
  public func start(_ id: UUID, _ create: () -> @Sendable () -> Void) -> Bool {
    gate.start(id, token: token, create)
  }

  public func finish(_ id: UUID) {
    gate.finish(id)
  }
}

/// Starts work in the order it was asked for (each waits for the one before).
final class NavOSSOrderedWork: @unchecked Sendable {
  private let lock = NSLock()
  private var last: Task<Void, Never>?

  func run(_ work: @escaping @Sendable () async -> Void) {
    lock.withLock {
      let previous = last
      last = Task {
        await previous?.value
        await work()
      }
    }
  }

  /// Waits for everything asked for so far (tests).
  func settled() async {
    while let task = lock.withLock({ last }) {
      await task.value
      if lock.withLock({ last }) == task { return }
    }
  }
}

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
  /// Not for this trip: the server is not accepting, rate-limited or refused this installation,
  /// this device cannot attest, or the trip was restored after a relaunch (`rejected`).
  case unavailable(reason: Reason)

  public enum Reason: String, Sendable {
    case notAccepting = "not-accepting"
    case rateLimited = "rate-limited"
    case unsupported
    case rejected
    case offline
  }
}

/// Where the uploader keeps the one thing it persists: the time before which this installation
/// must not ask for a credential again after a `403` with `retry-after`. A deadline, never a
/// position or an identifier, though it says roughly when the installation registered (the
/// server answers `403` for a day after registration), so Reset community identity clears it.
/// Without `defaults` it lives in memory (tests).
public final class NavOSSTrafficEmbargoStore: @unchecked Sendable {
  public static let shared = NavOSSTrafficEmbargoStore(defaults: .standard)

  private static let key = "org.navoss.mobile.community.traffic-credential-not-before"
  private let defaults: UserDefaults?
  private let lock = NSLock()
  private var memory: Date?

  public init(defaults: UserDefaults? = nil) {
    self.defaults = defaults
  }

  public func load() -> Date? {
    lock.withLock {
      guard let defaults else { return memory }
      return defaults.object(forKey: Self.key) as? Date
    }
  }

  /// Forgets the deadline (Reset community identity: it tells roughly when the old installation
  /// registered).
  public func clear() {
    lock.withLock {
      if let defaults { defaults.removeObject(forKey: Self.key) } else { memory = nil }
    }
  }

  public func save(_ until: Date) {
    lock.withLock {
      if let defaults { defaults.set(until, forKey: Self.key) } else { memory = until }
    }
  }
}

/// Uploads community-traffic probes during one turn-by-turn trip at a time, following the
/// server contract exactly: status first, one credential held in memory and refreshed shortly
/// before expiry, batches sent once in order and never retried or stored; 401 → one new
/// credential, 429 → stop for the trip, 503 → pause five minutes, 400 → drop.
///
/// A trip is one navigation start (`startTrip`) to its end (`endTrip`). The sharing switch
/// (`setEnabled`) starts and stops collection inside it, but never lifts what the server imposed:
/// a `429`, a refused credential or a `403` holds until the next navigation start, a `503` pause
/// until its five minutes are over, and a `403` deadline survives a relaunch.
///
/// The app drives it through the synchronous `switchDidChange`, `navigationDidStart` and
/// `navigationDidEnd`: they close `gate` before returning, so once sharing is off or navigation
/// has ended no upload request is created, and one already started is cancelled; the actor then
/// discards the batches and the credential in the order the calls were made.
public actor NavOSSTrafficSharingSession {
  public static let credentialRefreshMarginSeconds: TimeInterval = 300
  public static let unavailablePauseSeconds: TimeInterval = 300
  /// A trip may replace its credential after a 401 at most this often.
  static let maximumCredentialRefreshesPerTrip = 3

  /// What the server (or this trip) ruled out until the next navigation start.
  private enum TripRestriction {
    case rateLimited
    case rejected
    case unsupported
    case startsLater(Date)
    /// A trip restored after a relaunch: its original trip-end zones may be gone.
    case restored

    var state: NavOSSTrafficSharingState {
      switch self {
      case .rateLimited: .unavailable(reason: .rateLimited)
      case .rejected, .restored: .unavailable(reason: .rejected)
      case .unsupported: .unavailable(reason: .unsupported)
      case let .startsLater(until): .startsLater(until: until)
      }
    }
  }

  private var collector: NavOSSTrafficProbeCollector?
  private var credential: NavOSSTrafficCredential?
  private var credentialRefreshes = 0
  private let embargo: NavOSSTrafficEmbargoStore
  private var enabled = false
  /// Advanced whenever collection is discarded: work begun under an older value is abandoned.
  private var generation: UInt64 = 0
  private var navigating = false
  private let now: @Sendable () -> Date
  private let onStateChange: @Sendable (NavOSSTrafficSharingState) -> Void
  private var pausedUntil: Date?
  private var protectedPoints: [NavOSSCarPlayCoordinate] = []
  private var queue: [NavOSSTrafficProbeBatch] = []
  private var restriction: TripRestriction?
  private var trafficNotOffered = false
  public private(set) var state: NavOSSTrafficSharingState = .off
  private let transport: NavOSSTrafficTransport
  private var uploadTask: Task<Void, Never>?
  private var permit: NavOSSTrafficUploadPermit?
  /// Closed synchronously by the app before off or end returns.
  public nonisolated let gate = NavOSSTrafficUploadGate()
  /// Work from the synchronous entry points, in call order (internal: tests make it lag).
  nonisolated let ordered = NavOSSOrderedWork()
  /// How many uploads ended in each outcome this process: counts only, never content.
  public private(set) var outcomeCounts: [String: Int] = [:]

  public init(
    transport: NavOSSTrafficTransport,
    now: @escaping @Sendable () -> Date = { Date() },
    embargo: NavOSSTrafficEmbargoStore = NavOSSTrafficEmbargoStore(),
    onStateChange: @escaping @Sendable (NavOSSTrafficSharingState) -> Void = { _ in }
  ) {
    self.transport = transport
    self.now = now
    self.embargo = embargo
    self.onStateChange = onStateChange
  }

  // MARK: Synchronous entry points (the app)

  /// The driver's switch changed. Closes the gate before returning; with `restart` the current
  /// collection is discarded even though the switch ends up on (an off came in between).
  public nonisolated func switchDidChange(_ enabled: Bool, restart: Bool = false) {
    if restart || !enabled { gate.close() }
    gate.setSwitch(enabled)
    ordered.run {
      if restart { await self.applyEnabled(false) }
      await self.applyEnabled(enabled)
    }
  }

  public nonisolated func navigationDidStart(
    protectedPoints: [NavOSSCarPlayCoordinate], restored: Bool
  ) {
    gate.setNavigating(true)
    ordered.run { await self.applyStart(protectedPoints: protectedPoints, restored: restored) }
  }

  /// Closes the gate before returning, then discards the trip.
  public nonisolated func navigationDidEnd() {
    gate.setNavigating(false)
    ordered.run { await self.applyEnd() }
  }

  public nonisolated func routeDidAddStops(_ coordinates: [NavOSSCarPlayCoordinate]) {
    ordered.run { await self.protect(coordinates) }
  }

  /// Waits until every synchronous call so far has reached the actor (tests).
  public func settled() async {
    await ordered.settled()
  }

  // MARK: Awaited entry points (tests and sequential callers)

  /// The driver's switch. Off discards everything in memory, including the credential, and
  /// cancels the upload in flight; on during guidance starts collecting for the rest of the trip
  /// unless the trip is restricted.
  public func setEnabled(_ enabled: Bool) async {
    gate.setSwitch(enabled)
    await applyEnabled(enabled)
  }

  private func applyEnabled(_ enabled: Bool) async {
    guard enabled != self.enabled else { return }
    self.enabled = enabled
    if !enabled {
      discardCollection()
      set(.off)
    } else if navigating {
      await beginCollection()
    } else {
      set(idleState())
    }
  }

  /// Turn-by-turn guidance started: a new trip. `protectedPoints` are the route origin,
  /// destination and stops. A `restored` trip (resumed after a relaunch) shares nothing: its
  /// route may have replaced the one navigation started with, and the visited stops and
  /// restrictions of the original trip are not known.
  public func startTrip(protectedPoints: [NavOSSCarPlayCoordinate], restored: Bool = false) async {
    gate.setNavigating(true)
    await applyStart(protectedPoints: protectedPoints, restored: restored)
  }

  private func applyStart(protectedPoints: [NavOSSCarPlayCoordinate], restored: Bool) async {
    discardCollection()
    navigating = true
    self.protectedPoints = protectedPoints
    restriction = restored ? .restored : nil
    if enabled { await beginCollection() }
  }

  /// A new destination or stop: the collector drops its unsent fixes and batches, and anything
  /// queued for upload is dropped too, so nothing inside the new zone is sent.
  public func protect(_ coordinates: [NavOSSCarPlayCoordinate]) {
    guard navigating else { return }
    protectedPoints += coordinates
    if collector?.protect(coordinates) == true {
      queue.removeAll()
    }
  }

  /// Arrival or cancellation. Held-back fixes and the open batch are discarded, the upload in
  /// flight is cancelled and the credential forgotten.
  public func endTrip() {
    gate.setNavigating(false)
    applyEnd()
  }

  private func applyEnd() {
    discardCollection()
    navigating = false
    protectedPoints = []
    restriction = nil
    set(enabled ? idleState() : .off)
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
    while let uploadTask {
      await uploadTask.value
    }
  }

  private func idleState() -> NavOSSTrafficSharingState {
    if let until = embargo.load(), now() < until { return .startsLater(until: until) }
    return .ready
  }

  /// Status, collector and credential for the rest of this trip.
  private func beginCollection() async {
    guard enabled, navigating, collector == nil else { return }
    if let restriction {
      set(restriction.state)
      return
    }
    if let until = embargo.load(), now() < until {
      // A 403 deadline at the start holds for the whole trip, even if it passes on the way.
      restriction = .startsLater(until)
      set(.startsLater(until: until))
      return
    }
    // A server that answered 404 (no community traffic) is not asked again this launch.
    if trafficNotOffered {
      set(.unavailable(reason: .notAccepting))
      return
    }
    let current = generation
    set(.starting)
    let status: NavOSSTrafficStatus
    do {
      status = try await transport.trafficStatus()
    } catch NavOSSCommunityFailure.notFound {
      // A server without community traffic (an older API) answers 404: not available, quietly.
      trafficNotOffered = true
      if generation == current { set(.unavailable(reason: .notAccepting)) }
      return
    } catch {
      if generation == current { set(.unavailable(reason: .offline)) }
      return
    }
    guard generation == current else { return }
    guard status.accepting, status.rules.schemaVersion == 1 else {
      set(.unavailable(reason: .notAccepting))
      return
    }
    // Collect from the first fix so the trip's start is trimmed even while the credential is
    // requested; anything completed before a credential exists is dropped.
    collector = NavOSSTrafficProbeCollector(rules: status.rules, protectedPoints: protectedPoints)
    // Nil when the app has already turned sharing off or ended navigation (that change is on its
    // way here): nothing can be uploaded under it.
    permit = gate.open()
    guard await refreshCredential(generation: current), generation == current else { return }
    if let pausedUntil, now() < pausedUntil {
      set(.paused(until: pausedUntil))
    } else {
      pausedUntil = nil
      set(.sharing)
    }
  }

  /// Drops everything collected, queued or held for upload, and cancels the upload in flight so
  /// that its batch is never sent.
  private func discardCollection() {
    generation &+= 1
    permit = nil
    gate.close()
    uploadTask?.cancel()
    uploadTask = nil
    collector?.finish()
    collector = nil
    credential = nil
    credentialRefreshes = 0
    queue.removeAll()
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
    if uploadTask == nil {
      let current = generation
      uploadTask = Task { await self.upload(generation: current) }
    }
  }

  private func upload(generation current: UInt64) async {
    defer {
      // A newer generation already dropped this task (and may have started another).
      if generation == current { uploadTask = nil }
    }
    while generation == current, !Task.isCancelled, !queue.isEmpty {
      let batch = queue.removeFirst()
      // Never send a batch the server would refuse as stale.
      guard now().timeIntervalSince(batch.capturedAt) < 590 else {
        record(.dropped)
        continue
      }
      if let credential,
        credential.expiresAt.timeIntervalSince(now()) < Self.credentialRefreshMarginSeconds
      {
        guard await refreshCredential(generation: current) else { return }
      }
      guard generation == current, !Task.isCancelled, let credential, let permit else { return }
      let outcome = await transport.uploadProbes(
        batch, credential: credential.value, permit: permit)
      record(outcome)
      guard generation == current else { return }
      switch outcome {
      case .accepted, .dropped:
        continue
      case .unauthorized:
        // One new credential, then continue with the next batch; this batch is gone.
        credentialRefreshes += 1
        guard credentialRefreshes <= Self.maximumCredentialRefreshesPerTrip,
          await refreshCredential(generation: current)
        else {
          if generation == current { stop(.rejected) }
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
  private func refreshCredential(generation current: UInt64) async -> Bool {
    do {
      let issued = try await transport.trafficCredential()
      guard generation == current else { return false }
      credential = issued
      return true
    } catch let failure as NavOSSCommunityFailure {
      if case let .installationTooNew(retryAfter) = failure {
        // The deadline is about the installation, not this trip: kept even when the trip that
        // asked has ended or sharing was turned off meanwhile.
        let until = now().addingTimeInterval(TimeInterval(retryAfter ?? 24 * 60 * 60))
        embargo.save(until)
      }
      guard generation == current else { return false }
      switch failure {
      case .installationTooNew:
        guard let until = embargo.load() else { return false }
        restriction = .startsLater(until)
        discardCollection()
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
      if generation == current { stop(.rejected) }
      return false
    }
  }

  private func record(_ outcome: NavOSSTrafficUploadOutcome) {
    outcomeCounts["\(outcome)", default: 0] += 1
  }

  /// Nothing more on this trip. What the server imposed on this installation (`429`, a refused
  /// credential, no attestation) holds until the next navigation start; a server that is not
  /// accepting or unreachable is asked again only when the driver turns sharing on again.
  private func stop(_ reason: NavOSSTrafficSharingState.Reason) {
    switch reason {
    case .rateLimited: restriction = .rateLimited
    case .rejected: restriction = .rejected
    case .unsupported: restriction = .unsupported
    case .notAccepting, .offline: break
    }
    discardCollection()
    set(.unavailable(reason: reason))
  }

  private func set(_ state: NavOSSTrafficSharingState) {
    guard self.state != state else { return }
    self.state = state
    onStateChange(state)
  }
}
