import Foundation
import XCTest

@testable import NavOSSNavigationCore

/// Records everything a `NavigationEngine` asks its host to do, in order.
final class RecordingEngineHost: NavigationEngineHost, @unchecked Sendable {
  enum Event: Equatable {
    case publication(generation: UInt64, sequence: Int, tripId: String?)
    case restoredTripAcquisition(generation: UInt64, tripId: String)
    case clearTrip(generation: UInt64)
    case stateDidChange
    case speak(NavigationEngineSpeech, generation: UInt64)
    case cancelSpeech(generation: UInt64)
    case needsLocationUpdates
    case reconcileLocationUpdates(generation: UInt64)
    case startClock(generation: UInt64)
    case stopClock(generation: UInt64)
    /// A `RecordingEngineCompanion` call, in the same order as the host's.
    case companion(String)

    /// Short form for order assertions: the effect and its generation.
    var label: String {
      switch self {
      case .publication(let generation, _, _): "publication#\(generation)"
      case .restoredTripAcquisition(let generation, _): "acquisition#\(generation)"
      case .clearTrip(let generation): "clearTrip#\(generation)"
      case .stateDidChange: "stateDidChange"
      case .speak(let speech, let generation): "speak(\(speech.kind))#\(generation)"
      case .cancelSpeech(let generation): "cancelSpeech#\(generation)"
      case .needsLocationUpdates: "needsLocationUpdates"
      case .reconcileLocationUpdates(let generation): "reconcile#\(generation)"
      case .startClock(let generation): "startClock#\(generation)"
      case .stopClock(let generation): "stopClock#\(generation)"
      case .companion(let call): "companion.\(call)"
      }
    }
  }

  private let lock = NSLock()
  private var recorded: [Event] = []
  /// Origin returned for a reroute request; `nil` means no recent platform fix.
  var rerouteOrigin: NavOSSNavigationRouteOrigin?
  /// Runs inside `navigationEngineStateDidChange`, after it is recorded: the engine has
  /// released its lock, so a test can re-enter it here as another thread could.
  var onStateDidChange: (() -> Void)?

  var events: [Event] { lock.withLock { recorded } }

  /// The guidance of every publication, in order (`nil` where it carried none).
  var publishedGuidance: [NavOSSCarPlayGuidance?] { lock.withLock { guidances } }
  private var guidances: [NavOSSCarPlayGuidance?] = []
  /// What CarPlay is told in place of a maneuver at every publication and acquisition, in
  /// order, as the iOS service asks the engine (`tripPauseLocked`). Recorded only once
  /// `tripPause` is set.
  var publishedTripPauses: [NavOSSCarPlayTripPause?] { lock.withLock { tripPauses } }
  private var tripPauses: [NavOSSCarPlayTripPause?] = []
  /// The same, at every `navigationEngineStateDidChange`, as the iOS service stores it.
  var tripPausesAtStateChange: [NavOSSCarPlayTripPause?] { lock.withLock { stateChangePauses } }
  private var stateChangePauses: [NavOSSCarPlayTripPause?] = []
  var tripPause: (() -> NavOSSCarPlayTripPause?)?

  var spoken: [NavigationEngineSpeech] {
    events.compactMap {
      if case .speak(let speech, _) = $0 { return speech }
      return nil
    }
  }

  func removeAll() {
    lock.withLock { recorded.removeAll() }
  }

  fileprivate func record(_ event: Event) {
    lock.withLock { recorded.append(event) }
  }

  func navigationEnginePreparePublicationLocked(
    _ update: VersionedNavigationUpdate
  ) -> (() -> Void)? {
    let event = Event.publication(
      generation: update.generation, sequence: update.update.snapshot.sequence,
      tripId: update.update.trip?.id)
    let guidance = update.update.guidance
    let pause = tripPause.map { $0() }
    return { [weak self] in
      self?.record(event)
      self?.lock.withLock {
        self?.guidances.append(guidance)
        if let pause { self?.tripPauses.append(pause) }
      }
    }
  }

  func navigationEnginePrepareRestoredTripAcquisitionLocked(
    trip: NavOSSCarPlayTrip,
    _ update: VersionedNavigationUpdate
  ) -> (() -> Void)? {
    let event = Event.restoredTripAcquisition(generation: update.generation, tripId: trip.id)
    let pause = tripPause.map { $0() }
    return { [weak self] in
      self?.record(event)
      if let pause { self?.lock.withLock { self?.tripPauses.append(pause) } }
    }
  }

  func navigationEngineDidClearTrip(generation: UInt64, sequence: Int) {
    record(.clearTrip(generation: generation))
  }

  func navigationEngineStateDidChange() {
    record(.stateDidChange)
    if let pause = tripPause.map({ $0() }) {
      lock.withLock { stateChangePauses.append(pause) }
    }
    onStateDidChange?()
  }

  func navigationEngineSpeak(_ speech: NavigationEngineSpeech, generation: UInt64) {
    record(.speak(speech, generation: generation))
  }

