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
  /// A restored trip ended on its first accurate fix (see `navOSSRestoredTripEnding`).
  case ended(VersionedNavigationUpdate)

  var versionedUpdate: VersionedNavigationUpdate {
    switch self {
    case .published(let update), .acquiring(let update), .ended(let update): update
    }
  }
}

/// Where the active trip is kept so a relaunch can resume it.
protocol NavigationTripStoring: AnyObject {
  func save(_ trip: NavOSSCarPlayTrip)
  func loadSaved() -> NavOSSSavedTrip
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

#if !NAVOSS_HOST_HTTP
  /// The NavOSS API, through a fresh `NavOSSNavigationAPIClient` per reroute or camera fetch.
  /// Left out where the host supplies HTTP itself (`NAVOSS_HOST_HTTP`, the Android build).
  struct NavOSSNavigationAPIEngineNetwork: NavigationEngineNetwork {
    func rerouteClient() throws -> any NavigationRerouteRouting {
      try NavOSSNavigationAPIClient()
    }

    func safetyCameras() async throws -> [NavOSSSafetyCamera] {
      try await NavOSSNavigationAPIClient().safetyCameras()
    }
  }
#endif

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

/// Runs a trip: see the file comment for what it owns.
///
/// Threading model:
///
/// - Every entry point may be called from any thread, and they are: on iOS fixes and the clock
///   arrive on the main thread, the JavaScript module calls from its own queue, and reroute and
///   camera results arrive on the Swift concurrency pool. The engine needs no particular thread.
/// - All state is guarded by `lock`, one recursive lock which the host shares: the iOS service
///   guards its own location and CarPlay-connection state with it, so what the two read together
///   is consistent exactly as when they were one object.
/// - Host and companion callbacks run synchronously on the calling thread. Those named
///   `...Locked` run while `lock` is held: they read state and return, and must not wait on
///   another thread or call back into the engine's entry points. Every other callback runs
///   after `lock` is released, in the order written in each entry point; a host may hop to its
///   main queue there.
/// - Nothing computed under the lock is trusted after it is released. An update is published,
///   rerouted from and checkpointed only while it is still current (`isCurrentLocked`: same
///   generation, trip and sequence). A reroute result is used only for the generation, request,
///   trip and off-route state that asked for it, and its task is cancelled when any of them
///   moves on. Effects a host defers (speech, the clock, location) carry the generation they
///   were issued for, and the host drops them once it is no longer current.
/// - Reroute and camera requests are unstructured tasks holding the engine weakly; they re-enter
///   through the same lock. The camera list does not belong to a trip, so its result is kept
///   whatever the generation.
/// - `host` is weak and `companion` strong; set both before the first trip and leave them.
///
/// `@unchecked Sendable` rests on the above: apart from `host` and `companion`, which are set
/// once before the first trip, every stored property is immutable or read and written only with
/// `lock` held.
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
  /// When the next request may be made while the driver keeps leaving the routes they are given.
  private var rerouteSpacing = NavigationRerouteSpacing()
  /// The route the last install replaced, and the ask-first replacement the driver last
  /// declined: a replacement materially the same as either (or as the route followed) is not
  /// installed or offered again (`navigationIsMateriallySameRoute`).
  private var replacedTrip: NavOSSCarPlayTrip?
  private var declinedTrip: NavOSSCarPlayTrip?
  /// The latest fixes, for a reroute heading when the platform has none.
  private var recentTrack: [(coordinate: NavigationCoordinate, time: TimeInterval)] = []
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
    /// Tests only: runs after a restore has read the store and before it starts the trip, with
    /// the lock released, where a Start from another thread can land.
    var restoreWillStart: (() -> Void)?
  #endif
  /// A restored trip not yet published: withheld (shown as acquiring) until a fix is matched
  /// on a known pass or the matcher puts it off its route (`navOSSPersistedNavigationDecision`).
  private var validatesPersistedNavigation = false
  /// The restored trip's first accurate fix has not been judged yet (`navOSSRestoredTripEnding`).
  private var judgesRestoredTripEnding = false
  /// The progress the restored trip resumed from, for `navOSSRestoredTripEnding`.
  private var restoredProgress: NavigationResumeContext?
  /// Whether the current trip's guidance may be presented. A trip restored from a checkpoint
  /// starts `withheld`: whatever is published or read carries no guidance or road
  /// (`NavigationSessionUpdate.withoutGuidance`), so off its route it presents what a departure
  /// does (off route, rerouting, a proposal, End), never the maneuver, distances, lanes or
  /// estimate of where it was saved. Written only by `changeCheckpointGuidanceLocked`.
  private var checkpointGuidance = CheckpointGuidance.presented
  /// Capture time of the first accurate fix of a restored trip without usable progress, which
  /// is released as if just started after `navigationRestoredPassConfirmationSeconds`.
  private var firstAccurateRestoredFixAt: TimeInterval?
  /// The saved trip has been restored, or there was none: an engine restores once.
  private var hasResumedPersistedTrip = false
  private var tripEndReason: NavOSSTripEndReason?

