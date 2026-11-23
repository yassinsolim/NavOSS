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
  }

  private let lock = NSLock()
  private var recorded: [Event] = []
  /// Origin returned for a reroute request; `nil` means no recent platform fix.
  var rerouteOrigin: NavOSSNavigationRouteOrigin?

  var events: [Event] { lock.withLock { recorded } }

  var spoken: [NavigationEngineSpeech] {
    events.compactMap {
      if case .speak(let speech, _) = $0 { return speech }
      return nil
    }
  }

  func removeAll() {
    lock.withLock { recorded.removeAll() }
  }

  private func record(_ event: Event) {
    lock.withLock { recorded.append(event) }
  }

  func navigationEnginePreparePublicationLocked(
    _ update: VersionedNavigationUpdate
  ) -> (() -> Void)? {
    let event = Event.publication(
      generation: update.generation, sequence: update.update.snapshot.sequence,
      tripId: update.update.trip?.id)
    return { [weak self] in self?.record(event) }
  }

  func navigationEnginePrepareRestoredTripAcquisitionLocked(
    trip: NavOSSCarPlayTrip,
    _ update: VersionedNavigationUpdate
  ) -> (() -> Void)? {
    let event = Event.restoredTripAcquisition(generation: update.generation, tripId: trip.id)
    return { [weak self] in self?.record(event) }
  }

  func navigationEngineDidClearTrip(generation: UInt64, sequence: Int) {
    record(.clearTrip(generation: generation))
  }

  func navigationEngineStateDidChange() {
    record(.stateDidChange)
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
/// for it.
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
  private let gate = NSCondition()
  private var isOpen = false
  /// Answers a request; throwing makes it fail.
  var answer: (Request) throws -> [NavOSSCarPlayTrip]
  var cameras: () throws -> [NavOSSSafetyCamera] = { [] }

  init(answer: @escaping (Request) throws -> [NavOSSCarPlayTrip]) {
    self.answer = answer
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
    gate.lock()
    isOpen = open
    gate.broadcast()
    gate.unlock()
  }

  fileprivate func respond(_ request: Request) throws -> [NavOSSCarPlayTrip] {
    gate.lock()
    while !isOpen { gate.wait() }
    gate.unlock()
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
      try network.respond(
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

extension NavigationEngine {
  /// Lets an in-flight reroute through `network`'s gate and waits for it to finish. Returns
  /// whether one was in flight.
  @discardableResult
  func completePendingReroute(through network: ScriptedEngineNetwork) -> Bool {
    guard currentState().routeStatus == .rerouting else { return false }
    network.setGateOpen(true)
    defer { network.setGateOpen(false) }
    let done = DispatchSemaphore(value: 0)
    Task {
      await self.waitForPendingReroute()
      done.signal()
    }
    done.wait()
    return true
  }

  /// Waits for an in-flight safety-camera fetch.
  func completePendingSafetyCameraFetch() {
    let done = DispatchSemaphore(value: 0)
    Task {
      await self.waitForPendingSafetyCameraFetch()
      done.signal()
    }
    done.wait()
  }
}

/// A trip store backed by a throwaway `UserDefaults` suite, as in the app.
func makeEngineTripStore(
  clock: EngineTestClock? = nil
) -> (NavOSSActiveTripStore, UserDefaults) {
  let suite = "navigation-engine-\(UUID().uuidString)"
  let defaults = UserDefaults(suiteName: suite)!
  defaults.removePersistentDomain(forName: suite)
  let store = NavOSSActiveTripStore(
    defaults: defaults, clock: { clock?.now ?? Date() })
  return (store, defaults)
}
