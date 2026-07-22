import XCTest
@testable import NavOSSNavigationCore

final class NavigationCoreTests: XCTestCase {
  func testCarPlayTripStorePublishesValidatedLifecycle() {
    let notifications = NotificationCenter()
    let store = NavOSSCarPlayTripStore(notificationCenter: notifications)
    var changeCount = 0
    var navigationEndCount = 0
    let token = notifications.addObserver(
      forName: .navOSSCarPlayStateDidChange,
      object: store,
      queue: nil
    ) { _ in
      changeCount += 1
    }
    let endToken = notifications.addObserver(
      forName: .navOSSCarPlayNavigationDidEnd,
      object: store,
      queue: nil
    ) { _ in
      navigationEndCount += 1
    }
    defer {
      notifications.removeObserver(token)
      notifications.removeObserver(endToken)
    }

    let destination = NavOSSCarPlayDestination(
      id: "airport",
      label: "2000 Airport Road NE",
      latitude: 51.13157,
      longitude: -114.01055,
      name: "Calgary International Airport"
    )
    let geometry = [
      NavOSSCarPlayCoordinate(latitude: 51.0447, longitude: -114.0719),
      NavOSSCarPlayCoordinate(latitude: 51.13157, longitude: -114.01055)
    ]
    let trip = NavOSSCarPlayTrip(
      destination: destination,
      distanceMeters: 19_700,
      durationSeconds: 1_200,
      geometry: geometry,
      id: "route-1",
      steps: [
        NavOSSCarPlayRouteStep(
          distanceMeters: 19_700,
          durationSeconds: 1_200,
          geometry: geometry,
          instruction: "Continue to the airport",
          maneuverType: "continue",
          roadName: "Airport Trail NE"
        )
      ]
    )
    let guidance = NavOSSCarPlayGuidance(
      distanceToManeuverMeters: 350,
      durationToManeuverSeconds: 45,
      instruction: "Turn right",
      maneuverType: "right",
      phase: .navigating,
      remainingDistanceMeters: 12_500,
      remainingDurationSeconds: 780,
      roadName: "Airport Trail NE",
      stepIndex: 0
    )

    store.setConnected(true)
    store.publishTrip(trip)
    store.publishGuidance(guidance)

    XCTAssertEqual(store.snapshot(), NavOSSCarPlayState(
      connected: true,
      guidance: guidance,
      trip: trip
    ))
    XCTAssertEqual(changeCount, 3)

    store.endTripFromCarPlay()
    XCTAssertEqual(
      store.snapshot(),
      NavOSSCarPlayState(connected: true, guidance: nil, trip: nil)
    )
    XCTAssertEqual(changeCount, 4)
    XCTAssertEqual(navigationEndCount, 1)
  }

  func testCarPlayTripStoreRejectsInvalidTripAndGuidance() {
    let store = NavOSSCarPlayTripStore(notificationCenter: NotificationCenter())
    let coordinate = NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.08)
    let invalidTrip = NavOSSCarPlayTrip(
      destination: NavOSSCarPlayDestination(
        id: "",
        label: "Calgary",
        latitude: 51.04,
        longitude: -114.08,
        name: "Invalid"
      ),
      distanceMeters: 0,
      durationSeconds: 0,
      geometry: [coordinate],
      id: "",
      steps: []
    )

    store.publishTrip(invalidTrip)
    store.publishGuidance(
      NavOSSCarPlayGuidance(
        distanceToManeuverMeters: -.infinity,
        durationToManeuverSeconds: 0,
        instruction: "",
        maneuverType: "",
        phase: .navigating,
        remainingDistanceMeters: 0,
        remainingDurationSeconds: 0,
        roadName: "",
        stepIndex: -1
      )
    )

    XCTAssertEqual(
      store.snapshot(),
      NavOSSCarPlayState(connected: false, guidance: nil, trip: nil)
    )
  }

  func testCarPlayDestinationCatalogDeduplicatesAndBoundsRecents() throws {
    let suiteName = "NavOSSNavigationCoreTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let store = NavOSSCarPlayDestinationStore(defaults: defaults, key: "catalog")

    for index in 0..<14 {
      store.recordRecent(
        NavOSSCarPlayDestination(
          id: "destination-\(index)",
          label: "Calgary",
          latitude: 51.04,
          longitude: -114.08,
          name: "Destination \(index)"
        )
      )
    }
    store.recordRecent(
      NavOSSCarPlayDestination(
        id: "destination-5",
        label: "Calgary",
        latitude: 51.05,
        longitude: -114.07,
        name: "Updated Destination"
      )
    )

    let catalog = store.snapshot()
    XCTAssertEqual(catalog.recents.count, 12)
    XCTAssertEqual(catalog.recents.first?.id, "destination-5")
    XCTAssertEqual(catalog.recents.first?.name, "Updated Destination")
    XCTAssertEqual(catalog.recents.filter { $0.id == "destination-5" }.count, 1)
  }

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
    XCTAssertEqual(snapshot.matchedCourseDegrees ?? 0, 90, accuracy: 0.1)
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
    XCTAssertEqual(secondDeparture.matchedCourseDegrees ?? 0, 90, accuracy: 0.1)
    XCTAssertTrue(confirmedDeparture.isOffRoute)
    XCTAssertNil(confirmedDeparture.matchedCoordinate)
    XCTAssertNil(confirmedDeparture.matchedCourseDegrees)

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