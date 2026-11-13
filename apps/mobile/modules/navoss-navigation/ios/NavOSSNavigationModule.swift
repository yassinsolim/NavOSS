import ExpoModulesCore

private let navigationSnapshotEvent = "onNavigationSnapshot"
private let navigationPreferencesEvent = "onNavigationPreferencesChanged"
private let carPlayStateEvent = "onCarPlayStateChanged"
private let carPlayNavigationEndedEvent = "onCarPlayNavigationEnded"
private let offlineStateEvent = "onOfflineStateChanged"

private struct NavigationCoordinateRecord: Record {
  @Field
  var latitude: Double = 0

  @Field
  var longitude: Double = 0

  var coordinate: NavigationCoordinate {
    NavigationCoordinate(latitude: latitude, longitude: longitude)
  }
}

private struct NavigationLocationRecord: Record {
  @Field
  var courseDegrees: Double?

  @Field
  var horizontalAccuracyMeters: Double?

  @Field
  var latitude: Double = 0

  @Field
  var longitude: Double = 0

  @Field
  var speedMetersPerSecond: Double?

  /// Fix time in milliseconds since the Unix epoch, as JavaScript reports it.
  @Field
  var timestampMs: Double?

  var sample: NavigationLocationSample {
    NavigationLocationSample(
      coordinate: NavigationCoordinate(latitude: latitude, longitude: longitude),
      courseDegrees: courseDegrees,
      horizontalAccuracyMeters: horizontalAccuracyMeters,
      speedMetersPerSecond: speedMetersPerSecond,
      timestamp: timestampMs.map {
        Date(timeIntervalSince1970: $0 / 1_000).timeIntervalSinceReferenceDate
      }
    )
  }
}

private struct NavigationDestinationRecord: Record {
  @Field
  var category: String?

  @Field
  var id: String = ""

  @Field
  var label: String = ""

  @Field
  var latitude: Double = 0

  @Field
  var longitude: Double = 0

  @Field
  var name: String = ""

  var destination: NavOSSCarPlayDestination {
    NavOSSCarPlayDestination(
      category: category,
      id: id,
      label: label,
      latitude: latitude,
      longitude: longitude,
      name: name
    )
  }
}

private struct CarPlayRouteStepRecord: Record {
  @Field
  var distanceMeters: Double = 0

  @Field
  var durationSeconds: Double = 0

  @Field
  var geometry: [NavigationCoordinateRecord] = []

  @Field
  var instruction: String = ""

  @Field
  var maneuverType: String = ""

  @Field
  var roadName: String = ""

  @Field
  var spokenInstruction: String?

  var step: NavOSSCarPlayRouteStep {
    NavOSSCarPlayRouteStep(
      distanceMeters: distanceMeters,
      durationSeconds: durationSeconds,
      geometry: geometry.map { coordinate in
        NavOSSCarPlayCoordinate(
          latitude: coordinate.latitude,
          longitude: coordinate.longitude
        )
      },
      instruction: instruction,
      maneuverType: maneuverType,
      roadName: roadName,
      spokenInstruction: spokenInstruction
    )
  }
}

private struct RoutePreferencesRecord: Record {
  @Field
  var avoidFerries: Bool = false

  @Field
  var avoidHighways: Bool = false

  @Field
  var avoidTolls: Bool = false

  @Field
  var avoidUnpaved: Bool = false

  var preferences: NavOSSRoutePreferences {
    NavOSSRoutePreferences(
      avoidFerries: avoidFerries,
      avoidHighways: avoidHighways,
      avoidTolls: avoidTolls,
      avoidUnpaved: avoidUnpaved
    )
  }
}

private struct OfflineRouteRequestRecord: Record {
  @Field
  var alternatives: Int = 2

  @Field
  var destination: NavigationDestinationRecord = NavigationDestinationRecord()

  @Field
  var origin: NavigationCoordinateRecord = NavigationCoordinateRecord()

  @Field
  var originHeadingDegrees: Double?

  @Field
  var originHorizontalAccuracyMeters: Double?

  @Field
  var preferences: RoutePreferencesRecord = RoutePreferencesRecord()

  @Field
  var waypoints: [NavigationDestinationRecord] = []
}

