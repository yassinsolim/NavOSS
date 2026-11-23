import Foundation

// The platform-neutral navigation orchestration: what happens to a trip between a location fix
// and what the driver sees and hears. It drives `NavigationSession` (matching and guidance) and
// owns everything that used to live beside it in the iOS service: the order in which a fix is
// published (camera, speeding and report alerts, then the maneuver prompt), reroute consent and
// requests, the one-second clock's work, safety-camera fetching, speeding, and the checks and
// checkpoints that let a trip be restored after a relaunch.
//
// The platform supplies location fixes, ticks, storage, the network and the effects
// (`NavigationEngineHost`): on iOS that is `NavOSSNavigationService` with CoreLocation,
// AVFoundation and CarPlay; on Android the JNI layer. Nothing here imports a platform framework
// or the community and offline code, so the Android build can leave those out.
//
// Threading: every entry point may be called from any thread. All state is guarded by `lock`,
// a recursive lock the host shares (the iOS service guards its own location state with it too,
// so the two stay consistent exactly as when they were one object). Host callbacks run
// synchronously on the calling thread: those named `...Locked` or documented as such run while
// `lock` is held, every other one after it is released. Reroute and camera requests run in
// unstructured tasks and re-enter through the same lock.

/// A session update and the navigation generation it was produced in. A later start, reroute or
/// clear moves the generation on, which makes everything produced earlier stale.
struct VersionedNavigationUpdate: Sendable {
  let generation: UInt64
  let update: NavigationSessionUpdate
}

/// Something the engine wants spoken.
struct NavigationEngineSpeech: Equatable, Sendable {
  enum Kind: Equatable, Sendable {
    /// A camera, speeding or road-report alert, or "A new route is ready."
    case alert
    /// The maneuver prompt planned for an update.
    case maneuver
  }

  let text: String
  let kind: Kind
}

/// What became of a location fix.
enum NavigationEngineFixOutcome {
  /// Published to the driver (see `NavigationEngineHost`).
  case published(VersionedNavigationUpdate)
  /// A restored trip still finding its place: shown as acquiring, nothing guided.
  case acquiring(VersionedNavigationUpdate)
  /// A restored trip whose first fix was off its route; the trip was ended.
  case discarded(VersionedNavigationUpdate)

  var versionedUpdate: VersionedNavigationUpdate {
    switch self {
    case .published(let update), .acquiring(let update), .discarded(let update): update
    }
  }
}

/// Where the active trip is kept so a relaunch can resume it.
protocol NavigationTripStoring: AnyObject {
  func save(_ trip: NavOSSCarPlayTrip)
  func load() -> NavOSSCarPlayTrip?
  func clear()
  func saveProgress(_ progress: NavigationResumeContext, forTripId tripId: String)
  func loadProgress(for trip: NavOSSCarPlayTrip) -> NavigationResumePoint
}

extension NavOSSActiveTripStore: NavigationTripStoring {}

/// Fetches routes for a reroute. `NavOSSNavigationAPIClient` is the production implementation.
protocol NavigationRerouteRouting: Sendable {
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
  ) async throws -> [NavOSSCarPlayTrip]
}

extension NavOSSNavigationAPIClient: NavigationRerouteRouting {}

/// The engine's network: a routes client for each reroute and the fixed-camera list.
protocol NavigationEngineNetwork: Sendable {
  /// A client for one reroute (both of its requests when a keep-route rejoin is tried first).
  func rerouteClient() throws -> any NavigationRerouteRouting
  func safetyCameras() async throws -> [NavOSSSafetyCamera]
}

/// The NavOSS API, through a fresh `NavOSSNavigationAPIClient` per reroute or camera fetch.
struct NavOSSNavigationAPIEngineNetwork: NavigationEngineNetwork {
  func rerouteClient() throws -> any NavigationRerouteRouting {
    try NavOSSNavigationAPIClient()
  }

  func safetyCameras() async throws -> [NavOSSSafetyCamera] {
    try await NavOSSNavigationAPIClient().safetyCameras()
  }
}

/// Features that ride along with a trip without being part of navigation (on iOS, community
/// road reports and traffic speeds). Optional: Android has none yet.
protocol NavigationEngineCompanion: AnyObject {
  func navigationDidStart(_ trip: NavOSSCarPlayTrip, restored: Bool)
  func navigationRouteDidChange(_ trip: NavOSSCarPlayTrip)
  func navigationDidEnd()
  func navigationClockTick()
  /// Called with the engine's lock held, for every published update. Returns `nil` when there
  /// is nothing to announce. Otherwise it returns the announcement, which the engine evaluates
  /// (still under the lock) only when alerts are allowed: the text to speak, or `nil` when the
  /// driver turned these announcements off.
  func navigationDidUpdateLocked(routeProgress: Double, isTracking: Bool) -> (() -> String?)?
}

