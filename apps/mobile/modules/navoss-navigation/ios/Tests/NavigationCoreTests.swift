import XCTest
@testable import NavOSSNavigationCore

final class NavigationCoreTests: XCTestCase {
  func testProjectsLocationOntoRouteSegment() throws {
    let core = NavigationCore()
    try core.setRoute([
      NavigationCoordinate(latitude: 51.04, longitude: -114.08),
      NavigationCoordinate(latitude: 51.04, longitude: -114.06)
    ])

    let snapshot = try core.updateLocation(
      NavigationCoordinate(latitude: 51.041, longitude: -114.07)
    )
    let matchedCoordinate = try XCTUnwrap(snapshot.matchedCoordinate)

    XCTAssertEqual(snapshot.phase, .tracking)
    XCTAssertEqual(snapshot.rawCoordinate?.latitude, 51.041)
    XCTAssertEqual(matchedCoordinate.latitude, 51.04, accuracy: 0.000_001)
    XCTAssertEqual(matchedCoordinate.longitude, -114.07, accuracy: 0.000_001)
    XCTAssertEqual(snapshot.distanceFromRouteMeters ?? 0, 111.2, accuracy: 0.5)
    XCTAssertEqual(snapshot.routeProgress, 0.5, accuracy: 0.001)
  }

  func testSelectsNearestSegmentOnBentRoute() throws {
    let core = NavigationCore()
    try core.setRoute([
      NavigationCoordinate(latitude: 51.04, longitude: -114.08),
      NavigationCoordinate(latitude: 51.05, longitude: -114.08),
      NavigationCoordinate(latitude: 51.05, longitude: -114.06)
    ])

    let snapshot = try core.updateLocation(
      NavigationCoordinate(latitude: 51.0502, longitude: -114.07)
    )
    let matchedCoordinate = try XCTUnwrap(snapshot.matchedCoordinate)

    XCTAssertEqual(matchedCoordinate.latitude, 51.05, accuracy: 0.000_001)
    XCTAssertEqual(matchedCoordinate.longitude, -114.07, accuracy: 0.000_001)
    XCTAssertGreaterThan(snapshot.routeProgress, 0.5)
  }

  func testUsesCourseToChooseDirectionOnParallelRoads() throws {
    let eastboundCore = NavigationCore()
    let westboundCore = NavigationCore()
    let route = [
      NavigationCoordinate(latitude: 51.04, longitude: -114.08),
      NavigationCoordinate(latitude: 51.04, longitude: -114.06),
      NavigationCoordinate(latitude: 51.0402, longitude: -114.06),
      NavigationCoordinate(latitude: 51.0402, longitude: -114.08)
    ]
    try eastboundCore.setRoute(route)
    try westboundCore.setRoute(route)
    let coordinate = NavigationCoordinate(latitude: 51.0401, longitude: -114.07)

    let eastboundSnapshot = try eastboundCore.updateLocation(
      NavigationLocationSample(
        coordinate: coordinate,
        courseDegrees: 90,
        horizontalAccuracyMeters: 5
      )
    )
    let westboundSnapshot = try westboundCore.updateLocation(
      NavigationLocationSample(
        coordinate: coordinate,
        courseDegrees: 270,
        horizontalAccuracyMeters: 5
      )
    )

    XCTAssertLessThan(eastboundSnapshot.routeProgress, 0.5)
    XCTAssertGreaterThan(westboundSnapshot.routeProgress, 0.5)
  }

  func testKeepsProgressNearPreviousLegAtRevisitedCoordinate() throws {
    let core = NavigationCore()
    try core.setRoute([
      NavigationCoordinate(latitude: 51.04, longitude: -114.08),
      NavigationCoordinate(latitude: 51.04, longitude: -114.06),
      NavigationCoordinate(latitude: 51.05, longitude: -114.06),
      NavigationCoordinate(latitude: 51.05, longitude: -114.08),
      NavigationCoordinate(latitude: 51.04, longitude: -114.08),
      NavigationCoordinate(latitude: 51.03, longitude: -114.08)
    ])

    _ = try core.updateLocation(
      NavigationCoordinate(latitude: 51.035, longitude: -114.08)
    )
    let snapshot = try core.updateLocation(
      NavigationCoordinate(latitude: 51.04, longitude: -114.08)
    )

    XCTAssertGreaterThan(snapshot.routeProgress, 0.75)
  }

