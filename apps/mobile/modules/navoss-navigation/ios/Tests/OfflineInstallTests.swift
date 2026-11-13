import XCTest

@testable import NavOSSNavigationCore

final class OfflineInstallTests: XCTestCase {
  private func manifest() throws -> NavOSSOfflineManifest {
    try NavOSSOfflineManifest.parse(OfflineFixtures.data("manifest-2026-11-11.json"))
  }

  func testDownloadPauseResumeVerifyInstall() {
    var activity = NavOSSOfflineActivity.idle
    let steps: [(NavOSSOfflineEvent, NavOSSOfflineActivity)] = [
      (.request, .queued),
      (.start(totalBytes: 100, receivedBytes: 0), .downloading(receivedBytes: 0, totalBytes: 100)),
      (.progress(receivedBytes: 40), .downloading(receivedBytes: 40, totalBytes: 100)),
      (.pause, .paused(receivedBytes: 40, totalBytes: 100)),
      (.request, .queued),
      // A resume restarts from the bytes already on disk, not from zero.
      (.start(totalBytes: 100, receivedBytes: 40), .downloading(receivedBytes: 40, totalBytes: 100)),
      (.progress(receivedBytes: 100), .downloading(receivedBytes: 100, totalBytes: 100)),
      (.downloaded, .verifying),
      (.verified, .installing),
      (.installed, .idle),
    ]
    for (event, expected) in steps {
      activity = navOSSOfflineTransition(activity, event) ?? activity
      XCTAssertEqual(activity, expected, "after \(event)")
    }
  }

  func testRejectsTransitionsThatWouldCorruptState() {
    let downloading = NavOSSOfflineActivity.downloading(receivedBytes: 10, totalBytes: 100)
    XCTAssertNil(navOSSOfflineTransition(.idle, .progress(receivedBytes: 5)))
    XCTAssertNil(navOSSOfflineTransition(.paused(receivedBytes: 1, totalBytes: 2), .progress(receivedBytes: 2)))
    XCTAssertNil(navOSSOfflineTransition(downloading, .progress(receivedBytes: 101)))
    // Incomplete bytes can never be verified or installed.
    XCTAssertNil(navOSSOfflineTransition(downloading, .downloaded))
    XCTAssertNil(navOSSOfflineTransition(downloading, .installed))
    XCTAssertNil(navOSSOfflineTransition(.verifying, .pause))
    XCTAssertNil(navOSSOfflineTransition(.installing, .cancel))
    XCTAssertNil(navOSSOfflineTransition(.queued, .start(totalBytes: 10, receivedBytes: 11)))
  }

  func testFailuresKeepResumableBytesOnlyForTransferErrors() {
    let downloading = NavOSSOfflineActivity.downloading(receivedBytes: 60, totalBytes: 100)
    XCTAssertEqual(
      navOSSOfflineTransition(downloading, .fail(.network)),
      .failed(.network, receivedBytes: 60, totalBytes: 100))
    XCTAssertEqual(
      navOSSOfflineTransition(.verifying, .fail(.integrity)),
      .failed(.integrity, receivedBytes: 0, totalBytes: 0))
    XCTAssertEqual(
      navOSSOfflineTransition(.failed(.network, receivedBytes: 60, totalBytes: 100), .request),
      .queued)
    XCTAssertEqual(navOSSOfflineTransition(.paused(receivedBytes: 1, totalBytes: 2), .cancel), .idle)
  }

  func testBudgetCountsSharedResourcesOnceAndPartialBytes() throws {
    let calgary = try XCTUnwrap(try manifest().region(id: "calgary"))
    let fresh = navOSSOfflineRequiredBytes(
      region: calgary, alreadyDownloadedBytes: 0, resourcesInstalled: false)
    let downloads: Int64 = 284_360_731 + 61_597_437 + 105_001_070
    XCTAssertEqual(fresh, downloads + max(64 * 1_048_576, downloads / 50))
    let resumed = navOSSOfflineRequiredBytes(
      region: calgary, alreadyDownloadedBytes: 84_360_731, resourcesInstalled: true)
    XCTAssertEqual(resumed, 200_000_000 + 64 * 1_048_576)
  }

