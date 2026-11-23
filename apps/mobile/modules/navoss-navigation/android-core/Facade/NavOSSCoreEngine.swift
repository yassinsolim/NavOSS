import Foundation

// The navigation engine behind the JSON boundary of docs/architecture/android-core.md. The JNI
// layer (`android-core/JNI`) is a thin adapter over this class; everything it does can be tested
// on macOS.

/// Version of the boundary; the Kotlin binding refuses a library that reports another one.
public let navOSSCoreABIVersion: Int32 = 2
/// The JS contract (`NativeNavigationCapabilities.version`) the snapshots follow.
public let navOSSCoreContractVersion: Int32 = 11
/// The largest JSON text accepted from the host (a trip, an HTTP answer), in UTF-8 bytes. The
/// host bounds what it reads from the network; this is the boundary's own ceiling.
public let navOSSCoreMaximumJSONBytes = 16 * 1024 * 1024

/// A failure reported across the boundary instead of a trap. `code` is stable (see "Errors").
public struct NavOSSCoreError: Error, Equatable, CustomStringConvertible {
  public let code: String
  public let message: String

  public init(code: String, message: String) {
    self.code = code
    self.message = message
  }

  public var description: String { "\(code): \(message)" }

  /// Names what was wrong and where (the field path), never the text that was sent: messages
  /// can end up in logcat.
  static func invalidJSON(_ error: Error) -> NavOSSCoreError {
    func at(_ context: DecodingError.Context) -> String {
      let path = context.codingPath.reduce(into: "") { path, key in
        if let index = key.intValue {
          path += "[\(index)]"
        } else {
          path += (path.isEmpty ? "" : ".") + key.stringValue
        }
      }
      return path.isEmpty ? "" : " at " + path
    }
    let message =
      switch error {
      case DecodingError.typeMismatch(_, let context): "Wrong type" + at(context)
      case DecodingError.valueNotFound(_, let context): "Missing value" + at(context)
      case DecodingError.keyNotFound(let key, let context):
        "Missing field \(key.stringValue)" + at(context)
      case DecodingError.dataCorrupted(let context):
        context.codingPath.isEmpty ? "Not JSON" : "Invalid value" + at(context)
      default: "Not JSON"
      }
    return NavOSSCoreError(code: "invalid-json", message: message)
  }

  static func invalidArgument(_ message: String) -> NavOSSCoreError {
    NavOSSCoreError(code: "invalid-argument", message: message)
  }

  static let closed = NavOSSCoreError(code: "closed", message: "The engine was closed")

  /// Maps the core's own errors to boundary codes.
  static func from(_ error: Error) -> NavOSSCoreError {
    switch error {
    case let error as NavOSSCoreError: error
    case NavigationCoreError.invalidRoute:
      NavOSSCoreError(code: "invalid-route", message: "The trip failed validation")
    case NavigationCoreError.invalidCoordinate:
      NavOSSCoreError(code: "invalid-location", message: "The fix is not a valid coordinate")
    case NavigationCoreError.untimedLiveFix:
      NavOSSCoreError(code: "invalid-location", message: "The fix has no timestampMs")
    case NavigationSessionError.noActiveTrip:
      NavOSSCoreError(code: "no-active-trip", message: "There is no active trip")
    // The type only: an error's description may quote what it was given.
    default: NavOSSCoreError(code: "internal", message: "\(type(of: error))")
    }
  }
}

/// The platform side, implemented by the JNI layer over the Kotlin `NavOSSCore.Host`. See
/// "Callbacks" in the contract for the threads and lock state each one is called with.
public protocol NavOSSCoreHost: AnyObject {
  func stateChanged(_ snapshotJSON: String)
  func speak(text: String, kind: String, generation: UInt64)
  func cancelSpeech(generation: UInt64)
  func needsLocationUpdates()
  func reconcileLocationUpdates(generation: UInt64, shouldTrack: Bool)
  func startClock(generation: UInt64)
  func stopClock(generation: UInt64)
  /// Must return at once; the answer comes through `NavOSSCoreEngine.completeHTTPRequest`.
  func httpRequest(id: Int64, json: String)
  func cancelHTTPRequest(id: Int64)
  /// Engine lock held: must not call into the engine.
  func storageRead(key: String) -> String?
  /// Engine lock held: must not call into the engine. `nil` removes the key.
  func storageWrite(key: String, value: String?)
  /// Engine lock held: must not call into the engine. Milliseconds since the Unix epoch.
  func nowMs() -> Double
}

