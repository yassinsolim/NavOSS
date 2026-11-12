import Foundation
import XCTest

@testable import NavOSSNavigationCore

/// Ported from the former `apps/mobile/test/safety-camera-alert.test.ts` when camera eligibility
/// moved into native navigation. The cases and coordinates are unchanged.
final class NavigationSafetyCameraTests: XCTestCase {
  private func coordinates(_ lonLat: [(Double, Double)]) -> [NavigationCoordinate] {
    lonLat.map { NavigationCoordinate(latitude: $0.1, longitude: $0.0) }
  }

  private let northbound = [(-114.08, 51.04), (-114.08, 51.05)]

  private func camera(
    _ id: String,
    _ latitude: Double,
    _ longitude: Double,
    _ direction: NavOSSSafetyCamera.Direction = .northbound
  ) -> NavOSSSafetyCamera {
    NavOSSSafetyCamera(
      id: "calgary-isc:\(id)",
      latitude: latitude,
      longitude: longitude,
      direction: direction,
      location: "14 Street and Example Avenue N.W."
    )
  }

  private func upcoming(
    _ cameras: [NavOSSSafetyCamera],
    route: [(Double, Double)],
    progress: Double,
    announced: Set<String> = []
  ) throws -> (camera: NavOSSSafetyCamera, distanceAheadMeters: Double)? {
    let polyline = try RoutePolyline(coordinates: coordinates(route))
    return NavigationSafetyCameraIndex(cameras: cameras, route: polyline).upcoming(
      afterAlongMeters: progress * polyline.totalDistanceMeters,
      excluding: announced
    )
  }

  func testSelectsTheNearestDirectionAlignedCameraAheadOnTheRoute() throws {
    let result = try upcoming(
      [camera("far", 51.047, -114.08), camera("near", 51.045, -114.08)],
      route: northbound,
      progress: 0.2
    )
    XCTAssertEqual(result?.camera.id, "calgary-isc:near")
    XCTAssertGreaterThan(result?.distanceAheadMeters ?? 0, 300)
    XCTAssertLessThan(result?.distanceAheadMeters ?? 1_000, 400)
  }

  func testIgnoresOppositeDirectionAndOffRouteCameras() throws {
    XCTAssertNil(
      try upcoming(
        [camera("opposite", 51.045, -114.08, .southbound), camera("off-route", 51.045, -114.078)],
        route: northbound,
        progress: 0.2
      )
    )
  }

  func testIgnoresCamerasBehindTheCurrentProgress() throws {
    XCTAssertNil(try upcoming([camera("behind", 51.042, -114.08)], route: northbound, progress: 0.5))
  }

  func testDoesNotReturnACameraThatWasAlreadyAnnounced() throws {
    XCTAssertNil(
      try upcoming(
        [camera("announced", 51.045, -114.08)],
        route: northbound,
        progress: 0.2,
        announced: ["calgary-isc:announced"]
      )
    )
  }

  func testAlertsForADirectionAlignedRoadsideCameraWithinTheLateralAllowance() throws {
    XCTAssertEqual(
      try upcoming([camera("roadside", 51.045, -114.0795)], route: northbound, progress: 0.2)?
        .camera.id,
      "calgary-isc:roadside"
    )
  }

  func testKeepsAnAlignedCameraOutsideTheLookaheadSilent() throws {
    XCTAssertNil(try upcoming([camera("too-far", 51.047, -114.08)], route: northbound, progress: 0.2))
  }

  private struct CardinalCase {
    let geometry: [(Double, Double)]
    let match: NavOSSSafetyCamera.Direction
    let midpoint: (Double, Double)
    let opposite: NavOSSSafetyCamera.Direction
    let perpendiculars: (NavOSSSafetyCamera.Direction, NavOSSSafetyCamera.Direction)
  }

  private let cardinalCases = [
    CardinalCase(
      geometry: [(-114.08, 51.04), (-114.08, 51.05)], match: .northbound,
      midpoint: (-114.08, 51.045), opposite: .southbound, perpendiculars: (.eastbound, .westbound)
    ),
    CardinalCase(
      geometry: [(-114.08, 51.05), (-114.08, 51.04)], match: .southbound,
      midpoint: (-114.08, 51.045), opposite: .northbound, perpendiculars: (.eastbound, .westbound)
    ),
    CardinalCase(
      geometry: [(-114.08, 51.04), (-114.064096, 51.04)], match: .eastbound,
      midpoint: (-114.072048, 51.04), opposite: .westbound,
      perpendiculars: (.northbound, .southbound)
    ),
    CardinalCase(
      geometry: [(-114.064096, 51.04), (-114.08, 51.04)], match: .westbound,
      midpoint: (-114.072048, 51.04), opposite: .eastbound,
      perpendiculars: (.northbound, .southbound)
    ),
  ]