private struct CarPlayTripRecord: Record {
  @Field
  var destination: NavigationDestinationRecord = NavigationDestinationRecord()

  @Field
  var distanceMeters: Double = 0

  @Field
  var durationSeconds: Double = 0

  @Field
  var geometry: [NavigationCoordinateRecord] = []

  @Field
  var id: String = ""

  @Field
  var preferences: RoutePreferencesRecord = RoutePreferencesRecord()

  @Field
  var source: String?

  @Field
  var speedLimitsKph: [Int]?

  @Field
  var steps: [CarPlayRouteStepRecord] = []

  @Field
  var traffic: CarPlayTrafficRecord?

  @Field
  var waypoints: [NavigationDestinationRecord] = []

  var trip: NavOSSCarPlayTrip {
    NavOSSCarPlayTrip(
      destination: destination.destination,
      distanceMeters: distanceMeters,
      durationSeconds: durationSeconds,
      geometry: geometry.map { coordinate in
        NavOSSCarPlayCoordinate(
          latitude: coordinate.latitude,
          longitude: coordinate.longitude
        )
      },
      id: id,
      preferences: preferences.preferences,
      source: source,
      speedLimitsKph: speedLimitsKph,
      steps: steps.map(\.step),
      traffic: traffic?.traffic,
      waypoints: waypoints.isEmpty ? nil : waypoints.map(\.destination)
    )
  }
}

private struct CarPlayTrafficRecord: Record {
  @Field
  var delaySeconds: Double = 0

  @Field
  var typicalDurationSeconds: Double = 0

  var traffic: NavOSSCarPlayTraffic {
    NavOSSCarPlayTraffic(
      delaySeconds: delaySeconds,
      typicalDurationSeconds: typicalDurationSeconds
    )
  }
}

private struct CarPlayGuidanceRecord: Record {
  @Field
  var distanceToManeuverMeters: Double = 0

  @Field
  var durationToManeuverSeconds: Double = 0

  @Field
  var instruction: String = ""

  @Field
  var maneuverType: String = ""

  @Field
  var phase: String = NavOSSCarPlayGuidancePhase.navigating.rawValue

  @Field
  var remainingDistanceMeters: Double = 0

  @Field
  var remainingDurationSeconds: Double = 0

  @Field
  var roadName: String = ""

  @Field
  var stepIndex: Int = 0

  var guidance: NavOSSCarPlayGuidance? {
    guard let phase = NavOSSCarPlayGuidancePhase(rawValue: phase) else {
      return nil
    }
    return NavOSSCarPlayGuidance(
      distanceToManeuverMeters: distanceToManeuverMeters,
      durationToManeuverSeconds: durationToManeuverSeconds,
      instruction: instruction,
      maneuverType: maneuverType,
      phase: phase,
      remainingDistanceMeters: remainingDistanceMeters,
      remainingDurationSeconds: remainingDurationSeconds,
      roadName: roadName,
      stepIndex: stepIndex
    )
  }
}

public final class NavOSSNavigationModule: Module {
  private var carPlayNavigationEndedObserver: NSObjectProtocol?
  private var carPlayPreferencesObserver: NSObjectProtocol?
  private var carPlayStateObserver: NSObjectProtocol?
  private var navigationPreferencesObserver: NSObjectProtocol?
  private var navigationSnapshotObserver: NSObjectProtocol?
  private var offlineStateObserver: NSObjectProtocol?
  private let service = NavOSSNavigationService.shared