public final class NavOSSCoreEngine: @unchecked Sendable {
  let engine: NavigationEngine
  private let bridge: NavOSSCoreHostBridge
  private let http: NavOSSCoreHTTP
  private let effects: EngineEffects
  /// Guarded by the engine lock.
  private var announceRoadReports: Bool
  /// The fix being ingested, until the engine has taken or ignored it. Guarded by the engine lock.
  private var offeredSample: NavigationLocationSample?
  /// The newest fix the engine accepted, for the reroute origin's course, speed, accuracy and
  /// age. Guarded by the engine lock.
  private var acceptedSample: NavigationLocationSample?

  public init(configJSON: String, host: NavOSSCoreHost) throws {
    let config: NavOSSCoreConfig
    do {
      config = try JSONDecoder().decode(NavOSSCoreConfig.self, from: Data(configJSON.utf8))
    } catch {
      throw NavOSSCoreError.invalidJSON(error)
    }
    guard let baseURL = URL(string: config.apiBaseUrl), baseURL.scheme != nil else {
      throw NavOSSCoreError.invalidArgument("apiBaseUrl is not a URL")
    }
    let audioMode = try config.audioMode.map(Self.audioMode) ?? .allGuidance
    let rerouteMode = try config.rerouteMode.map(Self.rerouteMode) ?? .adaptive
    let bridge = NavOSSCoreHostBridge(host: host)
    let clock = bridge.now
    let http = NavOSSCoreHTTP(bridge: bridge)
    self.bridge = bridge
    self.http = http
    announceRoadReports = config.announceRoadReports ?? true
    engine = NavigationEngine(
      tripStore: NavOSSActiveTripStore(defaults: NavOSSCoreHostStorage(bridge: bridge), clock: clock),
      audioMode: audioMode,
      preferences: NavOSSNavigationPreferences(
        rerouteMode: rerouteMode,
        speedingToleranceKph: config.speedingToleranceKph
          ?? NavOSSNavigationPreferences.defaultSpeedingToleranceKph,
        speedingAudibleWarning: config.speedingAudibleWarning ?? false
      ),
      network: NavOSSCoreNetwork(
        baseURL: baseURL, transport: http.transport,
        discovery: NavOSSRoutesEndpointDiscovery(clock: clock)),
      clock: clock
    )
    effects = EngineEffects(bridge: bridge)
    effects.engine = engine
    effects.owner = self
    engine.host = effects
  }

  /// Cancels the host's pending requests, then stops every callback. When it returns no
  /// callback is running or will run, except that a `close()` made from inside a callback
  /// returns at once: callbacks already running (its own, and any on other threads) finish, and
  /// none starts. The stored trip stays for a later `resumePersistedTrip`. Idempotent.
  public func close() {
    http.close()
    bridge.close()
  }

  // MARK: Trip

  public func resumePersistedTrip() -> String {
    engine.resumePersistedNavigation()
    return snapshot()
  }

  public func setRoute(_ tripJSON: String) throws -> String {
    guard tripJSON.utf8.count <= navOSSCoreMaximumJSONBytes else {
      throw NavOSSCoreError.invalidArgument("The trip is larger than the boundary allows")
    }
    let record: NavOSSCoreTripRecord
    do {
      record = try JSONDecoder().decode(NavOSSCoreTripRecord.self, from: Data(tripJSON.utf8))
    } catch {
      throw NavOSSCoreError.invalidJSON(error)
    }
    do {
      try engine.startNavigation(record.trip)
    } catch {
      throw NavOSSCoreError.from(error)
    }
    return snapshot()
  }

