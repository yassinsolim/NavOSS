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
  private var backgroundActivitySession: AnyObject?
  private var carPlayConnected = false
  private let lock = NSRecursiveLock()
  private var locationManager: CLLocationManager?
  private var latestLocation: CLLocation?
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

  init(
    activeTripStore: NavOSSActiveTripStore = NavOSSActiveTripStore(),
    navigationSession: NavigationSession = NavigationSession(),
    notificationCenter: NotificationCenter = .default
  ) {
    self.activeTripStore = activeTripStore
    self.navigationSession = navigationSession
    self.notificationCenter = notificationCenter
    super.init()
    speechSynthesizer.delegate = self
  }

  public func announceSafetyCamera() {
    lock.lock()
    let generation = navigationGeneration
    lock.unlock()
    speak("Red light and speed camera ahead.", expectedGeneration: generation)
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
    lock.lock()
    defer { lock.unlock() }
    guard let latestLocation,
      latestLocation.horizontalAccuracy >= 0,
      latestLocation.horizontalAccuracy <= 100,
      Date().timeIntervalSince(latestLocation.timestamp) >= -5,
      Date().timeIntervalSince(latestLocation.timestamp) <= 30
    else {
      return nil
    }
    return NavOSSCarPlayCoordinate(
      latitude: latestLocation.coordinate.latitude,
      longitude: latestLocation.coordinate.longitude
    )
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

  public func prepareForCarPlayRoutePlanning() {
    lock.lock()
    let shouldPrepare = carPlayConnected
    lock.unlock()
    if shouldPrepare {
      ensureLocationUpdates()
    }
  }

  public func setCarPlayConnected(_ connected: Bool) {
    lock.lock()
    carPlayConnected = connected
    let update = navigationSession.currentUpdate()
    let hasActiveNavigation = update.trip != nil && update.snapshot.phase != .arrived
    let shouldTrackWhenConnected = update.snapshot.phase != .arrived
    let generation = navigationGeneration
    lock.unlock()
    if connected && shouldTrackWhenConnected {
      ensureLocationUpdates()
    } else if !connected && !hasActiveNavigation {
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
    publish(versionedUpdate)
    evaluateReroute(for: versionedUpdate)
    return versionedUpdate.update.snapshot
  }

  public func resumePersistedNavigation() {
    guard let trip = activeTripStore.load() else {
      return
    }
    do {
      try startNavigation(trip, persist: false)
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
    publish(versionedUpdate)
    evaluateReroute(for: versionedUpdate)
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
    let shouldTrack = hasActiveNavigation || carPlayConnected
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
    manager.distanceFilter = 5
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
      if let location = manager.location, location.horizontalAccuracy >= 0 {
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

  private func publish(_ versionedUpdate: VersionedNavigationUpdate) {
    lock.lock()
    guard isCurrentLocked(versionedUpdate) else {
      lock.unlock()
      return
    }
    let update = versionedUpdate.update
    let speechPrompt = update.trip.flatMap { trip in
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
      let carPlayCoordinate = (update.snapshot.matchedCoordinate ?? update.snapshot.rawCoordinate)
        .map {
          NavOSSCarPlayCoordinate(latitude: $0.latitude, longitude: $0.longitude)
        }
      let carPlayPosition = carPlayCoordinate.map {
        NavOSSCarPlayPosition(
          coordinate: $0,
          courseDegrees: update.snapshot.matchedCourseDegrees
        )
      }
      NavOSSCarPlayTripStore.shared.publishNavigationState(
        trip: trip,
        guidance: update.guidance,
        position: carPlayPosition,
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
          destination: trip.destination,
          preferences: trip.preferences,
          alternatives: 0
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
        try? audioSession.setActive(true)
      }
      self.pendingUtteranceIds.insert(ObjectIdentifier(utterance))
      self.speechSynthesizer.speak(utterance)
    }
  }

  private func completeSpeechUtterance(_ utterance: AVSpeechUtterance) {
    DispatchQueue.main.async { [weak self] in
      guard let self,
        self.pendingUtteranceIds.remove(ObjectIdentifier(utterance)) != nil,
        self.pendingUtteranceIds.isEmpty
      else {
        return
      }
      self.deactivateAudioSession()
    }
  }

  private func deactivateAudioSession() {
    try? AVAudioSession.sharedInstance().setActive(
      false,
      options: .notifyOthersOnDeactivation
    )
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
  }

  private func startNavigation(_ trip: NavOSSCarPlayTrip, persist: Bool) throws {
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
    publish(versionedUpdate)
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
      let shouldStop =
        force
        || (generationMatches && !hasActiveNavigation)
      self.lock.unlock()
      guard shouldStop else {
        return
      }
      self.locationManager?.stopUpdatingLocation()
      if #available(iOS 17.0, *),
        let session = self.backgroundActivitySession as? CLBackgroundActivitySession
      {
        session.invalidate()
      }
      self.backgroundActivitySession = nil
    }
  }

}
