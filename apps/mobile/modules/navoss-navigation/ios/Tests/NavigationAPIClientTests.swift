import XCTest

@testable import NavOSSNavigationCore

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

final class NavigationAPIClientTests: XCTestCase {
  override func tearDown() {
    NavigationURLProtocol.handler = nil
    super.tearDown()
  }

  func testSearchRoundsProximityAndDecodesDestinations() async throws {
    NavigationURLProtocol.handler = { request in
      let body = try Self.requestBody(request)
      let payload = try XCTUnwrap(
        JSONSerialization.jsonObject(with: body) as? [String: Any]
      )
      XCTAssertEqual(payload["q"] as? String, "Airport")
      XCTAssertEqual(payload["latitude"] as? Double, 51.123)
      XCTAssertEqual(payload["longitude"] as? Double, -114.988)
      return Self.response(
        request: request,
        json: """
          {
            "degraded": false,
            "results": [{
              "category": "landmark",
              "center": {"latitude": 51.13, "longitude": -114.01},
              "confidence": 1,
              "id": "airport",
              "label": "2000 Airport Road NE",
              "name": "Calgary International Airport"
            }],
            "source": {
              "datasetVersion": "test",
              "freshness": "fresh",
              "id": "test",
              "updatedAt": "2026-07-22T00:00:00.000Z"
            }
          }
          """
      )
    }
    let client = try makeClient()

    let results = try await client.search(
      query: "Airport",
      proximity: NavOSSCarPlayCoordinate(latitude: 51.1234, longitude: -114.9876)
    )

    XCTAssertEqual(results.first?.id, "airport")
    XCTAssertEqual(results.first?.latitude, 51.13)
  }

  func testRoutesPreserveCoordinateOrderPreferencesAndSpeech() async throws {
    NavigationURLProtocol.handler = { request in
      let body = try Self.requestBody(request)
      let payload = try XCTUnwrap(
        JSONSerialization.jsonObject(with: body) as? [String: Any]
      )
      let preferences = try XCTUnwrap(payload["preferences"] as? [String: Any])
      XCTAssertEqual(preferences["avoidHighways"] as? Bool, true)
      return Self.response(
        request: request,
        json: """
          {
            "degraded": true,
            "generatedAt": "2026-07-22T00:00:00.000Z",
            "routes": [{
              "distanceMeters": 1000,
              "durationSeconds": 120,
              "geometry": [[-114.08, 51.04], [-114.01, 51.13]],
              "id": "route-1",
              "label": "fastest",
              "steps": [{
                "distanceMeters": 1000,
                "durationSeconds": 120,
                "geometry": [[-114.08, 51.04], [-114.01, 51.13]],
                "instruction": "Continue north",
                "maneuverType": "continue",
                "roadName": "Airport Trail NE",
                "spokenInstruction": "Continue north on Airport Trail NE"
              }]
            }],
            "source": {
              "attribution": "Routing by Valhalla using OpenStreetMap data",
              "id": "valhalla-development",
              "mode": "development",
              "traffic": "unavailable"
            }
          }
          """
      )
    }
    let client = try makeClient()
    let preferences = NavOSSRoutePreferences(avoidHighways: true)

    let routes = try await client.routes(
      origin: NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.08),
      destination: NavOSSCarPlayDestination(
        id: "airport",
        label: "2000 Airport Road NE",
        latitude: 51.13,
        longitude: -114.01,
        name: "Calgary International Airport"
      ),
      preferences: preferences
    )

    XCTAssertEqual(routes.first?.geometry.first?.latitude, 51.04)
    XCTAssertEqual(routes.first?.geometry.first?.longitude, -114.08)
    XCTAssertEqual(routes.first?.preferences, preferences)
    XCTAssertEqual(
      routes.first?.steps.first?.spokenInstruction,
      "Continue north on Airport Trail NE"
    )
  }

  private func makeClient() throws -> NavOSSNavigationAPIClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [NavigationURLProtocol.self]
    return try NavOSSNavigationAPIClient(
      baseURL: URL(string: "https://example.test"),
      session: URLSession(configuration: configuration)
    )
  }

  private static func requestBody(_ request: URLRequest) throws -> Data {
    if let body = request.httpBody {
      return body
    }
    let stream = try XCTUnwrap(request.httpBodyStream)
    stream.open()
    defer { stream.close() }
    var body = Data()
    var buffer = [UInt8](repeating: 0, count: 4_096)
    while stream.hasBytesAvailable {
      let count = stream.read(&buffer, maxLength: buffer.count)
      guard count >= 0 else {
        throw stream.streamError ?? NavOSSNavigationAPIError.invalidResponse
      }
      if count == 0 {
        break
      }
      body.append(buffer, count: count)
    }
    return body
  }

  private static func response(
    request: URLRequest,
    json: String
  ) -> (HTTPURLResponse, Data) {
    let response = HTTPURLResponse(
      url: request.url!,
      statusCode: 200,
      httpVersion: nil,
      headerFields: ["content-type": "application/json"]
    )!
    return (response, Data(json.utf8))
  }
}

private final class NavigationURLProtocol: URLProtocol {
  static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

  override class func canInit(with request: URLRequest) -> Bool {
    true
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest {
    request
  }

  override func startLoading() {
    do {
      let (response, data) = try Self.handler!(request)
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch {
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  override func stopLoading() {}
}