  func testConfirmsAndRecoversFromOffRouteWithHysteresis() throws {
    let core = NavigationCore()
    try core.setRoute([
      NavigationCoordinate(latitude: 51.04, longitude: -114.08),
      NavigationCoordinate(latitude: 51.04, longitude: -114.06)
    ])
    let onRouteSample = NavigationLocationSample(
      coordinate: NavigationCoordinate(latitude: 51.04, longitude: -114.07),
      horizontalAccuracyMeters: 5
    )
    let offRouteSample = NavigationLocationSample(
      coordinate: NavigationCoordinate(latitude: 51.041, longitude: -114.07),
      horizontalAccuracyMeters: 5
    )

    _ = try core.updateLocation(onRouteSample)
    let firstDeparture = try core.updateLocation(offRouteSample)
    let secondDeparture = try core.updateLocation(offRouteSample)
    let confirmedDeparture = try core.updateLocation(offRouteSample)

    XCTAssertFalse(firstDeparture.isOffRoute)
    XCTAssertFalse(secondDeparture.isOffRoute)
    XCTAssertNotNil(secondDeparture.matchedCoordinate)
    XCTAssertTrue(confirmedDeparture.isOffRoute)
    XCTAssertNil(confirmedDeparture.matchedCoordinate)

    let firstRecovery = try core.updateLocation(onRouteSample)
    let confirmedRecovery = try core.updateLocation(onRouteSample)

    XCTAssertTrue(firstRecovery.isOffRoute)
    XCTAssertNil(firstRecovery.matchedCoordinate)
    XCTAssertFalse(confirmedRecovery.isOffRoute)
    XCTAssertNotNil(confirmedRecovery.matchedCoordinate)
  }

  func testHorizontalAccuracyPreventsFalseOffRouteConfirmation() throws {
    let core = NavigationCore()
    try core.setRoute([
      NavigationCoordinate(latitude: 51.04, longitude: -114.08),
      NavigationCoordinate(latitude: 51.04, longitude: -114.06)
    ])
    let uncertainSample = NavigationLocationSample(
      coordinate: NavigationCoordinate(latitude: 51.041, longitude: -114.07),
      horizontalAccuracyMeters: 100
    )

    var snapshot = try core.updateLocation(uncertainSample)
    snapshot = try core.updateLocation(uncertainSample)
    snapshot = try core.updateLocation(uncertainSample)

    XCTAssertFalse(snapshot.isOffRoute)
    XCTAssertNotNil(snapshot.matchedCoordinate)
    XCTAssertEqual(snapshot.horizontalAccuracyMeters, 100)
  }

  func testPoorHorizontalAccuracyCannotConfirmRecovery() throws {
    let core = NavigationCore()
    try core.setRoute([
      NavigationCoordinate(latitude: 51.04, longitude: -114.08),
      NavigationCoordinate(latitude: 51.04, longitude: -114.06)
    ])
    let offRouteSample = NavigationLocationSample(
      coordinate: NavigationCoordinate(latitude: 51.041, longitude: -114.07),
      horizontalAccuracyMeters: 5
    )
    let uncertainOnRouteSample = NavigationLocationSample(
      coordinate: NavigationCoordinate(latitude: 51.04, longitude: -114.07),
      horizontalAccuracyMeters: 100
    )

    _ = try core.updateLocation(offRouteSample)
    _ = try core.updateLocation(offRouteSample)
    _ = try core.updateLocation(offRouteSample)
    _ = try core.updateLocation(uncertainOnRouteSample)
    let snapshot = try core.updateLocation(uncertainOnRouteSample)

    XCTAssertTrue(snapshot.isOffRoute)
    XCTAssertNil(snapshot.matchedCoordinate)
  }

  func testConfirmsArrivalAfterTwoAccurateEndpointSamples() throws {
    let core = NavigationCore()
    try core.setRoute([
      NavigationCoordinate(latitude: 51.04, longitude: -114.08),
      NavigationCoordinate(latitude: 51.05, longitude: -114.08)
    ])
    let arrivalSample = NavigationLocationSample(
      coordinate: NavigationCoordinate(latitude: 51.04995, longitude: -114.08),
      horizontalAccuracyMeters: 5
    )

    let firstSample = try core.updateLocation(arrivalSample)
    let confirmedArrival = try core.updateLocation(arrivalSample)

    XCTAssertEqual(firstSample.phase, .tracking)
    XCTAssertEqual(confirmedArrival.phase, .arrived)
    XCTAssertFalse(confirmedArrival.isOffRoute)
    XCTAssertEqual(confirmedArrival.routeProgress, 1)
  }

