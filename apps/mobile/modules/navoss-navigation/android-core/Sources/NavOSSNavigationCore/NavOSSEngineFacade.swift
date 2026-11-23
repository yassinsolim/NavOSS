import Foundation

/// Spike facade: the navigation core behind a JSON-string boundary, for a JNI caller.
///
/// It composes the same Core types the iOS service drives (`NavigationSession`, the speech
/// planner, the speeding monitor) for route, location and clear, and reports state and
/// maneuver prompts. It deliberately leaves out what the iOS service also does (reroute
/// requests, the one-second clock, cameras, persistence); see RESULTS.md for the seam.
///
/// Times come from the fix, not the wall clock, so a replay is deterministic.
public final class NavOSSEngineFacade {
  public typealias EventSink = (_ kind: String, _ json: String) -> Void

  private let session = NavigationSession()
  private let speechPlanner = NavigationSpeechPlanner()
  private var speedingMonitor = NavigationSpeedingMonitor()
  private var preferences = NavOSSNavigationPreferences()
  private let lock = NSLock()
  public var onEvent: EventSink?

  public init() {}

  /// `{"destination": {...}, "routeIndex": n, "response": <recorded /v2/routes response>}`.
  public func setRoute(fromRoutesV2Request json: String) throws -> String {
    guard
      let document = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
      let response = document["response"], let destination = document["destination"],
      let routeIndex = document["routeIndex"] as? Int
    else {
      throw NavigationCoreError.invalidRoute
    }
    let place = try decoder.decode(
      Destination.self, from: JSONSerialization.data(withJSONObject: destination))
    let trips = try navOSSTripsFromRoutesV2Response(
      try JSONSerialization.data(withJSONObject: response),
      destination: NavOSSCarPlayDestination(
        id: place.id, label: place.label, latitude: place.latitude, longitude: place.longitude,
        name: place.name)
    )
    guard trips.indices.contains(routeIndex) else {
      throw NavigationCoreError.invalidRoute
    }
    return try withLock {
      let update = try session.start(trips[routeIndex])
      speedingMonitor.reset()
      return try encode(update)
    }
  }

  /// `{"latitude", "longitude", "timestampMs", "courseDegrees"?, "horizontalAccuracyMeters"?,
  /// "speedMetersPerSecond"?}`. Untimed fixes are refused, as on iOS.
  public func updateLocation(_ json: String) throws -> String {
    let fix = try decoder.decode(LocationRecord.self, from: Data(json.utf8))
    let sample = try navOSSLiveNavigationFix(fix.sample)
    var prompts: [String] = []
    let state: String = try withLock {
      let update = try session.updateLocation(sample)
      let now = sample.timestamp ?? 0
      if speedingMonitor.update(
        speedMetersPerSecond: update.snapshot.speedMetersPerSecond,
        speedLimitKph: update.roadContext.speedLimitKph,
        preferences: preferences,
        now: now
      ), let limit = update.roadContext.speedLimitKph {
        prompts.append(navigationSpeedingWarningText(speedLimitKph: limit))
      }
      if let prompt = speechPlanner.prompt(for: update, now: now) {
        prompts.append(prompt.text)
      }
      return try encode(update)
    }
    for text in prompts {
      onEvent?("speech", try encodeString(SpeechEvent(text: text)))
    }
    onEvent?("state", state)
    return state
  }

  public func clearRoute() throws -> String {
    try withLock {
      speedingMonitor.reset()
      return try encode(session.clear())
    }
  }

  public func snapshot() throws -> String {
    try withLock { try encode(session.currentUpdate()) }
  }

  public func setSpeedingWarning(toleranceKph: Int, audible: Bool) {
    withLock {
      preferences = NavOSSNavigationPreferences(
        rerouteMode: preferences.rerouteMode,
        speedingToleranceKph: toleranceKph,
        speedingAudibleWarning: audible
      )
    }
  }

  private func withLock<T>(_ body: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try body()
  }

  private let decoder = JSONDecoder()

  private func encode(_ update: NavigationSessionUpdate) throws -> String {
    try encodeString(StatePayload(update, speedingState: speedingMonitor.state))
  }

  private func encodeString<T: Encodable>(_ value: T) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return String(decoding: try encoder.encode(value), as: UTF8.self)
  }
}

private struct SpeechEvent: Encodable {
  let text: String
}

private struct Destination: Decodable {
  let id: String
  let label: String
  let latitude: Double
  let longitude: Double
  let name: String
}

private struct LocationRecord: Decodable {
  let latitude: Double
  let longitude: Double
  let courseDegrees: Double?
  let horizontalAccuracyMeters: Double?
  let speedMetersPerSecond: Double?
  /// Milliseconds since the Unix epoch, as JavaScript and Android report it.
  let timestampMs: Double?

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

/// The navigation part of the iOS module's state payload, under the same keys.
private struct StatePayload: Encodable {
  struct Coordinate: Encodable {
    let latitude: Double
    let longitude: Double
  }

  struct Guidance: Encodable {
    let distanceToManeuverMeters: Double
    let durationToManeuverSeconds: Double
    let instruction: String
    let maneuverType: String
    let phase: String
    let remainingDistanceMeters: Double
    let remainingDurationSeconds: Double
    let roadName: String
    let stepIndex: Int
  }

  let currentRoadName: String?
  let distanceFromRouteMeters: Double?
  let guidance: Guidance?
  let horizontalAccuracyMeters: Double?
  let isDeadReckoning: Bool
  let isOffRoute: Bool
  let matchedCoordinate: Coordinate?
  let matchedCourseDegrees: Double?
  let phase: String
  let rawCoordinate: Coordinate?
  let routeProgress: Double
  let routeVersion: Int
  let sequence: Int
  let speedLimitKph: Int?
  let speedMetersPerSecond: Double?
  let speedingState: String
  let tripId: String?

  init(_ update: NavigationSessionUpdate, speedingState: NavOSSSpeedingState) {
    let snapshot = update.snapshot
    currentRoadName = update.roadContext.currentRoadName
    distanceFromRouteMeters = snapshot.distanceFromRouteMeters
    guidance = snapshot.phase == .idle ? nil : update.guidance.map {
      Guidance(
        distanceToManeuverMeters: $0.distanceToManeuverMeters,
        durationToManeuverSeconds: $0.durationToManeuverSeconds,
        instruction: $0.instruction,
        maneuverType: $0.maneuverType,
        phase: $0.phase.rawValue,
        remainingDistanceMeters: $0.remainingDistanceMeters,
        remainingDurationSeconds: $0.remainingDurationSeconds,
        roadName: $0.roadName,
        stepIndex: $0.stepIndex
      )
    }
    horizontalAccuracyMeters = snapshot.horizontalAccuracyMeters
    isDeadReckoning = snapshot.isDeadReckoning
    isOffRoute = snapshot.isOffRoute
    matchedCoordinate = snapshot.matchedCoordinate.map {
      Coordinate(latitude: $0.latitude, longitude: $0.longitude)
    }
    matchedCourseDegrees = snapshot.matchedCourseDegrees
    phase = snapshot.phase.rawValue
    rawCoordinate = snapshot.rawCoordinate.map {
      Coordinate(latitude: $0.latitude, longitude: $0.longitude)
    }
    routeProgress = snapshot.routeProgress
    routeVersion = snapshot.routeVersion
    sequence = snapshot.sequence
    speedLimitKph = update.roadContext.speedLimitKph
    speedMetersPerSecond = snapshot.speedMetersPerSecond
    self.speedingState = speedingState.rawValue
    tripId = update.trip?.id
  }
}
