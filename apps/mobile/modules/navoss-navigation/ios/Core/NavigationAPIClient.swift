import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

public enum NavOSSNavigationAPIError: Error {
  case invalidConfiguration
  case invalidRequest
  case invalidResponse
  case serviceUnavailable
}

private struct SearchRequest: Encodable {
  let category: String?
  let includeDetails = false
  let latitude: Double?
  let limit: Int
  let longitude: Double?
  let q: String
  let sort: String?
}

private struct SearchResponse: Decodable {
  let results: [SearchResult]
}

private struct SearchResult: Decodable {
  let category: String
  let center: NavOSSCarPlayCoordinate
  let id: String
  let label: String
  let name: String
}

private struct RouteRequest: Encodable {
  let alternatives: Int
  let destination: NavOSSCarPlayCoordinate
  let origin: NavOSSCarPlayCoordinate
  let originHeadingDegrees: Double?
  let originHorizontalAccuracyMeters: Double?
  let preferences: NavOSSRoutePreferences
  let waypoints: [NavOSSCarPlayCoordinate]?
}

public struct NavOSSNavigationRouteOrigin: Sendable {
  public let coordinate: NavOSSCarPlayCoordinate
  public let headingDegrees: Double?
  public let horizontalAccuracyMeters: Double?

  public init(
    coordinate: NavOSSCarPlayCoordinate,
    headingDegrees: Double? = nil,
    horizontalAccuracyMeters: Double? = nil
  ) {
    self.coordinate = coordinate
    self.headingDegrees = headingDegrees
    self.horizontalAccuracyMeters = horizontalAccuracyMeters
  }
}

public func navOSSNavigationRouteOrigin(
  coordinate: NavOSSCarPlayCoordinate,
  courseDegrees: Double?,
  speedMetersPerSecond: Double?,
  horizontalAccuracyMeters: Double,
  ageSeconds: TimeInterval
) -> NavOSSNavigationRouteOrigin? {
  guard horizontalAccuracyMeters.isFinite,
    (0...100).contains(horizontalAccuracyMeters),
    ageSeconds >= -5,
    ageSeconds <= 15
  else {
    return nil
  }
  let headingDegrees: Double? =
    if let courseDegrees, let speedMetersPerSecond,
      courseDegrees.isFinite, (0..<360).contains(courseDegrees),
      speedMetersPerSecond.isFinite, speedMetersPerSecond >= 2
    {
      courseDegrees
    } else {
      nil
    }
  return NavOSSNavigationRouteOrigin(
    coordinate: coordinate,
    headingDegrees: headingDegrees,
    horizontalAccuracyMeters: horizontalAccuracyMeters
  )
}

public func navOSSShouldAcceptNavigationLocation(
  candidateTimestamp: TimeInterval,
  latestTimestamp: TimeInterval?,
  nowTimestamp: TimeInterval
) -> Bool {
  let ageSeconds = nowTimestamp - candidateTimestamp
  return ageSeconds >= -5 && ageSeconds <= 15
    && latestTimestamp.map { $0 <= candidateTimestamp } ?? true
}

private struct RouteResponse: Decodable {
  let routes: [Route]
  let source: RouteSource
}

private struct RouteSource: Decodable {
  let id: String
}

private struct Route: Decodable {
  let distanceMeters: Double
  let durationSeconds: Double
  let geometry: [[Double]]
  let id: String
  let speedLimitsKph: [Int]?
  let steps: [RouteStep]
  let traffic: RouteTraffic?
}

private struct RouteTraffic: Decodable {
  let delaySeconds: Double
  let typicalDurationSeconds: Double
}

private struct SafetyCameraResponse: Decodable {
  let cameras: [SafetyCameraRecord]
}

private struct SafetyCameraRecord: Decodable {
  let coordinate: NavOSSCarPlayCoordinate
  let direction: String
  let id: String
  let location: String
}

private struct RouteStep: Decodable {
  let distanceMeters: Double
  let durationSeconds: Double
  let geometry: [[Double]]
  let instruction: String
  let maneuverType: String
  let roadName: String
  let spokenInstruction: String?
}

