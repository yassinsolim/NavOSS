import AVFoundation
import CoreLocation
import Foundation

extension Notification.Name {
  /// Posted by `NavOSSNavigationService.shared` whenever navigation state changes, on the queue
  /// that changed it.
  public static let navOSSNavigationSnapshotDidChange = Notification.Name(
    "org.navoss.mobile.navigation-snapshot-did-change"
  )
}

/// Interval of the navigation clock while guidance is active.
private let navigationClockTickSeconds = 1.0

public final class NavOSSNavigationService: NSObject, CLLocationManagerDelegate,
  AVSpeechSynthesizerDelegate, @unchecked Sendable
{
  public static let shared = NavOSSNavigationService()

  /// The platform-neutral navigation state and orchestration. Its lock guards this service's own
  /// state below too, as it did when the two were one object.
  private let engine: NavigationEngine
  private var lock: NSRecursiveLock { engine.lock }
  private let communityCompanion = NavOSSCommunityNavigationCompanion()
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
  private var navigationClockTimer: DispatchSourceTimer?
  private var deferredSpeech: (text: String, expectedGeneration: UInt64?)?
  private var isCarPlayVoiceInputActive: Bool { !carPlayVoiceInputLeases.isEmpty }
  private var locationManager: CLLocationManager?
  private var latestLocation: CLLocation?
  private var latestCompassHeadingDegrees: Double?
  private var navigationPreferencesObserver: NSObjectProtocol?
  private let navigationPreferencesStore: NavOSSNavigationPreferencesStore
  private let notificationCenter: NotificationCenter
  private var pendingAudioSessionRelease: DispatchWorkItem?
  /// Guidance utterances still owed a completion callback. Main queue only.
  private var pendingUtterances = NavOSSSpeechUtteranceLedger()
  private let speechSynthesizer = AVSpeechSynthesizer()
  #if DEBUG
    /// Simulator harness only: runs inside the checkpoint's critical section, just before the
    /// store write, so a test can hold it there while a clear or restart competes for the lock.
    var checkpointWillWrite: (() -> Void)? {
      get { engine.checkpointWillWrite }
      set { engine.checkpointWillWrite = newValue }
    }
    /// Simulator harness only: each utterance as it is handed to the synthesizer (main queue).
    var speechWillStart: ((String) -> Void)?
  #endif

  init(
    activeTripStore: NavOSSActiveTripStore = NavOSSActiveTripStore(),
    preferencesStore: NavOSSCarPlayPreferencesStore = NavOSSCarPlayPreferencesStore.shared,
    navigationPreferencesStore: NavOSSNavigationPreferencesStore =
      NavOSSNavigationPreferencesStore.shared,
    navigationSession: NavigationSession = NavigationSession(),
    notificationCenter: NotificationCenter = .default
  ) {
    engine = NavigationEngine(
      tripStore: activeTripStore,
      audioMode: navOSSInitialCarPlayAudioState(preferencesStore: preferencesStore).mode,
      preferences: navigationPreferencesStore.load(),
      session: navigationSession
    )
    self.navigationPreferencesStore = navigationPreferencesStore
    self.notificationCenter = notificationCenter
    super.init()
    engine.host = self
    engine.companion = communityCompanion
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
    engine.currentNavigationPreferences()
  }

  /// Accepts the pending ask-first replacement route. Returns `false` when `id` is no longer
  /// pending (withdrawn, timed out, or already answered).
  @discardableResult
  public func acceptRerouteProposal(id: String) -> Bool {
    engine.acceptRerouteProposal(id: id)
  }

  /// Declines the pending ask-first replacement; the selected route stays.
  @discardableResult
  public func declineRerouteProposal(id: String) -> Bool {
    engine.declineRerouteProposal(id: id)
  }

  private func reloadNavigationPreferences() {
    engine.setNavigationPreferences(navigationPreferencesStore.load())
  }

  public func audioMode() -> NavOSSCarPlayAudioMode {
    engine.audioMode()
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
    let generation = engine.navigationGenerationLocked
    let allowsAlerts = engine.allowsAlertsLocked
    lock.unlock()
    guard allowsAlerts else {
      return
    }
    speak("Red light and speed camera ahead.", expectedGeneration: generation)
  }
  #endif

  public func setAudioMode(_ mode: NavOSSCarPlayAudioMode) {
    engine.setAudioMode(mode)
  }

  public func clearNavigation() {
    engine.clearNavigation()
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

  /// The core's live road context, speeding, reroute-proposal, and camera-alert state, for
  /// CarPlay surfaces outside this module.
  public func carPlayLiveGuidance() -> NavOSSCarPlayLiveGuidance {
    lock.lock()
    defer { lock.unlock() }
    let state = engine.currentStateLocked()
    return NavOSSCarPlayLiveGuidance(
      currentRoadName: state.roadContext.currentRoadName,
      speedLimitKph: state.roadContext.speedLimitKph,
      speedingState: state.speedingState,
      rerouteProposal: state.rerouteProposal.map {
        NavOSSCarPlayLiveGuidance.RerouteProposal(
          id: $0.id,
          durationDeltaSeconds: $0.durationDeltaSeconds,
          distanceDeltaMeters: $0.distanceDeltaMeters
        )
      },
      safetyCameraAlert: state.safetyCameraAlert.map { alert in
        NavOSSCarPlayLiveGuidance.SafetyCameraAlert(
          cameraId: alert.cameraId,
          distanceAheadMeters: alert.distanceAheadMeters,
          location: alert.location,
          sequence: alert.sequence,
          coordinate: engine.safetyCameraLocked(id: alert.cameraId).map {
            NavOSSCarPlayCoordinate(latitude: $0.latitude, longitude: $0.longitude)
          }
        )
      }
    )
  }

  func currentState() -> NavOSSNavigationServiceState {
    engine.currentState()
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
    let generation = engine.navigationGenerationLocked
    lock.unlock()
    stopLocationUpdates(expectedGeneration: generation)
  }

  public func finishCarPlayRoutePlanning(_ leaseIdentifier: UUID) {
    lock.lock()
    carPlayRoutePlanningLeases.release(leaseIdentifier)
    let generation = engine.navigationGenerationLocked
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
    let update = engine.currentUpdateLocked()
    let hasActiveNavigation = update.trip != nil && update.snapshot.phase != .arrived
    let shouldTrack = navOSSShouldTrackLocation(
      hasActiveNavigation: hasActiveNavigation,
      isCarPlayRoutePlanning: carPlayRoutePlanningLeases.isActive,
      isCarPlayConnected: carPlayConnected
    )
    let generation = engine.navigationGenerationLocked
    lock.unlock()
    if shouldTrack {
      ensureLocationUpdates()
    } else {
      stopLocationUpdates(expectedGeneration: generation)
    }
  }

  func ingest(_ sample: NavigationLocationSample) throws -> NavigationSnapshot {
    try engine.ingest(navOSSLiveNavigationFix(sample)).versionedUpdate.update.snapshot
  }

  public func resumePersistedNavigation() {
    engine.resumePersistedNavigation()
  }

  public func startNavigation(_ trip: NavOSSCarPlayTrip) throws {
    try engine.startNavigation(trip)
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
    let generation = engine.navigationGenerationLocked
    lock.unlock()
    cancelNavigationSpeech(expectedGeneration: generation)
  }

  private func cancelNavigationSpeech(expectedGeneration: UInt64) {
    DispatchQueue.main.async { [weak self] in
      guard let self else {
        return
      }
      self.lock.lock()
      let isCurrent = self.engine.navigationGenerationLocked == expectedGeneration
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
      let outcome = try? engine.ingest(
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
    // Only real fixes during turn-by-turn guidance can become traffic probes, and only when
    // the driver turned "Share traffic speeds" on; the community service enforces both.
    if case .published(let versionedUpdate) = outcome, versionedUpdate.update.trip != nil,
      versionedUpdate.update.snapshot.phase == .tracking
    {
      NavOSSCommunityService.shared.navigationDidReceiveFix(
        NavOSSTrafficFix(
          coordinate: NavOSSCarPlayCoordinate(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude
          ),
          horizontalAccuracyMeters: location.horizontalAccuracy,
          timestamp: location.timestamp
        )
      )
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
      generation: engine.navigationGenerationLocked,
      update: engine.currentUpdateLocked()
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
      tripPause: previousState.tripPause,
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
    let update = engine.currentUpdateLocked()
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
    didStart utterance: AVSpeechUtterance
  ) {
    startSpeechUtterance(utterance)
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

  /// Where CarPlay draws the vehicle from the latest raw fix, when it is recent and usable.
  /// Caller holds `lock`.
  private func latestCarPlayPositionLocked() -> NavOSSCarPlayPosition? {
    latestLocation.flatMap { location -> NavOSSCarPlayPosition? in
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
        compassHeadingDegrees: latestCompassHeadingDegrees,
        speedMetersPerSecond: location.speed >= 0 ? location.speed : nil
      )
    }
  }

  /// A one-second clock while a trip is active. It dead-reckons through gaps in fixes (so the
  /// puck and maneuver distance keep moving), applies reroute-consent deadlines even when no fix
  /// arrives, and retries a failed camera fetch. Start and stop are bound to the navigation
  /// generation that requested them, so a stale stop queued by an earlier trip cannot cancel
  /// the clock a newer trip started.
  private func startNavigationClock(expectedGeneration: UInt64) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      let isCurrent = self.lock.withLock {
        self.engine.navigationGenerationLocked == expectedGeneration
          && self.engine.tripLocked != nil
      }
      guard isCurrent, self.navigationClockTimer == nil else { return }
      let timer = DispatchSource.makeTimerSource(queue: .main)
      timer.schedule(
        deadline: .now() + navigationClockTickSeconds,
        repeating: navigationClockTickSeconds,
        leeway: .milliseconds(100)
      )
      timer.setEventHandler { [weak self] in
        self?.navigationClockTick()
      }
      self.navigationClockTimer = timer
      timer.resume()
    }
  }

  private func stopNavigationClock(expectedGeneration: UInt64) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      let isCurrent = self.lock.withLock {
        self.engine.navigationGenerationLocked == expectedGeneration
      }
      guard isCurrent else { return }
      self.navigationClockTimer?.cancel()
      self.navigationClockTimer = nil
    }
  }

  private func navigationClockTick() {
    engine.clockTick()
  }

  private func speak(_ text: String, expectedGeneration: UInt64? = nil) {
    DispatchQueue.main.async { [weak self] in
      guard let self, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        return
      }
      if let expectedGeneration {
        self.lock.lock()
        let isCurrent = self.engine.navigationGenerationLocked == expectedGeneration
        self.lock.unlock()
        guard isCurrent else {
          return
        }
      }
      if self.isCarPlayVoiceInputActive {
        self.deferredSpeech = (text: text, expectedGeneration: expectedGeneration)
        return
      }
      #if DEBUG
        self.speechWillStart?(text)
      #endif
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

  private func startSpeechUtterance(_ utterance: AVSpeechUtterance) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.pendingUtterances.start(
        ObjectIdentifier(utterance),
        now: Date().timeIntervalSinceReferenceDate
      )
    }
  }

  /// Not gated on `speechSynthesizer.isSpeaking`: between two queued prompts it can briefly read
  /// false, which used to release the session under the next prompt. Lost callbacks are covered
  /// by the ledger's deadlines instead.
  private func completeSpeechUtterance(_ utterance: AVSpeechUtterance) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.pendingUtterances.complete(
        ObjectIdentifier(utterance),
        now: Date().timeIntervalSinceReferenceDate
      )
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
    let update = engine.currentUpdateLocked()
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

  /// Re-evaluates location ownership after a trip transition. A connected CarPlay scene remains a
  /// valid reason to track its idle map, while an idle phone alone never starts background location.
  private func reconcileLocationUpdates(expectedGeneration: UInt64) {
    lock.lock()
    guard engine.navigationGenerationLocked == expectedGeneration else {
      lock.unlock()
      return
    }
    let update = engine.currentUpdateLocked()
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
      let update = self.engine.currentUpdateLocked()
      let hasActiveNavigation = update.trip != nil && update.snapshot.phase != .arrived
      let generationMatches =
        expectedGeneration.map { $0 == self.engine.navigationGenerationLocked } ?? true
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

// MARK: - Engine host

extension NavOSSNavigationService: NavigationEngineHost {
  func navigationEnginePreparePublicationLocked(
    _ versionedUpdate: VersionedNavigationUpdate
  ) -> (() -> Void)? {
    let update = versionedUpdate.update
    let compassHeadingDegrees = latestCompassHeadingDegrees
    let latestCarPlayPosition = latestCarPlayPositionLocked()
    let tripPause = engine.tripPauseLocked
    return { [weak self] in
      guard let self, let trip = update.trip else { return }
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
          runOn: update.carPlayRunOn,
          fallback: latestCarPlayPosition
        )
      )
      NavOSSCarPlayTripStore.shared.publishNavigationState(
        trip: trip,
        guidance: update.guidance,
        position: carPlayPosition,
        routeProgress: update.snapshot.routeProgress,
        tripPause: tripPause,
        generation: versionedUpdate.generation,
        sequence: update.snapshot.sequence
      )
    }
  }

  func navigationEnginePrepareRestoredTripAcquisitionLocked(
    trip: NavOSSCarPlayTrip,
    _ versionedUpdate: VersionedNavigationUpdate
  ) -> (() -> Void)? {
    let position = latestCarPlayPositionLocked()
    let tripPause = engine.tripPauseLocked
    return {
      NavOSSCarPlayTripStore.shared.publishNavigationState(
        trip: trip,
        guidance: nil,
        position: position,
        routeProgress: 0,
        tripPause: tripPause,
        generation: versionedUpdate.generation,
        sequence: versionedUpdate.update.snapshot.sequence
      )
    }
  }

  func navigationEngineDidClearTrip(generation: UInt64, sequence: Int) {
    NavOSSCarPlayTripStore.shared.clearTrip(generation: generation, sequence: sequence)
  }

  func navigationEngineStateDidChange() {
    // A reroute status change without a fix (a request started or failed, a proposal offered
    // or withdrawn) can change why the trip has no maneuver; CarPlay must not keep the old one.
    let (tripId, tripPause) = lock.withLock { (engine.tripLocked?.id, engine.tripPauseLocked) }
    if let tripId {
      NavOSSCarPlayTripStore.shared.publishTripPause(tripPause, forTripId: tripId)
    }
    notificationCenter.post(name: .navOSSNavigationSnapshotDidChange, object: self)
  }

  func navigationEngineSpeak(_ speech: NavigationEngineSpeech, generation: UInt64) {
    speak(speech.text, expectedGeneration: generation)
  }

  func navigationEngineCancelSpeech(generation: UInt64) {
    cancelNavigationSpeech(expectedGeneration: generation)
  }

  func navigationEngineNeedsLocationUpdates() {
    ensureLocationUpdates()
  }

  func navigationEngineReconcileLocationUpdates(generation: UInt64) {
    reconcileLocationUpdates(expectedGeneration: generation)
  }

  func navigationEngineStartClock(generation: UInt64) {
    startNavigationClock(expectedGeneration: generation)
  }

  func navigationEngineStopClock(generation: UInt64) {
    stopNavigationClock(expectedGeneration: generation)
  }

  func navigationEngineRerouteOriginLocked(
    at coordinate: NavOSSCarPlayCoordinate
  ) -> NavOSSNavigationRouteOrigin? {
    latestLocation.flatMap {
      navOSSNavigationRouteOrigin(
        coordinate: coordinate,
        courseDegrees: $0.course,
        speedMetersPerSecond: $0.speed,
        horizontalAccuracyMeters: $0.horizontalAccuracy,
        ageSeconds: Date().timeIntervalSince($0.timestamp)
      )
    }
  }
}

/// Community road reports and traffic speeds, riding along with the engine's trips.
private final class NavOSSCommunityNavigationCompanion: NavigationEngineCompanion {
  func navigationDidStart(_ trip: NavOSSCarPlayTrip, restored: Bool) {
    NavOSSCommunityService.shared.navigationDidStart(trip, restored: restored)
  }

  func navigationRouteDidChange(_ trip: NavOSSCarPlayTrip) {
    NavOSSCommunityService.shared.navigationRouteDidChange(trip)
  }

  func navigationDidEnd() {
    NavOSSCommunityService.shared.navigationDidEnd()
  }

  func navigationClockTick() {
    NavOSSCommunityService.shared.navigationClockTick()
  }

  func navigationDidUpdateLocked(routeProgress: Double, isTracking: Bool) -> (() -> String?)? {
    guard
      let reportAlert = NavOSSCommunityService.shared.navigationDidUpdate(
        routeProgress: routeProgress,
        isTracking: isTracking
      )
    else {
      return nil
    }
    return {
      NavOSSCommunityService.shared.preferences().announcesRoadReports
        ? navOSSCommunityReportSpokenAlert(reportAlert.type) : nil
    }
  }
}