  init(
    tripStore: NavigationTripStoring,
    audioMode: NavOSSCarPlayAudioMode,
    preferences: NavOSSNavigationPreferences,
    network: NavigationEngineNetwork,
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

  #if !NAVOSS_HOST_HTTP
    /// An engine on the NavOSS API.
    convenience init(
      tripStore: NavigationTripStoring,
      audioMode: NavOSSCarPlayAudioMode,
      preferences: NavOSSNavigationPreferences,
      session: NavigationSession = NavigationSession()
    ) {
      self.init(
        tripStore: tripStore, audioMode: audioMode, preferences: preferences,
        network: NavOSSNavigationAPIEngineNetwork(), session: session)
    }
  #endif

  // MARK: Reads (lock held by the caller)

  var navigationGenerationLocked: UInt64 { navigationGeneration }
  var allowsAlertsLocked: Bool { announcementState.allowsAlerts }
  var tripLocked: NavOSSCarPlayTrip? { navigationSession.trip }
  /// The latest fix the session applied to the current route; `nil` after a route is started,
  /// replaced or cleared until its first fix. For the Android facade's reroute origin.
  var lastAppliedFixLocked: NavigationLocationSample? { navigationSession.lastAppliedFix }

  func currentUpdateLocked() -> NavigationSessionUpdate {
    presentedLocked(navigationSession.currentUpdate())
  }

  /// Why the trip under way has no maneuver to show (`NavOSSCarPlayTripPause`): a restored trip
  /// finding its place, or one off its route with no guidance since its checkpoint. `nil` when
  /// there is guidance to show, or no trip under way.
  ///
  /// Decided from the engine's own state, never from missing guidance, and current for every
  /// read: a reroute status change (request started, failed, proposal offered, withdrawn or
  /// expired, route installed) changes it without a fix. Part of every state read
  /// (`NavOSSNavigationServiceState.tripPause`); CarPlay's store takes it at every publication
  /// and every state change.
  var tripPauseLocked: NavOSSCarPlayTripPause? {
    let current = navigationSession.currentUpdate()
    guard current.trip != nil, current.snapshot.phase == .tracking else {
      return nil
    }
    // Withheld: nothing but the trip is shown, whatever the session computed.
    if validatesPersistedNavigation {
      return .locating
    }
    guard checkpointGuidance == .withheld else {
      return nil
    }
    guard current.snapshot.isOffRoute else {
      return .locating
    }
    return routeStatus == .rerouting ? .rerouting : .proceedToRoute
  }

  private enum CheckpointGuidance {
    case presented
    case withheld
  }

  /// What may change `checkpointGuidance`. A new trip sets it; the three exits release it.
  private enum CheckpointGuidanceChange {
    /// A trip was started, restored, replaced by one the driver chose, or cleared.
    case trip(restoredFromCheckpoint: Bool)
    /// The matcher accepted a fix on the route (`NavigationSession.acceptedLatestFix`) on a
    /// pass it has confirmed (`NavigationSnapshot.isPassConfirmed`), with an accuracy of
    /// `navigationPoorAccuracyMeters` or better. An unconfirmed placement is not that: where the
    /// route passes the same place twice it may be on either pass. A matched coordinate is not
    /// that either:
    /// restored progress lets a poor fix match within its accuracy, and a rejected, held or
    /// dead-reckoned update carries an earlier fix's match.
    case accurateFixAccepted
    /// A replacement route was installed: guided from its own start.
    case routeInstalled
    case arrived
  }

  /// The only writer of `checkpointGuidance`. Lock held.
  private func changeCheckpointGuidanceLocked(_ change: CheckpointGuidanceChange) {
    switch change {
    case .trip(let restoredFromCheckpoint):
      checkpointGuidance = restoredFromCheckpoint ? .withheld : .presented
    case .accurateFixAccepted, .routeInstalled, .arrived:
      checkpointGuidance = .presented
    }
  }

  /// `update` as it may be presented (see `checkpointGuidance`).
  private func presentedLocked(_ update: NavigationSessionUpdate) -> NavigationSessionUpdate {
    checkpointGuidance == .withheld ? update.withoutGuidance() : update
  }

  func safetyCameraLocked(id: String) -> NavOSSSafetyCamera? {
    safetyCameraMonitor.camera(id: id)
  }

  /// The state every reader gets: the module's `getSnapshot` and change events, CarPlay's live
  /// guidance, and everything else that pulls it. A restored trip not yet matched on a known
  /// pass is withheld here, not only from the published updates.
  func currentStateLocked() -> NavOSSNavigationServiceState {
    let update = currentUpdateLocked()
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
      tripEndReason: update.trip == nil ? tripEndReason : nil,
      tripPause: tripPauseLocked
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

  /// Changes some of the preferences in one step: `change` edits the preferences as they are
  /// now, with `lock` held, so two partial changes made at once cannot overwrite each other.
  /// Otherwise as `setNavigationPreferences`. The Android facade's setters use it; iOS loads
  /// and applies whole preferences. `change` must only edit its argument.
  func updateNavigationPreferences(_ change: (inout NavOSSNavigationPreferences) -> Void) {
    lock.lock()
    var preferences = navigationPreferences
    change(&preferences)
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
    let declined = rerouteConsent.proposal?.trip
    guard rerouteConsent.decline(id: id, now: clock().timeIntervalSinceReferenceDate) else {
      lock.unlock()
      return false
    }
    declinedTrip = declined
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

  /// Restores the trip an earlier process saved (on iOS at launch, on Android once after the
  /// engine is created). Once per engine, and never over a trip already running: a second call
  /// cannot start the trip again and repeat its requests. A saved trip is restored unless it
  /// has expired; one that cannot be read or started again is removed. Either way the trip
  /// ends with a reason the phone tells the driver (`NavOSSTripEndReason`).
  func resumePersistedNavigation() {
    lock.lock()
    guard !hasResumedPersistedTrip, navigationSession.trip == nil else {
      lock.unlock()
      return
    }
    hasResumedPersistedTrip = true
    let saved = tripStore.loadSaved()
    var resume = NavigationResumePoint.withoutProgress
    if case .trip(let trip) = saved {
      resume = tripStore.loadProgress(for: trip)
    }
    lock.unlock()
    #if DEBUG
      restoreWillStart?()
    #endif
    switch saved {
    case .none:
      return
    case .expired:
      endUnrestoredTrip(.restoredTripExpired)
    case .unreadable:
      endUnrestoredTrip(.restoredTripUnavailable)
    case .trip(let trip):
      do {
        try startNavigation(trip, persist: false, resume: resume, restoring: true)
      } catch {
        endUnrestoredTrip(.restoredTripUnavailable)
      }
    }
  }

  /// A saved trip that was not restored: its records go, and the phone is told why. A trip
  /// started in the meantime is left alone.
  private func endUnrestoredTrip(_ reason: NavOSSTripEndReason) {
    lock.lock()
    guard navigationSession.trip == nil else {
      lock.unlock()
      return
    }
    tripStore.clear()
    tripEndReason = reason
    stateVersion &+= 1
    lock.unlock()
    host?.navigationEngineStateDidChange()
  }

  /// Starts guiding `trip`. With `resume` it is a trip restored after a relaunch. One saved
  /// before its first match starts as it was started. Any other is withheld: nothing is guided
  /// from it until a fix is matched on a known pass or the matcher puts it off its route, and
  /// until then it is shown as finding its place on the route. A restore (`restoring`) finding
  /// a trip already started (a Start that landed after the restore read the store) does nothing:
  /// the new trip wins and is neither replaced nor cleared.
  private func startNavigation(
    _ trip: NavOSSCarPlayTrip,
    persist: Bool,
    resume: NavigationResumePoint? = nil,
    restoring: Bool = false
  ) throws {
    let update: NavigationSessionUpdate
    let isWithheld = resume != nil && resume != .beforeFirstMatch
    lock.lock()
    if restoring, navigationSession.trip != nil {
      lock.unlock()
      return
    }
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
      resetRerouteHistoryLocked()
      routeStatus = .tracking
      safetyCameraMonitor.startTrip(geometry: Self.coordinates(trip))
      speechPlanner.reset()
      speedingMonitor.reset()
      validatesPersistedNavigation = isWithheld
      judgesRestoredTripEnding = isWithheld
      firstAccurateRestoredFixAt = nil
      if case .progress(let saved) = resume, saved.isUsable {
        restoredProgress = saved
        changeCheckpointGuidanceLocked(.trip(restoredFromCheckpoint: true))
      } else {
        restoredProgress = nil
        changeCheckpointGuidanceLocked(.trip(restoredFromCheckpoint: false))
      }
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
    if isWithheld {
      publishRestoredTripAcquisition(versionedUpdate)
    } else {
      publish(versionedUpdate)
    }
    host?.navigationEngineNeedsLocationUpdates()
    host?.navigationEngineStartClock(generation: versionedUpdate.generation)
    refreshSafetyCamerasIfNeeded()
  }

  /// Forgets the reroutes of the trip before. Lock held.
  private func resetRerouteHistoryLocked() {
    rerouteSpacing = NavigationRerouteSpacing()
    replacedTrip = nil
    declinedTrip = nil
    recentTrack.removeAll()
  }

  func clearNavigation(endReason: NavOSSTripEndReason? = nil) {
    lock.lock()
    tripEndReason = endReason
    validatesPersistedNavigation = false
    judgesRestoredTripEnding = false
    restoredProgress = nil
    changeCheckpointGuidanceLocked(.trip(restoredFromCheckpoint: false))
    firstAccurateRestoredFixAt = nil
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
    resetRerouteHistoryLocked()
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
      recentTrack.append((sample.coordinate, sample.timestamp ?? clock().timeIntervalSinceReferenceDate))
      if recentTrack.count > 12 {
        recentTrack.removeFirst(recentTrack.count - 12)
      }
      versionedUpdate = prepareForPublicationLocked(update, fix: sample)
    } catch {
      lock.unlock()
      throw error
    }
    lock.unlock()
    switch persistedNavigationDecision(versionedUpdate, fixTimestamp: sample.timestamp) {
    case .end(let reason):
      clearNavigation(endReason: reason)
      return .ended(versionedUpdate)
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

  /// `fix` is the sample `update` came from; `nil` for the clock's dead reckoning.
  private func prepareForPublicationLocked(
    _ update: NavigationSessionUpdate,
    fix: NavigationLocationSample? = nil
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
    // A restored trip presents its checkpoint's guidance again only from a fix the matcher
    // accepted on a confirmed pass that is accurate enough to place the vehicle, or on arrival.
    if update.snapshot.phase == .arrived {
      changeCheckpointGuidanceLocked(.arrived)
    } else if let accuracy = fix?.horizontalAccuracyMeters,
      accuracy <= navigationPoorAccuracyMeters, navigationSession.acceptedLatestFix,
      update.snapshot.isPassConfirmed
    {
      changeCheckpointGuidanceLocked(.accurateFixAccepted)
    }
    stateVersion &+= 1
    return VersionedNavigationUpdate(
      generation: navigationGeneration, update: presentedLocked(update))
  }

  private func persistedNavigationDecision(
    _ versionedUpdate: VersionedNavigationUpdate,
    fixTimestamp: TimeInterval?
  ) -> NavOSSPersistedNavigationDecision {
    lock.lock()
    defer { lock.unlock() }
    guard isCurrentLocked(versionedUpdate) else {
      return .wait
    }
    guard validatesPersistedNavigation else {
      return .publish
    }
    let snapshot = versionedUpdate.update.snapshot
    // The reasons to end a restored trip are judged once, on its first accurate fix.
    var ending: NavOSSTripEndReason?
    if judgesRestoredTripEnding, let accuracy = snapshot.horizontalAccuracyMeters,
      accuracy <= navigationPoorAccuracyMeters, let raw = snapshot.rawCoordinate,
      let distances = navigationSession.distances(from: raw)
    {
      judgesRestoredTripEnding = false
      ending = navOSSRestoredTripEnding(
        distanceFromRouteMeters: distances.routeMeters,
        distanceFromDestinationMeters: distances.destinationMeters,
        accuracyMeters: accuracy,
        fixTimestamp: fixTimestamp,
        saved: restoredProgress,
        checkpointRemainingMeters: checkpointRemainingMetersLocked()
      )
    }
    var decision = navOSSPersistedNavigationDecision(snapshot, ending: ending)
    // A trip without usable progress (saved by build 75, which wrote none, or with a damaged
    // record) that has not confirmed its pass after two minutes of accurate fixes is released
    // as if Start had just been tapped there: the pre-match rules decide from here, instead of
    // "Resuming your trip" for as long as the car stands still.
    if decision == .wait, restoredProgress == nil, let fixTimestamp,
      let accuracy = snapshot.horizontalAccuracyMeters, accuracy <= navigationPoorAccuracyMeters
    {
      let since = firstAccurateRestoredFixAt ?? fixTimestamp
      firstAccurateRestoredFixAt = since
      if fixTimestamp - since >= navigationRestoredPassConfirmationSeconds {
        navigationSession.forgetPassConfirmation()
        decision = .publish
      }
    }
    // Withholding ends with the update that is published. An ended trip stays withheld until
    // `clearNavigation` removes it.
    if decision == .publish {
      validatesPersistedNavigation = false
      restoredProgress = nil
    }
    return decision
  }

  /// Route left after the restored checkpoint, when no stop is left before the destination;
  /// `nil` otherwise or without a checkpoint. Lock held.
  private func checkpointRemainingMetersLocked() -> Double? {
    guard let saved = restoredProgress, let trip = navigationSession.trip,
      let length = navigationSession.routeLengthMeters, length > 0,
      navOSSRemainingWaypoints(in: trip, after: saved.alongMeters / length).isEmpty
    else {
      return nil
    }
    return max(0, length - saved.alongMeters)
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
    // A restored trip still withheld asks for nothing: no accurate fix has placed it yet.
    guard isCurrentLocked(versionedUpdate), !validatesPersistedNavigation, let trip = update.trip
    else {
      lock.unlock()
      return
    }
    let mode = navigationPreferences.rerouteMode
    let now = clock()
    let isOffRoute = update.snapshot.phase == .tracking && update.snapshot.isOffRoute
    let raw = update.snapshot.rawCoordinate
    rerouteSpacing.observe(
      coordinate: raw,
      accuracyMeters: update.snapshot.horizontalAccuracyMeters,
      isOffRoute: isOffRoute,
      isMatched: update.snapshot.matchedCoordinate != nil,
      now: now.timeIntervalSinceReferenceDate
    )
    let canRequest = isOffRoute && raw != nil && rerouteTask == nil
      && (rerouteRetryAfter.map { $0 <= now } ?? true)
      && rerouteSpacing.allowsRequest(
        now: now.timeIntervalSinceReferenceDate,
        isOwed: rerouteConsent.proposal != nil || rerouteConsent.installsNextReplacement)
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
    // Without the platform's heading, the one the recent fixes show: a route the router starts
    // the other way along the road is left again on its first fixes.
    let originHeading = rerouteOrigin?.headingDegrees ?? navigationTrackHeadingDegrees(recentTrack)
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
            originHeadingDegrees: originHeading,
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
    rerouteSpacing.answered(now: clock().timeIntervalSinceReferenceDate)
    // The route followed, the one it replaced or the one just declined, again: nothing changes
    // for the driver, so nothing is installed, offered or said. The vehicle stays off route
    // until it rejoins the route or moves away from it (`NavigationRerouteSpacing`). Before the
    // first match the replacement is chosen for being closest to the chosen route
    // (`navigationReplacement`) and installing it restarts the pre-match rules, as before.
    if navigationSession.hasMatchedRoute, let trip = current.trip,
      ([trip] + [replacedTrip, declinedTrip].compactMap { $0 }).contains(where: {
        navigationIsMateriallySameRoute(replacement, as: $0)
      })
    {
      routeStatus = .tracking
      stateVersion &+= 1
      lock.unlock()
      host?.navigationEngineStateDidChange()
      return
    }
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
      replacedTrip = current.trip
      navigationGeneration &+= 1
      rerouteSpacing.routeReplaced()
      changeCheckpointGuidanceLocked(.routeInstalled)
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
    /// Tests only: the in-flight reroute request, to wait for.
    var pendingRerouteTask: Task<Void, Never>? { lock.withLock { rerouteTask } }

    /// Tests only: the in-flight safety-camera fetch, to wait for.
    var pendingSafetyCameraTask: Task<Void, Never>? { lock.withLock { safetyCameraTask } }
  #endif
}
