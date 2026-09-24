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
      XCTAssertEqual(payload["sort"] as? String, "distance")
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
      XCTAssertEqual(payload["originHeadingDegrees"] as? Double, 25)
      XCTAssertEqual(payload["originHorizontalAccuracyMeters"] as? Double, 8)
      let waypoints = try XCTUnwrap(payload["waypoints"] as? [[String: Any]])
      XCTAssertEqual(waypoints.first?["latitude"] as? Double, 51.08)
      XCTAssertEqual(waypoints.first?["longitude"] as? Double, -114.05)
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
              "speedLimitsKph": [0],
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
      originHeadingDegrees: 25,
      originHorizontalAccuracyMeters: 8,
      destination: NavOSSCarPlayDestination(
        id: "airport",
        label: "2000 Airport Road NE",
        latitude: 51.13,
        longitude: -114.01,
        name: "Calgary International Airport"
      ),
      preferences: preferences,
      waypoints: [
        NavOSSCarPlayDestination(
          id: "groceries",
          label: "Calgary Co-op",
          latitude: 51.08,
          longitude: -114.05,
          name: "Calgary Co-op"
        )
      ]
    )

    XCTAssertEqual(routes.first?.geometry.first?.latitude, 51.04)
    XCTAssertEqual(routes.first?.geometry.first?.longitude, -114.08)
    XCTAssertEqual(routes.first?.preferences, preferences)
    XCTAssertEqual(routes.first?.waypoints?.first?.id, "groceries")
    XCTAssertEqual(routes.first?.source, "valhalla-development")
    XCTAssertEqual(routes.first?.speedLimitsKph, [0])
    XCTAssertNil(routes.first?.traffic)
    XCTAssertEqual(
      routes.first?.steps.first?.spokenInstruction,
      "Continue north on Airport Trail NE"
    )
  }

  func testRoutesRetryWithoutOriginMetadataAfterInvalidRequest() async throws {
    var payloads: [[String: Any]] = []
    NavigationURLProtocol.handler = { request in
      let payload = try XCTUnwrap(
        JSONSerialization.jsonObject(with: Self.requestBody(request)) as? [String: Any]
      )
      payloads.append(payload)
      if payloads.count == 1 {
        return Self.response(request: request, json: "{}", statusCode: 400)
      }
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
                "roadName": "Test Road"
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

    _ = try await client.routes(
      origin: NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.08),
      originHeadingDegrees: 25,
      originHorizontalAccuracyMeters: 8,
      destination: NavOSSCarPlayDestination(
        id: "airport",
        label: "Airport Road",
        latitude: 51.13,
        longitude: -114.01,
        name: "Airport"
      ),
      preferences: NavOSSRoutePreferences()
    )

    XCTAssertEqual(payloads.count, 2)
    XCTAssertEqual(payloads.first?["originHeadingDegrees"] as? Double, 25)
    XCTAssertNil(payloads.last?["originHeadingDegrees"])
    XCTAssertNil(payloads.last?["originHorizontalAccuracyMeters"])
  }

  func testRoutesReorderShorterRouteFirstWithinSharedDisplayedMinute() async throws {
    NavigationURLProtocol.handler = { request in
      Self.response(
        request: request,
        json: """
          {
            "degraded": true,
            "generatedAt": "2026-07-22T00:00:00.000Z",
            "routes": [{
              "distanceMeters": 9200,
              "durationSeconds": 595,
              "geometry": [[-114.08, 51.04], [-114.01, 51.13]],
              "id": "route-quicker-raw",
              "label": "fastest",
              "steps": [{
                "distanceMeters": 9200,
                "durationSeconds": 595,
                "geometry": [[-114.08, 51.04], [-114.01, 51.13]],
                "instruction": "Continue north",
                "maneuverType": "continue",
                "roadName": "Test Road"
              }]
            }, {
              "distanceMeters": 8100,
              "durationSeconds": 605,
              "geometry": [[-114.08, 51.04], [-114.02, 51.12]],
              "id": "route-shorter-distance",
              "label": "alternative",
              "steps": [{
                "distanceMeters": 8100,
                "durationSeconds": 605,
                "geometry": [[-114.08, 51.04], [-114.02, 51.12]],
                "instruction": "Continue northeast",
                "maneuverType": "continue",
                "roadName": "Other Road"
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

    let routes = try await client.routes(
      origin: NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.08),
      destination: NavOSSCarPlayDestination(
        id: "airport",
        label: "Airport Road",
        latitude: 51.13,
        longitude: -114.01,
        name: "Airport"
      ),
      preferences: NavOSSRoutePreferences()
    )

    // Both routes round to the same displayed minute; the API listed the quicker-raw route
    // first, but the shorter-distance route must present first, and precise fields survive.
    XCTAssertEqual(routes.map(\.id), ["route-shorter-distance", "route-quicker-raw"])
    XCTAssertEqual(routes[0].distanceMeters, 8_100)
    XCTAssertEqual(routes[0].durationSeconds, 605)
    XCTAssertEqual(routes[1].distanceMeters, 9_200)
    XCTAssertEqual(routes[1].durationSeconds, 595)
  }

  func testRoutesKeepFasterDisplayedMinuteRouteFirstWhenListedSecond() async throws {
    NavigationURLProtocol.handler = { request in
      Self.response(
        request: request,
        json: """
          {
            "degraded": true,
            "generatedAt": "2026-07-22T00:00:00.000Z",
            "routes": [{
              "distanceMeters": 5000,
              "durationSeconds": 650,
              "geometry": [[-114.08, 51.04], [-114.01, 51.13]],
              "id": "route-listed-first-slower-minute",
              "label": "alternative",
              "steps": [{
                "distanceMeters": 5000,
                "durationSeconds": 650,
                "geometry": [[-114.08, 51.04], [-114.01, 51.13]],
                "instruction": "Continue north",
                "maneuverType": "continue",
                "roadName": "Test Road"
              }]
            }, {
              "distanceMeters": 20000,
              "durationSeconds": 550,
              "geometry": [[-114.08, 51.04], [-113.9, 51.2]],
              "id": "route-listed-second-faster-minute",
              "label": "fastest",
              "steps": [{
                "distanceMeters": 20000,
                "durationSeconds": 550,
                "geometry": [[-114.08, 51.04], [-113.9, 51.2]],
                "instruction": "Continue on highway",
                "maneuverType": "continue",
                "roadName": "Highway"
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

    let routes = try await client.routes(
      origin: NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.08),
      destination: NavOSSCarPlayDestination(
        id: "airport",
        label: "Airport Road",
        latitude: 51.13,
        longitude: -114.01,
        name: "Airport"
      ),
      preferences: NavOSSRoutePreferences()
    )

    XCTAssertEqual(
      routes.map(\.id),
      ["route-listed-second-faster-minute", "route-listed-first-slower-minute"]
    )
    XCTAssertEqual(routes[0].durationSeconds, 550)
    XCTAssertEqual(routes[1].durationSeconds, 650)
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
    json: String,
    statusCode: Int = 200
  ) -> (HTTPURLResponse, Data) {
    let response = HTTPURLResponse(
      url: request.url!,
      statusCode: statusCode,
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
