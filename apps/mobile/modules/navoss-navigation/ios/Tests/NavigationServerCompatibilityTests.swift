import Foundation
import XCTest

@testable import NavOSSNavigationCore

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// The native client against every server generation, using responses recorded from the deployed
/// production API (which predates `/v2/routes`) and from the new server
/// (`apps/mobile/test/fixtures/server-config`), plus a synthetic future server.
final class NavigationServerCompatibilityTests: XCTestCase {
  private static let baseURL = URL(string: "https://compat.example.test")!
  private static let fixtures = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .appendingPathComponent("../../../../test/fixtures/server-config")
    .standardized
  private static let borderPoints = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .appendingPathComponent(
      "../../../../../../packages/contracts/test/fixtures/coverage-border-points.json"
    )
    .standardized

  private static let calgaryOrigin = NavOSSCarPlayCoordinate(latitude: 51.01428, longitude: -114.005743)
  private static let calgaryTower = NavOSSCarPlayDestination(
    id: "landmark:calgary-tower", label: "Calgary Tower", latitude: 51.04427, longitude: -114.06309,
    name: "Calgary Tower")
  private static let edmonton = NavOSSCarPlayDestination(
    id: "edmonton", label: "Edmonton", latitude: 53.5461, longitude: -113.4938, name: "Edmonton")
  private static let vancouver = NavOSSCarPlayCoordinate(latitude: 49.2827, longitude: -123.1207)
  private static let seattle = NavOSSCarPlayCoordinate(latitude: 47.6062, longitude: -122.3321)

  override func tearDown() {
    CompatURLProtocol.handler = nil
    super.tearDown()
  }

  // MARK: Config decoding

  func testProductionConfigDeclaresV1RoutesAndCalgaryAndKelownaOnly() throws {
    let config = try Self.config("production-2026-11.v2-config")
    XCTAssertEqual(config.routesVersion, .v1)
    XCTAssertFalse(config.liveTraffic)
    XCTAssertFalse(config.communityReports)
    let coverage = try XCTUnwrap(config.coverage)
    XCTAssertEqual(coverage.displayName, "Calgary and Kelowna service areas")
    XCTAssertEqual(coverage.areas.map(\.id), ["calgary-ab", "kelowna-bc"])
    XCTAssertTrue(coverage.serves(Self.calgaryOrigin))
    XCTAssertTrue(coverage.serves(.init(latitude: 49.8879, longitude: -119.496)))
    XCTAssertFalse(coverage.serves(.init(latitude: Self.edmonton.latitude, longitude: Self.edmonton.longitude)))
    XCTAssertFalse(coverage.serves(Self.vancouver))
  }

  func testNewServerConfigDeclaresV2RoutesAndTheProvincialPolygons() throws {
    let config = try Self.config("new-server.v2-config")
    XCTAssertEqual(config.routesVersion, .v2)
    let coverage = try XCTUnwrap(config.coverage)
    XCTAssertEqual(coverage.displayName, "Alberta and British Columbia")
    XCTAssertTrue(coverage.serves(Self.vancouver))
    XCTAssertFalse(coverage.serves(Self.seattle), "the BC rectangle reaches Seattle; the polygon does not")

    struct Points: Decodable {
      struct Case: Decodable {
        let id: String
        let coordinate: NavOSSCarPlayCoordinate
        let serviceAreaId: String?
      }
      let cases: [Case]
    }
    let points = try JSONDecoder().decode(Points.self, from: Data(contentsOf: Self.borderPoints))
    XCTAssertGreaterThan(points.cases.count, 40)
    for point in points.cases {
      XCTAssertEqual(
        coverage.areas.first { $0.contains(point.coordinate) }?.id, point.serviceAreaId, point.id)
    }
  }