/// Answers routes and search from installed offline regions when the NavOSS service cannot be
/// reached. The app installs one at launch; without it the client is online-only.
public protocol NavOSSOfflineNavigationFallback: AnyObject, Sendable {
  var isNetworkAvailable: Bool { get }
  var hasInstalledRegions: Bool { get }
  func covers(_ points: [NavOSSCarPlayCoordinate]) -> Bool
  func offlineRoutes(
    origin: NavOSSCarPlayCoordinate,
    originHeadingDegrees: Double?,
    originHorizontalAccuracyMeters: Double?,
    destination: NavOSSCarPlayDestination,
    preferences: NavOSSRoutePreferences,
    alternatives: Int,
    waypoints: [NavOSSCarPlayDestination]
  ) async throws -> [NavOSSCarPlayTrip]
  func offlineSearch(
    query: String,
    proximity: NavOSSCarPlayCoordinate?,
    limit: Int,
    category: String?
  ) async throws -> [NavOSSCarPlayDestination]
}

public final class NavOSSNavigationAPIClient: @unchecked Sendable {
  /// Installed by the app at launch; every client created afterwards falls back to it.
  nonisolated(unsafe) public static var offlineFallback: NavOSSOfflineNavigationFallback?

  /// Online requests that offline data could answer give up sooner, so a dead connection
  /// does not hold a reroute for the full timeout.
  static let timeoutWithOfflineFallback: TimeInterval = 8

  private let baseURL: URL
  private let decoder = JSONDecoder()
  private let encoder = JSONEncoder()
  private let offlineFallback: NavOSSOfflineNavigationFallback?
  private let session: URLSession

  public init(
    baseURL: URL? = nil,
    session: URLSession = .shared,
    offlineFallback: NavOSSOfflineNavigationFallback? = NavOSSNavigationAPIClient.offlineFallback
  ) throws {
    guard let resolvedBaseURL = baseURL ?? Self.configuredBaseURL() else {
      throw NavOSSNavigationAPIError.invalidConfiguration
    }
    self.baseURL = resolvedBaseURL
    self.offlineFallback = offlineFallback
    self.session = session
  }

  /// Whether an online failure should be answered from offline data: the service or the
  /// network was unreachable. A rejected request (400) is not retried offline.
  static func isUnreachable(_ error: Error) -> Bool {
    if error is URLError { return true }
    if case NavOSSNavigationAPIError.serviceUnavailable = error { return true }
    return false
  }

  public func search(
    query: String,
    proximity: NavOSSCarPlayCoordinate?,
    limit: Int = 8,
    category: String? = nil
  ) async throws -> [NavOSSCarPlayDestination] {
    guard let offlineFallback, offlineFallback.hasInstalledRegions else {
      return try await onlineSearch(
        query: query, proximity: proximity, limit: limit, category: category, timeout: 20)
    }
    func offline() async throws -> [NavOSSCarPlayDestination] {
      // Labelled so a driver never mistakes downloaded OpenStreetMap data for live search.
      try await offlineFallback.offlineSearch(
        query: query, proximity: proximity, limit: limit, category: category
      ).map {
        NavOSSCarPlayDestination(
          category: $0.category, id: $0.id, label: "Offline result · \($0.label)",
          latitude: $0.latitude, longitude: $0.longitude, name: $0.name)
      }
    }
    if !offlineFallback.isNetworkAvailable { return try await offline() }
    do {
      return try await onlineSearch(
        query: query, proximity: proximity, limit: limit, category: category,
        timeout: Self.timeoutWithOfflineFallback)
    } catch where Self.isUnreachable(error) {
      return try await offline()
    }
  }

