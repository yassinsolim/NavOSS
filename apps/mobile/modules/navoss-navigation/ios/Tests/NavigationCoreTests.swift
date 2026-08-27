import XCTest

@testable import NavOSSNavigationCore

final class NavigationCoreTests: XCTestCase {
  func testLocationTrackingRequiresPlanningOrActiveNavigation() {
    XCTAssertFalse(
      navOSSShouldTrackLocation(
        hasActiveNavigation: false,
        isCarPlayRoutePlanning: false
      )
    )
    XCTAssertTrue(
      navOSSShouldTrackLocation(
        hasActiveNavigation: false,
        isCarPlayRoutePlanning: true
      )
    )
    XCTAssertTrue(
      navOSSShouldTrackLocation(
        hasActiveNavigation: true,
        isCarPlayRoutePlanning: false
      )
    )
  }

  func testLocationTrackingLeasesReleaseIndependently() {
    var leases = NavOSSLocationTrackingLeases()
    let first = leases.acquire()
    let second = leases.acquire()

    leases.release(first)
    XCTAssertTrue(leases.isActive)

    leases.release(second)
    XCTAssertFalse(leases.isActive)
  }

  func testCarPlayPublishUsesFreshFallbackBeforeFirstNavigationUpdate() {
    let fallback = NavOSSCarPlayPosition(
      coordinate: NavOSSCarPlayCoordinate(latitude: 51.0447, longitude: -114.0719),
      courseDegrees: 270,
      speedMetersPerSecond: 0
    )

    XCTAssertEqual(
      navOSSCarPlayPublishedPosition(
        matchedCoordinate: nil,
        rawCoordinate: nil,
        matchedCourseDegrees: nil,
        speedMetersPerSecond: nil,
        fallback: fallback
      ),
      fallback
    )
  }

  func testPersistedNavigationWaitsForValidatedLocation() {
    XCTAssertEqual(
      navOSSPersistedNavigationDecision(
        distanceFromRouteMeters: nil,
        horizontalAccuracyMeters: nil,
        isOffRoute: false
      ),
      .wait
    )
    XCTAssertEqual(
      navOSSPersistedNavigationDecision(
        distanceFromRouteMeters: 80,
        horizontalAccuracyMeters: 80,
        isOffRoute: false
      ),
      .wait
    )
    XCTAssertEqual(
      navOSSPersistedNavigationDecision(
        distanceFromRouteMeters: 10,
        horizontalAccuracyMeters: 5,
        isOffRoute: false
      ),
      .publish
    )
    XCTAssertEqual(
      navOSSPersistedNavigationDecision(
        distanceFromRouteMeters: 80,
        horizontalAccuracyMeters: 5,
        isOffRoute: false
      ),
      .discard
    )
    XCTAssertEqual(
      navOSSPersistedNavigationDecision(
        distanceFromRouteMeters: 10,
        horizontalAccuracyMeters: 5,
        isOffRoute: true
      ),
      .discard
    )
  }

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

  func testManeuverSpeechUsesCurrentSegmentVoiceInstruction() {
    let planner = NavigationSpeechPlanner()
    let trip = makeNavigationSessionTrip(
      currentSpokenInstruction: "Turn right onto Aspen Glen Way SW",
      nextSpokenInstruction: "Turn left onto Aspen Summit Drive SW"
    )

    let execute = planner.prompt(
      trip: trip,
      guidance: makeGuidance(distance: 60, duration: 8),
      hasCurrentLocation: true
    )

    XCTAssertEqual(execute?.text, "Turn right onto Aspen Glen Way southwest")
  }

  func testCarPlayDistanceMeasurementUsesDrivingScaleUnits() {
    let nearby = navOSSCarPlayDistanceMeasurement(450)
    XCTAssertEqual(nearby.unit, .meters)
    XCTAssertEqual(nearby.value, 450)

    let route = navOSSCarPlayDistanceMeasurement(12_500)
    XCTAssertEqual(route.unit, .kilometers)
    XCTAssertEqual(route.value, 12.5)
  }

  func testCarPlayCameraAdaptsToManeuverDistance() {
    XCTAssertEqual(navOSSCarPlayViewingDistance(nil), 850)
    XCTAssertEqual(navOSSCarPlayViewingDistance(50), 450)
    XCTAssertEqual(navOSSCarPlayViewingDistance(300), 650)
    XCTAssertEqual(navOSSCarPlayViewingDistance(1_000), 900)
    XCTAssertEqual(navOSSCarPlayViewingDistance(3_000), 1_200)
  }

