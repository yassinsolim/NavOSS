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

private struct RouteStep: Decodable {
  let distanceMeters: Double
  let durationSeconds: Double
  let geometry: [[Double]]
  let instruction: String
  let maneuverType: String
  let roadName: String
  let spokenInstruction: String?
}

public final class NavOSSNavigationAPIClient: @unchecked Sendable {
  private let baseURL: URL
  private let decoder = JSONDecoder()
  private let encoder = JSONEncoder()
  private let session: URLSession

  public init(
    baseURL: URL? = nil,
    session: URLSession = .shared
  ) throws {
    guard let resolvedBaseURL = baseURL ?? Self.configuredBaseURL() else {
      throw NavOSSNavigationAPIError.invalidConfiguration
    }
    self.baseURL = resolvedBaseURL
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

  public func routes(
    origin: NavOSSCarPlayCoordinate,
    originHeadingDegrees: Double? = nil,
    originHorizontalAccuracyMeters: Double? = nil,
    destination: NavOSSCarPlayDestination,
    preferences: NavOSSRoutePreferences,
    alternatives: Int = 2,
    waypoints: [NavOSSCarPlayDestination] = []
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
      response = try await post(path: "v1/routes", body: request)
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
      response = try await post(path: "v1/routes", body: fallback)
    }
    return try response.routes.map { route in
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
    body: Request
  ) async throws -> Response {
    var request = URLRequest(url: baseURL.appending(path: path))
    request.httpBody = try encoder.encode(body)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.timeoutInterval = 20

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