/// The platform side of the engine.
protocol NavigationEngineHost: AnyObject {
  /// Lock held. Captures whatever the platform publishes beside `update` (on iOS, the CarPlay
  /// position from the latest raw fix and compass) and returns the work to do once the lock is
  /// released, which the engine runs before `navigationEngineStateDidChange`.
  func navigationEnginePreparePublicationLocked(
    _ update: VersionedNavigationUpdate
  ) -> (() -> Void)?
  /// Lock held. As above, for a restored trip that is still finding its place.
  func navigationEnginePrepareRestoredTripAcquisitionLocked(
    trip: NavOSSCarPlayTrip,
    _ update: VersionedNavigationUpdate
  ) -> (() -> Void)?
  /// The trip of `generation` was cleared.
  func navigationEngineDidClearTrip(generation: UInt64, sequence: Int)
  /// State readers should read again (`currentState`).
  func navigationEngineStateDidChange()
  /// Speak `speech`, unless `generation` is no longer current when it is due.
  func navigationEngineSpeak(_ speech: NavigationEngineSpeech, generation: UInt64)
  /// Stop guidance speech, if `generation` is still current.
  func navigationEngineCancelSpeech(generation: UInt64)
  /// A trip started or a route was installed: make sure location updates run.
  func navigationEngineNeedsLocationUpdates()
  /// A trip ended or arrived: decide again whether location updates are needed.
  func navigationEngineReconcileLocationUpdates(generation: UInt64)
  /// Start or stop the one-second clock that calls `clockTick()`, for `generation` only.
  func navigationEngineStartClock(generation: UInt64)
  func navigationEngineStopClock(generation: UInt64)
  /// Lock held. The reroute origin at `coordinate`, with the heading and accuracy of the latest
  /// platform fix when it is recent enough to use; `nil` without one.
  func navigationEngineRerouteOriginLocked(
    at coordinate: NavOSSCarPlayCoordinate
  ) -> NavOSSNavigationRouteOrigin?
}

final class NavigationEngine: @unchecked Sendable {
  /// Guards all engine state. Shared with the host; see the file comment.
  let lock: NSRecursiveLock

  weak var host: NavigationEngineHost?
  var companion: NavigationEngineCompanion?

  private let tripStore: NavigationTripStoring
  private let network: NavigationEngineNetwork
  private let clock: () -> Date
  private var announcementState: NavOSSCarPlayAudioState
  private var navigationGeneration: UInt64 = 0
  private var navigationPreferences: NavOSSNavigationPreferences
  private let navigationSession: NavigationSession
  private var rerouteConsent = NavigationRerouteConsent()
  private var rerouteCount = 0
  private var rerouteRequestId: UUID?
  /// Requests that have failed in a row since the vehicle left the route. Spaces out retries.
  private var rerouteFailureCount = 0
  private var rerouteRetryAfter: Date?
  private var rerouteTask: Task<Void, Never>?
  private var routeStatus = NavOSSNavigationRouteStatus.tracking
  private var safetyCameraFetchAttemptedAt: Date?
  private var safetyCameraFetchedAt: Date?
  private var safetyCameraMonitor = NavigationSafetyCameraMonitor()
  private var safetyCameraTask: Task<Void, Never>?
  private var speedingMonitor = NavigationSpeedingMonitor()
  private let speechPlanner = NavigationSpeechPlanner()
  private var stateVersion: UInt64 = 0
  private var lastProgressPersistedAt: Date?
  /// The checkpoint last written for the current route, to write a change of arrival deferral
  /// at once instead of up to fifteen seconds later.
  private var lastPersistedProgress: NavigationResumeContext?
  #if DEBUG
    /// Simulator harness only: runs inside the checkpoint's critical section, just before the
    /// store write, so a test can hold it there while a clear or restart competes for the lock.
    var checkpointWillWrite: (() -> Void)?
  #endif
  private var validatesPersistedNavigation = false
  private var tripEndReason: NavOSSTripEndReason?

  init(
    tripStore: NavigationTripStoring,
    audioMode: NavOSSCarPlayAudioMode,
    preferences: NavOSSNavigationPreferences,
    network: NavigationEngineNetwork = NavOSSNavigationAPIEngineNetwork(),
    session: NavigationSession = NavigationSession(),
    lock: NSRecursiveLock = NSRecursiveLock(),
    clock: @escaping () -> Date = Date.init
  ) {
    self.tripStore = tripStore
    announcementState = NavOSSCarPlayAudioState(mode: audioMode)
    navigationPreferences = preferences
    self.network = network
    navigationSession = session
    self.lock = lock
    self.clock = clock
  }

  // MARK: Reads (lock held by the caller)