  func testCarPlayEndControlsFollowActiveTripAcrossTemplates() {
    let inactive = NavOSSCarPlayControlState(hasActiveTrip: false, searchVisible: false)
    XCTAssertFalse(inactive.drivingControlsVisible)
    XCTAssertFalse(inactive.endNavigationVisible)
    XCTAssertFalse(inactive.reportVisible)
    XCTAssertFalse(inactive.returnToRootFromSearch)
    XCTAssertTrue(inactive.searchVisible)
    XCTAssertTrue(inactive.settingsVisible)
    XCTAssertFalse(inactive.soundSettingsVisible)

    let activeMap = NavOSSCarPlayControlState(hasActiveTrip: true, searchVisible: false)
    XCTAssertTrue(activeMap.drivingControlsVisible)
    XCTAssertTrue(activeMap.endNavigationVisible)
    XCTAssertTrue(activeMap.reportVisible)
    XCTAssertFalse(activeMap.returnToRootFromSearch)
    XCTAssertFalse(activeMap.searchVisible)
    XCTAssertFalse(activeMap.settingsVisible)
    XCTAssertTrue(activeMap.soundSettingsVisible)

    let activeSearch = NavOSSCarPlayControlState(hasActiveTrip: true, searchVisible: true)
    XCTAssertTrue(activeSearch.endNavigationVisible)
    XCTAssertTrue(activeSearch.returnToRootFromSearch)
  }

  func testNavigationAnnouncementsCanRemainMutedAcrossUpdates() {
    var state = NavOSSCarPlayAudioState()

    XCTAssertTrue(state.allowsAlerts)
    XCTAssertTrue(state.allowsManeuverGuidance)
    state.setMode(.alertsOnly)
    XCTAssertTrue(state.allowsAlerts)
    XCTAssertFalse(state.allowsManeuverGuidance)
    state.setMode(.muted)
    XCTAssertFalse(state.allowsAlerts)
    XCTAssertFalse(state.allowsManeuverGuidance)
  }

  func testInitialAudioStateRestoresPersistedModeWithoutCarPlay() throws {
    let suiteName = "NavOSSNavigationCoreTests.service-audio.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let preferencesStore = NavOSSCarPlayPreferencesStore(defaults: defaults)
    preferencesStore.setAudioMode(.muted)

    let state = navOSSInitialCarPlayAudioState(preferencesStore: preferencesStore)

    XCTAssertEqual(state.mode, .muted)
  }

  func testCarPlayPreferencesPersistMapAndAudioChoices() throws {
    let suiteName = "NavOSSNavigationCoreTests.preferences.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let store = NavOSSCarPlayPreferencesStore(defaults: defaults)

    XCTAssertEqual(store.load(), NavOSSCarPlayPreferences())
    store.setAppearance(.light)
    store.setAudioMode(.alertsOnly)
    store.setRoutePreferences(
      NavOSSRoutePreferences(
        avoidFerries: true,
        avoidHighways: true,
        avoidTolls: true,
        avoidUnpaved: true
      )
    )
    store.setMapOrientation(.northUp)
    store.setShowsPointsOfInterest(false)
    store.setVehicleMarker(.car)

    XCTAssertEqual(
      store.load(),
      NavOSSCarPlayPreferences(
        appearance: .light,
        audioMode: .alertsOnly,
        routePreferences: NavOSSRoutePreferences(
          avoidFerries: true,
          avoidHighways: true,
          avoidTolls: true,
          avoidUnpaved: true
        ),
        mapOrientation: .northUp,
        showsPointsOfInterest: false,
        vehicleMarker: .car
      )
    )
  }

  func testCarPlayPreferencesNotifyObserversAfterMutation() throws {
    let suiteName = "NavOSSNavigationCoreTests.preference-events.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let notificationCenter = NotificationCenter()
    let store = NavOSSCarPlayPreferencesStore(
      defaults: defaults,
      notificationCenter: notificationCenter
    )
    let expectation = expectation(
      forNotification: .navOSSCarPlayPreferencesDidChange,
      object: store,
      notificationCenter: notificationCenter
    )

    store.setRoutePreferences(NavOSSRoutePreferences(avoidTolls: true))

    wait(for: [expectation], timeout: 0.1)
    XCTAssertTrue(store.load().routePreferences.avoidTolls)
  }

