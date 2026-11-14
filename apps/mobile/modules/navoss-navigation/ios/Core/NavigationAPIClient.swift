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
  /// A place on a newly planned route is outside the coverage the server declares, named here
  /// as the server names it (e.g. "Calgary and Kelowna service areas").
  case outsideCoverage(String)
}

private struct SearchRequest: Encodable {
  let category: String?
  let includeDetails = true
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
  let confidence: Double?
  let center: NavOSSCarPlayCoordinate
  let details: SearchPlaceDetails?
  let id: String
  let label: String
  let name: String
}

private struct SearchPlaceDetails: Decodable {
  let category: String?
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
  private let routesDiscovery: NavOSSRoutesEndpointDiscovery
  private let session: URLSession

  public init(
    baseURL: URL? = nil,
    session: URLSession = .shared,
    routesDiscovery: NavOSSRoutesEndpointDiscovery = .shared,
    offlineFallback: NavOSSOfflineNavigationFallback? = NavOSSNavigationAPIClient.offlineFallback
  ) throws {
    guard let resolvedBaseURL = baseURL ?? Self.configuredBaseURL() else {
      throw NavOSSNavigationAPIError.invalidConfiguration
    }
    self.baseURL = resolvedBaseURL
    self.offlineFallback = offlineFallback
    self.routesDiscovery = routesDiscovery
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
      sort: category == nil ? "relevance" : roundedProximity == nil ? nil : "distance"
    )
    let response: SearchResponse = try await post(
      path: "v1/search", body: request, timeout: timeout)
    return response.results.map {
      NavOSSCarPlayDestination(
        category: $0.category,
        placeCategory: $0.details?.category,
        searchConfidence: $0.confidence,
        id: $0.id,
        label: $0.label,
        latitude: $0.center.latitude,
        longitude: $0.center.longitude,
        name: $0.name
      )
    }
  }

  /// Fetches routes from `/v2/routes` unless the server's `/v2/config` declares only
  /// `/v1/routes`. Waypoints whose id is in `passThroughWaypointIds` steer the route without
  /// becoming stops (v2 `through` waypoints); a v1-only server cannot express that and the call
  /// throws `throughWaypointsUnsupported` instead of silently adding a stop.
  ///
  /// With `requireCoverage`, a route whose origin, stops or destination lie outside the coverage
  /// the server declares is refused with `outsideCoverage` before any route request. A reroute
  /// passes `false`: a trip between two covered places may cross uncovered roads.
  ///
  /// An installed offline region covering every stop also authorises the trip: the route comes
  /// from the device when the service is unreachable, or when the server's declared coverage
  /// does not include the trip. Online stays first whenever the network is up and the server
  /// covers the trip, so routing returns to the service as soon as it answers again.
  public func routes(
    origin: NavOSSCarPlayCoordinate,
    originHeadingDegrees: Double? = nil,
    originHorizontalAccuracyMeters: Double? = nil,
    destination: NavOSSCarPlayDestination,
    preferences: NavOSSRoutePreferences,
    alternatives: Int = 2,
    waypoints: [NavOSSCarPlayDestination] = [],
    passThroughWaypointIds: Set<String> = [],
    requireCoverage: Bool = true
  ) async throws -> [NavOSSCarPlayTrip] {
    func online(timeout: TimeInterval) async throws -> [NavOSSCarPlayTrip] {
      try await onlineRoutes(
        origin: origin, originHeadingDegrees: originHeadingDegrees,
        originHorizontalAccuracyMeters: originHorizontalAccuracyMeters, destination: destination,
        preferences: preferences, alternatives: alternatives, waypoints: waypoints,
        passThroughWaypointIds: passThroughWaypointIds, requireCoverage: requireCoverage,
        timeout: timeout)
    }
    let points =
      [origin]
      + (waypoints + [destination]).map {
        NavOSSCarPlayCoordinate(latitude: $0.latitude, longitude: $0.longitude)
      }
    // Offline routes have no pass-through waypoints; such a trip stays online-only.
    guard let offlineFallback, passThroughWaypointIds.isEmpty, offlineFallback.covers(points)
    else {
      return try await online(timeout: 20)
    }
    func offline() async throws -> [NavOSSCarPlayTrip] {
      try await offlineFallback.offlineRoutes(
        origin: origin, originHeadingDegrees: originHeadingDegrees,
        originHorizontalAccuracyMeters: originHorizontalAccuracyMeters, destination: destination,
        preferences: preferences, alternatives: alternatives, waypoints: waypoints)
    }
    if !offlineFallback.isNetworkAvailable { return try await offline() }
    do {
      return try await online(timeout: Self.timeoutWithOfflineFallback)
    } catch where Self.isUnreachable(error) {
      return try await offline()
    } catch NavOSSNavigationAPIError.outsideCoverage {
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
    passThroughWaypointIds: Set<String>,
    requireCoverage: Bool,
    timeout: TimeInterval
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
      let decoded = try navigationTrips(
        from: response,
        version: version,
        destination: destination,
        preferences: preferences,
        waypoints: stops
      )
      // A /v2/routes order is the server's recommendation, kept as sent: community traffic may
      // reorder routes only within the server's bounds (never onto more minor roads), and
      // re-sorting by duration here would undo them. Only the deployed /v1-only server, which has
      // no community traffic, is re-ordered with the shared `compareRouteAlternatives` rule.
      // "Fastest" naming (`navOSSCarPlayFastestRouteIndex`) follows duration, not position.
      return version == .v1 ? navOSSCarPlayTripsOrderedForDisplay(decoded) : decoded
    }

    let config = await serverConfig()
    if requireCoverage, let coverage = config?.coverage {
      let places =
        [origin]
        + (waypoints + [destination]).map {
          NavOSSCarPlayCoordinate(latitude: $0.latitude, longitude: $0.longitude)
        }
      guard places.allSatisfy(coverage.serves) else {
        throw NavOSSNavigationAPIError.outsideCoverage(coverage.displayName)
      }
    }
    if config?.routesVersion != .v1 {
      do {
        return try trips(
          try await postRoutes(path: "v2/routes", request(.v2), timeout: timeout), .v2)
      } catch NavOSSNavigationAPIError.endpointNotFound {
        routesDiscovery.record(.v1, for: baseURL)
      }
    }
    guard waypoints.allSatisfy({ !passThroughWaypointIds.contains($0.id) }) else {
      throw NavOSSNavigationAPIError.throughWaypointsUnsupported
    }
    return try trips(
      try await postRoutes(path: "v1/routes", request(.v1), timeout: timeout), .v1)
  }

  /// What the server's `/v2/config` declares, remembered per server. `nil` when the answer is
  /// unknown (a transient failure or an unreadable config); the caller then tries `/v2/routes`,
  /// falls back on 404 and refuses nothing locally. A server without `/v2/config` predates
  /// `/v2/routes`.
  private func serverConfig() async -> NavigationServerConfig? {
    if let known = routesDiscovery.config(for: baseURL) {
      return known
    }
    var request = URLRequest(url: baseURL.appending(path: "v2/config"))
    request.httpMethod = "GET"
    request.timeoutInterval = 10
    let config: NavigationServerConfig
    do {
      config = try await send(request)
    } catch NavOSSNavigationAPIError.endpointNotFound {
      config = NavigationServerConfig(routesVersion: .v1)
    } catch {
      return nil
    }
    routesDiscovery.record(config, for: baseURL)
    return config
  }

  /// Posts a route request, retrying once without origin heading/accuracy when the server
  /// rejects them (an older API did not accept them).
  private func postRoutes(
    path: String,
    _ request: NavigationRouteRequest,
    timeout: TimeInterval
  ) async throws -> NavigationRouteResponseWire {
    do {
      return try await post(path: path, body: request, timeout: timeout)
    } catch NavOSSNavigationAPIError.invalidRequest
      where request.originHeadingDegrees != nil || request.originHorizontalAccuracyMeters != nil
    {
      return try await post(path: path, body: request.withoutOriginMetadata(), timeout: timeout)
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
    body: Request,
    timeout: TimeInterval = 20
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