  public func definition() -> ModuleDefinition {
    Name("NavOSSNavigation")

    View(NavOSSGooglePlaceRatingView.self) {
      Prop("latitude") { (view, value: Double) in
        view.setLatitude(value)
      }
      Prop("longitude") { (view, value: Double) in
        view.setLongitude(value)
      }
      Prop("name") { (view, value: String) in
        view.setName(value)
      }
      OnViewDidUpdateProps { view in
        view.updateContent()
      }
    }

    Events(
      navigationSnapshotEvent,
      navigationPreferencesEvent,
      carPlayStateEvent,
      carPlayNavigationEndedEvent,
      offlineStateEvent
    )

    OnCreate {
      self.offlineStateObserver = NotificationCenter.default.addObserver(
        forName: .navOSSOfflineStateDidChange,
        object: NavOSSOfflineStore.shared,
        queue: .main
      ) { [weak self] _ in
        self?.sendEvent(
          offlineStateEvent, NavOSSOfflinePayloads.status(NavOSSOfflineStore.shared.status()))
      }
      self.carPlayStateObserver = NotificationCenter.default.addObserver(
        forName: .navOSSCarPlayStateDidChange,
        object: NavOSSCarPlayTripStore.shared,
        queue: .main
      ) { [weak self] _ in
        self?.emitCarPlayState()
      }
      self.carPlayNavigationEndedObserver = NotificationCenter.default.addObserver(
        forName: .navOSSCarPlayNavigationDidEnd,
        object: NavOSSCarPlayTripStore.shared,
        queue: .main
      ) { [weak self] _ in
        self?.sendEvent(carPlayNavigationEndedEvent, ["reason": "carplay"])
      }
      self.carPlayPreferencesObserver = NotificationCenter.default.addObserver(
        forName: .navOSSCarPlayPreferencesDidChange,
        object: NavOSSCarPlayPreferencesStore.shared,
        queue: .main
      ) { [weak self] _ in
        self?.emitNavigationPreferences()
      }
      self.navigationPreferencesObserver = NotificationCenter.default.addObserver(
        forName: .navOSSNavigationPreferencesDidChange,
        object: NavOSSNavigationPreferencesStore.shared,
        queue: .main
      ) { [weak self] _ in
        self?.emitNavigationPreferences()
      }
      self.navigationSnapshotObserver = NotificationCenter.default.addObserver(
        forName: .navOSSNavigationSnapshotDidChange,
        object: self.service,
        queue: .main
      ) { [weak self] _ in
        guard let self else {
          return
        }
        self.sendEvent(navigationSnapshotEvent, self.serialize(self.service.currentState()))
      }
    }

    OnDestroy {
      if let offlineStateObserver = self.offlineStateObserver {
        NotificationCenter.default.removeObserver(offlineStateObserver)
        self.offlineStateObserver = nil
      }
      if let carPlayNavigationEndedObserver = self.carPlayNavigationEndedObserver {
        NotificationCenter.default.removeObserver(carPlayNavigationEndedObserver)
        self.carPlayNavigationEndedObserver = nil
      }
      if let carPlayStateObserver = self.carPlayStateObserver {
        NotificationCenter.default.removeObserver(carPlayStateObserver)
        self.carPlayStateObserver = nil
      }
      if let carPlayPreferencesObserver = self.carPlayPreferencesObserver {
        NotificationCenter.default.removeObserver(carPlayPreferencesObserver)
        self.carPlayPreferencesObserver = nil
      }
      if let navigationPreferencesObserver = self.navigationPreferencesObserver {
        NotificationCenter.default.removeObserver(navigationPreferencesObserver)
        self.navigationPreferencesObserver = nil
      }
      if let navigationSnapshotObserver = self.navigationSnapshotObserver {
        NotificationCenter.default.removeObserver(navigationSnapshotObserver)
        self.navigationSnapshotObserver = nil
      }
    }

    Function("getCapabilities") { () -> [String: Any] in
      return [
        "arrivalDetection": true,
        "backgroundLocation": self.service.backgroundLocationEnabled,
        "carPlayTripBridge": true,
        "courseMatching": true,
        "deadReckoning": true,
        "geometryGuidance": true,
        "implementation": "native-ios",
        "nativeSafetyCameraAlerts": true,
        "offRouteDetection": true,
        "replayInput": true,
        "rerouteConsent": true,
        "routeContinuity": true,
        "routeMatching": true,
        "safetyCameraAnnouncements": true,
        "speedingWarning": true,
        "version": 9,
      ]
    }

    Function("isGooglePlaceRatingAvailable") { () -> Bool in
      NavOSSGooglePlacesConfiguration.isAvailable
    }

    Function("isCarPlayVisualHarness") { () -> Bool in
      #if targetEnvironment(simulator)
        return ProcessInfo.processInfo.environment["NAVOSS_CARPLAY_VISUAL_SCENARIO"] != nil
      #else
        return false
      #endif
    }

    Function("getGooglePlacesOpenSourceLicenseInfo") { () -> String? in
      NavOSSGooglePlacesConfiguration.openSourceLicenseInfo
    }

    Function("getSnapshot") { () -> [String: Any] in
      return self.serialize(self.service.currentState())
    }

    Function("getCarPlayState") { () -> [String: Any] in
      return self.serialize(NavOSSCarPlayTripStore.shared.snapshot())
    }

    Function("getNavigationPreferences") { () -> [String: Any] in
      self.navigationPreferencesPayload()
    }

    Function("setRerouteMode") { (rawValue: String) in
      guard let mode = NavOSSRerouteMode(rawValue: rawValue) else { return }
      NavOSSNavigationPreferencesStore.shared.setRerouteMode(mode)
    }

    Function("setSpeedingWarning") { (toleranceKph: Int, audible: Bool) in
      NavOSSNavigationPreferencesStore.shared.setSpeedingWarning(
        toleranceKph: toleranceKph,
        audible: audible
      )
    }

    Function("acceptRerouteProposal") { (id: String) -> Bool in
      self.service.acceptRerouteProposal(id: id)
    }

    Function("declineRerouteProposal") { (id: String) -> Bool in
      self.service.declineRerouteProposal(id: id)
    }

    Function("getAudioMode") { () -> String in
      self.service.audioMode().rawValue
    }

    Function("getRecentDestinationIds") { () -> [String] in
      NavOSSCarPlayDestinationStore.shared.snapshot().recents.map(\.id)
    }

    Function("getRoutePreferences") { () -> [String: Bool] in
      let preferences = NavOSSCarPlayPreferencesStore.shared.load().routePreferences
      return [
        "avoidFerries": preferences.avoidFerries,
        "avoidHighways": preferences.avoidHighways,
        "avoidTolls": preferences.avoidTolls,
        "avoidUnpaved": preferences.avoidUnpaved,
      ]
    }

    Function("getDestinationCatalog") { () -> [String: Any] in
      self.serialize(NavOSSCarPlayDestinationStore.shared.snapshot())
    }

    Function("setRoute") { (trip: CarPlayTripRecord) throws -> [String: Any] in
      // An offline route planned on this device keeps its lanes, signs and bearings, which the
      // JavaScript route model does not carry.
      let planned = trip.trip
      let rich =
        planned.source == navOSSOfflineRouteSource
        ? NavOSSOfflineRouter.shared.recentTrip(matching: planned) : nil
      try self.service.startNavigation(rich ?? planned)
      return self.serialize(self.service.currentState())
    }

    Function("setRoutePreferences") { (record: RoutePreferencesRecord) in
      NavOSSCarPlayPreferencesStore.shared.setRoutePreferences(record.preferences)
    }

    Function("clearRoute") { () -> [String: Any] in
      self.service.clearNavigation()
      return self.serialize(self.service.currentState())
    }

    Function("updateLocation") {
      (location: NavigationLocationRecord) throws -> [String: Any] in
      _ = try self.service.ingest(location.sample)
      return self.serialize(self.service.currentState())
    }

    Function("recordRecentDestination") { (destination: NavigationDestinationRecord) in
      NavOSSCarPlayDestinationStore.shared.recordRecent(destination.destination)
    }

    Function("clearRecentDestinations") { () in
      NavOSSCarPlayDestinationStore.shared.clearRecents()
    }

    Function("clearDestinationHistory") { () in
      NavOSSCarPlayDestinationStore.shared.clearDestinations()
    }

    Function("isFavoriteDestination") { (id: String) -> Bool in
      NavOSSCarPlayDestinationStore.shared.isFavorite(id: id)
    }

    Function("toggleFavoriteDestination") { (destination: NavigationDestinationRecord) -> Bool in
      NavOSSCarPlayDestinationStore.shared.toggleFavorite(destination.destination)
    }

    Function("setHomeDestination") { (destination: NavigationDestinationRecord?) in
      NavOSSCarPlayDestinationStore.shared.setHome(destination?.destination)
    }

    Function("setWorkDestination") { (destination: NavigationDestinationRecord?) in
      NavOSSCarPlayDestinationStore.shared.setWork(destination?.destination)
    }

    Function("setAudioMode") { (rawValue: String) in
      guard let mode = NavOSSCarPlayAudioMode(rawValue: rawValue) else { return }
      NavOSSCarPlayPreferencesStore.shared.setAudioMode(mode)
      self.service.setAudioMode(mode)
    }

    Function("replaceFavoriteDestinations") { (destinations: [NavigationDestinationRecord]) in
      NavOSSCarPlayDestinationStore.shared.replaceFavorites(destinations.map(\.destination))
    }

    Function("clearCarPlayTrip") { () in
      self.service.clearNavigation()
    }

    Function("stopAnnouncements") { () in
      self.service.stopAnnouncements()
    }

    // MARK: Offline maps

    Function("getOfflineState") { () -> [String: Any] in
      NavOSSOfflinePayloads.status(NavOSSOfflineStore.shared.status())
    }

    AsyncFunction("refreshOfflineManifest") { () async -> [String: Any] in
      await NavOSSOfflineStore.shared.refreshManifest()
      return NavOSSOfflinePayloads.status(NavOSSOfflineStore.shared.status())
    }

    Function("downloadOfflineRegion") { (regionId: String) in
      NavOSSOfflineStore.shared.download(regionId: regionId)
    }

    Function("pauseOfflineRegion") { (regionId: String) in
      NavOSSOfflineStore.shared.pause(regionId: regionId)
    }

    Function("deleteOfflineRegion") { (regionId: String) -> String in
      NavOSSOfflineStore.shared.delete(regionId: regionId).rawValue
    }

    Function("setPreferOfflineMaps") { (prefer: Bool) in
      NavOSSOfflineStore.shared.preferOffline = prefer
    }

    /// The bound offline style JSON for a hosted style slug, rendering the installed region that
    /// covers the given point. `use` says whether the map should show it now (no network, or
    /// prefer-offline inside coverage); a caller may still use it after a hosted style fails.
    Function("getOfflineMapStyle") {
      (slug: String, latitude: Double?, longitude: Double?) -> [String: Any]? in
      let near = latitude.flatMap { latitude in
        longitude.map { NavOSSCarPlayCoordinate(latitude: latitude, longitude: $0) }
      }
      let store = NavOSSOfflineStore.shared
      guard let file = store.offlineStyleFile(slug: slug, near: near),
        let json = try? String(contentsOf: file, encoding: .utf8)
      else {
        return nil
      }
      return ["style": json, "use": store.shouldUseOfflineMap(near: near)]
    }

    AsyncFunction("planOfflineRoutes") { (request: OfflineRouteRequestRecord) async -> [String: Any] in
      do {
        let trips = try await NavOSSOfflineRouter.shared.routes(
          origin: NavOSSCarPlayCoordinate(
            latitude: request.origin.latitude, longitude: request.origin.longitude),
          originHeadingDegrees: request.originHeadingDegrees,
          originHorizontalAccuracyMeters: request.originHorizontalAccuracyMeters,
          destination: request.destination.destination,
          preferences: request.preferences.preferences,
          alternatives: request.alternatives,
          waypoints: request.waypoints.map(\.destination)
        )
        return ["ok": true, "trips": trips.map { self.serialize($0) }]
      } catch {
        return ["ok": false, "code": NavOSSOfflinePayloads.errorCode(error)]
      }
    }

    AsyncFunction("searchOffline") {
      (query: String, latitude: Double?, longitude: Double?, limit: Int, category: String?) async
        -> [String: Any] in
      let proximity = latitude.flatMap { latitude in
        longitude.map { NavOSSCarPlayCoordinate(latitude: latitude, longitude: $0) }
      }
      do {
        let places = try await NavOSSOfflineRouter.shared.search(
          query: query, proximity: proximity, limit: max(1, min(20, limit)), category: category)
        let snapshot = NavOSSOfflineStore.shared.installedSnapshot
        return [
          "ok": true,
          "results": places.map(NavOSSOfflinePayloads.place),
          "bundleVersion": snapshot.regions.first?.bundleVersion ?? "",
          "osmTimestamp": snapshot.regions.first?.osmTimestamp ?? "",
        ]
      } catch {
        return ["ok": false, "code": NavOSSOfflinePayloads.errorCode(error)]
      }
    }
  }