  var navigationGenerationLocked: UInt64 { navigationGeneration }
  var allowsAlertsLocked: Bool { announcementState.allowsAlerts }
  var tripLocked: NavOSSCarPlayTrip? { navigationSession.trip }

  func currentUpdateLocked() -> NavigationSessionUpdate {
    navigationSession.currentUpdate()
  }

  func safetyCameraLocked(id: String) -> NavOSSSafetyCamera? {
    safetyCameraMonitor.camera(id: id)
  }

  /// The state every reader gets: the module's `getSnapshot` and change events, CarPlay's live
  /// guidance, and everything else that pulls it. A restored trip not yet matched on a known
  /// pass is withheld here, not only from the published updates.
  func currentStateLocked() -> NavOSSNavigationServiceState {
    let update = navigationSession.currentUpdate()
    let state = NavOSSNavigationServiceState(
      guidance: update.guidance,
      navigation: update.snapshot,
      rerouteCount: rerouteCount,
      rerouteMode: navigationPreferences.rerouteMode,
      rerouteProposal: rerouteConsent.proposal,
      roadContext: update.roadContext,
      routeStatus: routeStatus,
      safetyCameraAlert: safetyCameraMonitor.activeAlert,
      speedingState: speedingMonitor.state,
      stateVersion: stateVersion,
      trip: update.trip,
      tripEndReason: update.trip == nil ? tripEndReason : nil
    )
    return validatesPersistedNavigation && update.trip != nil
      ? state.acquiringRestoredTrip() : state
  }

  func currentState() -> NavOSSNavigationServiceState {
    lock.lock()
    defer { lock.unlock() }
    return currentStateLocked()
  }

  // MARK: Preferences and audio

  /// Shared reroute/speeding preferences, as the engine is currently applying them.
  func currentNavigationPreferences() -> NavOSSNavigationPreferences {
    lock.lock()
    defer { lock.unlock() }
    return navigationPreferences
  }

  /// Applies newly loaded preferences. A mode change can resolve a pending proposal (switching
  /// to automatic installs it).
  func setNavigationPreferences(_ preferences: NavOSSNavigationPreferences) {
    lock.lock()
    let changed = preferences != navigationPreferences
    navigationPreferences = preferences
    if changed {
      stateVersion &+= 1
    }
    lock.unlock()
    guard changed else { return }
    host?.navigationEngineStateDidChange()
    lock.lock()
    let versionedUpdate = VersionedNavigationUpdate(
      generation: navigationGeneration,
      update: navigationSession.currentUpdate()
    )
    lock.unlock()
    evaluateReroute(for: versionedUpdate)
  }

  func audioMode() -> NavOSSCarPlayAudioMode {
    lock.lock()
    defer { lock.unlock() }
    return announcementState.mode
  }

  func setAudioMode(_ mode: NavOSSCarPlayAudioMode) {
    lock.lock()
    guard announcementState.mode != mode else {
      lock.unlock()
      return
    }
    announcementState.setMode(mode)
    let generation = navigationGeneration
    lock.unlock()
    if mode != .allGuidance {
      host?.navigationEngineCancelSpeech(generation: generation)
    }
  }

  // MARK: Reroute consent

  /// Accepts the pending ask-first replacement route. Returns `false` when `id` is no longer
  /// pending (withdrawn, timed out, or already answered).
  @discardableResult
  func acceptRerouteProposal(id: String) -> Bool {
    lock.lock()
    guard let replacement = rerouteConsent.accept(
      id: id,
      now: clock().timeIntervalSinceReferenceDate
    ),
      let tripId = navigationSession.trip?.id
    else {
      lock.unlock()
      return false
    }
    let generation = navigationGeneration
    lock.unlock()
    return (try? installReroute(
      replacement,
      expectedGeneration: generation,
      expectedTripId: tripId,
      requestId: nil
    )) ?? false
  }

  /// Declines the pending ask-first replacement; the selected route stays.
  @discardableResult
  func declineRerouteProposal(id: String) -> Bool {
    lock.lock()
    guard rerouteConsent.decline(id: id, now: clock().timeIntervalSinceReferenceDate) else {
      lock.unlock()
      return false
    }
    routeStatus = .tracking
    stateVersion &+= 1
    lock.unlock()
    host?.navigationEngineStateDidChange()
    return true
  }

  // MARK: Trip lifecycle

  func startNavigation(_ trip: NavOSSCarPlayTrip) throws {
    try startNavigation(trip, persist: true)
  }

  func resumePersistedNavigation() {
    guard let trip = tripStore.load() else {
      return
    }
    do {
      try startNavigation(
        trip,
        persist: false,
        resume: tripStore.loadProgress(for: trip)
      )
    } catch {
      tripStore.clear()
    }
  }