  func navigationEngineCancelSpeech(generation: UInt64) {
    record(.cancelSpeech(generation: generation))
  }

  func navigationEngineNeedsLocationUpdates() {
    record(.needsLocationUpdates)
  }

  func navigationEngineReconcileLocationUpdates(generation: UInt64) {
    record(.reconcileLocationUpdates(generation: generation))
  }

  func navigationEngineStartClock(generation: UInt64) {
    record(.startClock(generation: generation))
  }

  func navigationEngineStopClock(generation: UInt64) {
    record(.stopClock(generation: generation))
  }

  func navigationEngineRerouteOriginLocked(
    at coordinate: NavOSSCarPlayCoordinate
  ) -> NavOSSNavigationRouteOrigin? {
    rerouteOrigin
  }
}

/// A network answered by the test. Reroute requests wait until the test opens the gate
/// (`completePendingReroute`), so nothing a reroute does can interleave with the fix that asked
/// for it. A waiting request is suspended, not parked on a thread: the cooperative pool has as
/// many threads as cores (three on GitHub's macOS runner), and a blocked one starves every
/// later test. A test must not end with a request waiting: `assertNothingWaiting()` (run by
/// every engine test class's tear-down) fails the test that left one and lets it through.
final class ScriptedEngineNetwork: NavigationEngineNetwork, @unchecked Sendable {
  struct Request: Equatable {
    let origin: NavOSSCarPlayCoordinate
    let originHeadingDegrees: Double?
    let alternatives: Int
    let waypointIds: [String]
    let passThroughWaypointIds: Set<String>
  }

  private let lock = NSLock()
  private var clients = 0
  private var made: [Request] = []
  private var cameraFetches = 0
  private var isOpen = false
  /// Requests suspended at the closed gate, resumed when it opens.
  private var waiting: [Waiter] = []
  private var nextWaiterId = 0
  private struct Waiter {
    let id: Int
    let request: Request
    let continuation: CheckedContinuation<Void, Never>
    /// The engine withdrew the request (cancelled its task) while it waited.
    var isWithdrawn = false
  }
  /// Every network made since the last `assertNothingWaiting()`.
  private static let registryLock = NSLock()
  nonisolated(unsafe) private static var live: [WeakNetwork] = []
  private struct WeakNetwork { weak var network: ScriptedEngineNetwork? }
  /// Answers a request; throwing makes it fail.
  var answer: (Request) throws -> [NavOSSCarPlayTrip]
  var cameras: () throws -> [NavOSSSafetyCamera] = { [] }

  init(answer: @escaping (Request) throws -> [NavOSSCarPlayTrip]) {
    self.answer = answer
    Self.registryLock.withLock { Self.live.append(WeakNetwork(network: self)) }
  }

  /// Requests waiting at the gate that the engine has not withdrawn.
  var waitingCount: Int { lock.withLock { waiting.filter { !$0.isWithdrawn }.count } }
  /// Requests suspended at the gate, withdrawn or not.
  var suspendedCount: Int { lock.withLock { waiting.count } }

  /// Fails the current test if any network made during it still holds a request the engine
  /// is waiting for, then lets every waiting request through so nothing is left suspended.
  /// Call from `tearDown`.
  static func assertNothingWaiting(file: StaticString = #filePath, line: UInt = #line) {
    let networks = registryLock.withLock {
      defer { live.removeAll() }
      return live.compactMap(\.network)
    }
    for network in networks {
      let leaked = network.waitingCount
      if leaked > 0 {
        XCTFail(
          "\(leaked) reroute request(s) left waiting at the scripted network's gate",
          file: file, line: line)
      }
      network.setGateOpen(true)
    }
  }

  /// Reroutes asked for (one client per reroute, as the API network makes).
  var rerouteCount: Int { lock.withLock { clients } }
  var requests: [Request] { lock.withLock { made } }
  var cameraFetchCount: Int { lock.withLock { cameraFetches } }

  func rerouteClient() throws -> any NavigationRerouteRouting {
    lock.withLock { clients += 1 }
    return Client(network: self)
  }

  func safetyCameras() async throws -> [NavOSSSafetyCamera] {
    lock.withLock { cameraFetches += 1 }
    return try cameras()
  }

  /// Lets requests through (`true`) or holds them (`false`).
  func setGateOpen(_ open: Bool) {
    let resumed = lock.withLock {
      isOpen = open
      guard open else { return [CheckedContinuation<Void, Never>]() }
      defer { waiting.removeAll() }
      return waiting.map(\.continuation)
    }
    resumed.forEach { $0.resume() }
  }

  /// Lets through only the waiting requests `matching` picks; the gate stays as it is.
  func release(_ matching: (Request) -> Bool) {
    let resumed = lock.withLock {
      let picked = waiting.filter { matching($0.request) }
      waiting.removeAll { matching($0.request) }
      return picked.map(\.continuation)
    }
    resumed.forEach { $0.resume() }
  }