  private func onlineSearch(
    query: String,
    proximity: NavOSSCarPlayCoordinate?,
    limit: Int,
    category: String?,
    timeout: TimeInterval
  ) async throws -> [NavOSSCarPlayDestination] {
    let roundedProximity = proximity.map {
      NavOSSCarPlayCoordinate(
        latitude: ($0.latitude * 1_000).rounded() / 1_000,
        longitude: ($0.longitude * 1_000).rounded() / 1_000
      )
    }
    let request = SearchRequest(
      category: category,
      latitude: roundedProximity?.latitude,
      limit: limit,
      longitude: roundedProximity?.longitude,
      q: query,
      sort: roundedProximity == nil ? nil : "distance"
    )
    let response: SearchResponse = try await post(
      path: "v1/search", body: request, timeout: timeout)
    return response.results.map {
      NavOSSCarPlayDestination(
        category: $0.category,
        id: $0.id,
        label: $0.label,
        latitude: $0.center.latitude,
        longitude: $0.center.longitude,
        name: $0.name
      )
    }
  }

  public func routes(
    origin: NavOSSCarPlayCoordinate,
    originHeadingDegrees: Double? = nil,
    originHorizontalAccuracyMeters: Double? = nil,
    destination: NavOSSCarPlayDestination,
    preferences: NavOSSRoutePreferences,
    alternatives: Int = 2,
    waypoints: [NavOSSCarPlayDestination] = []
  ) async throws -> [NavOSSCarPlayTrip] {
    let points =
      [origin]
      + (waypoints + [destination]).map {
        NavOSSCarPlayCoordinate(latitude: $0.latitude, longitude: $0.longitude)
      }
    guard let offlineFallback, offlineFallback.covers(points) else {
      return try await onlineRoutes(
        origin: origin, originHeadingDegrees: originHeadingDegrees,
        originHorizontalAccuracyMeters: originHorizontalAccuracyMeters, destination: destination,
        preferences: preferences, alternatives: alternatives, waypoints: waypoints, timeout: 20)
    }
    func offline() async throws -> [NavOSSCarPlayTrip] {
      try await offlineFallback.offlineRoutes(
        origin: origin, originHeadingDegrees: originHeadingDegrees,
        originHorizontalAccuracyMeters: originHorizontalAccuracyMeters, destination: destination,
        preferences: preferences, alternatives: alternatives, waypoints: waypoints)
    }
    // Online stays first whenever the network is up, so routing returns to the service (and its
    // traffic and closures) as soon as it is reachable again.
    if !offlineFallback.isNetworkAvailable { return try await offline() }
    do {
      return try await onlineRoutes(
        origin: origin, originHeadingDegrees: originHeadingDegrees,
        originHorizontalAccuracyMeters: originHorizontalAccuracyMeters, destination: destination,
        preferences: preferences, alternatives: alternatives, waypoints: waypoints,
        timeout: Self.timeoutWithOfflineFallback)
    } catch where Self.isUnreachable(error) {
      return try await offline()
    }
  }

