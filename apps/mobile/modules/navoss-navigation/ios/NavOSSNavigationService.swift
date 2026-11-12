import AVFoundation
import CoreLocation
import Foundation

extension Notification.Name {
  static let navOSSNavigationSnapshotDidChange = Notification.Name(
    "org.navoss.mobile.navigation-snapshot-did-change"
  )
}

public enum NavOSSNavigationRouteStatus: String, Sendable {
  case rerouteFailed = "reroute-failed"
  case rerouting
  case tracking
}

private struct VersionedNavigationUpdate: Sendable {
  let generation: UInt64
  let update: NavigationSessionUpdate
}

struct NavOSSNavigationServiceState: Sendable {
  let guidance: NavOSSCarPlayGuidance?
  let navigation: NavigationSnapshot
  let rerouteCount: Int
  let rerouteMode: NavOSSRerouteMode
  let rerouteProposal: NavigationRerouteProposal?
  let roadContext: NavigationRoadContext
  let routeStatus: NavOSSNavigationRouteStatus
  let safetyCameraAlert: NavigationSafetyCameraAlert?
  let speedingState: NavOSSSpeedingState
  let stateVersion: UInt64
  let trip: NavOSSCarPlayTrip?
}

/// Interval of the dead-reckoning tick while guidance is active.
private let deadReckoningTickSeconds = 1.0
/// Cameras are refreshed at most this often; the source updates monthly.
private let safetyCameraRefreshSeconds: TimeInterval = 6 * 60 * 60
/// A failed camera fetch is retried no sooner than this.
private let safetyCameraRetrySeconds: TimeInterval = 5 * 60