  public func updateLocation(_ sampleJSON: String) throws -> String {
    let record: NavOSSCoreLocationRecord
    do {
      record = try JSONDecoder().decode(NavOSSCoreLocationRecord.self, from: Data(sampleJSON.utf8))
    } catch {
      throw NavOSSCoreError.invalidJSON(error)
    }
    do {
      let sample = try navOSSLiveNavigationFix(record.sample)
      engine.lock.withLock { offeredSample = sample }
      defer {
        engine.lock.withLock {
          settleLocked(sample)
          if offeredSample == sample { offeredSample = nil }
        }
      }
      _ = try engine.ingest(sample)
    } catch {
      throw NavOSSCoreError.from(error)
    }
    return snapshot()
  }

  public func clearRoute() -> String {
    engine.clearNavigation()
    return snapshot()
  }

  public func snapshot() -> String {
    navOSSCoreSnapshot(engine.currentState()).encodedString()
  }

  public func acceptRerouteProposal(id: String) -> Bool {
    engine.acceptRerouteProposal(id: id)
  }

  public func declineRerouteProposal(id: String) -> Bool {
    engine.declineRerouteProposal(id: id)
  }

  // MARK: Preferences

  public func setRerouteMode(_ rawValue: String) throws {
    let mode = try Self.rerouteMode(rawValue)
    #if DEBUG
      preferencesWillChange?()
    #endif
    engine.updateNavigationPreferences {
      $0 = NavOSSNavigationPreferences(
        rerouteMode: mode,
        speedingToleranceKph: $0.speedingToleranceKph,
        speedingAudibleWarning: $0.speedingAudibleWarning
      )
    }
  }

  public func setAudioMode(_ rawValue: String) throws {
    engine.setAudioMode(try Self.audioMode(rawValue))
  }

  public func setSpeedingWarning(toleranceKph: Int, audible: Bool) {
    #if DEBUG
      preferencesWillChange?()
    #endif
    engine.updateNavigationPreferences {
      $0 = NavOSSNavigationPreferences(
        rerouteMode: $0.rerouteMode,
        speedingToleranceKph: toleranceKph,
        speedingAudibleWarning: audible
      )
    }
  }

  public func setAnnounceRoadReports(_ enabled: Bool) {
    engine.lock.withLock { announceRoadReports = enabled }
  }

  public func preferences() -> String {
    let preferences = engine.currentNavigationPreferences()
    let audioMode = engine.audioMode()
    let announce = engine.lock.withLock { announceRoadReports }
    return NavOSSCoreJSON.object([
      "announceRoadReports": .bool(announce),
      "audioMode": .string(audioMode.rawValue),
      "rerouteMode": .string(preferences.rerouteMode.rawValue),
      "speedingAudibleWarning": .bool(preferences.speedingAudibleWarning),
      "speedingToleranceKph": .int(preferences.speedingToleranceKph),
    ]).encodedString()
  }

  // MARK: Clock and host answers

  public func clockTick() {
    engine.clockTick()
  }

  public func isCurrentGeneration(_ generation: UInt64) -> Bool {
    engine.lock.withLock { engine.navigationGenerationLocked == generation }
  }

  public func completeHTTPRequest(id: Int64, responseJSON: String) {
    http.complete(id: id, responseJSON: responseJSON)
  }

  #if DEBUG
    /// Tests: waits for the reroute and camera requests in flight.
    func waitForPendingWork() async {
      await engine.pendingRerouteTask?.value
      await engine.pendingSafetyCameraTask?.value
    }

    /// Tests: runs in the reroute-mode and speeding setters before the change is applied, where
    /// another caller's change may land.
    var preferencesWillChange: (() -> Void)?

    /// Tests: the HTTP carrier and the host gate, for their interleaving hooks.
    var httpForTesting: NavOSSCoreHTTP { http }
    var bridgeForTesting: NavOSSCoreHostBridge { bridge }
  #endif

  // MARK: Internals