  func testAFutureServerWithUnknownFieldsStillDecodes() throws {
    var document = try Self.document("new-server.v2-config")
    document["apiVersion"] = "v3"
    document["offline"] = ["manifest": "/v1/offline/manifest"]
    var endpoints = try XCTUnwrap(document["endpoints"] as? [String: Any])
    endpoints["routes"] = "/v3/routes"
    endpoints["trafficFlow"] = "/v2/traffic/flow"
    document["endpoints"] = endpoints
    var features = try XCTUnwrap(document["features"] as? [String: Any])
    features["laneGuidance"] = true
    features["offlineBundles"] = "beta"
    features["liveTraffic"] = "soon"
    document["features"] = features
    var coverage = try XCTUnwrap(document["coverage"] as? [String: Any])
    var areas = try XCTUnwrap(coverage["serviceAreas"] as? [[String: Any]])
    areas = areas.map { $0.merging(["timeZone": "America/Edmonton"]) { $1 } }
    areas.append(["id": "saskatchewan", "geometryRef": "/v3/coverage/saskatchewan"])
    coverage["serviceAreas"] = areas
    coverage["modes"] = ["driving", "cycling"]
    document["coverage"] = coverage

    let config = try JSONDecoder().decode(
      NavigationServerConfig.self, from: JSONSerialization.data(withJSONObject: document))
    XCTAssertEqual(config.routesVersion, .v2, "a newer path is tried as v2 with the 404 fallback")
    XCTAssertFalse(config.liveTraffic, "a malformed flag is not available")
    XCTAssertEqual(config.coverage?.areas.map(\.id), ["alberta", "british-columbia"])
  }

  func testAMalformedConfigLeavesCoverageUnknownRatherThanFailing() throws {
    let config = try JSONDecoder().decode(
      NavigationServerConfig.self,
      from: Data(#"{"endpoints":"none","features":[],"coverage":{"displayName":"X","serviceAreas":[{"id":"x"}]}}"#.utf8))
    XCTAssertEqual(config.routesVersion, .v2)
    XCTAssertNil(config.coverage)
  }

  // MARK: Against the deployed production API

  func testProductionRoutesGoStraightToV1WithoutLanes() async throws {
    let paths = CompatPathLog()
    CompatURLProtocol.handler = { request in
      paths.append(request.url!.path)
      switch request.url!.path {
      case "/v2/config": return Self.response(request, try Self.fixture("production-2026-11.v2-config"))
      case "/v1/routes": return Self.response(request, try Self.fixture("production-2026-11.routes-calgary.v1"))
      default: return Self.notFound(request)
      }
    }
    let client = try makeClient()
    let trips = try await client.routes(
      origin: Self.calgaryOrigin, destination: Self.calgaryTower, preferences: NavOSSRoutePreferences())
    _ = try await client.routes(
      origin: Self.calgaryOrigin, destination: Self.calgaryTower, preferences: NavOSSRoutePreferences())

    XCTAssertEqual(paths.values, ["/v2/config", "/v1/routes", "/v1/routes"], "no /v2/routes 404s")
    XCTAssertEqual(trips.count, 3)
    XCTAssertTrue(trips.allSatisfy(\.isValid))
    XCTAssertTrue(trips.flatMap(\.steps).allSatisfy { $0.lanes == nil })
  }

  func testProductionRefusesAPlaceOutsideItsDeclaredCoverageBeforeRequesting() async throws {
    let paths = CompatPathLog()
    CompatURLProtocol.handler = { request in
      paths.append(request.url!.path)
      return request.url!.path == "/v2/config"
        ? Self.response(request, try Self.fixture("production-2026-11.v2-config"))
        : Self.notFound(request)
    }
    do {
      _ = try await makeClient().routes(
        origin: Self.calgaryOrigin, destination: Self.edmonton, preferences: NavOSSRoutePreferences())
      XCTFail("Edmonton is outside what production declares")
    } catch NavOSSNavigationAPIError.outsideCoverage(let name) {
      XCTAssertEqual(name, "Calgary and Kelowna service areas")
    }
    XCTAssertEqual(paths.values, ["/v2/config"])
  }

  func testARerouteIsNotRefusedForCrossingUncoveredRoads() async throws {
    CompatURLProtocol.handler = { request in
      switch request.url!.path {
      case "/v2/config": return Self.response(request, try Self.fixture("production-2026-11.v2-config"))
      case "/v1/routes": return Self.response(request, try Self.fixture("production-2026-11.routes-calgary.v1"))
      default: return Self.notFound(request)
      }
    }
    let trips = try await makeClient().routes(
      origin: .init(latitude: Self.edmonton.latitude, longitude: Self.edmonton.longitude),
      destination: Self.calgaryTower, preferences: NavOSSRoutePreferences(), alternatives: 0,
      requireCoverage: false)
    XCTAssertFalse(trips.isEmpty)
  }

  func testProductionSearchResponsesDecode() async throws {
    CompatURLProtocol.handler = { request in
      request.url!.path == "/v1/search"
        ? Self.response(request, try Self.fixture("production-2026-11.search-calgary-tower"))
        : Self.notFound(request)
    }
    let results = try await makeClient().search(query: "Calgary Tower", proximity: Self.calgaryOrigin)
    XCTAssertEqual(results.first?.name, "Calgary Tower")

    CompatURLProtocol.handler = { request in
      request.url!.path == "/v1/search"
        ? Self.response(request, try Self.fixture("production-2026-11.search-cafe"))
        : Self.notFound(request)
    }
    let cafes = try await makeClient().search(
      query: "Coffee", proximity: Self.calgaryOrigin, category: "cafe")
    XCTAssertEqual(cafes.count, 5)
  }

  func testProductionSafetyCamerasDecode() async throws {
    CompatURLProtocol.handler = { request in
      request.url!.path == "/v1/cameras"
        ? Self.response(request, try Self.fixture("production-2026-11.cameras"))
        : Self.notFound(request)
    }
    let cameras = try await makeClient().safetyCameras()
    XCTAssertEqual(cameras.count, 57)
  }

  func testAServerWithoutCamerasAnswersNotFoundOnce() async throws {
    let paths = CompatPathLog()
    CompatURLProtocol.handler = { request in
      paths.append(request.url!.path)
      return Self.notFound(request)
    }
    do {
      _ = try await makeClient().safetyCameras()
      XCTFail("expected endpointNotFound")
    } catch NavOSSNavigationAPIError.endpointNotFound {}
    XCTAssertEqual(paths.values, ["/v1/cameras"])
  }

  // MARK: Helpers

  private func makeClient() throws -> NavOSSNavigationAPIClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CompatURLProtocol.self]
    return try NavOSSNavigationAPIClient(
      baseURL: Self.baseURL,
      session: URLSession(configuration: configuration),
      routesDiscovery: NavOSSRoutesEndpointDiscovery()
    )
  }