  private func emitNavigationPreferences() {
    sendEvent(navigationPreferencesEvent, navigationPreferencesPayload())
  }

  private func navigationPreferencesPayload() -> [String: Any] {
    var payload = serialize(NavOSSCarPlayPreferencesStore.shared.load())
    let navigation = NavOSSNavigationPreferencesStore.shared.load()
    payload["rerouteMode"] = navigation.rerouteMode.rawValue
    payload["speedingAudibleWarning"] = navigation.speedingAudibleWarning
    payload["speedingToleranceKph"] = navigation.speedingToleranceKph
    return payload
  }

  private func emitCarPlayState() {
    sendEvent(carPlayStateEvent, serialize(NavOSSCarPlayTripStore.shared.snapshot()))
  }

  private func serialize(_ catalog: NavOSSCarPlayDestinationCatalog) -> [String: Any] {
    func destination(_ value: NavOSSCarPlayDestination) -> [String: Any] {
      var payload: [String: Any] = [
        "id": value.id,
        "label": value.label,
        "latitude": value.latitude,
        "longitude": value.longitude,
        "name": value.name,
      ]
      if let category = value.category {
        payload["category"] = category
      }
      return payload
    }

    var payload: [String: Any] = [
      "favorites": catalog.favorites.map(destination),
      "recents": catalog.recents.map(destination),
    ]
    if let home = catalog.home {
      payload["home"] = destination(home)
    }
    if let work = catalog.work {
      payload["work"] = destination(work)
    }
    return payload
  }