  /// Starts guiding `trip`. With `resume` it is a trip restored after a relaunch: nothing is
  /// guided from it until a fix is matched on a known pass, and until then it is shown as
  /// finding its place on the route.
  private func startNavigation(
    _ trip: NavOSSCarPlayTrip,
    persist: Bool,
    resume: NavigationResumePoint? = nil
  ) throws {
    let update: NavigationSessionUpdate
    lock.lock()
    do {
      update = try navigationSession.start(trip, resume: resume)
      lastProgressPersistedAt = nil
      lastPersistedProgress = nil
      navigationGeneration &+= 1
      rerouteTask?.cancel()
      rerouteTask = nil
      rerouteRequestId = nil
      rerouteRetryAfter = nil
      rerouteFailureCount = 0
      rerouteCount = 0
      rerouteConsent.reset()
      routeStatus = .tracking
      safetyCameraMonitor.startTrip(geometry: Self.coordinates(trip))
      speechPlanner.reset()
      speedingMonitor.reset()
      validatesPersistedNavigation = resume != nil
      tripEndReason = nil
      stateVersion &+= 1
      if persist {
        tripStore.save(trip)
      }
    } catch {
      lock.unlock()
      throw error
    }
    let versionedUpdate = VersionedNavigationUpdate(
      generation: navigationGeneration,
      update: update
    )
    lock.unlock()
    companion?.navigationDidStart(trip, restored: resume != nil)
    host?.navigationEngineCancelSpeech(generation: versionedUpdate.generation)
    if resume == nil {
      publish(versionedUpdate)
    } else {
      publishRestoredTripAcquisition(versionedUpdate)
    }
    host?.navigationEngineNeedsLocationUpdates()
    host?.navigationEngineStartClock(generation: versionedUpdate.generation)
    refreshSafetyCamerasIfNeeded()
  }

  func clearNavigation(endReason: NavOSSTripEndReason? = nil) {
    lock.lock()
    tripEndReason = endReason
    let update = navigationSession.clear()
    navigationGeneration &+= 1
    let generation = navigationGeneration
    rerouteTask?.cancel()
    rerouteTask = nil
    rerouteRequestId = nil
    rerouteRetryAfter = nil
    rerouteFailureCount = 0
    rerouteCount = 0
    rerouteConsent.reset()
    routeStatus = .tracking
    safetyCameraMonitor.endTrip()
    speechPlanner.reset()
    speedingMonitor.reset()
    stateVersion &+= 1
    tripStore.clear()
    lock.unlock()
    host?.navigationEngineStopClock(generation: generation)
    companion?.navigationDidEnd()
    host?.navigationEngineDidClearTrip(generation: generation, sequence: update.snapshot.sequence)
    host?.navigationEngineStateDidChange()
    host?.navigationEngineReconcileLocationUpdates(generation: generation)
    host?.navigationEngineCancelSpeech(generation: generation)
  }

  // MARK: Fixes

  /// Feeds a fix through the session and publishes, reroutes and checkpoints as it calls for.
  /// Throws, changing nothing, when there is no active trip or the fix is invalid.
  @discardableResult
  func ingest(_ sample: NavigationLocationSample) throws -> NavigationEngineFixOutcome {
    let versionedUpdate: VersionedNavigationUpdate
    lock.lock()
    do {
      let update = try navigationSession.updateLocation(sample)
      versionedUpdate = prepareForPublicationLocked(update)
    } catch {
      lock.unlock()
      throw error
    }
    lock.unlock()
    switch persistedNavigationDecision(versionedUpdate) {
    case .discard:
      clearNavigation(endReason: .restoredTripOffRoute)
      return .discarded(versionedUpdate)
    case .publish:
      publish(versionedUpdate)
      evaluateReroute(for: versionedUpdate)
      persistProgressIfDue(versionedUpdate)
      return .published(versionedUpdate)
    case .wait:
      publishRestoredTripAcquisition(versionedUpdate)
      return .acquiring(versionedUpdate)
    }
  }

  /// Records how far the trip has got, so that a relaunch resumes it there. Written from a
  /// real fix matched on a known pass of the route, at most every fifteen seconds, and at once
  /// whenever an arrival starts or stops waiting for movement (a relaunch must not lose that).
  /// Written while holding `lock`: a clear, a restart or a reroute takes the same lock before
  /// it touches the store, so a checkpoint can never be written after them for the trip they
  /// replaced, even one that keeps the trip's identifier.
  private func persistProgressIfDue(_ versionedUpdate: VersionedNavigationUpdate) {
    guard let trip = versionedUpdate.update.trip,
      navOSSIsProgressCheckpoint(versionedUpdate.update.snapshot)
    else {
      return
    }
    let now = clock()
    lock.lock()
    defer { lock.unlock() }
    guard isCurrentLocked(versionedUpdate),
      let progress = navigationSession.resumeContext,
      navOSSShouldPersistProgress(
        progress,
        lastPersisted: lastPersistedProgress,
        now: now,
        lastPersistedAt: lastProgressPersistedAt
      )
    else {
      return
    }
    #if DEBUG
      checkpointWillWrite?()
    #endif
    lastProgressPersistedAt = now
    lastPersistedProgress = progress
    tripStore.saveProgress(progress, forTripId: trip.id)
  }