  func testSnapshotStorageAndCoveringRegion() throws {
    let manifest = try manifest()
    let calgary = try XCTUnwrap(manifest.region(id: "calgary"))
    let alberta = try XCTUnwrap(manifest.region(id: "alberta"))
    func installed(_ region: NavOSSOfflineRegion) -> NavOSSOfflineInstalledRegion {
      NavOSSOfflineInstalledRegion(
        region: region, bundleVersion: manifest.bundleVersion, graphId: manifest.graph.id,
        osmTimestamp: manifest.osmTimestamp, installedAt: Date(timeIntervalSince1970: 0))
    }
    var snapshot = NavOSSOfflineActiveSnapshot().installing(installed(calgary))
    XCTAssertEqual(snapshot.storageBytes, 284_360_731 + 105_001_070)
    snapshot = snapshot.installing(installed(alberta))
    XCTAssertEqual(snapshot.regions.map(\.region.id), ["alberta", "calgary"])
    // One shared resource set for both regions.
    XCTAssertEqual(snapshot.referencedResources.count, 1)
    XCTAssertEqual(
      snapshot.storageBytes,
      284_360_731 + alberta.regionDownloadBytes + 105_001_070)

    let downtown = NavOSSCarPlayCoordinate(latitude: 51.0447, longitude: -114.0631)
    let edmonton = NavOSSCarPlayCoordinate(latitude: 53.5461, longitude: -113.4938)
    // The widest pack covering the whole trip wins.
    XCTAssertEqual(
      navOSSOfflineCoveringRegion(snapshot.regions, points: [downtown])?.region.id, "alberta")
    XCTAssertEqual(
      navOSSOfflineCoveringRegion(snapshot.regions, points: [downtown, edmonton])?.region.id,
      "alberta")
    let cityOnly = snapshot.removing(regionId: "alberta")
    XCTAssertEqual(
      navOSSOfflineCoveringRegion(cityOnly.regions, points: [downtown])?.region.id, "calgary")
    // A trip leaving the only installed pack is not routed offline.
    XCTAssertNil(navOSSOfflineCoveringRegion(cityOnly.regions, points: [downtown, edmonton]))

    let encoded = try JSONEncoder().encode(snapshot)
    XCTAssertEqual(try JSONDecoder().decode(NavOSSOfflineActiveSnapshot.self, from: encoded), snapshot)
  }

  func testDeletionWaitsForAnOfflineRouteOverTheRegion() throws {
    let manifest = try manifest()
    let calgary = try XCTUnwrap(manifest.region(id: "calgary"))
    let downtown = NavOSSCarPlayCoordinate(latitude: 51.0447, longitude: -114.0719)
    let north = NavOSSCarPlayCoordinate(latitude: 51.0866, longitude: -114.1305)
    let step = NavOSSCarPlayRouteStep(
      distanceMeters: 1, durationSeconds: 1, geometry: [downtown, north], instruction: "Drive",
      maneuverType: "depart", roadName: "")
    func trip(source: String?, geometry: [NavOSSCarPlayCoordinate]) -> NavOSSCarPlayTrip {
      NavOSSCarPlayTrip(
        destination: NavOSSCarPlayDestination(
          id: "d", label: "D", latitude: north.latitude, longitude: north.longitude, name: "D"),
        distanceMeters: 1, durationSeconds: 1, geometry: geometry, id: "t", source: source,
        steps: [step])
    }
    XCTAssertTrue(
      navOSSOfflineDeletionBlocked(
        region: calgary, activeTrip: trip(source: "offline-valhalla", geometry: [downtown, north])))
    // An online route does not read the region's files.
    XCTAssertFalse(
      navOSSOfflineDeletionBlocked(
        region: calgary, activeTrip: trip(source: "valhalla-self-hosted", geometry: [downtown, north])))
    XCTAssertFalse(
      navOSSOfflineDeletionBlocked(
        region: calgary,
        activeTrip: trip(
          source: "offline-valhalla",
          geometry: [.init(latitude: 53.5, longitude: -113.5), .init(latitude: 53.6, longitude: -113.5)])))
    XCTAssertFalse(navOSSOfflineDeletionBlocked(region: calgary, activeTrip: nil))
  }

  func testPolygonHolesAreExcluded() {
    func ring(_ west: Double, _ south: Double, _ east: Double, _ north: Double)
      -> [NavOSSCarPlayCoordinate]
    {
      [
        .init(latitude: south, longitude: west), .init(latitude: south, longitude: east),
        .init(latitude: north, longitude: east), .init(latitude: north, longitude: west),
        .init(latitude: south, longitude: west),
      ]
    }
    let polygon = [[ring(0, 0, 10, 10), ring(4, 4, 6, 6)]]
    XCTAssertTrue(navOSSOfflinePolygonContains(polygon, .init(latitude: 2, longitude: 2)))
    XCTAssertFalse(navOSSOfflinePolygonContains(polygon, .init(latitude: 5, longitude: 5)))
    XCTAssertFalse(navOSSOfflinePolygonContains(polygon, .init(latitude: 11, longitude: 5)))
  }

  func testLayoutMatchesTheDocumentedTree() {
    let layout = NavOSSOfflineLayout(root: URL(fileURLWithPath: "/AS/NavOSSOffline", isDirectory: true))
    XCTAssertEqual(
      layout.region(regionId: "calgary", bundleVersion: "2026-11-11-v1-798f5c442644").path,
      "/AS/NavOSSOffline/regions/calgary/2026-11-11-v1-798f5c442644")
    XCTAssertEqual(
      layout.staging(bundleVersion: "v", regionId: "calgary").path,
      "/AS/NavOSSOffline/staging/v/calgary")
    XCTAssertEqual(layout.shared(resourcesSha256: "abc").path, "/AS/NavOSSOffline/shared/abc")
    XCTAssertEqual(layout.activeSnapshot.path, "/AS/NavOSSOffline/active.json")
  }
}
