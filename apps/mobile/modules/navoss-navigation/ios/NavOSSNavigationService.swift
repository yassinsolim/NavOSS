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
  let routeStatus: NavOSSNavigationRouteStatus
  let stateVersion: UInt64
  let trip: NavOSSCarPlayTrip?
}

public final class NavOSSNavigationService: NSObject, CLLocationManagerDelegate,
  AVSpeechSynthesizerDelegate, @unchecked Sendable
{
  public static let shared = NavOSSNavigationService()

  private let activeTripStore: NavOSSActiveTripStore
  private var announcementState = NavOSSCarPlayAudioState()
  private var audioSessionNeedsDeactivation = false
  private var backgroundActivitySession: AnyObject?
  private var carPlayConnected = false
  private var carPlayRoutePlanningLeases = NavOSSLocationTrackingLeases()
  private let lock = NSRecursiveLock()
  private var locationManager: CLLocationManager?
  private var latestLocation: CLLocation?
  private var latestCompassHeadingDegrees: Double?
  private var navigationGeneration: UInt64 = 0
  private let navigationSession: NavigationSession
  private let notificationCenter: NotificationCenter
  private var pendingUtteranceIds: Set<ObjectIdentifier> = []
  private var rerouteCount = 0
  private var rerouteRequestId: UUID?
  private var rerouteRetryAfter: Date?
  private var rerouteTask: Task<Void, Never>?
  private var routeStatus = NavOSSNavigationRouteStatus.tracking
  private let speechPlanner = NavigationSpeechPlanner()
  private let speechSynthesizer = AVSpeechSynthesizer()
  private var stateVersion: UInt64 = 0
  private var validatesPersistedNavigation = false

  init(
    activeTripStore: NavOSSActiveTripStore = NavOSSActiveTripStore(),
    preferencesStore: NavOSSCarPlayPreferencesStore = NavOSSCarPlayPreferencesStore.shared,
    navigationSession: NavigationSession = NavigationSession(),
    notificationCenter: NotificationCenter = .default
  ) {
    self.activeTripStore = activeTripStore
    announcementState = navOSSInitialCarPlayAudioState(preferencesStore: preferencesStore)
    self.navigationSession = navigationSession
    self.notificationCenter = notificationCenter
    super.init()
    speechSynthesizer.delegate = self
  }

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

  public func audioMode() -> NavOSSCarPlayAudioMode {
    lock.lock()
    defer { lock.unlock() }
    return announcementState.mode
  }

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
    routeStatus = .tracking
    speechPlanner.reset()
    stateVersion &+= 1
    activeTripStore.clear()
    lock.unlock()
    NavOSSCarPlayTripStore.shared.clearTrip(
      generation: generation,
      sequence: update.snapshot.sequence
    )
    notificationCenter.post(name: .navOSSNavigationSnapshotDidChange, object: self)
    stopLocationUpdates(expectedGeneration: generation)
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

  public func setCarPlayConnected(_ connected: Bool) {
    lock.lock()
    carPlayConnected = connected
    if !connected {
      carPlayRoutePlanningLeases.removeAll()
    }
    let update = navigationSession.currentUpdate()
    let hasActiveNavigation = update.trip != nil && update.snapshot.phase != .arrived
    let shouldTrack = navOSSShouldTrackLocation(
      hasActiveNavigation: hasActiveNavigation,
      isCarPlayRoutePlanning: carPlayRoutePlanningLeases.isActive
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
      self.pendingUtteranceIds.removeAll()
      self.speechSynthesizer.stopSpeaking(at: .immediate)
      self.deactivateAudioSession()
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
          horizontalAccuracyMeters: location.horizontalAccuracy
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
      isCarPlayRoutePlanning: carPlayRoutePlanningLeases.isActive
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
    // which only runs during active guidance or CarPlay route planning, takes every fix the OS
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
    let speechPrompt =
      !announcementState.allowsManeuverGuidance
      ? nil
      : update.trip.flatMap { trip in
        update.guidance.flatMap { guidance in
          speechPlanner.prompt(
            trip: trip,
            guidance: guidance,
            hasCurrentLocation: update.snapshot.rawCoordinate != nil
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
    if let speechPrompt {
      if update.snapshot.phase == .arrived {
        cancelNavigationSpeech(expectedGeneration: versionedUpdate.generation)
      }
      speak(speechPrompt.text, expectedGeneration: versionedUpdate.generation)
    }
    if update.snapshot.phase == .arrived {
      stopLocationUpdates(expectedGeneration: versionedUpdate.generation)
    }
  }

  private func evaluateReroute(for versionedUpdate: VersionedNavigationUpdate) {
    let update = versionedUpdate.update
    guard update.snapshot.isOffRoute, let trip = update.trip,
      let rawCoordinate = update.snapshot.rawCoordinate
    else {
      return
    }
    lock.lock()
    guard isCurrentLocked(versionedUpdate), rerouteTask == nil,
      rerouteRetryAfter.map({ $0 <= Date() }) ?? true
    else {
      lock.unlock()
      return
    }
    let requestId = UUID()
    let rerouteOrigin = latestLocation.flatMap {
      navOSSNavigationRouteOrigin(
        coordinate: NavOSSCarPlayCoordinate(
          latitude: rawCoordinate.latitude,
          longitude: rawCoordinate.longitude
        ),
        courseDegrees: $0.course,
        speedMetersPerSecond: $0.speed,
        horizontalAccuracyMeters: $0.horizontalAccuracy,
        ageSeconds: Date().timeIntervalSince($0.timestamp)
      )
    }
    rerouteRequestId = requestId
    routeStatus = .rerouting
    stateVersion &+= 1
    rerouteTask = Task { [weak self] in
      guard let self else {
        return
      }
      do {
        let client = try NavOSSNavigationAPIClient()
        let routes = try await client.routes(
          origin: NavOSSCarPlayCoordinate(
            latitude: rawCoordinate.latitude,
            longitude: rawCoordinate.longitude
          ),
          originHeadingDegrees: rerouteOrigin?.headingDegrees,
          originHorizontalAccuracyMeters: rerouteOrigin?.horizontalAccuracyMeters,
          destination: trip.destination,
          preferences: trip.preferences,
          alternatives: 0,
          waypoints: navOSSRemainingWaypoints(
            in: trip,
            after: update.snapshot.routeProgress
          )
        )
        guard !Task.isCancelled, let replacement = routes.first else {
          throw NavOSSNavigationAPIError.invalidResponse
        }
        guard
          try self.installReroute(
            replacement,
            expectedGeneration: versionedUpdate.generation,
            expectedTripId: trip.id,
            requestId: requestId
          )
        else {
          return
        }
      } catch {
        guard !Task.isCancelled else {
          return
        }
        self.handleRerouteFailure(
          expectedGeneration: versionedUpdate.generation,
          expectedTripId: trip.id,
          requestId: requestId
        )
      }
    }
    lock.unlock()
    notificationCenter.post(name: .navOSSNavigationSnapshotDidChange, object: self)
  }

  private static func distanceMeters(
    from origin: NavOSSCarPlayCoordinate,
    to destination: NavOSSCarPlayCoordinate
  ) -> Double {
    let latitudeDelta = (destination.latitude - origin.latitude) * .pi / 180
    let longitudeDelta = (destination.longitude - origin.longitude) * .pi / 180
    let originLatitude = origin.latitude * .pi / 180
    let destinationLatitude = destination.latitude * .pi / 180
    let haversine =
      pow(sin(latitudeDelta / 2), 2)
      + cos(originLatitude) * cos(destinationLatitude) * pow(sin(longitudeDelta / 2), 2)
    return 12_742_000 * asin(sqrt(haversine))
  }

  private func installReroute(
    _ trip: NavOSSCarPlayTrip,
    expectedGeneration: UInt64,
    expectedTripId: String,
    requestId: UUID
  ) throws -> Bool {
    let update: NavigationSessionUpdate
    lock.lock()
    let current = navigationSession.currentUpdate()
    guard navigationGeneration == expectedGeneration,
      rerouteRequestId == requestId,
      current.trip?.id == expectedTripId,
      current.snapshot.phase == .tracking,
      current.snapshot.isOffRoute
    else {
      lock.unlock()
      return false
    }
    do {
      update = try navigationSession.start(trip)
      navigationGeneration &+= 1
      activeTripStore.save(trip)
      rerouteCount += 1
      routeStatus = .tracking
      rerouteRequestId = nil
      rerouteRetryAfter = nil
      rerouteTask = nil
      speechPlanner.reset()
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
      routeStatus: routeStatus,
      stateVersion: stateVersion,
      trip: update.trip
    )
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
      if self.pendingUtteranceIds.isEmpty {
        let audioSession = AVAudioSession.sharedInstance()
        try? audioSession.setCategory(
          .playback,
          mode: .voicePrompt,
          options: [.duckOthers]
        )
        do {
          try audioSession.setActive(true)
          self.audioSessionNeedsDeactivation = true
        } catch {
          self.audioSessionNeedsDeactivation = false
        }
      }
      self.pendingUtteranceIds.insert(ObjectIdentifier(utterance))
      self.speechSynthesizer.speak(utterance)
    }
  }

  private func completeSpeechUtterance(_ utterance: AVSpeechUtterance) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.pendingUtteranceIds.remove(ObjectIdentifier(utterance))
      if !self.speechSynthesizer.isSpeaking {
        self.pendingUtteranceIds.removeAll()
      }
      guard self.pendingUtteranceIds.isEmpty else { return }
      self.deactivateAudioSession()
    }
  }

  private func deactivateAudioSession(attempt: Int = 0) {
    guard audioSessionNeedsDeactivation, pendingUtteranceIds.isEmpty else { return }
    guard !speechSynthesizer.isSpeaking else {
      scheduleAudioSessionDeactivationRetry(attempt: attempt)
      return
    }
    do {
      try AVAudioSession.sharedInstance().setActive(
        false,
        options: .notifyOthersOnDeactivation
      )
      audioSessionNeedsDeactivation = false
    } catch {
      scheduleAudioSessionDeactivationRetry(attempt: attempt)
    }
  }

  private func scheduleAudioSessionDeactivationRetry(attempt: Int) {
    guard attempt < 4 else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
      self?.deactivateAudioSession(attempt: attempt + 1)
    }
  }

  private func startAuthorizedLocationUpdates(_ manager: CLLocationManager) {
    lock.lock()
    let update = navigationSession.currentUpdate()
    let hasActiveTrip = update.trip != nil && update.snapshot.phase != .arrived
    lock.unlock()
    if hasActiveTrip,
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
      routeStatus = .tracking
      speechPlanner.reset()
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
        isCarPlayRoutePlanning: self.carPlayRoutePlanningLeases.isActive
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
