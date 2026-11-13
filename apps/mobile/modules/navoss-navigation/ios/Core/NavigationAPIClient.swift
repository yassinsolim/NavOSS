import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

public enum NavOSSNavigationAPIError: Error {
  case invalidConfiguration
  case invalidRequest
  case invalidResponse
  case serviceUnavailable
  /// The server answered 404: it does not offer the requested endpoint.
  case endpointNotFound
  /// A pass-through waypoint was requested from a server that only offers `/v1/routes`, which
  /// would turn it into a stop.
  case throughWaypointsUnsupported
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

private struct SafetyCameraResponse: Decodable {
  let cameras: [SafetyCameraRecord]
}

private struct SafetyCameraRecord: Decodable {
  let coordinate: NavOSSCarPlayCoordinate
  let direction: String
  let id: String
  let location: String
}

public final class NavOSSNavigationAPIClient: @unchecked Sendable {
  private let baseURL: URL
  private let decoder = JSONDecoder()
  private let encoder = JSONEncoder()
  private let routesDiscovery: NavOSSRoutesEndpointDiscovery
  private let session: URLSession

  public init(
    baseURL: URL? = nil,
    session: URLSession = .shared,
    routesDiscovery: NavOSSRoutesEndpointDiscovery = .shared
  ) throws {
    guard let resolvedBaseURL = baseURL ?? Self.configuredBaseURL() else {
      throw NavOSSNavigationAPIError.invalidConfiguration
    }
    self.baseURL = resolvedBaseURL
    self.routesDiscovery = routesDiscovery
    self.session = session
  }

  public func search(
    query: String,
    proximity: NavOSSCarPlayCoordinate?,
    limit: Int = 8,
    category: String? = nil
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
    let response: SearchResponse = try await post(path: "v1/search", body: request)
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

  /// Fetches routes from `/v2/routes` when the server advertises it in `/v2/config`, otherwise
  /// from `/v1/routes`. Waypoints whose id is in `passThroughWaypointIds` steer the route without
  /// becoming stops (v2 `through` waypoints); a v1-only server cannot express that and the call
  /// throws `throughWaypointsUnsupported` instead of silently adding a stop.
  public func routes(
    origin: NavOSSCarPlayCoordinate,
    originHeadingDegrees: Double? = nil,
    originHorizontalAccuracyMeters: Double? = nil,
    destination: NavOSSCarPlayDestination,
    preferences: NavOSSRoutePreferences,
    alternatives: Int = 2,
    waypoints: [NavOSSCarPlayDestination] = [],
    passThroughWaypointIds: Set<String> = []
  ) async throws -> [NavOSSCarPlayTrip] {
    func request(_ version: NavigationRoutesAPIVersion) -> NavigationRouteRequest {
      NavigationRouteRequest(
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
            NavigationRouteWaypointRequest(
              latitude: $0.latitude,
              longitude: $0.longitude,
              type: version == .v2 && passThroughWaypointIds.contains($0.id) ? "through" : nil
            )
          }
      )
    }
    let stops = waypoints.filter { !passThroughWaypointIds.contains($0.id) }
    func trips(
      _ response: NavigationRouteResponseWire,
      _ version: NavigationRoutesAPIVersion
    ) throws -> [NavOSSCarPlayTrip] {
      // Present the same order the API and phone client promise: mirrors the shared
      // `compareRouteAlternatives` bucket-then-distance ordering so CarPlay does not depend on a
      // coordinated server deploy. Fastest-name logic (`navOSSCarPlayFastestRouteIndex`) and
      // route choice details already track raw duration independently of array position.
      navOSSCarPlayTripsOrderedForDisplay(
        try navigationTrips(
          from: response,
          version: version,
          destination: destination,
          preferences: preferences,
          waypoints: stops
        )
      )
    }

    if await routesVersion() != .v1 {
      do {
        return try trips(try await postRoutes(path: "v2/routes", request(.v2)), .v2)
      } catch NavOSSNavigationAPIError.endpointNotFound {
        routesDiscovery.record(.v1, for: baseURL)
      }
    }
    guard waypoints.allSatisfy({ !passThroughWaypointIds.contains($0.id) }) else {
      throw NavOSSNavigationAPIError.throughWaypointsUnsupported
    }
    return try trips(try await postRoutes(path: "v1/routes", request(.v1)), .v1)
  }

  /// What `/v2/config` says about routes, remembered per server. `nil` when the answer is
  /// unknown (a transient failure); the caller then tries `/v2/routes` and falls back on 404.
  private func routesVersion() async -> NavigationRoutesAPIVersion? {
    if let known = routesDiscovery.version(for: baseURL) {
      return known
    }
    var request = URLRequest(url: baseURL.appending(path: "v2/config"))
    request.httpMethod = "GET"
    request.timeoutInterval = 10
    let version: NavigationRoutesAPIVersion
    do {
      let config: NavigationConfigDiscoveryResponse = try await send(request)
      version = config.endpoints.routes == "/v2/routes" ? .v2 : .v1
    } catch NavOSSNavigationAPIError.endpointNotFound {
      version = .v1
    } catch {
      return nil
    }
    routesDiscovery.record(version, for: baseURL)
    return version
  }

  /// Posts a route request, retrying once without origin heading/accuracy when the server
  /// rejects them (an older API did not accept them).
  private func postRoutes(
    path: String,
    _ request: NavigationRouteRequest
  ) async throws -> NavigationRouteResponseWire {
    do {
      return try await post(path: path, body: request)
    } catch NavOSSNavigationAPIError.invalidRequest
      where request.originHeadingDegrees != nil || request.originHorizontalAccuracyMeters != nil
    {
      return try await post(path: path, body: request.withoutOriginMetadata())
    }
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

  private func post<Request: Encodable, Response: Decodable>(
    path: String,
    body: Request
  ) async throws -> Response {
    var request = URLRequest(url: baseURL.appending(path: path))
    request.httpBody = try encoder.encode(body)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.timeoutInterval = 20
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
    guard response.statusCode != 404 else {
      throw NavOSSNavigationAPIError.endpointNotFound
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
