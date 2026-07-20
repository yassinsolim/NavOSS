import AVFoundation
import ExpoModulesCore

private let navigationSnapshotEvent = "onNavigationSnapshot"

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

public final class NavOSSNavigationModule: Module {
  private let core = NavigationCore()
  private let speechSynthesizer = AVSpeechSynthesizer()

  public func definition() -> ModuleDefinition {
    Name("NavOSSNavigation")

    Events(navigationSnapshotEvent)

    Function("getCapabilities") { () -> [String: Any] in
      return [
        "arrivalDetection": true,
        "backgroundLocation": false,
        "courseMatching": true,
        "implementation": "native-ios",
        "offRouteDetection": true,
        "replayInput": true,
        "routeContinuity": true,
        "routeMatching": true,
        "safetyCameraAnnouncements": true,
        "version": 6
      ]
    }

    Function("getSnapshot") { () -> [String: Any] in
      return self.serialize(self.core.currentSnapshot())
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