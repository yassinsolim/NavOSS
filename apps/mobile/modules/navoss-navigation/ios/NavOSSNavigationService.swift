import AVFoundation
import CoreLocation
import Foundation
import os

extension Notification.Name {
  /// Posted by `NavOSSNavigationService.shared` whenever navigation state changes, on the queue
  /// that changed it.
  public static let navOSSNavigationSnapshotDidChange = Notification.Name(
    "org.navoss.mobile.navigation-snapshot-did-change"
  )
}

/// Interval of the navigation clock while guidance is active.
private let navigationClockTickSeconds = 1.0

/// Guidance audio session changes, for checking in the car that the session is let go between
/// prompts (Console.app, subsystem `org.navoss.mobile`, category `guidance-audio`). Carries no
/// prompt text and no location: only what was done to the session, a prompt counter and audio
/// lengths.
private let guidanceAudioLog = Logger(subsystem: "org.navoss.mobile", category: "guidance-audio")

public final class NavOSSNavigationService: NSObject, CLLocationManagerDelegate,
  @unchecked Sendable
{
  public static let shared = NavOSSNavigationService()

  /// The platform-neutral navigation state and orchestration. Its lock guards this service's own
  /// state below too, as it did when the two were one object.
  private let engine: NavigationEngine
  private var lock: NSRecursiveLock { engine.lock }
  private let communityCompanion = NavOSSCommunityNavigationCompanion()
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
  /// These methods run on the main actor alongside the guidance audio lifecycle.
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
  /// When the audio session is activated and released for guidance. Main queue only, like the
  /// three properties after it.
  private var guidanceAudio: NavOSSGuidanceAudioLifecycle = {
    #if targetEnvironment(simulator)
      // Simulator harness only: exercise the fallback that speaks through the synthesizer.
      if ProcessInfo.processInfo.environment["NAVOSS_GUIDANCE_SPEECH_DIRECT"] == "1" {
        return NavOSSGuidanceAudioLifecycle(rendersPrompts: false)
      }
    #endif
    return NavOSSGuidanceAudioLifecycle()
  }()
  private var guidanceAudioTimer: DispatchWorkItem?
  /// Text of the prompts the lifecycle still holds.
  private var promptTexts: [NavOSSGuidanceAudioLifecycle.PromptID: String] = [:]
  private var warmUpPromptID: NavOSSGuidanceAudioLifecycle.PromptID?
  private let speechPlayer = NavOSSGuidanceSpeechPlayer()
  private var audioInterruptionObserver: NSObjectProtocol?
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
    speechPlayer.onEvent = { [weak self] event in
      self?.speechPlayerDidAnswer(event)
    }
    // A call or Siri deactivates the session under a prompt. Nothing reports that prompt
    // finished, so drop it and release now instead of waiting out its deadline.
    audioInterruptionObserver = NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: nil,
      queue: .main
    ) { [weak self] notification in
      guard
        let rawType = (notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? NSNumber)?
          .uintValue,
        AVAudioSession.InterruptionType(rawValue: rawType) == .began
      else { return }
      guard let self else { return }
      self.promptTexts.removeAll()
      self.applyGuidanceAudio(self.guidanceAudio.cancelAll(now: Self.guidanceAudioNow()))
    }
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
    if let audioInterruptionObserver {
      NotificationCenter.default.removeObserver(audioInterruptionObserver)
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
(guidanceAudio.owesRelease, guidanceAudio.hasPrompts, isCarPlayVoiceInputActive)
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
    let wasMuted = engine.audioMode() == .muted
    engine.setAudioMode(mode)
    // Guidance switched on during a trip that started muted: load the voice now.
    guard wasMuted, mode != .muted, hasTrip() else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.applyGuidanceAudio(self.guidanceAudio.warmUp(now: Self.guidanceAudioNow()))
    }
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
    beginGuidanceAudioTrip()
  }

  public func startNavigation(_ trip: NavOSSCarPlayTrip) throws {
    try engine.startNavigation(trip)
    beginGuidanceAudioTrip()
  }

  /// Gives rendering a fresh chance for this trip and, unless guidance is muted, loads the voice
  /// before the first prompt needs it (silent; see `NavOSSGuidanceAudioLifecycle.beginTrip`).
  /// Called after the engine has started the trip, because starting one cancels speech left from
  /// the trip before, on the same queue.
  private func beginGuidanceAudioTrip() {
    // Restoring at launch finds no trip most of the time; leave the session alone then.
    let warmUp = hasTrip() && engine.audioMode() != .muted
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.applyGuidanceAudio(
        self.guidanceAudio.beginTrip(now: Self.guidanceAudioNow(), warmUp: warmUp))
    }
  }

  private func hasTrip() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return engine.currentUpdateLocked().trip != nil
  }

  /// Stops navigation speech before CarPlay begins recording. The coordinator calls the matching
  /// finish method only after it has released its recording session.
  @MainActor
  public func beginCarPlayVoiceInput() -> UUID {
    let identifier = UUID()
    carPlayVoiceInputLeases.insert(identifier)
    deferredSpeech = nil
    promptTexts.removeAll()
    applyGuidanceAudio(guidanceAudio.beginVoiceInput())
    return identifier
  }

  /// Returns audio-session ownership to normal navigation guidance after CarPlay capture ends.
  @MainActor
  public func finishCarPlayVoiceInput(_ identifier: UUID) {
    guard carPlayVoiceInputLeases.remove(identifier) != nil, !isCarPlayVoiceInputActive else {
      return
    }
    // Always release, even when deferred speech exists: speak() may reject it (stale
    // navigationGeneration, empty text), and that must not strand the recording session. If
    // speak() accepts, the prompt activates the session again for playback.
    applyGuidanceAudio(guidanceAudio.endVoiceInput())
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
      self.promptTexts.removeAll()
      self.applyGuidanceAudio(self.guidanceAudio.cancelAll(now: Self.guidanceAudioNow()))
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
      guard
        let (id, effects) = self.guidanceAudio.enqueue(
          characterCount: text.count, now: Self.guidanceAudioNow())
      else { return }
      self.promptTexts[id] = text
      self.applyGuidanceAudio(effects)
    }
  }

  private static func guidanceAudioNow() -> TimeInterval {
    ProcessInfo.processInfo.systemUptime
  }

  /// Carries out what `NavOSSGuidanceAudioLifecycle` decided, in order, then arms its timer.
  /// The only place guidance activates or deactivates the shared `AVAudioSession`.
  private func applyGuidanceAudio(_ effects: [NavOSSGuidanceAudioLifecycle.Effect]) {
    for effect in effects {
      switch effect {
      case .idleCategory:
        // The synthesizer activates the session when a render starts. As `.ambient` that
        // neither ducks nor pauses anyone's audio.
        do {
          try AVAudioSession.sharedInstance().setCategory(.ambient, mode: .default, options: [])
        } catch {
          guidanceAudioLog.notice(
            "idle category failed code=\((error as NSError).code, privacy: .public)")
        }
      case .activate:
        activateGuidanceAudioSession()
      case .render(let id):
        if let text = promptTexts[id] {
          speechPlayer.render(id, text: text)
        }
      case .renderWarmUp(let id):
        warmUpPromptID = id
        speechPlayer.render(id, text: "Navigation")
      case .play(let id):
        speechPlayer.play(id)
      case .speakDirectly(let id):
        guidanceAudioLog.notice("prompt \(id, privacy: .public) spoken directly")
        if let text = promptTexts[id] {
          speechPlayer.speakDirectly(id, text: text)
        }
      case .stopAudio:
        speechPlayer.stop()
      case .deactivate(let reason):
        deactivateGuidanceAudioSession(reason)
      }
    }
    if !guidanceAudio.hasPrompts {
      promptTexts.removeAll()
    }
    guidanceAudioTimer?.cancel()
    guidanceAudioTimer = nil
    guard let deadline = guidanceAudio.nextDeadline else { return }
    let timer = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.applyGuidanceAudio(self.guidanceAudio.timerFired(now: Self.guidanceAudioNow()))
    }
    guidanceAudioTimer = timer
    DispatchQueue.main.asyncAfter(
      deadline: .now() + max(0.01, deadline - Self.guidanceAudioNow() + 0.01), execute: timer)
  }

  private func activateGuidanceAudioSession() {
    let audioSession = AVAudioSession.sharedInstance()
    do {
      // `.interruptSpokenAudioAndMixWithOthers` pauses a podcast or audiobook for the prompt
      // instead of talking over it; music is only ducked. Both resume on release via
      // `.notifyOthersOnDeactivation`.
      try audioSession.setCategory(
        .playback,
        mode: .voicePrompt,
        options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers]
      )
    } catch {
      guidanceAudioLog.notice(
        "category failed code=\((error as NSError).code, privacy: .public)")
    }
    do {
      try audioSession.setActive(true)
      guidanceAudioLog.notice("activate ok")
    } catch {
      // The prompt is still attempted and the release is still owed: the player and the
      // synthesizer each try to activate the session themselves.
      guidanceAudioLog.notice(
        "activate failed code=\((error as NSError).code, privacy: .public)")
    }
  }

  private func deactivateGuidanceAudioSession(
    _ reason: NavOSSGuidanceAudioLifecycle.DeactivationReason
  ) {
    var succeeded = true
    do {
      try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      guidanceAudioLog.notice("deactivate ok reason=\(reason.rawValue, privacy: .public)")
    } catch {
      succeeded = false
      guidanceAudioLog.notice(
        "deactivate failed reason=\(reason.rawValue, privacy: .public) code=\((error as NSError).code, privacy: .public)"
      )
    }
    guidanceAudio.deactivated(succeeded: succeeded, now: Self.guidanceAudioNow())
  }

  private func speechPlayerDidAnswer(_ event: NavOSSGuidanceSpeechPlayer.Event) {
    let now = Self.guidanceAudioNow()
    switch event {
    case .rendered(let id, let audioSeconds, let renderSeconds):
      let name = id == warmUpPromptID ? "warm-up" : "prompt"
      guidanceAudioLog.notice(
        "\(name, privacy: .public) \(id, privacy: .public) rendered ms=\(Int((renderSeconds * 1000).rounded()), privacy: .public) seconds=\(audioSeconds ?? 0, format: .fixed(precision: 2), privacy: .public)"
      )
      applyGuidanceAudio(guidanceAudio.rendered(id, audioSeconds: audioSeconds, now: now))
    case .finished(let id):
      guidanceAudioLog.notice("prompt \(id, privacy: .public) finished")
      applyGuidanceAudio(guidanceAudio.finished(id, now: now))
    }
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