  /// Decides what became of an offered fix: it is the accepted one if the engine's snapshot
  /// now stands at it and it is newer than the one kept. The session ignores a fix that was not
  /// captured after the last one (a duplicate, or an older one arriving late) and leaves its
  /// snapshot alone; such a fix must not replace the accepted one's course, accuracy and time.
  private func settleLocked(_ offered: NavigationLocationSample) {
    let raw = engine.currentUpdateLocked().snapshot.rawCoordinate
    guard raw == offered.coordinate else { return }
    if let accepted = acceptedSample, accepted.coordinate == raw,
      let acceptedAt = accepted.timestamp, let offeredAt = offered.timestamp,
      offeredAt <= acceptedAt
    {
      return
    }
    acceptedSample = offered
  }

  /// The origin metadata of a reroute from `coordinate`: only from the accepted fix at that
  /// very coordinate, never another fix's course or accuracy.
  fileprivate func rerouteOriginLocked(at coordinate: NavOSSCarPlayCoordinate)
    -> NavOSSNavigationRouteOrigin?
  {
    if let offeredSample { settleLocked(offeredSample) }
    guard let sample = acceptedSample,
      sample.coordinate.latitude == coordinate.latitude,
      sample.coordinate.longitude == coordinate.longitude,
      let accuracy = sample.horizontalAccuracyMeters, let timestamp = sample.timestamp
    else {
      return nil
    }
    return navOSSNavigationRouteOrigin(
      coordinate: coordinate,
      courseDegrees: sample.courseDegrees,
      speedMetersPerSecond: sample.speedMetersPerSecond,
      horizontalAccuracyMeters: accuracy,
      ageSeconds: bridge.now().timeIntervalSinceReferenceDate - timestamp
    )
  }

  private static func audioMode(_ rawValue: String) throws -> NavOSSCarPlayAudioMode {
    guard let mode = NavOSSCarPlayAudioMode(rawValue: rawValue) else {
      throw NavOSSCoreError.invalidArgument("Unknown audio mode")
    }
    return mode
  }

  private static func rerouteMode(_ rawValue: String) throws -> NavOSSRerouteMode {
    guard let mode = NavOSSRerouteMode(rawValue: rawValue) else {
      throw NavOSSCoreError.invalidArgument("Unknown reroute mode")
    }
    return mode
  }
}

/// The host, until `close()`. Every callback goes through `deliver`, which is how none starts
/// after `close()` and how `close()` waits for the ones already running.
final class NavOSSCoreHostBridge: @unchecked Sendable {
  private let condition = NSCondition()
  private var host: NavOSSCoreHost?
  /// Callbacks running now, by thread (a callback can cause another on its own thread).
  private var inFlight: [ObjectIdentifier: Int] = [:]
  #if DEBUG
    /// Tests: `close()` found callbacks running on other threads and is about to wait for them.
    var closeWillWait: (() -> Void)?
  #endif

  init(host: NavOSSCoreHost) {
    self.host = host
  }

  /// Calls the host unless the engine was closed; `nil` then. The closed check and the count
  /// of running callbacks are one step, so `close()` either prevents the call or waits for it.
  @discardableResult
  func deliver<Result>(_ body: (NavOSSCoreHost) -> Result) -> Result? {
    let thread = ObjectIdentifier(Thread.current)
    let host: NavOSSCoreHost? = condition.withLock {
      guard let host else { return nil }
      inFlight[thread, default: 0] += 1
      return host
    }
    guard let host else { return nil }
    defer {
      condition.withLock {
        if let count = inFlight[thread], count > 1 {
          inFlight[thread] = count - 1
        } else {
          inFlight[thread] = nil
          condition.broadcast()
        }
      }
    }
    return body(host)
  }

  /// Revokes the host and waits for the callbacks running on other threads. Called from
  /// inside a callback it cannot wait for its own caller, and two such calls would wait for
  /// each other, so it then only revokes.
  func close() {
    let thread = ObjectIdentifier(Thread.current)
    condition.lock()
    defer { condition.unlock() }
    host = nil
    guard inFlight[thread] == nil else { return }
    #if DEBUG
      if !inFlight.isEmpty { closeWillWait?() }
    #endif
    while !inFlight.isEmpty {
      condition.wait()
    }
  }

  /// The host's wall clock; the system clock once closed (nothing is published then).
  var now: @Sendable () -> Date {
    { [weak self] in
      guard let ms = self?.deliver({ $0.nowMs() }) else { return Date() }
      return Date(timeIntervalSince1970: ms / 1_000)
    }
  }
}

