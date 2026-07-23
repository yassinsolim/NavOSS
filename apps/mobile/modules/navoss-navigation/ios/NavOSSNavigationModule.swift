import ExpoModulesCore

private let navigationSnapshotEvent = "onNavigationSnapshot"
private let carPlayStateEvent = "onCarPlayStateChanged"
private let carPlayNavigationEndedEvent = "onCarPlayNavigationEnded"

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

  var sample: NavigationLocationSample {
    NavigationLocationSample(
      coordinate: NavigationCoordinate(latitude: latitude, longitude: longitude),
      courseDegrees: courseDegrees,
      horizontalAccuracyMeters: horizontalAccuracyMeters
    )
  }
}

private struct NavigationDestinationRecord: Record {
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
  var steps: [CarPlayRouteStepRecord] = []

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
      steps: steps.map(\.step)
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
  private var carPlayStateObserver: NSObjectProtocol?
  private var navigationSnapshotObserver: NSObjectProtocol?
  private let service = NavOSSNavigationService.shared

  public func definition() -> ModuleDefinition {
    Name("NavOSSNavigation")

    Events(navigationSnapshotEvent, carPlayStateEvent, carPlayNavigationEndedEvent)

    OnCreate {
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
      if let carPlayNavigationEndedObserver = self.carPlayNavigationEndedObserver {
        NotificationCenter.default.removeObserver(carPlayNavigationEndedObserver)
        self.carPlayNavigationEndedObserver = nil
      }
      if let carPlayStateObserver = self.carPlayStateObserver {
        NotificationCenter.default.removeObserver(carPlayStateObserver)
        self.carPlayStateObserver = nil
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
        "implementation": "native-ios",
        "offRouteDetection": true,
        "replayInput": true,
        "routeContinuity": true,
        "routeMatching": true,
        "safetyCameraAnnouncements": true,
        "version": 8,
      ]
    }

    Function("getSnapshot") { () -> [String: Any] in
      return self.serialize(self.service.currentState())
    }

    Function("getCarPlayState") { () -> [String: Any] in
      return self.serialize(NavOSSCarPlayTripStore.shared.snapshot())
    }

    Function("setRoute") { (trip: CarPlayTripRecord) throws -> [String: Any] in
      try self.service.startNavigation(trip.trip)
      return self.serialize(self.service.currentState())
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

    Function("setHomeDestination") { (destination: NavigationDestinationRecord?) in
      NavOSSCarPlayDestinationStore.shared.setHome(destination?.destination)
    }

    Function("setWorkDestination") { (destination: NavigationDestinationRecord?) in
      NavOSSCarPlayDestinationStore.shared.setWork(destination?.destination)
    }

    Function("replaceFavoriteDestinations") { (destinations: [NavigationDestinationRecord]) in
      NavOSSCarPlayDestinationStore.shared.replaceFavorites(destinations.map(\.destination))
    }

    Function("clearCarPlayTrip") { () in
      self.service.clearNavigation()
    }

    Function("announceSafetyCamera") { () in
      self.service.announceSafetyCamera()
    }

    Function("stopAnnouncements") { () in
      self.service.stopAnnouncements()
    }
  }

  private func emitCarPlayState() {
    sendEvent(carPlayStateEvent, serialize(NavOSSCarPlayTripStore.shared.snapshot()))
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
    ]

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
    [
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