  func testCarPlayPositionValidatesCurrentSpeed() {
    let coordinate = NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.08)

    XCTAssertTrue(
      NavOSSCarPlayPosition(
        coordinate: coordinate,
        courseDegrees: 90,
        speedMetersPerSecond: 13.5
      ).isValid
    )
    XCTAssertFalse(
      NavOSSCarPlayPosition(
        coordinate: coordinate,
        courseDegrees: 90,
        speedMetersPerSecond: -1
      ).isValid
    )
  }

  func testCarPlaySpeedingStartsAtFiveOverKnownLimit() {
    XCTAssertFalse(navOSSCarPlayIsSpeeding(speedKph: 54, speedLimitKph: 50))
    XCTAssertTrue(navOSSCarPlayIsSpeeding(speedKph: 55, speedLimitKph: 50))
    XCTAssertFalse(navOSSCarPlayIsSpeeding(speedKph: 120, speedLimitKph: nil))
  }

  func testNavigationRouteOriginRequiresFreshAccurateMovementForHeading() {
    let coordinate = NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.08)
    let moving = navOSSNavigationRouteOrigin(
      coordinate: coordinate,
      courseDegrees: 25,
      speedMetersPerSecond: 8,
      horizontalAccuracyMeters: 8,
      ageSeconds: 15
    )
    let stationary = navOSSNavigationRouteOrigin(
      coordinate: coordinate,
      courseDegrees: 25,
      speedMetersPerSecond: 0,
      horizontalAccuracyMeters: 8,
      ageSeconds: 0
    )

    XCTAssertEqual(moving?.headingDegrees, 25)
    XCTAssertNil(stationary?.headingDegrees)
    XCTAssertNil(
      navOSSNavigationRouteOrigin(
        coordinate: coordinate,
        courseDegrees: 25,
        speedMetersPerSecond: 8,
        horizontalAccuracyMeters: 8,
        ageSeconds: 15.01
      )
    )
    XCTAssertNil(
      navOSSNavigationRouteOrigin(
        coordinate: coordinate,
        courseDegrees: 25,
        speedMetersPerSecond: 8,
        horizontalAccuracyMeters: 100.01,
        ageSeconds: 0
      )
    )
  }

  func testNavigationLocationRejectsStaleAndOutOfOrderCallbacks() {
    XCTAssertTrue(
      navOSSShouldAcceptNavigationLocation(
        candidateTimestamp: 995,
        latestTimestamp: 990,
        nowTimestamp: 1_000
      )
    )
    XCTAssertFalse(
      navOSSShouldAcceptNavigationLocation(
        candidateTimestamp: 984.99,
        latestTimestamp: nil,
        nowTimestamp: 1_000
      )
    )
    XCTAssertFalse(
      navOSSShouldAcceptNavigationLocation(
        candidateTimestamp: 995,
        latestTimestamp: 996,
        nowTimestamp: 1_000
      )
    )
  }

  func testCarPlaySpeedLimitUsesCurrentGeometrySegmentAndHidesUnknown() {
    let speedLimits = [0, 50, 40]
    let geometry = [
      NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.10),
      NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.099),
      NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.08),
      NavOSSCarPlayCoordinate(latitude: 51.05, longitude: -114.08),
    ]

    XCTAssertNil(
      navOSSCarPlaySpeedLimit(
        speedLimits,
        geometry: geometry,
        matchedCoordinate: geometry[0],
        routeProgress: 0.2
      )
    )
    XCTAssertEqual(
      navOSSCarPlaySpeedLimit(
        speedLimits,
        geometry: geometry,
        matchedCoordinate: NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.09),
        routeProgress: 0.95
      ),
      50
    )
    XCTAssertEqual(
      navOSSCarPlaySpeedLimit(
        speedLimits,
        geometry: geometry,
        matchedCoordinate: nil,
        routeProgress: 1
      ),
      40
    )
    XCTAssertNil(
      navOSSCarPlaySpeedLimit(
        nil,
        geometry: geometry,
        matchedCoordinate: nil,
        routeProgress: 0.5
      )
    )
  }

  func testCarPlayReportsStayPrivateBoundedAndExpire() throws {
    let suiteName = "NavOSSNavigationCoreTests.reports.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let store = NavOSSCarPlayReportStore(
      defaults: defaults,
      expirationInterval: 120,
      maximumDrafts: 2
    )
    let now = Date(timeIntervalSince1970: 1_000)
    let coordinate = NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.07)

    XCTAssertNotNil(store.record(.collision, coordinate: coordinate, now: now))
    XCTAssertNotNil(store.record(.pothole, coordinate: coordinate, now: now.addingTimeInterval(1)))
    XCTAssertNotNil(
      store.record(.slowTraffic, coordinate: coordinate, now: now.addingTimeInterval(2))
    )
    XCTAssertEqual(
      store.load(now: now.addingTimeInterval(3)).map(\.type),
      [
        .slowTraffic, .pothole,
      ])
    XCTAssertTrue(store.load(now: now.addingTimeInterval(123)).isEmpty)
  }

  func testCarPlayRemainingRouteGeometryDeletesTravelledTrail() throws {
    let geometry = [
      NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.10),
      NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.08),
      NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.06),
    ]
    let matchedCoordinate = NavOSSCarPlayCoordinate(latitude: 51.0401, longitude: -114.079)

    let remaining = navOSSRemainingRouteGeometry(
      geometry,
      routeProgress: 0.6,
      matchedCoordinate: matchedCoordinate
    )

    XCTAssertEqual(remaining.first, matchedCoordinate)
    XCTAssertEqual(remaining.last, geometry.last)
    XCTAssertEqual(remaining.count, 2)
    XCTAssertFalse(remaining.contains(geometry[0]))
  }

  func testCarPlayRemainingRouteGeometryKeepsVisibleFinalSegmentAtCompletion() {
    let geometry = [
      NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.10),
      NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.08),
      NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.06),
    ]

    let remaining = navOSSRemainingRouteGeometry(geometry, routeProgress: 1)

    XCTAssertEqual(remaining, Array(geometry.suffix(2)))
    XCTAssertNotEqual(remaining.first, remaining.last)
  }

  func testCarPlayRemainingWaypointsDropsVisitedStops() {
    let geometry = [
      NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.10),
      NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.08),
      NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.06),
      NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.04),
    ]
    let visited = NavOSSCarPlayDestination(
      id: "visited",
      label: "Visited stop",
      latitude: 51.04,
      longitude: -114.08,
      name: "Visited"
    )
    let upcoming = NavOSSCarPlayDestination(
      id: "upcoming",
      label: "Upcoming stop",
      latitude: 51.04,
      longitude: -114.04,
      name: "Upcoming"
    )
    let trip = makeNavigationSessionTrip(geometry: geometry, waypoints: [visited, upcoming])

    XCTAssertEqual(navOSSRemainingWaypoints(in: trip, after: 0.5), [upcoming])
  }

  func testCarPlayRemainingWaypointsKeepsStopUntilProgressReachesIt() {
    let geometry = [
      NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.10),
      NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.08),
      NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.06),
      NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.04),
    ]
    let firstStop = NavOSSCarPlayDestination(
      id: "first-stop",
      label: "First stop",
      latitude: 51.04,
      longitude: -114.08,
      name: "First stop"
    )
    let trip = makeNavigationSessionTrip(geometry: geometry, waypoints: [firstStop])

    XCTAssertEqual(navOSSRemainingWaypoints(in: trip, after: 0.3315), [firstStop])
    XCTAssertTrue(navOSSRemainingWaypoints(in: trip, after: 0.334).isEmpty)
  }

  func testCarPlayRemainingWaypointsProjectsOffRoadStopOntoSparseSegment() {
    let geometry = [
      NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.10),
      NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.00),
    ]
    let midpointStop = NavOSSCarPlayDestination(
      id: "midpoint",
      label: "Off-road midpoint stop",
      latitude: 51.041,
      longitude: -114.05,
      name: "Midpoint"
    )
    let trip = makeNavigationSessionTrip(geometry: geometry, waypoints: [midpointStop])

    XCTAssertEqual(navOSSRemainingWaypoints(in: trip, after: 0.4), [midpointStop])
    XCTAssertTrue(navOSSRemainingWaypoints(in: trip, after: 0.6).isEmpty)
  }

  func testCarPlayTripStoreRejectsStaleNavigationPublications() {
    let store = NavOSSCarPlayTripStore(notificationCenter: NotificationCenter())
    let firstTrip = makeNavigationSessionTrip()
    let secondTrip = makeNavigationSessionTrip(id: "route-2")
    let firstGuidance = makeGuidance(distance: 300, duration: 30)
    let secondGuidance = makeGuidance(distance: 200, duration: 20)
    let firstPosition = NavOSSCarPlayPosition(
      coordinate: NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.08),
      courseDegrees: 90
    )
    let secondPosition = NavOSSCarPlayPosition(
      coordinate: NavOSSCarPlayCoordinate(latitude: 51.05, longitude: -114.07),
      courseDegrees: 45
    )

    store.publishNavigationState(
      trip: firstTrip,
      guidance: firstGuidance,
      position: firstPosition,
      routeProgress: 0.25,
      generation: 4,
      sequence: 10
    )
    store.clearTrip(generation: 5, sequence: 11)
    store.publishNavigationState(
      trip: firstTrip,
      guidance: firstGuidance,
      position: firstPosition,
      routeProgress: 0.5,
      generation: 4,
      sequence: 12
    )
    XCTAssertNil(store.snapshot().trip)

    store.publishNavigationState(
      trip: secondTrip,
      guidance: secondGuidance,
      position: secondPosition,
      routeProgress: 0.75,
      generation: 6,
      sequence: 20
    )
    store.publishNavigationState(
      trip: firstTrip,
      guidance: firstGuidance,
      position: firstPosition,
      routeProgress: 0.5,
      generation: 6,
      sequence: 19
    )
    XCTAssertEqual(store.snapshot().trip, secondTrip)
    XCTAssertEqual(store.snapshot().guidance, secondGuidance)
    XCTAssertEqual(store.snapshot().position, secondPosition)
    XCTAssertEqual(store.snapshot().routeProgress, 0.75)
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

  func testCarPlayRouteNamesDescribeDistinctMajorRoads() {
    let sharedStart = NavOSSCarPlayRouteStep(
      distanceMeters: 300,
      durationSeconds: 30,
      geometry: [
        NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.08),
        NavOSSCarPlayCoordinate(latitude: 51.05, longitude: -114.07),
      ],
      instruction: "Head east",
      maneuverType: "depart",
      roadName: "17 Avenue SW"
    )
    let glenmoreRoute = makeNavigationSessionTrip(
      id: "glenmore",
      steps: [
        sharedStart,
        NavOSSCarPlayRouteStep(
          distanceMeters: 1_650,
          durationSeconds: 120,
          geometry: [
            NavOSSCarPlayCoordinate(latitude: 51.05, longitude: -114.07),
            NavOSSCarPlayCoordinate(latitude: 51.13, longitude: -114.01),
          ],
          instruction: "Continue east",
          maneuverType: "straight",
          roadName: "Glenmore Trail"
        ),
        NavOSSCarPlayRouteStep(
          distanceMeters: 50,
          durationSeconds: 10,
          geometry: [
            NavOSSCarPlayCoordinate(latitude: 51.12, longitude: -114.02),
            NavOSSCarPlayCoordinate(latitude: 51.13, longitude: -114.01),
          ],
          instruction: "Take the ramp",
          maneuverType: "right",
          roadName: "Airport Ramp"
        ),
      ]
    )
    let stoneyRoute = makeNavigationSessionTrip(
      id: "stoney",
      steps: [
        sharedStart,
        NavOSSCarPlayRouteStep(
          distanceMeters: 1_700,
          durationSeconds: 125,
          geometry: [
            NavOSSCarPlayCoordinate(latitude: 51.05, longitude: -114.07),
            NavOSSCarPlayCoordinate(latitude: 51.13, longitude: -114.01),
          ],
          instruction: "Continue north",
          maneuverType: "straight",
          roadName: "Stoney Trail"
        ),
      ]
    )

    XCTAssertEqual(
      navOSSCarPlayRouteChoiceDetails([glenmoreRoute, stoneyRoute]),
      ["via Glenmore Trail", "via Stoney Trail"]
    )
  }

  func testCarPlayRouteNamesMeasureDifferenceWhenRoadsMatch() {
    let fastestRoute = makeNavigationSessionTrip(id: "fastest")
    let longerRoute = NavOSSCarPlayTrip(
      destination: fastestRoute.destination,
      distanceMeters: fastestRoute.distanceMeters + 320,
      durationSeconds: fastestRoute.durationSeconds + 45,
      geometry: fastestRoute.geometry,
      id: "longer",
      steps: fastestRoute.steps
    )

    XCTAssertEqual(
      navOSSCarPlayRouteChoiceDetails([fastestRoute, longerRoute]),
      [nil, "300 m longer"]
    )
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

  func testCarPlayDestinationStoreTogglesFavorite() throws {
    let suiteName = "NavOSSNavigationCoreTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let store = NavOSSCarPlayDestinationStore(defaults: defaults, key: "catalog")
    let favorite = NavOSSCarPlayDestination(
      category: "poi",
      id: "favorite",
      label: "101 9 Avenue SW",
      latitude: 51.04427,
      longitude: -114.06309,
      name: "Calgary Tower"
    )

    XCTAssertFalse(store.isFavorite(id: favorite.id))
    XCTAssertTrue(store.toggleFavorite(favorite))
    XCTAssertTrue(store.isFavorite(id: favorite.id))
    XCTAssertEqual(store.snapshot().searchableDestinations, [favorite])
    XCTAssertEqual(store.snapshot().favorites.first?.category, "poi")
    XCTAssertFalse(store.toggleFavorite(favorite))
    XCTAssertFalse(store.isFavorite(id: favorite.id))
    XCTAssertTrue(store.snapshot().favorites.isEmpty)
  }

  func testCarPlayDestinationStoreRecognizesEquivalentOSMFavoriteIds() throws {
    let suiteName = "NavOSSNavigationCoreTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let store = NavOSSCarPlayDestinationStore(defaults: defaults, key: "catalog")
    let mapPlace = NavOSSCarPlayDestination(
      id: "map-poi:42",
      label: "101 Test Avenue SW",
      latitude: 51.04427,
      longitude: -114.06309,
      name: "Test Cafe"
    )
    let searchPlace = NavOSSCarPlayDestination(
      id: "nominatim:node:42",
      label: "101 Test Avenue SW",
      latitude: 51.04428,
      longitude: -114.06308,
      name: "Test Cafe"
    )

    XCTAssertTrue(store.toggleFavorite(mapPlace))
    XCTAssertTrue(store.isFavorite(id: searchPlace.id))
    XCTAssertFalse(store.toggleFavorite(searchPlace))
    XCTAssertTrue(store.snapshot().favorites.isEmpty)
  }

  func testCarPlayDestinationStoreClearsAllLocalDestinations() throws {
    let suiteName = "NavOSSNavigationCoreTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let store = NavOSSCarPlayDestinationStore(defaults: defaults, key: "catalog")
    let destination = NavOSSCarPlayDestination(
      id: "calgary-tower",
      label: "101 9 Avenue SW",
      latitude: 51.04427,
      longitude: -114.06309,
      name: "Calgary Tower"
    )

    store.recordRecent(destination)
    store.replaceFavorites([destination])
    store.setHome(destination)
    store.setWork(destination)
    store.clearDestinations()

    XCTAssertEqual(store.snapshot(), NavOSSCarPlayDestinationCatalog())
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

  // Route below spans 0.02 degrees of longitude at latitude 51.04 (Calgary), which is
  // 1398.6 m. A 0.00005 degree jitter is therefore ~3.5 m of along-route regression.
  private static let jitterRouteLengthMeters = 1398.6

  func testMatchedProgressTracksBackwardJitterInsideAccuracyBand() throws {
    let core = NavigationCore()
    try core.setRoute([
      NavigationCoordinate(latitude: 51.04, longitude: -114.08),
      NavigationCoordinate(latitude: 51.04, longitude: -114.06),
    ])
    let forward = try core.updateLocation(
      NavigationLocationSample(
        coordinate: NavigationCoordinate(latitude: 51.04, longitude: -114.07),
        courseDegrees: 90,
        horizontalAccuracyMeters: 5
      )
    )
    let jitteredBackward = try core.updateLocation(
      NavigationLocationSample(
        coordinate: NavigationCoordinate(latitude: 51.04, longitude: -114.07005),
        courseDegrees: 90,
        horizontalAccuracyMeters: 5
      )
    )

    // Contract: a regression inside `backwardProgressToleranceMeters` + accuracy (15 + 5 m)
    // is tracked rather than held, so the puck keeps following the vehicle. Holding the
    // previous match here is what stalled the puck at low speed.
    XCTAssertFalse(jitteredBackward.isOffRoute)
    XCTAssertNotEqual(jitteredBackward.matchedCoordinate, forward.matchedCoordinate)

    let regressionMeters =
      (forward.routeProgress - jitteredBackward.routeProgress) * Self.jitterRouteLengthMeters
    XCTAssertEqual(regressionMeters, 3.5, accuracy: 0.5)
    XCTAssertLessThanOrEqual(regressionMeters, 20)
  }

  func testStationaryGPSNoiseDoesNotStallMatchedPosition() throws {
    let core = NavigationCore()
    try core.setRoute([
      NavigationCoordinate(latitude: 51.04, longitude: -114.08),
      NavigationCoordinate(latitude: 51.04, longitude: -114.06),
    ])
    func fix(_ longitude: Double) -> NavigationLocationSample {
      NavigationLocationSample(
        coordinate: NavigationCoordinate(latitude: 51.04, longitude: longitude),
        courseDegrees: nil,
        horizontalAccuracyMeters: 5
      )
    }

    _ = try core.updateLocation(fix(-114.07))
    // One noisy fix lands ~7 m ahead of where the stopped vehicle actually is.
    let ahead = try core.updateLocation(fix(-114.0699))

    // The vehicle is stationary at a light; every later fix reports the true position.
    var settled = ahead
    for _ in 0..<6 {
      settled = try core.updateLocation(fix(-114.07))
    }

    // Regression contract: progress must settle back onto the true position instead of
    // latching to the forward extreme of the noise until the vehicle drives past it.
    XCTAssertFalse(settled.isOffRoute)
    XCTAssertLessThan(settled.routeProgress, ahead.routeProgress)
    XCTAssertNotEqual(settled.matchedCoordinate, ahead.matchedCoordinate)
  }

  func testSustainedBackwardTravelTriggersRerouteWithoutRewindingProgress() throws {
    let core = NavigationCore()
    try core.setRoute([
      NavigationCoordinate(latitude: 51.04, longitude: -114.08),
      NavigationCoordinate(latitude: 51.04, longitude: -114.06),
    ])
    let forward = try core.updateLocation(
      NavigationLocationSample(
        coordinate: NavigationCoordinate(latitude: 51.04, longitude: -114.07),
        courseDegrees: 90,
        horizontalAccuracyMeters: 5
      )
    )

    var reversed = forward
    for longitude in [-114.0705, -114.071, -114.0715] {
      reversed = try core.updateLocation(
        NavigationLocationSample(
          coordinate: NavigationCoordinate(latitude: 51.04, longitude: longitude),
          courseDegrees: 270,
          horizontalAccuracyMeters: 5
        )
      )
    }

    XCTAssertTrue(reversed.isOffRoute)
    XCTAssertNil(reversed.matchedCoordinate)
    XCTAssertEqual(reversed.routeProgress, forward.routeProgress, accuracy: 0.000_001)

    var backwardRecovery = reversed
    for _ in 0..<2 {
      backwardRecovery = try core.updateLocation(
        NavigationLocationSample(
          coordinate: NavigationCoordinate(latitude: 51.04, longitude: -114.07005),
          courseDegrees: 90,
          horizontalAccuracyMeters: 5
        )
      )
    }
    XCTAssertTrue(backwardRecovery.isOffRoute)
    XCTAssertNil(backwardRecovery.matchedCoordinate)
    XCTAssertEqual(backwardRecovery.routeProgress, forward.routeProgress, accuracy: 0.000_001)
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

  private func makeNavigationSessionTrip(
    id: String = "route-1",
    currentSpokenInstruction: String? = nil,
    nextSpokenInstruction: String? = nil,
    geometry: [NavOSSCarPlayCoordinate]? = nil,
    steps: [NavOSSCarPlayRouteStep]? = nil,
    waypoints: [NavOSSCarPlayDestination]? = nil
  ) -> NavOSSCarPlayTrip {
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
      geometry: geometry ?? [
        NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.08),
        NavOSSCarPlayCoordinate(latitude: 51.05, longitude: -114.07),
        NavOSSCarPlayCoordinate(latitude: 51.13, longitude: -114.01),
      ],
      id: id,
      steps: steps ?? [
        NavOSSCarPlayRouteStep(
          distanceMeters: 500,
          durationSeconds: 60,
          geometry: [
            NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.08),
            NavOSSCarPlayCoordinate(latitude: 51.05, longitude: -114.07),
          ],
          instruction: "Head north",
          maneuverType: "depart",
          roadName: "Centre Street",
          spokenInstruction: currentSpokenInstruction
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
          roadName: "Airport Trail NE",
          spokenInstruction: nextSpokenInstruction
        ),
      ],
      waypoints: waypoints
    )
  }
}