  private func serialize(_ state: NavOSSCarPlayState) -> [String: Any] {
    var payload: [String: Any] = [
      "connected": state.connected,
      "hasActiveTrip": state.trip != nil,
    ]
    if let guidance = state.guidance {
      payload["guidance"] = serialize(guidance)
    }
    return payload
  }

  private func serialize(_ preferences: NavOSSCarPlayPreferences) -> [String: Any] {
    [
      "audioMode": preferences.audioMode.rawValue,
      "routePreferences": [
        "avoidFerries": preferences.routePreferences.avoidFerries,
        "avoidHighways": preferences.routePreferences.avoidHighways,
        "avoidTolls": preferences.routePreferences.avoidTolls,
        "avoidUnpaved": preferences.routePreferences.avoidUnpaved,
      ],
    ]
  }

  private func serialize(_ state: NavOSSNavigationServiceState) -> [String: Any] {
    let snapshot = state.navigation
    var payload: [String: Any] = [
      "isOffRoute": snapshot.isOffRoute,
      "phase": snapshot.phase.rawValue,
      "rerouteCount": state.rerouteCount,
      "routeProgress": snapshot.routeProgress,
      "routeStatus": state.routeStatus.rawValue,
      "routeVersion": snapshot.routeVersion,
      "sequence": snapshot.sequence,
      "stateVersion": state.stateVersion,
      "isDeadReckoning": snapshot.isDeadReckoning,
      "rerouteMode": state.rerouteMode.rawValue,
      "speedingState": state.speedingState.rawValue,
    ]

    if let speedMetersPerSecond = snapshot.speedMetersPerSecond {
      payload["speedMetersPerSecond"] = speedMetersPerSecond
    }
    if let speedLimitKph = state.roadContext.speedLimitKph {
      payload["speedLimitKph"] = speedLimitKph
    }
    if let currentRoadName = state.roadContext.currentRoadName {
      payload["currentRoadName"] = currentRoadName
    }
    if let proposal = state.rerouteProposal {
      payload["rerouteProposal"] = [
        "createdAtMs": Date(timeIntervalSinceReferenceDate: proposal.createdAt)
          .timeIntervalSince1970 * 1_000,
        "distanceDeltaMeters": proposal.distanceDeltaMeters,
        "distanceMeters": proposal.trip.distanceMeters,
        "durationDeltaSeconds": proposal.durationDeltaSeconds,
        "durationSeconds": proposal.trip.durationSeconds,
        "id": proposal.id,
        "respondWithinSeconds": NavigationRerouteConsent.askFirstResponseSeconds,
        "trip": serialize(proposal.trip),
      ] as [String: Any]
    }
    if let alert = state.safetyCameraAlert {
      payload["safetyCameraAlert"] = [
        "cameraId": alert.cameraId,
        "distanceAheadMeters": alert.distanceAheadMeters,
        "location": alert.location,
        "sequence": alert.sequence,
      ] as [String: Any]
    }

    if let rawCoordinate = snapshot.rawCoordinate {
      payload["rawCoordinate"] = serialize(rawCoordinate)
    }
    if let matchedCoordinate = snapshot.matchedCoordinate {
      payload["matchedCoordinate"] = serialize(matchedCoordinate)
    }
    if let matchedCourseDegrees = snapshot.matchedCourseDegrees {
      payload["matchedCourseDegrees"] = matchedCourseDegrees
    }
    if let distanceFromRouteMeters = snapshot.distanceFromRouteMeters {
      payload["distanceFromRouteMeters"] = distanceFromRouteMeters
    }
    if let horizontalAccuracyMeters = snapshot.horizontalAccuracyMeters {
      payload["horizontalAccuracyMeters"] = horizontalAccuracyMeters
    }
    if snapshot.phase != .idle, let guidance = state.guidance {
      payload["guidance"] = serialize(guidance)
    }
    if snapshot.phase != .idle, let trip = state.trip {
      payload["trip"] = serialize(trip)
    }

    return payload
  }