public final class NavOSSNavigationService: NSObject, CLLocationManagerDelegate,
  AVSpeechSynthesizerDelegate, @unchecked Sendable
{
  public static let shared = NavOSSNavigationService()

  private let activeTripStore: NavOSSActiveTripStore
  private var announcementState = NavOSSCarPlayAudioState()
  private var audioSessionOwnership = NavOSSAudioSessionOwnership()
  private var backgroundActivitySession: AnyObject?
  /// Scenes currently reporting a connected CarPlay display.
  ///
  /// The template scene and the Dashboard scene connect and disconnect independently, and either
  /// alone is a reason to keep tracking. A single flag let whichever disconnected first clear the
  /// state while the other was still on screen.
  private var carPlayConnectedScenes = NavOSSCarPlayConnectedScenes()
  private var carPlayConnected: Bool { carPlayConnectedScenes.isConnected }
  private var carPlayRoutePlanningLeases = NavOSSLocationTrackingLeases()
  /// Voice capture owns the shared audio session while any connected CarPlay scene records.
  /// These methods run on the main actor alongside AVSpeechSynthesizer callbacks.
  private var carPlayVoiceInputLeases: Set<UUID> = []
  private var deadReckoningTimer: DispatchSourceTimer?
  private var deferredSpeech: (text: String, expectedGeneration: UInt64?)?
  private var isCarPlayVoiceInputActive: Bool { !carPlayVoiceInputLeases.isEmpty }
  private let lock = NSRecursiveLock()
  private var locationManager: CLLocationManager?
  private var latestLocation: CLLocation?
  private var latestCompassHeadingDegrees: Double?
  private var navigationGeneration: UInt64 = 0
  private var navigationPreferences: NavOSSNavigationPreferences
  private var navigationPreferencesObserver: NSObjectProtocol?
  private let navigationPreferencesStore: NavOSSNavigationPreferencesStore
  private let navigationSession: NavigationSession
  private let notificationCenter: NotificationCenter
  private var pendingAudioSessionRelease: DispatchWorkItem?
  /// Guidance utterances still owed a completion callback. Main queue only.
  private var pendingUtterances = NavOSSSpeechUtteranceLedger()
  private var rerouteConsent = NavigationRerouteConsent()
  private var rerouteCount = 0
  private var rerouteRequestId: UUID?
  private var rerouteRetryAfter: Date?
  private var rerouteTask: Task<Void, Never>?
  private var routeStatus = NavOSSNavigationRouteStatus.tracking
  private var safetyCameraFetchAttemptedAt: Date?
  private var safetyCameraFetchedAt: Date?
  private var safetyCameraMonitor = NavigationSafetyCameraMonitor()
  private var safetyCameraTask: Task<Void, Never>?
  private var speedingMonitor = NavigationSpeedingMonitor()
  private let speechPlanner = NavigationSpeechPlanner()
  private let speechSynthesizer = AVSpeechSynthesizer()
  private var stateVersion: UInt64 = 0
  private var validatesPersistedNavigation = false

  init(
    activeTripStore: NavOSSActiveTripStore = NavOSSActiveTripStore(),
    preferencesStore: NavOSSCarPlayPreferencesStore = NavOSSCarPlayPreferencesStore.shared,
    navigationPreferencesStore: NavOSSNavigationPreferencesStore =
      NavOSSNavigationPreferencesStore.shared,
    navigationSession: NavigationSession = NavigationSession(),
    notificationCenter: NotificationCenter = .default
  ) {
    self.activeTripStore = activeTripStore
    announcementState = navOSSInitialCarPlayAudioState(preferencesStore: preferencesStore)
    self.navigationPreferencesStore = navigationPreferencesStore
    navigationPreferences = navigationPreferencesStore.load()
    self.navigationSession = navigationSession
    self.notificationCenter = notificationCenter
    super.init()
    speechSynthesizer.delegate = self
    navigationPreferencesObserver = notificationCenter.addObserver(
      forName: .navOSSNavigationPreferencesDidChange,
      object: navigationPreferencesStore,
      queue: nil
    ) { [weak self] _ in
      self?.reloadNavigationPreferences()
    }
  }

  deinit {
    if let navigationPreferencesObserver {
      notificationCenter.removeObserver(navigationPreferencesObserver)
    }
  }

  /// Shared reroute/speeding preferences, as the service is currently applying them.
  public func currentNavigationPreferences() -> NavOSSNavigationPreferences {
    lock.lock()
    defer { lock.unlock() }
    return navigationPreferences
  }

  /// Accepts the pending ask-first replacement route. Returns `false` when `id` is no longer
  /// pending (withdrawn, timed out, or already answered).
  @discardableResult
  public func acceptRerouteProposal(id: String) -> Bool {
    lock.lock()
    guard let replacement = rerouteConsent.accept(id: id),
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
  public func declineRerouteProposal(id: String) -> Bool {
    lock.lock()
    guard rerouteConsent.decline(id: id, now: Date().timeIntervalSinceReferenceDate) else {
      lock.unlock()
      return false
    }
    routeStatus = .tracking
    stateVersion &+= 1
    lock.unlock()
    notificationCenter.post(name: .navOSSNavigationSnapshotDidChange, object: self)
    return true
  }

  private func reloadNavigationPreferences() {
    let preferences = navigationPreferencesStore.load()
    lock.lock()
    let changed = preferences != navigationPreferences
    navigationPreferences = preferences
    if changed {
      stateVersion &+= 1
    }
    lock.unlock()
    guard changed else { return }
    notificationCenter.post(name: .navOSSNavigationSnapshotDidChange, object: self)
    // A mode change can resolve a pending proposal (e.g. switching to automatic installs it).
    lock.lock()
    let versionedUpdate = VersionedNavigationUpdate(
      generation: navigationGeneration,
      update: navigationSession.currentUpdate()
    )
    lock.unlock()
    evaluateReroute(for: versionedUpdate)
  }

  public func audioMode() -> NavOSSCarPlayAudioMode {
    lock.lock()
    defer { lock.unlock() }
    return announcementState.mode
  }

  #if targetEnvironment(simulator)
  /// Read-only state for the simulator harness; no audio or transcript leaves the service.
  @MainActor
  public var audioSessionTestState: (needsRelease: Bool, isSpeaking: Bool, hasVoiceInput: Bool) {
    (audioSessionOwnership.needsRelease, speechSynthesizer.isSpeaking, isCarPlayVoiceInputActive)
  }

  /// Simulator harness only: speaks the camera alert on demand to exercise audio-session
  /// activation and release. Real alerts come from `NavigationSafetyCameraMonitor`.
  public func announceSafetyCamera() {
    lock.lock()
    let generation = navigationGeneration
    let allowsAlerts = announcementState.allowsAlerts
    lock.unlock()
    guard allowsAlerts else {
      return
    }
    speak("Red light and speed camera ahead.", expectedGeneration: generation)
  }
  #endif

  public func setAudioMode(_ mode: NavOSSCarPlayAudioMode) {
    lock.lock()
    guard announcementState.mode != mode else {
      lock.unlock()
      return
    }
    announcementState.setMode(mode)
    let generation = navigationGeneration
    lock.unlock()
    if mode != .allGuidance {
      cancelNavigationSpeech(expectedGeneration: generation)
    }
  }

  public func clearNavigation() {
    lock.lock()
    let update = navigationSession.clear()
    navigationGeneration &+= 1
    let generation = navigationGeneration
    rerouteTask?.cancel()
    rerouteTask = nil
    rerouteRequestId = nil
    rerouteRetryAfter = nil
    rerouteCount = 0
    rerouteConsent.reset()
    routeStatus = .tracking
    safetyCameraMonitor.endTrip()
    speechPlanner.reset()
    speedingMonitor.reset()
    stateVersion &+= 1
    activeTripStore.clear()
    lock.unlock()
    stopDeadReckoning()
    NavOSSCarPlayTripStore.shared.clearTrip(
      generation: generation,
      sequence: update.snapshot.sequence
    )
    notificationCenter.post(name: .navOSSNavigationSnapshotDidChange, object: self)
    reconcileLocationUpdates(expectedGeneration: generation)
    cancelNavigationSpeech(expectedGeneration: generation)
  }

  public func currentCoordinate() -> NavOSSCarPlayCoordinate? {
    currentRouteOrigin()?.coordinate
  }

  public func currentRouteOrigin() -> NavOSSNavigationRouteOrigin? {
    lock.lock()
    defer { lock.unlock() }
    guard let latestLocation else { return nil }
    return navOSSNavigationRouteOrigin(
      coordinate: NavOSSCarPlayCoordinate(
        latitude: latestLocation.coordinate.latitude,
        longitude: latestLocation.coordinate.longitude
      ),
      courseDegrees: latestLocation.course,
      speedMetersPerSecond: latestLocation.speed,
      horizontalAccuracyMeters: latestLocation.horizontalAccuracy,
      ageSeconds: Date().timeIntervalSince(latestLocation.timestamp)
    )
  }

  public func awaitCurrentRouteOrigin(
    timeoutSeconds: TimeInterval = 5
  ) async -> NavOSSNavigationRouteOrigin? {
    let leaseIdentifier = beginCarPlayRoutePlanning()
    defer {
      if let leaseIdentifier {
        finishCarPlayRoutePlanning(leaseIdentifier)
      }
    }
    if let origin = currentRouteOrigin() {
      return origin
    }
    let deadline = Date().addingTimeInterval(timeoutSeconds)
    while Date() < deadline {
      do {
        try await Task.sleep(nanoseconds: 100_000_000)
      } catch {
        return nil
      }
      if let origin = currentRouteOrigin() {
        return origin
      }
    }
    return nil
  }

  func currentState() -> NavOSSNavigationServiceState {
    lock.lock()
    defer { lock.unlock() }
    return currentStateLocked()
  }

  public var backgroundLocationEnabled: Bool {
    let modes = Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String]
    return modes?.contains("location") == true
  }

  public func endNavigationFromCarPlay() {
    clearNavigation()
    NavOSSCarPlayTripStore.shared.endTripFromCarPlay()
  }

  public func beginCarPlayRoutePlanning() -> UUID? {
    lock.lock()
    guard carPlayConnected else {
      lock.unlock()
      return nil
    }
    let leaseIdentifier = carPlayRoutePlanningLeases.acquire()
    lock.unlock()
    ensureLocationUpdates()
    return leaseIdentifier
  }

  public func finishCarPlayRoutePlanning() {
    lock.lock()
    carPlayRoutePlanningLeases.removeAll()
    let generation = navigationGeneration
    lock.unlock()
    stopLocationUpdates(expectedGeneration: generation)
  }

  public func finishCarPlayRoutePlanning(_ leaseIdentifier: UUID) {
    lock.lock()
    carPlayRoutePlanningLeases.release(leaseIdentifier)
    let generation = navigationGeneration
    lock.unlock()
    stopLocationUpdates(expectedGeneration: generation)
  }

  /// `scene` names the CarPlay scene reporting the change, so the template and Dashboard scenes
  /// can connect and disconnect in any order without one clearing the other's state.
  public func setCarPlayConnected(_ connected: Bool, scene: String) {
    lock.lock()
    carPlayConnectedScenes.set(connected, scene: scene)
    if !carPlayConnected {
      carPlayRoutePlanningLeases.removeAll()
    }
    let update = navigationSession.currentUpdate()
    let hasActiveNavigation = update.trip != nil && update.snapshot.phase != .arrived
    let shouldTrack = navOSSShouldTrackLocation(
      hasActiveNavigation: hasActiveNavigation,
      isCarPlayRoutePlanning: carPlayRoutePlanningLeases.isActive,
      isCarPlayConnected: carPlayConnected
    )
    let generation = navigationGeneration
    lock.unlock()
    if shouldTrack {
      ensureLocationUpdates()
    } else {
      stopLocationUpdates(expectedGeneration: generation)
    }
  }

  func ingest(_ sample: NavigationLocationSample) throws -> NavigationSnapshot {
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
      clearNavigation()
    case .publish:
      publish(versionedUpdate)
      evaluateReroute(for: versionedUpdate)
    case .wait:
      break
    }
    return versionedUpdate.update.snapshot
  }

  public func resumePersistedNavigation() {
    guard let trip = activeTripStore.load() else {
      return
    }
    do {
      try startNavigation(
        trip,
        persist: false,
        publishInitialUpdate: false,
        validatesPersistedNavigation: true
      )
    } catch {
      activeTripStore.clear()
    }
  }

  public func startNavigation(_ trip: NavOSSCarPlayTrip) throws {
    try startNavigation(trip, persist: true)
  }

  /// Stops navigation speech before CarPlay begins recording. The coordinator calls the matching
  /// finish method only after it has released its recording session.
  @MainActor
  public func beginCarPlayVoiceInput() -> UUID {
    let identifier = UUID()
    carPlayVoiceInputLeases.insert(identifier)
    deferredSpeech = nil
    pendingUtterances.removeAll()
    speechSynthesizer.stopSpeaking(at: .immediate)
    audioSessionOwnership.claim()
    cancelPendingAudioSessionRelease()
    return identifier
  }

  /// Returns audio-session ownership to normal navigation guidance after CarPlay capture ends.
  @MainActor
  public func finishCarPlayVoiceInput(_ identifier: UUID) {
    guard carPlayVoiceInputLeases.remove(identifier) != nil, !isCarPlayVoiceInputActive else {
      return
    }
    // Always attempt release, even when deferred speech exists: speak() may reject it (stale
    // navigationGeneration, empty text) without claiming anything, and that must not strand the
    // session claimed with nothing left to release it. If speak() does accept, its own claim()
    // supersedes this attempt (or cancels it if still only scheduled as a retry).
    attemptAudioSessionRelease(epoch: audioSessionOwnership.epoch)
    guard let deferredSpeech else {
      return
    }
    self.deferredSpeech = nil
    speak(deferredSpeech.text, expectedGeneration: deferredSpeech.expectedGeneration)
  }

  public func stopAnnouncements() {
    lock.lock()
    let generation = navigationGeneration
    lock.unlock()
    cancelNavigationSpeech(expectedGeneration: generation)
  }

  private func cancelNavigationSpeech(expectedGeneration: UInt64) {
    DispatchQueue.main.async { [weak self] in
      guard let self else {
        return
      }
      self.lock.lock()
      let isCurrent = self.navigationGeneration == expectedGeneration
      self.lock.unlock()
      guard isCurrent else {
        return
      }
      self.deferredSpeech = nil
      self.pendingUtterances.removeAll()
      self.speechSynthesizer.stopSpeaking(at: .immediate)
      self.attemptAudioSessionRelease(epoch: self.audioSessionOwnership.epoch)
    }
  }

  public func locationManager(
    _ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]
  ) {
    guard let location = locations.last, location.horizontalAccuracy >= 0 else {
      return
    }
    lock.lock()
    guard
      navOSSShouldAcceptNavigationLocation(
        candidateTimestamp: location.timestamp.timeIntervalSinceReferenceDate,
        latestTimestamp: latestLocation?.timestamp.timeIntervalSinceReferenceDate,
        nowTimestamp: Date().timeIntervalSinceReferenceDate
      )
    else {
      lock.unlock()
      return
    }
    latestLocation = location
    lock.unlock()

    let course =
      location.speed >= 2 && (0..<360).contains(location.course)
      ? location.course
      : nil
    guard
      let versionedUpdate = try? navigationSessionUpdate(
        NavigationLocationSample(
          coordinate: NavigationCoordinate(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude
          ),
          courseDegrees: course,
          horizontalAccuracyMeters: location.horizontalAccuracy,
          speedMetersPerSecond: location.speed >= 0 && location.speed.isFinite
            ? location.speed
            : nil,
          timestamp: location.timestamp.timeIntervalSinceReferenceDate
        )
      )
    else {
      return
    }
    switch persistedNavigationDecision(versionedUpdate) {
    case .discard:
      clearNavigation()
    case .publish:
      publish(versionedUpdate)
      evaluateReroute(for: versionedUpdate)
    case .wait:
      break
    }
  }

  public func locationManager(
    _ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading
  ) {
    guard newHeading.headingAccuracy >= 0 else {
      return
    }
    let compassHeadingDegrees =
      newHeading.trueHeading >= 0 ? newHeading.trueHeading : newHeading.magneticHeading
    guard compassHeadingDegrees.isFinite, (0..<360).contains(compassHeadingDegrees) else {
      return
    }

    let versionedUpdate: VersionedNavigationUpdate
    lock.lock()
    latestCompassHeadingDegrees = compassHeadingDegrees
    guard latestLocation != nil else {
      lock.unlock()
      return
    }
    versionedUpdate = VersionedNavigationUpdate(
      generation: navigationGeneration,
      update: navigationSession.currentUpdate()
    )
    lock.unlock()

    guard let trip = versionedUpdate.update.trip,
      versionedUpdate.update.snapshot.phase != .arrived
    else {
      return
    }
    let previousState = NavOSSCarPlayTripStore.shared.snapshot()
    guard previousState.trip?.id == trip.id,
      let position = navOSSCarPlayPositionApplyingCompassHeading(
        compassHeadingDegrees,
        to: previousState.position
      ),
      position.isValid
    else {
      return
    }
    NavOSSCarPlayTripStore.shared.publishNavigationState(
      trip: trip,
      guidance: previousState.guidance,
      position: position,
      routeProgress: previousState.routeProgress,
      generation: versionedUpdate.generation,
      sequence: versionedUpdate.update.snapshot.sequence
    )
  }

  public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    guard let locationError = error as? CLError, locationError.code == .denied else {
      return
    }
    stopLocationUpdates(force: true)
  }

  public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    lock.lock()
    let update = navigationSession.currentUpdate()
    let hasActiveNavigation = update.trip != nil && update.snapshot.phase != .arrived
    let shouldTrack = navOSSShouldTrackLocation(
      hasActiveNavigation: hasActiveNavigation,
      isCarPlayRoutePlanning: carPlayRoutePlanningLeases.isActive,
      isCarPlayConnected: carPlayConnected
    )
    lock.unlock()
    guard shouldTrack else {
      return
    }
    switch manager.authorizationStatus {
    case .authorizedAlways, .authorizedWhenInUse:
      startAuthorizedLocationUpdates(manager)
    case .notDetermined:
      manager.requestWhenInUseAuthorization()
    case .denied, .restricted:
      stopLocationUpdates(force: true)
    @unknown default:
      stopLocationUpdates(force: true)
    }
  }

  public func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    didFinish utterance: AVSpeechUtterance
  ) {
    completeSpeechUtterance(utterance)
  }

  public func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    didCancel utterance: AVSpeechUtterance
  ) {
    completeSpeechUtterance(utterance)
  }

  private func configureLocationManager() -> CLLocationManager {
    if let locationManager {
      return locationManager
    }
    let manager = CLLocationManager()
    manager.activityType = .automotiveNavigation
    manager.allowsBackgroundLocationUpdates = backgroundLocationEnabled
    manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
    // Three degrees avoids sub-degree magnetometer jitter and needless wakeups while still
    // moving the facing cone smoothly as a parked vehicle turns.
    manager.headingFilter = 3
    // A 5 m threshold behaves as an effective update interval at low speed: measured against an
    // identical simulated track at 1 m/s, `distanceFilter = 5` delivered 11 callbacks with a
    // median gap of 5030 ms, while `kCLDistanceFilterNone` delivered 71 with a median of
    // 1008 ms. Crawling traffic is exactly when the puck must keep moving, so this manager,
    // which runs during active guidance, CarPlay route planning, or while a CarPlay display is
    // connected, takes every fix the OS
    // will give it. `kCLLocationAccuracyBestForNavigation` already dominates power here.
    manager.distanceFilter = kCLDistanceFilterNone
    manager.pausesLocationUpdatesAutomatically = false
    manager.showsBackgroundLocationIndicator = backgroundLocationEnabled
    manager.delegate = self
    locationManager = manager
    return manager
  }

  private func ensureLocationUpdates() {
    DispatchQueue.main.async { [weak self] in
      guard let self else {
        return
      }
      let manager = self.configureLocationManager()
      self.lock.lock()
      if let location = manager.location,
        navOSSNavigationRouteOrigin(
          coordinate: NavOSSCarPlayCoordinate(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude
          ),
          courseDegrees: location.course,
          speedMetersPerSecond: location.speed,
          horizontalAccuracyMeters: location.horizontalAccuracy,
          ageSeconds: Date().timeIntervalSince(location.timestamp)
        ) != nil,
        self.latestLocation.map({ $0.timestamp <= location.timestamp }) ?? true
      {
        self.latestLocation = location
      }
      self.lock.unlock()
      self.locationManagerDidChangeAuthorization(manager)
    }
  }

  private func navigationSessionUpdate(
    _ sample: NavigationLocationSample
  ) throws -> VersionedNavigationUpdate {
    lock.lock()
    defer { lock.unlock() }
    return prepareForPublicationLocked(try navigationSession.updateLocation(sample))
  }

  private func prepareForPublicationLocked(
    _ update: NavigationSessionUpdate
  ) -> VersionedNavigationUpdate {
    if update.snapshot.phase == .arrived || !update.snapshot.isOffRoute {
      rerouteTask?.cancel()
      rerouteTask = nil
      rerouteRequestId = nil
      rerouteRetryAfter = nil
      routeStatus = .tracking
    }
    if update.snapshot.phase == .arrived {
      activeTripStore.clear()
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
    let snapshot = versionedUpdate.update.snapshot
    let decision = navOSSPersistedNavigationDecision(
      distanceFromRouteMeters: snapshot.distanceFromRouteMeters,
      horizontalAccuracyMeters: snapshot.horizontalAccuracyMeters,
      isOffRoute: snapshot.isOffRoute
    )
    if decision != .wait {
      validatesPersistedNavigation = false
    }
    return decision
  }

  private func publish(_ versionedUpdate: VersionedNavigationUpdate) {
    lock.lock()
    guard isCurrentLocked(versionedUpdate) else {
      lock.unlock()
      return
    }
    let update = versionedUpdate.update
    let compassHeadingDegrees = latestCompassHeadingDegrees
    let latestCarPlayPosition = latestLocation.flatMap { location -> NavOSSCarPlayPosition? in
      guard
        let origin = navOSSNavigationRouteOrigin(
          coordinate: NavOSSCarPlayCoordinate(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude
          ),
          courseDegrees: location.course,
          speedMetersPerSecond: location.speed,
          horizontalAccuracyMeters: location.horizontalAccuracy,
          ageSeconds: Date().timeIntervalSince(location.timestamp)
        )
      else { return nil }
      return NavOSSCarPlayPosition(
        coordinate: origin.coordinate,
        courseDegrees: origin.headingDegrees,
        compassHeadingDegrees: compassHeadingDegrees,
        speedMetersPerSecond: location.speed >= 0 ? location.speed : nil
      )
    }
    let now = Date().timeIntervalSinceReferenceDate
    // Alerts first (cameras, speeding), then the maneuver prompt: all from native state, so
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
    let speechPrompt =
      !announcementState.allowsManeuverGuidance
      ? nil
      : update.trip.flatMap { trip in
        update.guidance.flatMap { guidance in
          speechPlanner.prompt(
            trip: trip,
            guidance: guidance,
            hasCurrentLocation: update.snapshot.rawCoordinate != nil,
            speedMetersPerSecond: update.snapshot.speedMetersPerSecond,
            isOffRoute: update.snapshot.isOffRoute,
            now: now
          )
        }
      }
    lock.unlock()
    if let trip = update.trip {
      let speed = self.lock.withLock {
        self.latestLocation.flatMap { $0.speed >= 0 ? $0.speed : nil }
      }
      let carPlayPosition = navOSSCarPlayPositionApplyingCompassHeading(
        compassHeadingDegrees,
        to: navOSSCarPlayPublishedPosition(
          matchedCoordinate: update.snapshot.matchedCoordinate,
          rawCoordinate: update.snapshot.rawCoordinate,
          matchedCourseDegrees: update.snapshot.matchedCourseDegrees,
          rawCourseDegrees: latestCarPlayPosition?.courseDegrees,
          speedMetersPerSecond: speed,
          fallback: latestCarPlayPosition
        )
      )
      NavOSSCarPlayTripStore.shared.publishNavigationState(
        trip: trip,
        guidance: update.guidance,
        position: carPlayPosition,
        routeProgress: update.snapshot.routeProgress,
        generation: versionedUpdate.generation,
        sequence: update.snapshot.sequence
      )
    }
    notificationCenter.post(name: .navOSSNavigationSnapshotDidChange, object: self)
    if update.snapshot.phase == .arrived, speechPrompt != nil {
      cancelNavigationSpeech(expectedGeneration: versionedUpdate.generation)
    }
    for text in utterances {
      speak(text, expectedGeneration: versionedUpdate.generation)
    }
    if let speechPrompt {
      speak(speechPrompt.text, expectedGeneration: versionedUpdate.generation)
    }
    if update.snapshot.phase == .arrived {
      stopDeadReckoning()
      reconcileLocationUpdates(expectedGeneration: versionedUpdate.generation)
    }
  }

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
    let now = Date()
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
    case .withdrew:
      routeStatus = .tracking
      stateVersion &+= 1
      lock.unlock()
      notificationCenter.post(name: .navOSSNavigationSnapshotDidChange, object: self)
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
      notificationCenter.post(name: .navOSSNavigationSnapshotDidChange, object: self)
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
    let rerouteOrigin = latestLocation.flatMap {
      navOSSNavigationRouteOrigin(
        coordinate: origin,
        courseDegrees: $0.course,
        speedMetersPerSecond: $0.speed,
        horizontalAccuracyMeters: $0.horizontalAccuracy,
        ageSeconds: Date().timeIntervalSince($0.timestamp)
      )
    }
    let remainingWaypoints = navOSSRemainingWaypoints(in: trip, after: routeProgress)
    // Keep-route recovery routes back onto the selected route ahead of the vehicle. It is only
    // used when no stop lies between here and the rejoin point, so no stop can be skipped.
    let rejoin: NavOSSCarPlayDestination? = {
      guard mode == .keepRoute, let routeLength = navigationSession.routeLengthMeters,
        routeLength > 0,
        let rejoinAlong = navigationKeepRouteRejoinAlongMeters(
          fixAlongMeters: routeProgress * routeLength,
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
    rerouteRequestId = requestId
    routeStatus = .rerouting
    stateVersion &+= 1
    rerouteTask = Task { [weak self] in
      guard let self else {
        return
      }
      do {
        let client = try NavOSSNavigationAPIClient()
        func fetch(_ waypoints: [NavOSSCarPlayDestination]) async throws -> NavOSSCarPlayTrip? {
          try await client.routes(
            origin: origin,
            originHeadingDegrees: rerouteOrigin?.headingDegrees,
            originHorizontalAccuracyMeters: rerouteOrigin?.horizontalAccuracyMeters,
            destination: trip.destination,
            preferences: trip.preferences,
            alternatives: 0,
            waypoints: waypoints
          ).first
        }
        let fetched: NavOSSCarPlayTrip?
        if let rejoin {
          do {
            fetched = try await fetch([rejoin] + remainingWaypoints)
          } catch NavOSSNavigationAPIError.invalidRequest {
            // The rejoin point could not be routed through; recovering matters more than
            // keeping the route.
            fetched = try await fetch(remainingWaypoints)
          }
        } else {
          fetched = try await fetch(remainingWaypoints)
        }
        guard !Task.isCancelled, let fetched else {
          throw NavOSSNavigationAPIError.invalidResponse
        }
        // The rejoin point steers the route; it is not a stop the driver asked for.
        let replacement = NavOSSCarPlayTrip(
          destination: fetched.destination,
          distanceMeters: fetched.distanceMeters,
          durationSeconds: fetched.durationSeconds,
          geometry: fetched.geometry,
          id: fetched.id,
          preferences: fetched.preferences,
          source: fetched.source,
          speedLimitsKph: fetched.speedLimitsKph,
          steps: fetched.steps,
          traffic: fetched.traffic,
          waypoints: remainingWaypoints.isEmpty ? nil : remainingWaypoints
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
    let decision = rerouteConsent.received(
      replacement,
      mode: navigationPreferences.rerouteMode,
      remainingDurationSeconds: current.guidance?.remainingDurationSeconds,
      remainingDistanceMeters: current.guidance?.remainingDistanceMeters,
      now: Date().timeIntervalSinceReferenceDate
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
      notificationCenter.post(name: .navOSSNavigationSnapshotDidChange, object: self)
      if allowsAlerts {
        speak("A new route is ready.", expectedGeneration: expectedGeneration)
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
    guard navigationGeneration == expectedGeneration,
      requestId.map({ $0 == rerouteRequestId }) ?? true,
      current.trip?.id == expectedTripId,
      current.snapshot.phase == .tracking
    else {
      lock.unlock()
      return false
    }
    do {
      update = try navigationSession.start(trip)
      navigationGeneration &+= 1
      activeTripStore.save(trip)
      rerouteCount += 1
      rerouteConsent.reset()
      routeStatus = .tracking
      rerouteRequestId = nil
      rerouteRetryAfter = nil
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
    cancelNavigationSpeech(expectedGeneration: versionedUpdate.generation)
    publish(versionedUpdate)
    ensureLocationUpdates()
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
    rerouteRetryAfter = Date().addingTimeInterval(10)
    rerouteRequestId = nil
    rerouteTask = nil
    stateVersion &+= 1
    lock.unlock()
    notificationCenter.post(name: .navOSSNavigationSnapshotDidChange, object: self)
  }

  private func isCurrentLocked(_ versionedUpdate: VersionedNavigationUpdate) -> Bool {
    let current = navigationSession.currentUpdate()
    return navigationGeneration == versionedUpdate.generation
      && current.trip?.id == versionedUpdate.update.trip?.id
      && current.snapshot.sequence == versionedUpdate.update.snapshot.sequence
  }

  private func currentStateLocked() -> NavOSSNavigationServiceState {
    let update = navigationSession.currentUpdate()
    return NavOSSNavigationServiceState(
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
      trip: update.trip
    )
  }

  private static func coordinates(_ trip: NavOSSCarPlayTrip) -> [NavigationCoordinate] {
    trip.geometry.map { NavigationCoordinate(latitude: $0.latitude, longitude: $0.longitude) }
  }

  /// Fetches fixed safety cameras for native alerting when the cache is missing or old. The
  /// request carries no location.
  private func refreshSafetyCamerasIfNeeded() {
    lock.lock()
    let now = Date()
    let isFresh = safetyCameraFetchedAt.map {
      now.timeIntervalSince($0) < safetyCameraRefreshSeconds
    } ?? false
    let recentlyAttempted = safetyCameraFetchAttemptedAt.map {
      now.timeIntervalSince($0) < safetyCameraRetrySeconds
    } ?? false
    guard !isFresh, !recentlyAttempted, safetyCameraTask == nil else {
      lock.unlock()
      return
    }
    safetyCameraFetchAttemptedAt = now
    safetyCameraTask = Task { [weak self] in
      let cameras = try? await NavOSSNavigationAPIClient().safetyCameras()
      guard let self else { return }
      self.lock.withLock {
        self.safetyCameraTask = nil
        if let cameras {
          self.safetyCameraMonitor.setCameras(cameras)
          self.safetyCameraFetchedAt = Date()
        }
      }
    }
    lock.unlock()
  }

  /// Ticks dead reckoning while a trip is active, so a gap in fixes moves the puck and the
  /// maneuver distance instead of freezing them. The core decides whether extrapolation is
  /// allowed; most ticks are no-ops because a fresh fix arrived.
  private func startDeadReckoning() {
    DispatchQueue.main.async { [weak self] in
      guard let self, self.deadReckoningTimer == nil else { return }
      let timer = DispatchSource.makeTimerSource(queue: .main)
      timer.schedule(
        deadline: .now() + deadReckoningTickSeconds,
        repeating: deadReckoningTickSeconds,
        leeway: .milliseconds(100)
      )
      timer.setEventHandler { [weak self] in
        self?.deadReckonTick()
      }
      self.deadReckoningTimer = timer
      timer.resume()
    }
  }

  private func stopDeadReckoning() {
    DispatchQueue.main.async { [weak self] in
      self?.deadReckoningTimer?.cancel()
      self?.deadReckoningTimer = nil
    }
  }

  private func deadReckonTick() {
    lock.lock()
    guard !validatesPersistedNavigation,
      let update = navigationSession.deadReckon(at: Date().timeIntervalSinceReferenceDate)
    else {
      lock.unlock()
      return
    }
    let versionedUpdate = prepareForPublicationLocked(update)
    lock.unlock()
    publish(versionedUpdate)
  }

  private func speak(_ text: String, expectedGeneration: UInt64? = nil) {
    DispatchQueue.main.async { [weak self] in
      guard let self, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        return
      }
      if let expectedGeneration {
        self.lock.lock()
        let isCurrent = self.navigationGeneration == expectedGeneration
        self.lock.unlock()
        guard isCurrent else {
          return
        }
      }
      if self.isCarPlayVoiceInputActive {
        self.deferredSpeech = (text: text, expectedGeneration: expectedGeneration)
        return
      }
      let utterance = AVSpeechUtterance(string: text)
      utterance.pitchMultiplier = 1.02
      utterance.preUtteranceDelay = 0.04
      utterance.postUtteranceDelay = 0.12
      utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.92
      utterance.voice =
        AVSpeechSynthesisVoice.speechVoices()
        .filter { $0.language == "en-CA" }
        .max { $0.quality.rawValue < $1.quality.rawValue }
        ?? AVSpeechSynthesisVoice(language: "en-CA")
      if self.pendingUtterances.isEmpty {
        let audioSession = AVAudioSession.sharedInstance()
        // `.interruptSpokenAudioAndMixWithOthers` pauses a podcast or audiobook for the prompt
        // instead of talking over it; music is still only ducked. Both resume on release via
        // `.notifyOthersOnDeactivation`.
        try? audioSession.setCategory(
          .playback,
          mode: .voicePrompt,
          options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers]
        )
        do {
          try audioSession.setActive(true)
          self.audioSessionOwnership.claim()
          self.cancelPendingAudioSessionRelease()
        } catch {
          // Nothing new was actually claimed; leave any prior release obligation untouched
          // rather than pretending it is satisfied.
        }
      }
      self.pendingUtterances.begin(
        ObjectIdentifier(utterance),
        characterCount: text.count,
        now: Date().timeIntervalSinceReferenceDate
      )
      self.speechSynthesizer.speak(utterance)
      self.scheduleUtteranceWatchdog()
    }
  }

  /// Releases the session even if the synthesizer never reports an utterance finished. See
  /// `NavOSSSpeechUtteranceLedger`.
  private func scheduleUtteranceWatchdog() {
    guard let deadline = pendingUtterances.nextDeadline else { return }
    let delay = max(0.1, deadline - Date().timeIntervalSinceReferenceDate + 0.05)
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
      guard let self else { return }
      if self.pendingUtterances.expireOverdue(now: Date().timeIntervalSinceReferenceDate) {
        self.attemptAudioSessionRelease(epoch: self.audioSessionOwnership.epoch)
      } else {
        self.scheduleUtteranceWatchdog()
      }
    }
  }

  private func completeSpeechUtterance(_ utterance: AVSpeechUtterance) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.pendingUtterances.complete(ObjectIdentifier(utterance))
      if !self.speechSynthesizer.isSpeaking {
        self.pendingUtterances.removeAll()
      }
      guard self.pendingUtterances.isEmpty else { return }
      self.attemptAudioSessionRelease(epoch: self.audioSessionOwnership.epoch)
    }
  }

  /// Sole real caller of `AVAudioSession.setActive(false)` — the sole *deactivation* owner.
  /// Guidance speech finishing and CarPlay capture finishing both route through this one
  /// entrypoint. `epoch` is checked first, before any state or the real session is touched, so a
  /// stale call (a retry scheduled against a superseded claim) is a complete no-op.
  private func attemptAudioSessionRelease(epoch: NavOSSAudioSessionOwnership.Epoch) {
    guard audioSessionOwnership.isCurrentClaim(epoch) else {
      return
    }
    cancelPendingAudioSessionRelease()
    guard !isCarPlayVoiceInputActive, pendingUtterances.isEmpty else {
      return
    }
    // Not gated on `speechSynthesizer.isSpeaking`: every queued utterance has already reported
    // didFinish/didCancel, and on device `isSpeaking` can stay true afterwards, which previously
    // deferred release indefinitely and left other audio ducked. Per AVAudioSession.h, deactivating
    // with I/O still running deactivates anyway (iOS 26 no longer even reports isBusy).
    do {
      try AVAudioSession.sharedInstance().setActive(
        false,
        options: .notifyOthersOnDeactivation
      )
      audioSessionOwnership.releaseSucceeded(epoch: epoch)
    } catch {
      scheduleAudioSessionReleaseRetry(epoch: epoch)
    }
  }

  private func scheduleAudioSessionReleaseRetry(epoch: NavOSSAudioSessionOwnership.Epoch) {
    switch audioSessionOwnership.releaseFailed(epoch: epoch) {
    case .stale:
      return
    case .retryAfter(let delay):
      let workItem = DispatchWorkItem { [weak self] in
        self?.attemptAudioSessionRelease(epoch: epoch)
      }
      pendingAudioSessionRelease = workItem
      DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
    }
  }

  /// Invalidates any scheduled release retry so it can never fire against a session a new owner
  /// (fresh guidance speech, or a new CarPlay recording lease) has since claimed.
  private func cancelPendingAudioSessionRelease() {
    pendingAudioSessionRelease?.cancel()
    pendingAudioSessionRelease = nil
  }

  private func startAuthorizedLocationUpdates(_ manager: CLLocationManager) {
    lock.lock()
    let update = navigationSession.currentUpdate()
    let hasActiveTrip = update.trip != nil && update.snapshot.phase != .arrived
    let isCarPlayConnected = carPlayConnected
    lock.unlock()
    if navOSSShouldHoldBackgroundLocationSession(
      hasActiveNavigation: hasActiveTrip,
      isCarPlayConnected: isCarPlayConnected
    ),
      backgroundLocationEnabled,
      #available(iOS 17.0, *),
      backgroundActivitySession == nil
    {
      backgroundActivitySession = CLBackgroundActivitySession()
    }
    manager.startUpdatingLocation()
    if CLLocationManager.headingAvailable() {
      manager.startUpdatingHeading()
    }
  }

  private func startNavigation(
    _ trip: NavOSSCarPlayTrip,
    persist: Bool,
    publishInitialUpdate: Bool = true,
    validatesPersistedNavigation: Bool = false
  ) throws {
    let update: NavigationSessionUpdate
    lock.lock()
    do {
      update = try navigationSession.start(trip)
      navigationGeneration &+= 1
      rerouteTask?.cancel()
      rerouteTask = nil
      rerouteRequestId = nil
      rerouteRetryAfter = nil
      rerouteCount = 0
      rerouteConsent.reset()
      routeStatus = .tracking
      safetyCameraMonitor.startTrip(geometry: Self.coordinates(trip))
      speechPlanner.reset()
      speedingMonitor.reset()
      self.validatesPersistedNavigation = validatesPersistedNavigation
      stateVersion &+= 1
      if persist {
        activeTripStore.save(trip)
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
    cancelNavigationSpeech(expectedGeneration: versionedUpdate.generation)
    if publishInitialUpdate {
      publish(versionedUpdate)
    }
    ensureLocationUpdates()
    startDeadReckoning()
    refreshSafetyCamerasIfNeeded()
  }

  /// Re-evaluates location ownership after a trip transition. A connected CarPlay scene remains a
  /// valid reason to track its idle map, while an idle phone alone never starts background location.
  private func reconcileLocationUpdates(expectedGeneration: UInt64) {
    lock.lock()
    guard navigationGeneration == expectedGeneration else {
      lock.unlock()
      return
    }
    let update = navigationSession.currentUpdate()
    let shouldTrack = navOSSShouldTrackLocation(
      hasActiveNavigation: update.trip != nil && update.snapshot.phase != .arrived,
      isCarPlayRoutePlanning: carPlayRoutePlanningLeases.isActive,
      isCarPlayConnected: carPlayConnected
    )
    lock.unlock()
    if shouldTrack {
      ensureLocationUpdates()
    } else {
      stopLocationUpdates(expectedGeneration: expectedGeneration)
    }
  }

  private func stopLocationUpdates(
    expectedGeneration: UInt64? = nil,
    force: Bool = false
  ) {
    DispatchQueue.main.async { [weak self] in
      guard let self else {
        return
      }
      self.lock.lock()
      let update = self.navigationSession.currentUpdate()
      let hasActiveNavigation = update.trip != nil && update.snapshot.phase != .arrived
      let generationMatches = expectedGeneration.map { $0 == self.navigationGeneration } ?? true
      let shouldTrack = navOSSShouldTrackLocation(
        hasActiveNavigation: hasActiveNavigation,
        isCarPlayRoutePlanning: self.carPlayRoutePlanningLeases.isActive,
        isCarPlayConnected: self.carPlayConnected
      )
      let shouldStop =
        force
        || (generationMatches && !shouldTrack)
      self.lock.unlock()
      guard shouldStop else {
        return
      }
      self.locationManager?.stopUpdatingLocation()
      self.locationManager?.stopUpdatingHeading()
      if #available(iOS 17.0, *),
        let session = self.backgroundActivitySession as? CLBackgroundActivitySession
      {
        session.invalidate()
      }
      self.backgroundActivitySession = nil
    }
  }

}
