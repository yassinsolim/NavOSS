import Foundation

// The navigation engine behind the JSON boundary of docs/architecture/android-core.md. The JNI
// layer (`android-core/JNI`) is a thin adapter over this class; everything it does can be tested
// on macOS.

/// Version of the boundary; the Kotlin binding refuses a library that reports another one.
public let navOSSCoreABIVersion: Int32 = 1
/// The JS contract (`NativeNavigationCapabilities.version`) the snapshots follow.
public let navOSSCoreContractVersion: Int32 = 11

/// A failure reported across the boundary instead of a trap. `code` is stable (see "Errors").
public struct NavOSSCoreError: Error, Equatable, CustomStringConvertible {
  public let code: String
  public let message: String

  public init(code: String, message: String) {
    self.code = code
    self.message = message
  }

  public var description: String { "\(code): \(message)" }

  static func invalidJSON(_ error: Error) -> NavOSSCoreError {
    NavOSSCoreError(code: "invalid-json", message: "\(error)")
  }

  static func invalidArgument(_ message: String) -> NavOSSCoreError {
    NavOSSCoreError(code: "invalid-argument", message: message)
  }

  static let closed = NavOSSCoreError(code: "closed", message: "The engine was closed")

  /// Maps the core's own errors to boundary codes.
  static func from(_ error: Error) -> NavOSSCoreError {
    switch error {
    case let error as NavOSSCoreError: error
    case NavigationCoreError.invalidRoute: NavOSSCoreError(code: "invalid-route", message: "\(error)")
    case NavigationCoreError.invalidCoordinate, NavigationCoreError.untimedLiveFix:
      NavOSSCoreError(code: "invalid-location", message: "\(error)")
    case NavigationSessionError.noActiveTrip:
      NavOSSCoreError(code: "no-active-trip", message: "\(error)")
    default: NavOSSCoreError(code: "internal", message: "\(error)")
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
  /// The latest fix and when it was given, for the reroute origin. Guarded by the engine lock.
  private var latestSample: NavigationLocationSample?

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

  /// Stops every callback and cancels pending requests. The stored trip stays for a later
  /// `resumePersistedTrip`. Idempotent.
  public func close() {
    bridge.close()
    http.cancelAll()
  }

  // MARK: Trip

  public func resumePersistedTrip() -> String {
    engine.resumePersistedNavigation()
    return snapshot()
  }

  public func setRoute(_ tripJSON: String) throws -> String {
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
      engine.lock.withLock { latestSample = sample }
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
    let current = engine.currentNavigationPreferences()
    engine.setNavigationPreferences(
      NavOSSNavigationPreferences(
        rerouteMode: mode,
        speedingToleranceKph: current.speedingToleranceKph,
        speedingAudibleWarning: current.speedingAudibleWarning
      ))
  }

  public func setAudioMode(_ rawValue: String) throws {
    engine.setAudioMode(try Self.audioMode(rawValue))
  }

  public func setSpeedingWarning(toleranceKph: Int, audible: Bool) {
    let current = engine.currentNavigationPreferences()
    engine.setNavigationPreferences(
      NavOSSNavigationPreferences(
        rerouteMode: current.rerouteMode,
        speedingToleranceKph: toleranceKph,
        speedingAudibleWarning: audible
      ))
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
  #endif

  // MARK: Internals

  fileprivate func rerouteOriginLocked(at coordinate: NavOSSCarPlayCoordinate)
    -> NavOSSNavigationRouteOrigin?
  {
    guard let latestSample, let accuracy = latestSample.horizontalAccuracyMeters,
      let timestamp = latestSample.timestamp
    else {
      return nil
    }
    return navOSSNavigationRouteOrigin(
      coordinate: coordinate,
      courseDegrees: latestSample.courseDegrees,
      speedMetersPerSecond: latestSample.speedMetersPerSecond,
      horizontalAccuracyMeters: accuracy,
      ageSeconds: bridge.now().timeIntervalSinceReferenceDate - timestamp
    )
  }

  private static func audioMode(_ rawValue: String) throws -> NavOSSCarPlayAudioMode {
    guard let mode = NavOSSCarPlayAudioMode(rawValue: rawValue) else {
      throw NavOSSCoreError.invalidArgument("Unknown audio mode \(rawValue)")
    }
    return mode
  }

  private static func rerouteMode(_ rawValue: String) throws -> NavOSSRerouteMode {
    guard let mode = NavOSSRerouteMode(rawValue: rawValue) else {
      throw NavOSSCoreError.invalidArgument("Unknown reroute mode \(rawValue)")
    }
    return mode
  }
}

/// The host, until `close()`. Every callback goes through here so none is delivered after it.
final class NavOSSCoreHostBridge: @unchecked Sendable {
  private let lock = NSLock()
  private var host: NavOSSCoreHost?

  init(host: NavOSSCoreHost) {
    self.host = host
  }

  var current: NavOSSCoreHost? {
    lock.withLock { host }
  }

  func close() {
    lock.withLock { host = nil }
  }

  /// The host's wall clock; the system clock once closed (nothing is published then).
  var now: @Sendable () -> Date {
    { [weak self] in
      guard let host = self?.current else { return Date() }
      return Date(timeIntervalSince1970: host.nowMs() / 1_000)
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
    bridge.current?.storageRead(key: key).map { Data($0.utf8) }
  }

  func setData(_ data: Data, forKey key: String) {
    bridge.current?.storageWrite(key: key, value: String(decoding: data, as: UTF8.self))
  }

  func removeObject(forKey key: String) {
    bridge.current?.storageWrite(key: key, value: nil)
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
    guard let host = bridge.current, let owner else { return }
    host.stateChanged(owner.snapshot())
  }

  func navigationEngineSpeak(_ speech: NavigationEngineSpeech, generation: UInt64) {
    let kind =
      switch speech.kind {
      case .alert: "alert"
      case .maneuver: "maneuver"
      }
    bridge.current?.speak(text: speech.text, kind: kind, generation: generation)
  }

  func navigationEngineCancelSpeech(generation: UInt64) {
    bridge.current?.cancelSpeech(generation: generation)
  }

  func navigationEngineNeedsLocationUpdates() {
    bridge.current?.needsLocationUpdates()
  }

  func navigationEngineReconcileLocationUpdates(generation: UInt64) {
    guard let engine else { return }
    let shouldTrack = engine.lock.withLock {
      let update = engine.currentUpdateLocked()
      return update.trip != nil && update.snapshot.phase != .arrived
    }
    bridge.current?.reconcileLocationUpdates(generation: generation, shouldTrack: shouldTrack)
  }

  func navigationEngineStartClock(generation: UInt64) {
    bridge.current?.startClock(generation: generation)
  }

  func navigationEngineStopClock(generation: UInt64) {
    bridge.current?.stopClock(generation: generation)
  }

  func navigationEngineRerouteOriginLocked(
    at coordinate: NavOSSCarPlayCoordinate
  ) -> NavOSSNavigationRouteOrigin? {
    owner?.rerouteOriginLocked(at: coordinate)
  }
}