  func testSelectsTheAlignedCameraAndIgnoresOppositeAndPerpendicularAtTheSamePoint() throws {
    for item in cardinalCases {
      let (longitude, latitude) = item.midpoint
      let result = try upcoming(
        [
          camera("aligned", latitude, longitude, item.match),
          camera("opposite", latitude, longitude, item.opposite),
          camera("perpendicular-a", latitude, longitude, item.perpendiculars.0),
          camera("perpendicular-b", latitude, longitude, item.perpendiculars.1),
        ],
        route: item.geometry,
        progress: 0.2
      )
      XCTAssertEqual(result?.camera.id, "calgary-isc:aligned", "\(item.match)")
      XCTAssertGreaterThan(result?.distanceAheadMeters ?? 0, 300)
      XCTAssertLessThan(result?.distanceAheadMeters ?? 1_000, 400)

      XCTAssertNil(
        try upcoming(
          [
            camera("opposite", latitude, longitude, item.opposite),
            camera("perpendicular-a", latitude, longitude, item.perpendiculars.0),
            camera("perpendicular-b", latitude, longitude, item.perpendiculars.1),
          ],
          route: item.geometry,
          progress: 0.2
        ),
        "\(item.match)"
      )
    }
  }

  private let turnRoute = [(-114.08, 51.04), (-114.08, 51.05), (-114.075708, 51.05)]
  private let turnRouteProgress = 0.6813

  func testSelectsTheIncomingCameraAtATurnVertexOverTheOutgoingOne() throws {
    let result = try upcoming(
      [
        camera("vertex-north", 51.05, -114.08, .northbound),
        camera("vertex-east", 51.05, -114.08, .eastbound),
      ],
      route: turnRoute,
      progress: turnRouteProgress
    )
    XCTAssertEqual(result?.camera.id, "calgary-isc:vertex-north")
    XCTAssertGreaterThan(result?.distanceAheadMeters ?? 0, 100)
    XCTAssertLessThan(result?.distanceAheadMeters ?? 1_000, 200)
  }

  func testSuppressesAnOutgoingLegCameraExactlyAtTheSharedVertexBeforeTheTurn() throws {
    XCTAssertNil(
      try upcoming(
        [camera("vertex-east", 51.05, -114.08, .eastbound)],
        route: turnRoute,
        progress: turnRouteProgress
      )
    )
  }

  func testStillAlertsForARealCameraFurtherAlongTheRoadAfterTheTurn() throws {
    let result = try upcoming(
      [camera("east-far", 51.05, -114.077139, .eastbound)],
      route: turnRoute,
      progress: turnRouteProgress
    )
    XCTAssertEqual(result?.camera.id, "calgary-isc:east-far")
    XCTAssertGreaterThan(result?.distanceAheadMeters ?? 0, 300)
    XCTAssertLessThan(result?.distanceAheadMeters ?? 1_000, 400)
  }

  func testRepeatedSharedVertexDoesNotChangeTheVertexSelection() throws {
    let duplicate = [(-114.08, 51.04), (-114.08, 51.05), (-114.08, 51.05), (-114.075708, 51.05)]
    XCTAssertEqual(
      try upcoming(
        [
          camera("vertex-north", 51.05, -114.08, .northbound),
          camera("vertex-east", 51.05, -114.08, .eastbound),
        ],
        route: duplicate,
        progress: turnRouteProgress
      )?.camera.id,
      "calgary-isc:vertex-north"
    )
    XCTAssertNil(
      try upcoming(
        [camera("vertex-east", 51.05, -114.08, .eastbound)],
        route: duplicate,
        progress: turnRouteProgress
      )
    )
  }

  func testDoesNotAlertPastTheRouteEndOrBeforeItsStart() throws {
    XCTAssertNil(
      try upcoming([camera("beyond-end", 51.05027, -114.08)], route: northbound, progress: 0.95)
    )
    XCTAssertNil(
      try upcoming([camera("before-start", 51.03973, -114.08)], route: northbound, progress: 0.02)
    )
  }