  /// Waits at the gate without holding a thread. A request the engine withdrew while it waited
  /// (the vehicle rejoined the route, the trip was cleared or replaced) still waits, so a test
  /// can deliver its late answer; it is only marked, so tear-down does not count it as leaked.
  fileprivate func respond(_ request: Request) async throws -> [NavOSSCarPlayTrip] {
    let id = lock.withLock {
      nextWaiterId += 1
      return nextWaiterId
    }
    await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        let passes: Bool = lock.withLock {
          if isOpen { return true }
          // Cancelled before it got here: `onCancel` has already run and found nothing.
          waiting.append(
            Waiter(
              id: id, request: request, continuation: continuation,
              isWithdrawn: Task.isCancelled))
          return false
        }
        if passes { continuation.resume() }
      }
    } onCancel: {
      lock.withLock {
        if let index = waiting.firstIndex(where: { $0.id == id }) {
          waiting[index].isWithdrawn = true
        }
      }
    }
    lock.withLock { made.append(request) }
    return try answer(request)
  }

  private struct Client: NavigationRerouteRouting, @unchecked Sendable {
    let network: ScriptedEngineNetwork

    func routes(
      origin: NavOSSCarPlayCoordinate,
      originHeadingDegrees: Double?,
      originHorizontalAccuracyMeters: Double?,
      destination: NavOSSCarPlayDestination,
      preferences: NavOSSRoutePreferences,
      alternatives: Int,
      waypoints: [NavOSSCarPlayDestination],
      passThroughWaypointIds: Set<String>,
      requireCoverage: Bool
    ) async throws -> [NavOSSCarPlayTrip] {
      try await network.respond(
        Request(
          origin: origin, originHeadingDegrees: originHeadingDegrees, alternatives: alternatives,
          waypointIds: waypoints.map(\.id), passThroughWaypointIds: passThroughWaypointIds))
    }
  }
}

/// A settable clock.
final class EngineTestClock: @unchecked Sendable {
  private let lock = NSLock()
  private var current: Date

  init(_ time: TimeInterval) {
    current = Date(timeIntervalSinceReferenceDate: time)
  }

  var now: Date {
    get { lock.withLock { current } }
    set { lock.withLock { current = newValue } }
  }

  var time: TimeInterval {
    get { now.timeIntervalSinceReferenceDate }
    set { now = Date(timeIntervalSinceReferenceDate: newValue) }
  }

  func advance(_ seconds: TimeInterval) {
    time += seconds
  }
}

/// Records the companion's calls into `host`'s events, so their order against the host's
/// effects can be asserted.
final class RecordingEngineCompanion: NavigationEngineCompanion {
  private let host: RecordingEngineHost
  /// Announcement returned for every published update; `nil` for none.
  var announcement: (() -> String?)?

  init(host: RecordingEngineHost) {
    self.host = host
  }

  func navigationDidStart(_ trip: NavOSSCarPlayTrip, restored: Bool) {
    host.record(.companion(restored ? "didStart(restored)" : "didStart"))
  }

  func navigationRouteDidChange(_ trip: NavOSSCarPlayTrip) {
    host.record(.companion("routeDidChange"))
  }

  func navigationDidEnd() {
    host.record(.companion("didEnd"))
  }

  func navigationClockTick() {}

  func navigationDidUpdateLocked(routeProgress: Double, isTracking: Bool) -> (() -> String?)? {
    announcement
  }
}

/// Blocks until `task` finishes; fails the test instead of hanging if it does not.
func waitForEngineTask(
  _ task: Task<Void, Never>?, file: StaticString = #filePath, line: UInt = #line
) {
  guard let task else { return }
  let done = DispatchSemaphore(value: 0)
  Task {
    await task.value
    done.signal()
  }
  if done.wait(timeout: .now() + 60) == .timedOut {
    XCTFail("the engine's task did not finish", file: file, line: line)
  }
}

extension NavigationEngine {
  /// Lets an in-flight reroute through `network`'s gate and waits for it to finish. Returns
  /// whether one was in flight.
  @discardableResult
  func completePendingReroute(through network: ScriptedEngineNetwork) -> Bool {
    guard let task = pendingRerouteTask else { return false }
    network.setGateOpen(true)
    defer { network.setGateOpen(false) }
    waitForEngineTask(task)
    return true
  }

  /// Waits for an in-flight safety-camera fetch.
  func completePendingSafetyCameraFetch() {
    waitForEngineTask(pendingSafetyCameraTask)
  }
}

/// A trip store backed by a throwaway `UserDefaults` suite, as in the app. The suite is
/// removed with the fixture.
final class EngineTripStoreFixture {
  let store: NavOSSActiveTripStore
  let defaults: UserDefaults
  private let suite = "navigation-engine-\(UUID().uuidString)"

  init(clock: EngineTestClock? = nil) {
    defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    store = NavOSSActiveTripStore(defaults: defaults, clock: { clock?.now ?? Date() })
  }

  deinit {
    defaults.removePersistentDomain(forName: suite)
  }
}
