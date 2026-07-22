import AVFoundation
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
      roadName: roadName
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
  private let core = NavigationCore()
  private let speechSynthesizer = AVSpeechSynthesizer()

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
    }

    Function("getCapabilities") { () -> [String: Any] in
      return [
        "arrivalDetection": true,
        "backgroundLocation": false,
        "carPlayTripBridge": true,
        "courseMatching": true,
        "implementation": "native-ios",
        "offRouteDetection": true,
        "replayInput": true,
        "routeContinuity": true,
        "routeMatching": true,
        "safetyCameraAnnouncements": true,
        "version": 7
      ]
    }

    Function("getSnapshot") { () -> [String: Any] in
      return self.serialize(self.core.currentSnapshot())
    }

    Function("getCarPlayState") { () -> [String: Any] in
      return self.serialize(NavOSSCarPlayTripStore.shared.snapshot())
    }

    Function("setRoute") { (geometry: [NavigationCoordinateRecord]) throws -> [String: Any] in
      let snapshot = try self.core.setRoute(geometry.map(\.coordinate))
      return self.emit(snapshot)
    }

    Function("clearRoute") { () -> [String: Any] in
      return self.emit(self.core.clearRoute())
    }

    Function("updateLocation") {
      (location: NavigationLocationRecord) throws -> [String: Any] in
      let snapshot = try self.core.updateLocation(location.sample)
      return self.emit(snapshot)
    }

    Function("recordRecentDestination") { (destination: NavigationDestinationRecord) in
      NavOSSCarPlayDestinationStore.shared.recordRecent(destination.destination)
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

    Function("publishCarPlayTrip") { (trip: CarPlayTripRecord) in
      NavOSSCarPlayTripStore.shared.publishTrip(trip.trip)
    }

    Function("publishCarPlayGuidance") { (guidance: CarPlayGuidanceRecord) in
      guard let guidance = guidance.guidance else {
        return
      }
      NavOSSCarPlayTripStore.shared.publishGuidance(guidance)
    }

    Function("clearCarPlayTrip") { () in
      NavOSSCarPlayTripStore.shared.clearTrip()
    }

    Function("announceSafetyCamera") { () in
      DispatchQueue.main.async {
        guard !self.speechSynthesizer.isSpeaking else {
          return
        }

        let utterance = AVSpeechUtterance(string: "Red light and speed camera ahead.")
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.9
        utterance.voice = AVSpeechSynthesisVoice(language: "en-CA")
        self.speechSynthesizer.speak(utterance)
      }
    }

    Function("stopAnnouncements") { () in
      DispatchQueue.main.async {
        self.speechSynthesizer.stopSpeaking(at: .immediate)
      }
    }
  }

  private func emit(_ snapshot: NavigationSnapshot) -> [String: Any] {
    let payload = serialize(snapshot)
    sendEvent(navigationSnapshotEvent, payload)
    return payload
  }

  private func emitCarPlayState() {
    sendEvent(carPlayStateEvent, serialize(NavOSSCarPlayTripStore.shared.snapshot()))
  }

  private func serialize(_ state: NavOSSCarPlayState) -> [String: Any] {
    var payload: [String: Any] = [
      "connected": state.connected,
      "hasActiveTrip": state.trip != nil
    ]
    if let guidance = state.guidance {
      payload["guidance"] = [
        "distanceToManeuverMeters": guidance.distanceToManeuverMeters,
        "durationToManeuverSeconds": guidance.durationToManeuverSeconds,
        "instruction": guidance.instruction,
        "maneuverType": guidance.maneuverType,
        "phase": guidance.phase.rawValue,
        "remainingDistanceMeters": guidance.remainingDistanceMeters,
        "remainingDurationSeconds": guidance.remainingDurationSeconds,
        "roadName": guidance.roadName,
        "stepIndex": guidance.stepIndex
      ]
    }
    return payload
  }

  private func serialize(_ snapshot: NavigationSnapshot) -> [String: Any] {
    var payload: [String: Any] = [
      "isOffRoute": snapshot.isOffRoute,
      "phase": snapshot.phase.rawValue,
      "routeProgress": snapshot.routeProgress,
      "routeVersion": snapshot.routeVersion,
      "sequence": snapshot.sequence
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

    return payload
  }

  private func serialize(_ coordinate: NavigationCoordinate) -> [String: Double] {
    return [
      "latitude": coordinate.latitude,
      "longitude": coordinate.longitude
    ]
  }
}