  private func onlineRoutes(
    origin: NavOSSCarPlayCoordinate,
    originHeadingDegrees: Double?,
    originHorizontalAccuracyMeters: Double?,
    destination: NavOSSCarPlayDestination,
    preferences: NavOSSRoutePreferences,
    alternatives: Int,
    waypoints: [NavOSSCarPlayDestination],
    timeout: TimeInterval
  ) async throws -> [NavOSSCarPlayTrip] {
    let request = RouteRequest(
      alternatives: alternatives,
      destination: NavOSSCarPlayCoordinate(
        latitude: destination.latitude,
        longitude: destination.longitude
      ),
      origin: origin,
      originHeadingDegrees: originHeadingDegrees,
      originHorizontalAccuracyMeters: originHorizontalAccuracyMeters,
      preferences: preferences,
      waypoints: waypoints.isEmpty
        ? nil
        : waypoints.map {
          NavOSSCarPlayCoordinate(latitude: $0.latitude, longitude: $0.longitude)
        }
    )
    let response: RouteResponse
    do {
      response = try await post(path: "v1/routes", body: request, timeout: timeout)
    } catch NavOSSNavigationAPIError.invalidRequest
      where originHeadingDegrees != nil || originHorizontalAccuracyMeters != nil
    {
      let fallback = RouteRequest(
        alternatives: alternatives,
        destination: request.destination,
        origin: origin,
        originHeadingDegrees: nil,
        originHorizontalAccuracyMeters: nil,
        preferences: preferences,
        waypoints: request.waypoints
      )
      response = try await post(path: "v1/routes", body: fallback, timeout: timeout)
    }
    let trips = try response.routes.map { route in
      NavOSSCarPlayTrip(
        destination: destination,
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
        geometry: try coordinates(route.geometry),
        id: route.id,
        preferences: preferences,
        source: response.source.id,
        speedLimitsKph: route.speedLimitsKph,
        steps: try route.steps.map { step in
          NavOSSCarPlayRouteStep(
            distanceMeters: step.distanceMeters,
            durationSeconds: step.durationSeconds,
            geometry: try coordinates(step.geometry),
            instruction: step.instruction,
            maneuverType: step.maneuverType,
            roadName: step.roadName,
            spokenInstruction: step.spokenInstruction
          )
        },
        traffic: route.traffic.map {
          NavOSSCarPlayTraffic(
            delaySeconds: $0.delaySeconds,
            typicalDurationSeconds: $0.typicalDurationSeconds
          )
        },
        waypoints: waypoints.isEmpty ? nil : waypoints
      )
    }
    // Present the same order the API and phone client promise: mirrors the shared
    // `compareRouteAlternatives` bucket-then-distance ordering so CarPlay does not depend on a
    // coordinated server deploy. Fastest-name logic (`navOSSCarPlayFastestRouteIndex`) and route
    // choice details already track raw duration independently of array position.
    return navOSSCarPlayTripsOrderedForDisplay(trips)
  }

  /// Fixed safety cameras for native alert eligibility. Records with an unknown direction are
  /// dropped rather than guessed.
  public func safetyCameras() async throws -> [NavOSSSafetyCamera] {
    var request = URLRequest(url: baseURL.appending(path: "v1/cameras"))
    request.httpMethod = "GET"
    request.timeoutInterval = 20
    let response: SafetyCameraResponse = try await send(request)
    return response.cameras.compactMap { record in
      guard let direction = NavOSSSafetyCamera.Direction(rawValue: record.direction),
        record.coordinate.isValid
      else {
        return nil
      }
      return NavOSSSafetyCamera(
        id: record.id,
        latitude: record.coordinate.latitude,
        longitude: record.coordinate.longitude,
        direction: direction,
        location: record.location
      )
    }
  }

  private func coordinates(_ values: [[Double]]) throws -> [NavOSSCarPlayCoordinate] {
    try values.map { value in
      guard value.count == 2 else {
        throw NavOSSNavigationAPIError.invalidResponse
      }
      return NavOSSCarPlayCoordinate(latitude: value[1], longitude: value[0])
    }
  }

  private func post<Request: Encodable, Response: Decodable>(
    path: String,
    body: Request,
    timeout: TimeInterval
  ) async throws -> Response {
    var request = URLRequest(url: baseURL.appending(path: path))
    request.httpBody = try encoder.encode(body)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.timeoutInterval = timeout
    return try await send(request)
  }

  private func send<Response: Decodable>(_ request: URLRequest) async throws -> Response {
    let (data, urlResponse) = try await session.data(for: request)
    guard let response = urlResponse as? HTTPURLResponse else {
      throw NavOSSNavigationAPIError.invalidResponse
    }
    guard response.statusCode != 400 else {
      throw NavOSSNavigationAPIError.invalidRequest
    }
    guard (200..<300).contains(response.statusCode) else {
      throw NavOSSNavigationAPIError.serviceUnavailable
    }
    do {
      return try decoder.decode(Response.self, from: data)
    } catch {
      throw NavOSSNavigationAPIError.invalidResponse
    }
  }

  private static func configuredBaseURL() -> URL? {
    guard let value = Bundle.main.object(forInfoDictionaryKey: "NavOSSAPIURL") as? String else {
      return nil
    }
    return URL(string: value)
  }
}