  func testRequiresTheNearestPhysicalApproachToMatchDirection() throws {
    let parallelReturn = [
      (-114.09, 51.0), (-114.09, 51.001799), (-114.089714, 51.001799), (-114.089714, 51.0),
    ]
    let southbound = camera("near-wrong-direction", 51.0009, -114.09, .southbound)
    XCTAssertNil(try upcoming([southbound], route: parallelReturn, progress: 0))
    // Once the closer northbound pass is behind, the upcoming southbound pass is eligible.
    XCTAssertEqual(
      try upcoming([southbound], route: parallelReturn, progress: 0.6)?.camera.id,
      "calgary-isc:near-wrong-direction"
    )
  }

  // MARK: - Monitor: ownership in native navigation

  private func snapshot(
    progress: Double,
    isOffRoute: Bool = false,
    sequence: Int = 1
  ) -> NavigationSnapshot {
    let coordinate = NavigationCoordinate(latitude: 51.04 + progress * 0.01, longitude: -114.08)
    return NavigationSnapshot(
      distanceFromRouteMeters: 2,
      horizontalAccuracyMeters: 5,
      isOffRoute: isOffRoute,
      matchedCoordinate: isOffRoute ? nil : coordinate,
      matchedCourseDegrees: isOffRoute ? nil : 0,
      phase: .tracking,
      rawCoordinate: coordinate,
      routeProgress: progress,
      routeVersion: 1,
      sequence: sequence
    )
  }

  func testMonitorAnnouncesOncePerTripTracksDistanceAndClearsOncePassed() {
    var monitor = NavigationSafetyCameraMonitor()
    monitor.setCameras([camera("near", 51.045, -114.08)])
    monitor.startTrip(geometry: coordinates(northbound))

    XCTAssertFalse(monitor.update(snapshot: snapshot(progress: 0.05)), "still beyond 450 m")
    XCTAssertTrue(monitor.update(snapshot: snapshot(progress: 0.2)))
    let first = monitor.activeAlert
    XCTAssertEqual(first?.cameraId, "calgary-isc:near")
    XCTAssertFalse(monitor.update(snapshot: snapshot(progress: 0.3)), "never twice")
    XCTAssertEqual(monitor.activeAlert?.sequence, first?.sequence)
    XCTAssertLessThan(monitor.activeAlert?.distanceAheadMeters ?? 1_000, first?.distanceAheadMeters ?? 0)
    XCTAssertFalse(monitor.update(snapshot: snapshot(progress: 0.6)))
    XCTAssertNil(monitor.activeAlert, "a passed camera is no longer presented")
  }

  func testMonitorStaysSilentOffRouteAndWhileReversing() {
    var monitor = NavigationSafetyCameraMonitor()
    monitor.setCameras([camera("near", 51.045, -114.08)])
    monitor.startTrip(geometry: coordinates(northbound))
    XCTAssertFalse(monitor.update(snapshot: snapshot(progress: 0.2, isOffRoute: true)))
    XCTAssertNil(monitor.activeAlert)

    var reversing = NavigationSafetyCameraMonitor()
    reversing.setCameras([camera("near", 51.045, -114.08)])
    reversing.startTrip(geometry: coordinates(northbound))
    XCTAssertFalse(reversing.update(snapshot: snapshot(progress: 0.6)), "camera already behind")
    XCTAssertFalse(
      reversing.update(snapshot: snapshot(progress: 0.45)),
      "backing up toward a camera is not approaching it"
    )
    XCTAssertTrue(reversing.update(snapshot: snapshot(progress: 0.46)), "forward again: alert")
  }

  func testRerouteKeepsAnnouncedCamerasButANewTripResetsThem() {
    var monitor = NavigationSafetyCameraMonitor()
    monitor.setCameras([camera("near", 51.045, -114.08)])
    monitor.startTrip(geometry: coordinates(northbound))
    XCTAssertTrue(monitor.update(snapshot: snapshot(progress: 0.2)))

    monitor.replaceRoute(geometry: coordinates(northbound))
    XCTAssertFalse(monitor.update(snapshot: snapshot(progress: 0.2)), "same trip after reroute")

    monitor.startTrip(geometry: coordinates(northbound))
    XCTAssertTrue(monitor.update(snapshot: snapshot(progress: 0.2)), "a new trip alerts again")
  }

  func testCamerasArrivingAfterTheTripStartAreStillUsed() {
    var monitor = NavigationSafetyCameraMonitor()
    monitor.startTrip(geometry: coordinates(northbound))
    XCTAssertFalse(monitor.update(snapshot: snapshot(progress: 0.1)))
    monitor.setCameras([camera("near", 51.045, -114.08)])
    XCTAssertTrue(monitor.update(snapshot: snapshot(progress: 0.2)))
  }
}
