import XCTest

@testable import NavOSSNavigationCore

final class NavigationCoreTests: XCTestCase {
  func testNavigationSessionDerivesGuidanceFromMatchedProgress() throws {
    let session = NavigationSession()
    let trip = makeNavigationSessionTrip()

    let initial = try session.start(trip)
    XCTAssertEqual(initial.guidance?.instruction, "Turn right")
    XCTAssertEqual(initial.guidance?.distanceToManeuverMeters, 500)
    XCTAssertEqual(initial.guidance?.remainingDistanceMeters, 2_000)

    let progressed = try session.updateLocation(
      NavigationLocationSample(
        coordinate: NavigationCoordinate(latitude: 51.045, longitude: -114.075),
        courseDegrees: 32,
        horizontalAccuracyMeters: 5
      )
    )

    XCTAssertEqual(progressed.guidance?.instruction, "Turn right")
    XCTAssertLessThan(progressed.guidance?.distanceToManeuverMeters ?? 500, 500)
    XCTAssertLessThan(progressed.guidance?.remainingDurationSeconds ?? 180, 180)
  }

  func testNavigationSessionPublishesArrivalAndClears() throws {
    let session = NavigationSession()
    let trip = makeNavigationSessionTrip()
    _ = try session.start(trip)
    let destination = NavigationLocationSample(
      coordinate: NavigationCoordinate(latitude: 51.13, longitude: -114.01),
      courseDegrees: 32,
      horizontalAccuracyMeters: 5
    )

    _ = try session.updateLocation(destination)
    let arrived = try session.updateLocation(destination)

    XCTAssertEqual(arrived.snapshot.phase, .arrived)
    XCTAssertEqual(arrived.guidance?.phase, .arrived)
    XCTAssertEqual(arrived.guidance?.remainingDistanceMeters, 0)
    XCTAssertNil(session.clear().trip)
    XCTAssertThrowsError(try session.updateLocation(destination)) { error in
      XCTAssertEqual(error as? NavigationSessionError, .noActiveTrip)
    }
  }

  func testNavigationSessionRetainsActiveTripWhenReplacementRouteIsRejected() throws {
    let session = NavigationSession()
    let activeTrip = makeNavigationSessionTrip()
    _ = try session.start(activeTrip)
    let duplicateCoordinate = NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.08)
    let invalidReplacement = NavOSSCarPlayTrip(
      destination: activeTrip.destination,
      distanceMeters: activeTrip.distanceMeters,
      durationSeconds: activeTrip.durationSeconds,
      geometry: [duplicateCoordinate, duplicateCoordinate],
      id: "invalid-replacement",
      preferences: activeTrip.preferences,
      steps: activeTrip.steps
    )