  private func prepareForPublicationLocked(
    _ update: NavigationSessionUpdate
  ) -> VersionedNavigationUpdate {
    if update.snapshot.phase == .arrived || !update.snapshot.isOffRoute {
      rerouteTask?.cancel()
      rerouteTask = nil
      rerouteRequestId = nil
      rerouteRetryAfter = nil
      rerouteFailureCount = 0
      routeStatus = .tracking
    }
    if update.snapshot.phase == .arrived {
      tripStore.clear()
    }
    stateVersion &+= 1
    return VersionedNavigationUpdate(generation: navigationGeneration, update: update)
  }

  private func persistedNavigationDecision(
    _ versionedUpdate: VersionedNavigationUpdate
  ) -> NavOSSPersistedNavigationDecision {
    lock.lock()
    defer { lock.unlock() }
    guard isCurrentLocked(versionedUpdate) else {
      return .wait
    }
    guard validatesPersistedNavigation else {
      return .publish
    }
    let decision = navOSSPersistedNavigationDecision(versionedUpdate.update.snapshot)
    // Withholding ends with the update that is published. A discarded trip stays withheld
    // until `clearNavigation` removes it.
    if decision == .publish {
      validatesPersistedNavigation = false
    }
    return decision
  }

  /// A restored trip that has not yet been matched on a known pass (see
  /// `navOSSPersistedNavigationDecision`): the phone and CarPlay show the trip, finding its
  /// place, with End available, and nothing else. No guidance, step, road, speed limit or
  /// estimate from where the trip was saved, no speech, no alerts. `currentStateLocked`
  /// withholds the same for every read until a fix is accepted.
  private func publishRestoredTripAcquisition(_ versionedUpdate: VersionedNavigationUpdate) {
    lock.lock()
    guard isCurrentLocked(versionedUpdate), validatesPersistedNavigation,
      let trip = versionedUpdate.update.trip
    else {
      lock.unlock()
      return
    }
    let apply = host?.navigationEnginePrepareRestoredTripAcquisitionLocked(
      trip: trip, versionedUpdate)
    lock.unlock()
    apply?()
    host?.navigationEngineStateDidChange()
  }

  private func publish(_ versionedUpdate: VersionedNavigationUpdate) {
    lock.lock()
    guard isCurrentLocked(versionedUpdate) else {
      lock.unlock()
      return
    }
    let update = versionedUpdate.update
    let applyPublication = host?.navigationEnginePreparePublicationLocked(versionedUpdate)
    let now = clock().timeIntervalSinceReferenceDate
    // Alerts first (cameras, speeding), then the maneuver prompt: all from engine state, so
    // they keep working with the phone locked and only CarPlay on screen.
    var utterances: [String] = []
    let announcesCamera = safetyCameraMonitor.update(snapshot: update.snapshot)
    if announcesCamera, announcementState.allowsAlerts {
      utterances.append("Red light and speed camera ahead.")
    }
    if speedingMonitor.update(
      speedMetersPerSecond: update.snapshot.speedMetersPerSecond,
      speedLimitKph: update.roadContext.speedLimitKph,
      preferences: navigationPreferences,
      now: now
    ), announcementState.allowsAlerts, let speedLimit = update.roadContext.speedLimitKph {
      utterances.append(navigationSpeedingWarningText(speedLimitKph: speedLimit))
    }
    let snapshot = update.snapshot
    if let reportAlert = companion?.navigationDidUpdateLocked(
      routeProgress: snapshot.routeProgress,
      isTracking: snapshot.phase == .tracking && !snapshot.isOffRoute
        && snapshot.rawCoordinate != nil && snapshot.matchedCoordinate != nil
    ), announcementState.allowsAlerts, let text = reportAlert() {
      utterances.append(text)
    }
    let speechPrompt =
      announcementState.allowsManeuverGuidance ? speechPlanner.prompt(for: update, now: now) : nil
    lock.unlock()
    applyPublication?()
    host?.navigationEngineStateDidChange()
    if update.snapshot.phase == .arrived, speechPrompt != nil {
      host?.navigationEngineCancelSpeech(generation: versionedUpdate.generation)
    }
    for text in utterances {
      host?.navigationEngineSpeak(
        NavigationEngineSpeech(text: text, kind: .alert), generation: versionedUpdate.generation)
    }
    if let speechPrompt {
      host?.navigationEngineSpeak(
        NavigationEngineSpeech(text: speechPrompt.text, kind: .maneuver),
        generation: versionedUpdate.generation)
    }
    if update.snapshot.phase == .arrived {
      companion?.navigationDidEnd()
      host?.navigationEngineStopClock(generation: versionedUpdate.generation)
      host?.navigationEngineReconcileLocationUpdates(generation: versionedUpdate.generation)
    }
  }

