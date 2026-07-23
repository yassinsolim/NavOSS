import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

public enum NavOSSNavigationAPIError: Error {
  case invalidConfiguration
  case invalidResponse
  case serviceUnavailable
}

private struct SearchRequest: Encodable {
  let includeDetails = false
  let latitude: Double?
  let limit: Int
  let longitude: Double?
  let q: String
}

private struct SearchResponse: Decodable {
  let results: [SearchResult]
}

private struct SearchResult: Decodable {
  let center: NavOSSCarPlayCoordinate
  let id: String
  let label: String
  let name: String
}

private struct RouteRequest: Encodable {
  let alternatives: Int
  let destination: NavOSSCarPlayCoordinate
  let origin: NavOSSCarPlayCoordinate
  let preferences: NavOSSRoutePreferences
}

private struct RouteResponse: Decodable {
  let routes: [Route]
}

private struct Route: Decodable {
  let distanceMeters: Double
  let durationSeconds: Double
  let geometry: [[Double]]
  let id: String
  let steps: [RouteStep]
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
    limit: Int = 8
  ) async throws -> [NavOSSCarPlayDestination] {
    let roundedProximity = proximity.map {
      NavOSSCarPlayCoordinate(
        latitude: ($0.latitude * 1_000).rounded() / 1_000,
        longitude: ($0.longitude * 1_000).rounded() / 1_000
      )
    }
    let request = SearchRequest(
      latitude: roundedProximity?.latitude,
      limit: limit,
      longitude: roundedProximity?.longitude,
      q: query
    )
    let response: SearchResponse = try await post(path: "v1/search", body: request)
    return response.results.map {
      NavOSSCarPlayDestination(
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
    destination: NavOSSCarPlayDestination,
    preferences: NavOSSRoutePreferences,
    alternatives: Int = 2
  ) async throws -> [NavOSSCarPlayTrip] {
    let request = RouteRequest(
      alternatives: alternatives,
      destination: NavOSSCarPlayCoordinate(
        latitude: destination.latitude,
        longitude: destination.longitude
      ),
      origin: origin,
      preferences: preferences
    )
    let response: RouteResponse = try await post(path: "v1/routes", body: request)
    return try response.routes.map { route in
      NavOSSCarPlayTrip(
        destination: destination,
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
        geometry: try coordinates(route.geometry),
        id: route.id,
        preferences: preferences,
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
        }
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