    XCTAssertThrowsError(try session.start(invalidReplacement)) { error in
      XCTAssertEqual(error as? NavigationCoreError, .invalidRoute)
    }
    XCTAssertEqual(session.currentUpdate().trip, activeTrip)
    XCTAssertEqual(session.currentUpdate().snapshot.phase, .tracking)
  }

  func testManeuverSpeechWaitsForFreshLocationAndDistanceThresholds() {
    let planner = NavigationSpeechPlanner()
    let trip = makeNavigationSessionTrip()
    let distant = makeGuidance(distance: 900, duration: 80)

    XCTAssertNil(planner.prompt(trip: trip, guidance: distant, hasCurrentLocation: false))
    XCTAssertNil(planner.prompt(trip: trip, guidance: distant, hasCurrentLocation: true))

    let prepare = planner.prompt(
      trip: trip,
      guidance: makeGuidance(distance: 430, duration: 40),
      hasCurrentLocation: true
    )
    XCTAssertEqual(prepare?.key, "route-1:1:prepare")
    XCTAssertEqual(prepare?.text, "In 450 meters, Turn right")
    XCTAssertNil(
      planner.prompt(
        trip: trip,
        guidance: makeGuidance(distance: 420, duration: 38),
        hasCurrentLocation: true
      ))

    let execute = planner.prompt(
      trip: trip,
      guidance: makeGuidance(distance: 60, duration: 8),
      hasCurrentLocation: true
    )
    XCTAssertEqual(execute?.key, "route-1:1:execute")
    XCTAssertEqual(execute?.text, "Turn right")
    XCTAssertNil(
      planner.prompt(
        trip: trip,
        guidance: makeGuidance(distance: 50, duration: 6),
        hasCurrentLocation: true
      ))
  }

  func testCarPlayTripStoreRejectsStaleNavigationPublications() {
    let store = NavOSSCarPlayTripStore(notificationCenter: NotificationCenter())
    let firstTrip = makeNavigationSessionTrip()
    let secondTrip = makeNavigationSessionTrip(id: "route-2")
    let firstGuidance = makeGuidance(distance: 300, duration: 30)
    let secondGuidance = makeGuidance(distance: 200, duration: 20)

    store.publishNavigationState(
      trip: firstTrip,
      guidance: firstGuidance,
      generation: 4,
      sequence: 10
    )
    store.clearTrip(generation: 5, sequence: 11)
    store.publishNavigationState(
      trip: firstTrip,
      guidance: firstGuidance,
      generation: 4,
      sequence: 12
    )
    XCTAssertNil(store.snapshot().trip)

    store.publishNavigationState(
      trip: secondTrip,
      guidance: secondGuidance,
      generation: 6,
      sequence: 20
    )
    store.publishNavigationState(
      trip: firstTrip,
      guidance: firstGuidance,
      generation: 6,
      sequence: 19
    )
    XCTAssertEqual(store.snapshot().trip, secondTrip)
    XCTAssertEqual(store.snapshot().guidance, secondGuidance)
  }

  func testActiveTripStoreExpiresAndClearsTransientRoute() throws {
    let suiteName = "NavOSSActiveTripStoreTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    var now = Date(timeIntervalSince1970: 1_000)
    let store = NavOSSActiveTripStore(
      defaults: defaults,
      key: "active-trip",
      expirationInterval: 60,
      clock: { now }
    )
    let trip = makeNavigationSessionTrip()

    store.save(trip)
    XCTAssertEqual(store.load(), trip)
    now = now.addingTimeInterval(61)
    XCTAssertNil(store.load())

    store.save(trip)
    store.clear()
    XCTAssertNil(store.load())
  }

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
      NavOSSCarPlayCoordinate(latitude: 51.13157, longitude: -114.01055),
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

    XCTAssertEqual(
      store.snapshot(),
      NavOSSCarPlayState(
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

    let favorite = NavOSSCarPlayDestination(
      id: "favorite",
      label: "Calgary",
      latitude: 51.05,
      longitude: -114.07,
      name: "Favorite"
    )
    store.replaceFavorites([favorite])
    store.setHome(favorite)
    store.clearRecents()

    let clearedCatalog = store.snapshot()
    XCTAssertTrue(clearedCatalog.recents.isEmpty)
    XCTAssertEqual(clearedCatalog.favorites, [favorite])
    XCTAssertEqual(clearedCatalog.home, favorite)
  }

  func testProjectsLocationOntoRouteSegment() throws {
    let core = NavigationCore()
    try core.setRoute([
      NavigationCoordinate(latitude: 51.04, longitude: -114.08),
      NavigationCoordinate(latitude: 51.04, longitude: -114.06),
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
      NavigationCoordinate(latitude: 51.05, longitude: -114.06),
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
      NavigationCoordinate(latitude: 51.0402, longitude: -114.08),
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
      NavigationCoordinate(latitude: 51.03, longitude: -114.08),
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
      NavigationCoordinate(latitude: 51.04, longitude: -114.06),
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
      NavigationCoordinate(latitude: 51.04, longitude: -114.06),
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
      NavigationCoordinate(latitude: 51.04, longitude: -114.06),
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
      NavigationCoordinate(latitude: 51.05, longitude: -114.08),
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
      NavigationCoordinate(latitude: 51.05, longitude: -114.08),
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
      NavigationCoordinate(latitude: 51.06, longitude: -114.08),
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
      NavigationCoordinate(latitude: 51.05, longitude: -114.08),
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
      NavigationCoordinate(latitude: 51.05, longitude: -114.08),
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
      NavigationCoordinate(latitude: 51.05, longitude: -114.08),
    ])

    let snapshot = core.clearRoute()

    XCTAssertEqual(snapshot.phase, .idle)
    XCTAssertNil(snapshot.matchedCoordinate)
    XCTAssertGreaterThan(snapshot.routeVersion, initialVersion)
  }

  private func makeGuidance(distance: Double, duration: Double) -> NavOSSCarPlayGuidance {
    NavOSSCarPlayGuidance(
      distanceToManeuverMeters: distance,
      durationToManeuverSeconds: duration,
      instruction: "Turn right",
      maneuverType: "right",
      phase: .navigating,
      remainingDistanceMeters: distance + 1_000,
      remainingDurationSeconds: duration + 100,
      roadName: "Airport Trail NE",
      stepIndex: 0
    )
  }

  private func makeNavigationSessionTrip(id: String = "route-1") -> NavOSSCarPlayTrip {
    NavOSSCarPlayTrip(
      destination: NavOSSCarPlayDestination(
        id: "airport",
        label: "2000 Airport Road NE",
        latitude: 51.13,
        longitude: -114.01,
        name: "Calgary International Airport"
      ),
      distanceMeters: 2_000,
      durationSeconds: 180,
      geometry: [
        NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.08),
        NavOSSCarPlayCoordinate(latitude: 51.05, longitude: -114.07),
        NavOSSCarPlayCoordinate(latitude: 51.13, longitude: -114.01),
      ],
      id: id,
      steps: [
        NavOSSCarPlayRouteStep(
          distanceMeters: 500,
          durationSeconds: 60,
          geometry: [
            NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.08),
            NavOSSCarPlayCoordinate(latitude: 51.05, longitude: -114.07),
          ],
          instruction: "Head north",
          maneuverType: "depart",
          roadName: "Centre Street"
        ),
        NavOSSCarPlayRouteStep(
          distanceMeters: 1_500,
          durationSeconds: 120,
          geometry: [
            NavOSSCarPlayCoordinate(latitude: 51.05, longitude: -114.07),
            NavOSSCarPlayCoordinate(latitude: 51.13, longitude: -114.01),
          ],
          instruction: "Turn right",
          maneuverType: "right",
          roadName: "Airport Trail NE"
        ),
      ]
    )
  }
}