  func testDoesNotArriveWithPoorAccuracy() throws {
    let core = NavigationCore()
    try core.setRoute([
      NavigationCoordinate(latitude: 51.04, longitude: -114.08),
      NavigationCoordinate(latitude: 51.05, longitude: -114.08)
    ])
    let uncertainEndpointSample = NavigationLocationSample(
      coordinate: NavigationCoordinate(latitude: 51.05, longitude: -114.08),
      horizontalAccuracyMeters: 50
    )

    _ = try core.updateLocation(uncertainEndpointSample)
    let snapshot = try core.updateLocation(uncertainEndpointSample)

    XCTAssertEqual(snapshot.phase, .tracking)
  }

  func testDoesNotArriveWhenRoutePassesDestinationEarly() throws {
    let core = NavigationCore()
    try core.setRoute([
      NavigationCoordinate(latitude: 51.0599, longitude: -114.08),
      NavigationCoordinate(latitude: 51.04, longitude: -114.08),
      NavigationCoordinate(latitude: 51.04, longitude: -114.06),
      NavigationCoordinate(latitude: 51.06, longitude: -114.08)
    ])
    let earlyDestinationSample = NavigationLocationSample(
      coordinate: NavigationCoordinate(latitude: 51.0599, longitude: -114.08),
      horizontalAccuracyMeters: 5
    )

    _ = try core.updateLocation(earlyDestinationSample)
    let snapshot = try core.updateLocation(earlyDestinationSample)

    XCTAssertEqual(snapshot.phase, .tracking)
    XCTAssertLessThan(snapshot.routeProgress, 0.1)
  }

  func testArrivalRemainsStickyUntilRouteChanges() throws {
    let core = NavigationCore()
    try core.setRoute([
      NavigationCoordinate(latitude: 51.04, longitude: -114.08),
      NavigationCoordinate(latitude: 51.05, longitude: -114.08)
    ])
    let arrivalSample = NavigationLocationSample(
      coordinate: NavigationCoordinate(latitude: 51.05, longitude: -114.08),
      horizontalAccuracyMeters: 5
    )
    _ = try core.updateLocation(arrivalSample)
    _ = try core.updateLocation(arrivalSample)

    let snapshot = try core.updateLocation(
      NavigationLocationSample(
        coordinate: NavigationCoordinate(latitude: 51.04, longitude: -114.06),
        horizontalAccuracyMeters: 5
      )
    )

    XCTAssertEqual(snapshot.phase, .arrived)
    XCTAssertFalse(snapshot.isOffRoute)
    XCTAssertEqual(snapshot.routeProgress, 1)
  }

  func testRejectsInvalidRoutesAndLocations() throws {
    let core = NavigationCore()

    XCTAssertThrowsError(
      try core.setRoute([NavigationCoordinate(latitude: 51.04, longitude: -114.08)])
    ) { error in
      XCTAssertEqual(error as? NavigationCoreError, .invalidRoute)
    }

    try core.setRoute([
      NavigationCoordinate(latitude: 51.04, longitude: -114.08),
      NavigationCoordinate(latitude: 51.05, longitude: -114.08)
    ])
    XCTAssertThrowsError(
      try core.updateLocation(NavigationCoordinate(latitude: 95, longitude: -114.08))
    ) { error in
      XCTAssertEqual(error as? NavigationCoreError, .invalidCoordinate)
    }
    XCTAssertThrowsError(
      try core.updateLocation(
        NavigationLocationSample(
          coordinate: NavigationCoordinate(latitude: 51.04, longitude: -114.08),
          courseDegrees: 360,
          horizontalAccuracyMeters: 5
        )
      )
    ) { error in
      XCTAssertEqual(error as? NavigationCoreError, .invalidCoordinate)
    }
  }

  func testClearingRouteReturnsIdleSnapshot() throws {
    let core = NavigationCore()
    let initialVersion = core.currentSnapshot().routeVersion
    try core.setRoute([
      NavigationCoordinate(latitude: 51.04, longitude: -114.08),
      NavigationCoordinate(latitude: 51.05, longitude: -114.08)
    ])

    let snapshot = core.clearRoute()

    XCTAssertEqual(snapshot.phase, .idle)
    XCTAssertNil(snapshot.matchedCoordinate)
    XCTAssertGreaterThan(snapshot.routeVersion, initialVersion)
  }
}