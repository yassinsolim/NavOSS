import XCTest

@testable import NavOSSNavigationCore

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

final class OfflineFallbackTests: XCTestCase {
  private final class Fallback: NavOSSOfflineNavigationFallback, @unchecked Sendable {
    var isNetworkAvailable = true
    var hasInstalledRegions = true
    var covered = true
    var routeCalls = 0
    var searchCalls = 0

    func covers(_ points: [NavOSSCarPlayCoordinate]) -> Bool { covered }

    func offlineRoutes(
      origin: NavOSSCarPlayCoordinate, originHeadingDegrees: Double?,
      originHorizontalAccuracyMeters: Double?, destination: NavOSSCarPlayDestination,
      preferences: NavOSSRoutePreferences, alternatives: Int, waypoints: [NavOSSCarPlayDestination]
    ) async throws -> [NavOSSCarPlayTrip] {
      routeCalls += 1
      return try navOSSOfflineTrips(
        fromValhallaJSON: OfflineFixtures.data("calgary-roundabout.response.json"),
        destination: destination, waypoints: waypoints, preferences: preferences)
    }

    func offlineSearch(
      query: String, proximity: NavOSSCarPlayCoordinate?, limit: Int, category: String?
    ) async throws -> [NavOSSCarPlayDestination] {
      searchCalls += 1
      return [
        NavOSSCarPlayDestination(
          category: "poi", id: "nominatim:way:25719793", label: "101 9 Avenue SE",
          latitude: 51.0443, longitude: -114.0631, name: "Calgary Tower")
      ]
    }
  }

  private final class StubProtocol: URLProtocol {
    nonisolated(unsafe) static var status: Int?
    nonisolated(unsafe) static var requests = 0

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
      Self.requests += 1
      guard let status = Self.status else {
        client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
        return
      }
      let response = HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data("{}".utf8))
      client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
  }

  private let destination = NavOSSCarPlayDestination(
    id: "d", label: "D", latitude: 51.0058566, longitude: -114.1293373, name: "D")
  private let origin = NavOSSCarPlayCoordinate(latitude: 51.0037312, longitude: -114.126945)

  override func setUp() {
    StubProtocol.status = nil
    StubProtocol.requests = 0
  }

  private func client(_ fallback: Fallback?) throws -> NavOSSNavigationAPIClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubProtocol.self]
    return try NavOSSNavigationAPIClient(
      baseURL: URL(string: "https://api.invalid")!, session: URLSession(configuration: configuration),
      offlineFallback: fallback)
  }

  func testUnreachableServiceFallsBackToAnOfflineRouteInsideCoverage() async throws {
    let fallback = Fallback()
    let trips = try await client(fallback).routes(
      origin: origin, destination: destination, preferences: NavOSSRoutePreferences())
    XCTAssertEqual(StubProtocol.requests, 1, "online is always tried first")
    XCTAssertEqual(fallback.routeCalls, 1)
    XCTAssertEqual(trips.first?.source, "offline-valhalla")

    StubProtocol.status = 503
    _ = try await client(fallback).routes(
      origin: origin, destination: destination, preferences: NavOSSRoutePreferences())
    XCTAssertEqual(fallback.routeCalls, 2)
  }

  func testNoNetworkGoesStraightToOfflineAndRecoveryGoesBackOnline() async throws {
    let fallback = Fallback()
    fallback.isNetworkAvailable = false
    _ = try await client(fallback).routes(
      origin: origin, destination: destination, preferences: NavOSSRoutePreferences())
    XCTAssertEqual(StubProtocol.requests, 0)
    XCTAssertEqual(fallback.routeCalls, 1)

    // Connectivity is back: the next request reaches the service again.
    fallback.isNetworkAvailable = true
    StubProtocol.status = 400
    do {
      _ = try await client(fallback).routes(
        origin: origin, destination: destination, preferences: NavOSSRoutePreferences())
      XCTFail("a rejected request is not answered offline")
    } catch {
      XCTAssertEqual(error as? NavOSSNavigationAPIError, .invalidRequest)
    }
    XCTAssertGreaterThan(StubProtocol.requests, 0)
    XCTAssertEqual(fallback.routeCalls, 1)
  }

  func testTripsOutsideInstalledCoverageStayOnline() async throws {
    let fallback = Fallback()
    fallback.covered = false
    do {
      _ = try await client(fallback).routes(
        origin: origin, destination: destination, preferences: NavOSSRoutePreferences())
      XCTFail("expected the online failure")
    } catch {
      XCTAssertTrue(error is URLError)
    }
    XCTAssertEqual(fallback.routeCalls, 0)
  }

  func testOfflineSearchResultsAreLabelled() async throws {
    let fallback = Fallback()
    let results = try await client(fallback).search(query: "tower", proximity: origin)
    XCTAssertEqual(fallback.searchCalls, 1)
    XCTAssertEqual(results.first?.label, "Offline result · 101 9 Avenue SE")

    let online = try client(nil)
    do {
      _ = try await online.search(query: "tower", proximity: origin)
      XCTFail("no fallback installed")
    } catch {
      XCTAssertTrue(error is URLError)
    }
  }
}