  private static func document(_ name: String) throws -> [String: Any] {
    let wrapper = try JSONSerialization.jsonObject(
      with: Data(contentsOf: fixtures.appendingPathComponent("\(name).json"))) as? [String: Any]
    return try XCTUnwrap(wrapper?["response"] as? [String: Any])
  }

  private static func fixture(_ name: String) throws -> Data {
    try JSONSerialization.data(withJSONObject: document(name))
  }

  private static func config(_ name: String) throws -> NavigationServerConfig {
    try JSONDecoder().decode(NavigationServerConfig.self, from: fixture(name))
  }

  private static func response(_ request: URLRequest, _ data: Data, status: Int = 200)
    -> (HTTPURLResponse, Data)
  {
    (
      HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: nil,
        headerFields: ["content-type": "application/json"])!,
      data
    )
  }

  private static func notFound(_ request: URLRequest) -> (HTTPURLResponse, Data) {
    response(
      request,
      Data(#"{"code":"not_found","detail":"The requested resource does not exist.","status":404,"title":"Not found"}"#.utf8),
      status: 404)
  }
}

private final class CompatPathLog: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: [String] = []
  func append(_ value: String) {
    lock.lock()
    storage.append(value)
    lock.unlock()
  }
  var values: [String] {
    lock.lock()
    defer { lock.unlock() }
    return storage
  }
}

private final class CompatURLProtocol: URLProtocol {
  static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

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