/// `NavOSSActiveTripStore`'s records in the host's storage, as UTF-8 JSON text.
private final class NavOSSCoreHostStorage: NavOSSKeyValueStore {
  private let bridge: NavOSSCoreHostBridge

  init(bridge: NavOSSCoreHostBridge) {
    self.bridge = bridge
  }

  func data(forKey key: String) -> Data? {
    (bridge.deliver { $0.storageRead(key: key) } ?? nil).map { Data($0.utf8) }
  }

  func setData(_ data: Data, forKey key: String) {
    bridge.deliver { $0.storageWrite(key: key, value: String(decoding: data, as: UTF8.self)) }
  }

  func removeObject(forKey key: String) {
    bridge.deliver { $0.storageWrite(key: key, value: nil) }
  }
}

/// The NavOSS API with the host as transport.
private struct NavOSSCoreNetwork: NavigationEngineNetwork {
  let baseURL: URL
  let transport: NavOSSHTTPTransport
  let discovery: NavOSSRoutesEndpointDiscovery

  private func client() throws -> NavOSSNavigationAPIClient {
    try NavOSSNavigationAPIClient(
      baseURL: baseURL, transport: transport, routesDiscovery: discovery, offlineFallback: nil)
  }

  func rerouteClient() throws -> any NavigationRerouteRouting {
    try client()
  }

  func safetyCameras() async throws -> [NavOSSSafetyCamera] {
    try await client().safetyCameras()
  }
}

/// The engine's host: forwards its effects to the platform host. Held strongly by the facade
/// (the engine keeps its host weakly).
private final class EngineEffects: NavigationEngineHost {
  private let bridge: NavOSSCoreHostBridge
  weak var engine: NavigationEngine?
  weak var owner: NavOSSCoreEngine?

  init(bridge: NavOSSCoreHostBridge) {
    self.bridge = bridge
  }

  func navigationEnginePreparePublicationLocked(
    _ update: VersionedNavigationUpdate
  ) -> (() -> Void)? {
    nil
  }

  func navigationEnginePrepareRestoredTripAcquisitionLocked(
    trip: NavOSSCarPlayTrip,
    _ update: VersionedNavigationUpdate
  ) -> (() -> Void)? {
    nil
  }

  func navigationEngineDidClearTrip(generation: UInt64, sequence: Int) {}

  func navigationEngineStateDidChange() {
    // The snapshot is read inside the gate: a `close()` that returns has waited for this.
    bridge.deliver { host in
      guard let owner else { return }
      host.stateChanged(owner.snapshot())
    }
  }

  func navigationEngineSpeak(_ speech: NavigationEngineSpeech, generation: UInt64) {
    let kind =
      switch speech.kind {
      case .alert: "alert"
      case .maneuver: "maneuver"
      }
    bridge.deliver { $0.speak(text: speech.text, kind: kind, generation: generation) }
  }

  func navigationEngineCancelSpeech(generation: UInt64) {
    bridge.deliver { $0.cancelSpeech(generation: generation) }
  }

  func navigationEngineNeedsLocationUpdates() {
    bridge.deliver { $0.needsLocationUpdates() }
  }

  func navigationEngineReconcileLocationUpdates(generation: UInt64) {
    guard let engine else { return }
    let shouldTrack = engine.lock.withLock {
      let update = engine.currentUpdateLocked()
      return update.trip != nil && update.snapshot.phase != .arrived
    }
    bridge.deliver {
      $0.reconcileLocationUpdates(generation: generation, shouldTrack: shouldTrack)
    }
  }

  func navigationEngineStartClock(generation: UInt64) {
    bridge.deliver { $0.startClock(generation: generation) }
  }

  func navigationEngineStopClock(generation: UInt64) {
    bridge.deliver { $0.stopClock(generation: generation) }
  }

  func navigationEngineRerouteOriginLocked(
    at coordinate: NavOSSCarPlayCoordinate
  ) -> NavOSSNavigationRouteOrigin? {
    owner?.rerouteOriginLocked(at: coordinate)
  }
}
