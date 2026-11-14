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
      XCTAssertEqual(payload["sort"] as? String, "relevance")
      XCTAssertEqual(payload["includeDetails"] as? Bool, true)
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
    XCTAssertNil(results.first?.placeCategory)
    XCTAssertEqual(results.first?.searchConfidence, 1)
  }

  func testSearchDecodesFactualCategoryAndToleratesMissingConfidence() async throws {
    NavigationURLProtocol.handler = { request in
      Self.response(request: request, json: """
        {"results":[{"category":"poi","center":{"latitude":51.0432499,"longitude":-113.9174518},
        "details":{"category":"warehouse store"},"id":"warehouse",
        "label":"Costco, 75 East Hills Boulevard SE, Calgary","name":"Costco"}]}
        """)
    }
    let results = try await makeClient().search(query: "Costco", proximity: nil)
    XCTAssertEqual(results.first?.placeCategory, "warehouse store")
    XCTAssertNil(results.first?.searchConfidence)
  }

  func testNearbyCategorySearchStillRequestsDistanceSorting() async throws {
    NavigationURLProtocol.handler = { request in
      let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: Self.requestBody(request)) as? [String: Any])
      XCTAssertEqual(payload["category"] as? String, "cafe")
      XCTAssertEqual(payload["sort"] as? String, "distance")
      XCTAssertEqual(payload["includeDetails"] as? Bool, true)
      return Self.response(request: request, json: "{\"results\":[]}")
    }
    _ = try await makeClient().search(query: "Cafes", proximity: .init(latitude: 51.045, longitude: -114.072), category: "cafe")
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
    // The deployed server: no /v2/config or /v2/routes, and routes possibly ordered by raw
    // duration. Only its /v1/routes answer is re-ordered; a /v2/routes order is kept.
    NavigationURLProtocol.handler = { request in
      guard request.url!.path == "/v1/routes" else {
        return Self.response(request: request, json: "{}", statusCode: 404)
      }
      return Self.response(
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
    // The deployed server: no /v2/config or /v2/routes, and routes possibly ordered by raw
    // duration. Only its /v1/routes answer is re-ordered; a /v2/routes order is kept.
    NavigationURLProtocol.handler = { request in
      guard request.url!.path == "/v1/routes" else {
        return Self.response(request: request, json: "{}", statusCode: 404)
      }
      return Self.response(
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

  func testRoutesDecodeSafelyWhenTheAPIAddsEnrichmentFields() async throws {
    // The routing API is adding optional lanes, signposts, current road names, per-segment
    // congestion and a traffic source. A build that predates them must still navigate.
    NavigationURLProtocol.handler = { request in
      Self.response(
        request: request,
        json: """
          {
            "degraded": false,
            "generatedAt": "2026-11-12T00:00:00.000Z",
            "routes": [{
              "congestion": ["free", "heavy"],
              "distanceMeters": 1000,
              "durationSeconds": 120,
              "geometry": [[-114.08, 51.04], [-114.07, 51.05], [-114.06, 51.06]],
              "id": "route-enriched",
              "label": "fastest",
              "steps": [{
                "currentRoadName": "Crowchild Trail NW",
                "distanceMeters": 1000,
                "durationSeconds": 120,
                "exitNumber": "12",
                "geometry": [[-114.08, 51.04], [-114.06, 51.06]],
                "instruction": "Continue north",
                "lanes": [{"indications": ["straight"], "valid": true, "active": true}],
                "maneuverModifier": "slight right",
                "maneuverType": "continue",
                "roadName": "Crowchild Trail NW",
                "signpost": "Banff"
              }],
              "trafficSource": "navoss-probes"
            }],
            "source": {
              "attribution": "Routing by Valhalla using OpenStreetMap data",
              "id": "valhalla-self-hosted",
              "mode": "production",
              "traffic": "unavailable"
            }
          }
          """
      )
    }

    let routes = try await makeClient().routes(
      origin: NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.08),
      destination: NavOSSCarPlayDestination(
        id: "destination",
        label: "Destination",
        latitude: 51.06,
        longitude: -114.06,
        name: "Destination"
      ),
      preferences: NavOSSRoutePreferences()
    )

    XCTAssertEqual(routes.map(\.id), ["route-enriched"])
    XCTAssertEqual(routes.first?.steps.first?.roadName, "Crowchild Trail NW")
    XCTAssertTrue(routes.first?.isValid == true)
  }

  func testSafetyCamerasDecodeWithoutSendingLocationAndDropUnknownDirections() async throws {
    NavigationURLProtocol.handler = { request in
      XCTAssertEqual(request.httpMethod, "GET")
      XCTAssertEqual(request.url?.path, "/v1/cameras")
      XCTAssertNil(request.url?.query)
      return Self.response(
        request: request,
        json: """
          {
            "cameras": [
              {
                "community": "HILLHURST",
                "coordinate": {"latitude": 51.045, "longitude": -114.08},
                "direction": "northbound",
                "enforcement": ["red-light", "speed-on-green"],
                "id": "calgary-isc:1",
                "location": "14 Street and Kensington Road N.W.",
                "quadrant": "NW"
              },
              {
                "community": "HILLHURST",
                "coordinate": {"latitude": 51.046, "longitude": -114.08},
                "direction": "northeastbound",
                "enforcement": ["red-light", "speed-on-green"],
                "id": "calgary-isc:2",
                "location": "Unknown approach",
                "quadrant": "NW"
              }
            ],
            "source": {
              "attribution": "The City of Calgary",
              "datasetId": "dv2f-necx",
              "datasetUrl": "https://data.calgary.ca/Health-and-Safety/Intersection-Safety-Cameras/dv2f-necx",
              "updateFrequency": "monthly",
              "updatedAt": "2026-11-01T00:00:00.000Z"
            }
          }
          """
      )
    }

    let cameras = try await makeClient().safetyCameras()

    XCTAssertEqual(
      cameras,
      [
        NavOSSSafetyCamera(
          id: "calgary-isc:1",
          latitude: 51.045,
          longitude: -114.08,
          direction: .northbound,
          location: "14 Street and Kensington Road N.W."
        )
      ]
    )
  }

  private func makeClient() throws -> NavOSSNavigationAPIClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [NavigationURLProtocol.self]
    // These cases exercise `/v2/routes` directly; discovery and the v1 fallback are covered by
    // `NavigationRoutesV2Tests`.
    let baseURL = try XCTUnwrap(URL(string: "https://example.test"))
    let discovery = NavOSSRoutesEndpointDiscovery()
    discovery.record(.v2, for: baseURL)
    return try NavOSSNavigationAPIClient(
      baseURL: baseURL,
      session: URLSession(configuration: configuration),
      routesDiscovery: discovery
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