  // MARK: Rerouting

  /// Runs reroute consent for an update. Off route this requests a replacement (respecting the
  /// shared reroute mode); back on route it withdraws any pending proposal.
  private func evaluateReroute(for versionedUpdate: VersionedNavigationUpdate) {
    let update = versionedUpdate.update
    lock.lock()
    guard isCurrentLocked(versionedUpdate), let trip = update.trip else {
      lock.unlock()
      return
    }
    let mode = navigationPreferences.rerouteMode
    let now = clock()
    let isOffRoute = update.snapshot.phase == .tracking && update.snapshot.isOffRoute
    let canRequest = isOffRoute && update.snapshot.rawCoordinate != nil && rerouteTask == nil
      && (rerouteRetryAfter.map { $0 <= now } ?? true)
    switch rerouteConsent.evaluate(
      mode: mode,
      isOffRoute: isOffRoute,
      canRequest: canRequest,
      now: now.timeIntervalSinceReferenceDate
    ) {
    case .none:
      lock.unlock()
    case .withdrew, .expired:
      routeStatus = .tracking
      stateVersion &+= 1
      lock.unlock()
      host?.navigationEngineStateDidChange()
    case .installProposal(let proposal):
      let generation = navigationGeneration
      lock.unlock()
      _ = try? installReroute(
        proposal.trip,
        expectedGeneration: generation,
        expectedTripId: trip.id,
        requestId: nil
      )
    case .request:
      guard let rawCoordinate = update.snapshot.rawCoordinate else {
        lock.unlock()
        return
      }
      requestRerouteLocked(
        trip: trip,
        rawCoordinate: rawCoordinate,
        routeProgress: update.snapshot.routeProgress,
        mode: mode,
        generation: versionedUpdate.generation
      )
      lock.unlock()
      host?.navigationEngineStateDidChange()
    }
  }

  /// Starts the replacement-route request. Caller holds `lock`.
  private func requestRerouteLocked(
    trip: NavOSSCarPlayTrip,
    rawCoordinate: NavigationCoordinate,
    routeProgress: Double,
    mode: NavOSSRerouteMode,
    generation: UInt64
  ) {
    let requestId = UUID()
    let origin = NavOSSCarPlayCoordinate(
      latitude: rawCoordinate.latitude,
      longitude: rawCoordinate.longitude
    )
    let rerouteOrigin = host?.navigationEngineRerouteOriginLocked(at: origin)
    let remainingWaypoints = navOSSRemainingWaypoints(in: trip, after: routeProgress)
    // Keep-route recovery routes back onto the selected route ahead of the vehicle. It is only
    // used when no stop lies between here and the rejoin point, so no stop can be skipped.
    let rejoin: NavOSSCarPlayDestination? = {
      guard mode == .keepRoute, let routeLength = navigationSession.routeLengthMeters,
        routeLength > 0,
        let rejoinAlong = navigationKeepRouteRejoinAlongMeters(
          // Measured from where the vehicle is now, not from where it left the route: after a
          // long gap the confirmed progress can be kilometres behind it.
          fixAlongMeters: navigationSession.rejoinBaseAlongMeters(near: rawCoordinate)
            ?? routeProgress * routeLength,
          routeLengthMeters: routeLength
        ),
        navOSSRemainingWaypoints(in: trip, after: rejoinAlong / routeLength).count
          == remainingWaypoints.count,
        let point = navigationSession.routePoint(alongMeters: rejoinAlong)
      else {
        return nil
      }
      return NavOSSCarPlayDestination(
        id: "navoss-route-rejoin",
        label: "",
        latitude: point.latitude,
        longitude: point.longitude,
        name: "Selected route"
      )
    }()
    // Before the first match the replacement follows the driver's choice as far as it can.
    let hasMatchedRoute = navigationSession.hasMatchedRoute
    let network = network
    rerouteRequestId = requestId
    routeStatus = .rerouting
    stateVersion &+= 1
    rerouteTask = Task { [weak self] in
      guard let self else {
        return
      }
      do {
        let client = try network.rerouteClient()
        func fetch(
          _ waypoints: [NavOSSCarPlayDestination],
          passThroughWaypointIds: Set<String>
        ) async throws -> NavOSSCarPlayTrip? {
          let routes = try await client.routes(
            origin: origin,
            originHeadingDegrees: rerouteOrigin?.headingDegrees,
            originHorizontalAccuracyMeters: rerouteOrigin?.horizontalAccuracyMeters,
            destination: trip.destination,
            preferences: trip.preferences,
            alternatives: navigationRerouteAlternatives(
              hasMatchedRoute: hasMatchedRoute, waypointCount: waypoints.count),
            waypoints: waypoints,
            passThroughWaypointIds: passThroughWaypointIds,
            // The trip was planned inside coverage; the roads between may not be.
            requireCoverage: false
          )
          return navigationReplacement(
            from: routes, closestTo: trip, hasMatchedRoute: hasMatchedRoute)
        }
        let fetched = try await navigationFetchRecoveryRoute(
          rejoin: rejoin,
          remainingWaypoints: remainingWaypoints,
          fetch: fetch
        )
        guard !Task.isCancelled, let fetched else {
          throw NavOSSNavigationAPIError.invalidResponse
        }
        // The rejoin point steers the route; it is not a stop the driver asked for.
        let replacement = fetched.replacingWaypoints(
          remainingWaypoints.isEmpty ? nil : remainingWaypoints
        )
        self.handleReplacement(
          replacement,
          expectedGeneration: generation,
          expectedTripId: trip.id,
          requestId: requestId
        )
      } catch {
        guard !Task.isCancelled else {
          return
        }
        self.handleRerouteFailure(
          expectedGeneration: generation,
          expectedTripId: trip.id,
          requestId: requestId
        )
      }
    }
  }