  private func serialize(_ guidance: NavOSSCarPlayGuidance) -> [String: Any] {
    [
      "distanceToManeuverMeters": guidance.distanceToManeuverMeters,
      "durationToManeuverSeconds": guidance.durationToManeuverSeconds,
      "instruction": guidance.instruction,
      "maneuverType": guidance.maneuverType,
      "phase": guidance.phase.rawValue,
      "remainingDistanceMeters": guidance.remainingDistanceMeters,
      "remainingDurationSeconds": guidance.remainingDurationSeconds,
      "roadName": guidance.roadName,
      "stepIndex": guidance.stepIndex,
    ]
  }

  private func serialize(_ trip: NavOSSCarPlayTrip) -> [String: Any] {
    var payload: [String: Any] = [
      "destination": [
        "id": trip.destination.id,
        "label": trip.destination.label,
        "latitude": trip.destination.latitude,
        "longitude": trip.destination.longitude,
        "name": trip.destination.name,
      ],
      "distanceMeters": trip.distanceMeters,
      "durationSeconds": trip.durationSeconds,
      "geometry": trip.geometry.map { serialize($0) },
      "id": trip.id,
      "preferences": [
        "avoidFerries": trip.preferences.avoidFerries,
        "avoidHighways": trip.preferences.avoidHighways,
        "avoidTolls": trip.preferences.avoidTolls,
        "avoidUnpaved": trip.preferences.avoidUnpaved,
      ],
      "steps": trip.steps.map { step in
        var payload: [String: Any] = [
          "distanceMeters": step.distanceMeters,
          "durationSeconds": step.durationSeconds,
          "geometry": step.geometry.map { serialize($0) },
          "instruction": step.instruction,
          "maneuverType": step.maneuverType,
          "roadName": step.roadName,
        ]
        if let spokenInstruction = step.spokenInstruction {
          payload["spokenInstruction"] = spokenInstruction
        }
        return payload
      },
    ]
    if let source = trip.source {
      payload["source"] = source
    }
    if let speedLimitsKph = trip.speedLimitsKph {
      payload["speedLimitsKph"] = speedLimitsKph
    }
    if let traffic = trip.traffic {
      payload["traffic"] = [
        "delaySeconds": traffic.delaySeconds,
        "typicalDurationSeconds": traffic.typicalDurationSeconds,
      ]
    }
    if let waypoints = trip.waypoints {
      payload["waypoints"] = waypoints.map { waypoint in
        var destination: [String: Any] = [
          "id": waypoint.id,
          "label": waypoint.label,
          "latitude": waypoint.latitude,
          "longitude": waypoint.longitude,
          "name": waypoint.name,
        ]
        if let category = waypoint.category {
          destination["category"] = category
        }
        return destination
      }
    }
    return payload
  }

  private func serialize(_ coordinate: NavigationCoordinate) -> [String: Double] {
    return [
      "latitude": coordinate.latitude,
      "longitude": coordinate.longitude,
    ]
  }

  private func serialize(_ coordinate: NavOSSCarPlayCoordinate) -> [String: Double] {
    [
      "latitude": coordinate.latitude,
      "longitude": coordinate.longitude,
    ]
  }
}
