import Foundation
import XCTest

@testable import NavOSSNavigationCore

/// The service end to end against a stubbed API: guidance fetches the route ahead, publishes
/// reports to the CarPlay map store, and alerts for the one on the route.
final class CommunityServiceTests: XCTestCase {
  private let routeStart = NavOSSCarPlayCoordinate(latitude: 51.0447, longitude: -114.2)

  private func point(_ meters: Double) -> NavOSSCarPlayCoordinate {
    NavOSSCarPlayCoordinate(
      latitude: 51.0447,
      longitude: -114.2 + meters / (navigationMetersPerDegreeLatitude * cos(51.0447 * .pi / 180))
    )
  }

  private func makeService(
    live: Bool,
    alertStore: NavOSSCarPlayMapAlertStore
  ) -> NavOSSCommunityService {
    CommunityStubProtocol.sent = []
    let onRoute = point(1_500)
    CommunityStubProtocol.handler = { sent in
      switch sent.path {
      case "/v2/config":
        return (200, ["features": ["communityReports": live]], [:])
      case "/v2/community/reports":
        return (
          200,
          [
            "generatedAt": "2026-11-12T18:04:00.000Z",
            "publication": "attested",
            "reports": [
              [
                "confirmations": 0,
                "coordinate": ["latitude": onRoute.latitude, "longitude": onRoute.longitude],
                "expiresAt": "2099-11-12T20:05:00.000Z",
                "id": "2f1a3c55-4b7e-4f8e-9f0e-0f1d2c3b4a59",
                "reportedAt": "2026-11-12T18:00:00.000Z",
                "source": "navoss-community",
                "state": "unconfirmed",
                "type": "road-closure",
              ]
            ],
          ],
          [:]
        )
      default:
        return (503, [:], [:])
      }
    }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CommunityStubProtocol.self]
    let client = NavOSSCommunityClient(
      baseURL: URL(string: "http://127.0.0.1:3001")!,
      provider: NavOSSUnavailableAttestationProvider(),
      store: NavOSSCommunityMemorySecretStore(),
      session: URLSession(configuration: configuration)
    )
    let defaults = UserDefaults(suiteName: "community-service-\(UUID().uuidString)")!
    return NavOSSCommunityService(
      client: client,
      preferencesStore: NavOSSCommunityPreferencesStore(
        defaults: defaults, notificationCenter: NotificationCenter()),
      alertStore: alertStore,
      notificationCenter: NotificationCenter()
    )
  }

  private func trip() -> NavOSSCarPlayTrip {
    let geometry = stride(from: 0.0, through: 5_000, by: 250).map { point($0) }
    return NavOSSCarPlayTrip(
      destination: NavOSSCarPlayDestination(
        category: nil, id: "d", label: "D", latitude: geometry.last!.latitude,
        longitude: geometry.last!.longitude, name: "D"),
      distanceMeters: 5_000,
      durationSeconds: 400,
      geometry: geometry,
      id: "trip",
      steps: [
        NavOSSCarPlayRouteStep(
          distanceMeters: 5_000, durationSeconds: 400, geometry: geometry,
          instruction: "Drive east.", maneuverType: "depart", roadName: "Test Road")
      ]
    )
  }

  private func waitFor(_ condition: () -> Bool) async {
    for _ in 0..<200 where !condition() {
      try? await Task.sleep(nanoseconds: 10_000_000)
    }
  }

  func testGuidanceFetchesTheRouteAheadPublishesMarkersAndAlertsOnce() async {
    let alertStore = NavOSSCarPlayMapAlertStore(notificationCenter: NotificationCenter())
    let service = makeService(live: true, alertStore: alertStore)
    service.navigationDidStart(trip())
    await waitFor { !alertStore.snapshot().isEmpty }
    XCTAssertEqual(alertStore.snapshot().map(\.kind), [.report(.roadClosure)])
    // The read carried no identity: a plain GET with only the bounding box.
    let read = CommunityStubProtocol.sent.first { $0.path == "/v2/community/reports" }
    XCTAssertEqual(read?.method, "GET")
    XCTAssertNil(read?.body)

    var alerts: [String] = []
    for along in stride(from: 0.0, through: 3_000, by: 50) {
      if let alert = service.navigationDidUpdate(routeProgress: along / 5_000, isTracking: true) {
        alerts.append(alert.reportId)
      }
    }
    XCTAssertEqual(alerts, ["2f1a3c55-4b7e-4f8e-9f0e-0f1d2c3b4a59"])
    service.navigationDidEnd()
    XCTAssertNil(service.navigationDidUpdate(routeProgress: 0.1, isTracking: true))
  }

  func testNothingIsFetchedOrDrawnWhileTheServerKeepsReportsOff() async {
    let alertStore = NavOSSCarPlayMapAlertStore(notificationCenter: NotificationCenter())
    let service = makeService(live: false, alertStore: alertStore)
    service.navigationDidStart(trip())
    await waitFor { CommunityStubProtocol.sent.contains { $0.path == "/v2/config" } }
    try? await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertFalse(CommunityStubProtocol.sent.contains { $0.path == "/v2/community/reports" })
    XCTAssertEqual(alertStore.snapshot(), [])
    let availability = await service.availability()
    XCTAssertEqual(availability.reportsLive, false)
    XCTAssertFalse(availability.canWrite)
    XCTAssertEqual(availability.trafficSharing, .off)
  }

  /// Production today: an older API without `/v2/community/*` or `/v2/traffic/*` (404) and, where
  /// `/v2/config` exists, `communityReports: false`. The client must stay silent.
  func testAnOlderServerGetsNoRegistrationNoChallengesAndNoRetryLoop() async {
    for configAnswer in [404, 200] {
      CommunityStubProtocol.sent = []
      CommunityStubProtocol.handler = { sent in
        if sent.path == "/v2/config", configAnswer == 200 {
          return (200, ["features": ["communityReports": false]], [:])
        }
        return (404, ["code": "not_found", "detail": "x", "requestId": "r", "status": 404, "title": "Not Found"], [:])
      }
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [CommunityStubProtocol.self]
      let client = NavOSSCommunityClient(
        baseURL: URL(string: "http://127.0.0.1:3001")!,
        provider: NavOSSDevelopmentAttestationProvider(
          teamId: "ABCDE12345", bundleId: "org.navoss.mobile",
          store: NavOSSCommunityMemorySecretStore()),
        store: NavOSSCommunityMemorySecretStore(),
        session: URLSession(configuration: configuration)
      )
      let defaults = UserDefaults(suiteName: "community-old-\(UUID().uuidString)")!
      let preferences = NavOSSCommunityPreferencesStore(defaults: defaults, notificationCenter: NotificationCenter())
      preferences.setSharesTrafficSpeeds(true)
      let alertStore = NavOSSCarPlayMapAlertStore(notificationCenter: NotificationCenter())
      let service = NavOSSCommunityService(
        client: client, preferencesStore: preferences, alertStore: alertStore,
        notificationCenter: NotificationCenter())
      service.navigationDidStart(trip())
      for _ in 0..<30 {
        service.navigationClockTick()
        _ = await service.refreshFeatures()
        _ = try? await service.fetchReports(
          in: NavOSSCommunityBounds(east: -114.0, north: 51.1, south: 51.0, west: -114.1))
        try? await Task.sleep(nanoseconds: 10_000_000)
      }
      do {
        _ = try await service.submitReport(type: .pothole, coordinate: point(10), heading: nil)
        XCTFail("submit must not proceed")
      } catch {}
      await waitFor { service.trafficSharingState() != .ready && service.trafficSharingState() != .starting }
      let paths = CommunityStubProtocol.sent.map(\.path)
      XCTAssertEqual(paths.filter { $0 == "/v2/config" }.count, 1, "config \(configAnswer): \(paths)")
      XCTAssertEqual(paths.filter { $0 == "/v2/traffic/status" }.count, 1, "\(paths)")
      XCTAssertFalse(paths.contains { $0.hasPrefix("/v2/community") }, "\(paths)")
      XCTAssertFalse(paths.contains("/v2/traffic/credentials"))
      XCTAssertEqual(alertStore.snapshot(), [])
      XCTAssertEqual(service.trafficSharingState(), .unavailable(reason: .notAccepting))
      XCTAssertEqual(navOSSCarPlayTrafficSharingDetail(service.trafficSharingState()), "Not available yet")
      service.navigationDidEnd()
      // A second trip does not ask a server that answered 404 again.
      service.navigationDidStart(trip())
      try? await Task.sleep(nanoseconds: 100_000_000)
      XCTAssertEqual(CommunityStubProtocol.sent.filter { $0.path == "/v2/traffic/status" }.count, 1)
      service.navigationDidEnd()
    }
  }

  func testAConfigWithoutTheCommunityFlagMeansOff() async throws {
    CommunityStubProtocol.sent = []
    CommunityStubProtocol.handler = { _ in (200, ["features": ["liveTraffic": false]], [:]) }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CommunityStubProtocol.self]
    let client = NavOSSCommunityClient(
      baseURL: URL(string: "http://127.0.0.1:3001")!,
      provider: NavOSSUnavailableAttestationProvider(),
      store: NavOSSCommunityMemorySecretStore(),
      session: URLSession(configuration: configuration)
    )
    let features = try await client.features()
    XCTAssertFalse(features.communityReports)
  }
}