  /// A replacement route arrived: install it, or in ask-first mode offer it.
  private func handleReplacement(
    _ replacement: NavOSSCarPlayTrip,
    expectedGeneration: UInt64,
    expectedTripId: String,
    requestId: UUID
  ) {
    lock.lock()
    let current = navigationSession.currentUpdate()
    guard navigationGeneration == expectedGeneration,
      rerouteRequestId == requestId,
      current.trip?.id == expectedTripId,
      current.snapshot.phase == .tracking,
      current.snapshot.isOffRoute
    else {
      lock.unlock()
      return
    }
    rerouteRequestId = nil
    rerouteTask = nil
    rerouteRetryAfter = nil
    rerouteFailureCount = 0
    let decision = rerouteConsent.received(
      replacement,
      mode: navigationPreferences.rerouteMode,
      remainingDurationSeconds: current.guidance?.remainingDurationSeconds,
      remainingDistanceMeters: current.guidance?.remainingDistanceMeters,
      now: clock().timeIntervalSinceReferenceDate
    )
    switch decision {
    case .install:
      lock.unlock()
      _ = try? installReroute(
        replacement,
        expectedGeneration: expectedGeneration,
        expectedTripId: expectedTripId,
        requestId: nil
      )
    case .propose:
      routeStatus = .tracking
      stateVersion &+= 1
      let allowsAlerts = announcementState.allowsAlerts
      lock.unlock()
      host?.navigationEngineStateDidChange()
      if allowsAlerts {
        host?.navigationEngineSpeak(
          NavigationEngineSpeech(text: "A new route is ready.", kind: .alert),
          generation: expectedGeneration)
      }
    }
  }

  /// Installs a replacement route for the current trip. `requestId` is checked when the install
  /// comes straight from a request; accepted proposals pass `nil`.
  private func installReroute(
    _ trip: NavOSSCarPlayTrip,
    expectedGeneration: UInt64,
    expectedTripId: String,
    requestId: UUID?
  ) throws -> Bool {
    let update: NavigationSessionUpdate
    lock.lock()
    let current = navigationSession.currentUpdate()
    guard
      navigationShouldInstallReplacement(
        generationMatches: navigationGeneration == expectedGeneration,
        requestMatches: requestId.map { $0 == rerouteRequestId } ?? true,
        tripMatches: current.trip?.id == expectedTripId,
        phase: current.snapshot.phase,
        isOffRoute: current.snapshot.isOffRoute
      )
    else {
      lock.unlock()
      return false
    }
    do {
      update = try navigationSession.start(trip)
      navigationGeneration &+= 1
      tripStore.save(trip)
      lastProgressPersistedAt = nil
      lastPersistedProgress = nil
      rerouteCount += 1
      rerouteConsent.reset()
      routeStatus = .tracking
      rerouteRequestId = nil
      rerouteRetryAfter = nil
      rerouteFailureCount = 0
      rerouteTask?.cancel()
      rerouteTask = nil
      safetyCameraMonitor.replaceRoute(geometry: Self.coordinates(trip))
      speechPlanner.resetForReroute()
      stateVersion &+= 1
    } catch {
      lock.unlock()
      throw error
    }
    let versionedUpdate = VersionedNavigationUpdate(
      generation: navigationGeneration,
      update: update
    )
    lock.unlock()
    companion?.navigationRouteDidChange(trip)
    host?.navigationEngineCancelSpeech(generation: versionedUpdate.generation)
    publish(versionedUpdate)
    host?.navigationEngineNeedsLocationUpdates()
    return true
  }

  private func handleRerouteFailure(
    expectedGeneration: UInt64,
    expectedTripId: String,
    requestId: UUID
  ) {
    lock.lock()
    let current = navigationSession.currentUpdate()
    guard navigationGeneration == expectedGeneration,
      rerouteRequestId == requestId,
      current.trip?.id == expectedTripId,
      current.snapshot.phase == .tracking,
      current.snapshot.isOffRoute
    else {
      lock.unlock()
      return
    }
    routeStatus = .rerouteFailed
    rerouteFailureCount += 1
    rerouteRetryAfter = clock().addingTimeInterval(
      navigationRerouteRetryDelaySeconds(consecutiveFailures: rerouteFailureCount)
    )
    rerouteRequestId = nil
    rerouteTask = nil
    stateVersion &+= 1
    lock.unlock()
    host?.navigationEngineStateDidChange()
  }

  private func isCurrentLocked(_ versionedUpdate: VersionedNavigationUpdate) -> Bool {
    let current = navigationSession.currentUpdate()
    return navigationGeneration == versionedUpdate.generation
      && current.trip?.id == versionedUpdate.update.trip?.id
      && current.snapshot.sequence == versionedUpdate.update.snapshot.sequence
  }

  private static func coordinates(_ trip: NavOSSCarPlayTrip) -> [NavigationCoordinate] {
    trip.geometry.map { NavigationCoordinate(latitude: $0.latitude, longitude: $0.longitude) }
  }

  // MARK: Safety cameras

  /// Fetches fixed safety cameras for native alerting when the cache is missing or old. The
  /// request carries no location.
  private func refreshSafetyCamerasIfNeeded() {
    lock.lock()
    let now = clock()
    guard navigationShouldFetchSafetyCameras(
      fetchedAt: safetyCameraFetchedAt?.timeIntervalSinceReferenceDate,
      attemptedAt: safetyCameraFetchAttemptedAt?.timeIntervalSinceReferenceDate,
      isFetching: safetyCameraTask != nil,
      now: now.timeIntervalSinceReferenceDate
    ) else {
      lock.unlock()
      return
    }
    safetyCameraFetchAttemptedAt = now
    let network = network
    safetyCameraTask = Task { [weak self] in
      let cameras = try? await network.safetyCameras()
      guard let self else { return }
      self.lock.withLock {
        self.safetyCameraTask = nil
        if let cameras {
          self.safetyCameraMonitor.setCameras(cameras)
          self.safetyCameraFetchedAt = self.clock()
        }
      }
    }
    lock.unlock()
  }

  // MARK: Clock

  /// The work of the one-second clock that runs while a trip is active (see
  /// `NavigationEngineHost.navigationEngineStartClock`). It dead-reckons through gaps in fixes
  /// (so the puck and maneuver distance keep moving), applies reroute-consent deadlines even when
  /// no fix arrives, and retries a failed camera fetch.
  func clockTick() {
    refreshSafetyCamerasIfNeeded()
    companion?.navigationClockTick()
    let now = clock().timeIntervalSinceReferenceDate
    lock.lock()
    let current = navigationSession.currentUpdate()
    guard let trip = current.trip, current.snapshot.phase == .tracking else {
      lock.unlock()
      return
    }
    // Consent deadlines run on the clock: during a GPS outage no fix arrives to evaluate them.
    // No request is made from here; the next real fix requests a fresh route.
    if rerouteConsent.proposal != nil, current.snapshot.isOffRoute {
      switch rerouteConsent.evaluate(
        mode: navigationPreferences.rerouteMode,
        isOffRoute: true,
        canRequest: false,
        now: now
      ) {
      case .expired:
        stateVersion &+= 1
        lock.unlock()
        host?.navigationEngineStateDidChange()
        lock.lock()
      case .installProposal(let proposal):
        let generation = navigationGeneration
        lock.unlock()
        _ = try? installReroute(
          proposal.trip,
          expectedGeneration: generation,
          expectedTripId: trip.id,
          requestId: nil
        )
        return
      case .none, .request, .withdrew:
        break
      }
    }
    guard !validatesPersistedNavigation,
      let update = navigationSession.deadReckon(at: now)
    else {
      lock.unlock()
      return
    }
    let versionedUpdate = prepareForPublicationLocked(update)
    lock.unlock()
    publish(versionedUpdate)
  }

  #if DEBUG
    /// Tests only: waits for an in-flight reroute request to finish.
    func waitForPendingReroute() async {
      let task = lock.withLock { rerouteTask }
      await task?.value
    }

    /// Tests only: waits for an in-flight safety-camera fetch to finish.
    func waitForPendingSafetyCameraFetch() async {
      let task = lock.withLock { safetyCameraTask }
      await task?.value
    }
  #endif
}
