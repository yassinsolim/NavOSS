import Foundation
import XCTest

@testable import NavOSSNavigationCore

/// Reproductions from the independent review of the v9 navigation core, kept as permanent
/// regression tests. Each one failed before its fix.
final class NavigationReviewRegressionTests: XCTestCase {
  private typealias Trace = NavigationTrace

  private func carPlay(_ coordinates: [NavigationCoordinate]) -> [NavOSSCarPlayCoordinate] {
    coordinates.map { NavOSSCarPlayCoordinate(latitude: $0.latitude, longitude: $0.longitude) }
  }

  private func step(
    _ corners: [(Double, Double)],
    distance: Double,
    instruction: String,
    maneuver: String? = nil,
    spoken: String? = nil
  ) -> NavOSSCarPlayRouteStep {
    NavOSSCarPlayRouteStep(
      distanceMeters: distance,
      durationSeconds: distance / 20,
      geometry: carPlay(Trace.route(corners)),
      instruction: instruction,
      maneuverType: maneuver ?? (instruction == "Arrive" ? "arrive" : "turn"),
      roadName: "",
      spokenInstruction: spoken
    )
  }

  private func trip(
    _ corners: [(Double, Double)],
    steps: [NavOSSCarPlayRouteStep],
    id: String = "review"
  ) -> NavOSSCarPlayTrip {
    let last = Trace.coordinate(corners.last!.0, corners.last!.1)
    return NavOSSCarPlayTrip(
      destination: NavOSSCarPlayDestination(
        id: "d", label: "d", latitude: last.latitude, longitude: last.longitude,
        name: "Destination"
      ),
      distanceMeters: steps.reduce(0) { $0 + $1.distanceMeters },
      durationSeconds: steps.reduce(0) { $0 + $1.durationSeconds },
      geometry: carPlay(Trace.route(corners)),
      id: id,
      steps: steps
    )
  }

  private func guidance(_ stepIndex: Int, distance: Double = 50, duration: Double = 4)
    -> NavOSSCarPlayGuidance
  {
    NavOSSCarPlayGuidance(
      distanceToManeuverMeters: distance, durationToManeuverSeconds: duration,
      instruction: "Turn right", maneuverType: "turn", phase: .navigating,
      remainingDistanceMeters: distance + 1_000, remainingDurationSeconds: duration + 100,
      roadName: "", stepIndex: stepIndex
    )
  }

  // MARK: 1. Dead reckoning stops before the next unconfirmed maneuver

  func testDeadReckoningNeverCarriesGuidancePastAnUnconfirmedManeuver() throws {
    let turning = trip(
      [(0, 0), (300, 0), (300, 100), (600, 100), (600, 2_000)],
      steps: [
        step([(0, 0), (300, 0)], distance: 300, instruction: "Head east"),
        step([(300, 0), (300, 100)], distance: 100, instruction: "Turn left onto First Street"),
        step([(300, 100), (600, 100)], distance: 300, instruction: "Turn right onto Second Avenue"),
        step([(600, 100), (600, 2_000)], distance: 1_900, instruction: "Turn left onto Third Street"),
        step([(600, 2_000), (600, 2_000)], distance: 0, instruction: "Arrive"),
      ]
    )
    let session = NavigationSession()
    try session.start(turning)
    _ = try session.updateLocation(Trace.sample(x: 0, y: 0, courseDegrees: 90, speed: 20, time: 0))

    let reckoned = try XCTUnwrap(session.deadReckon(at: Trace.time(20)))
    XCTAssertEqual(reckoned.guidance?.stepIndex, 0)
    XCTAssertEqual(reckoned.guidance?.instruction, "Turn left onto First Street")
    let along = reckoned.snapshot.routeProgress * (session.routeLengthMeters ?? 0)
    XCTAssertLessThan(along, 300, "stops short of the turn it cannot see being taken")
    XCTAssertGreaterThan(along, 250)

    // A real fix past the turn confirms it; extrapolation may then continue on the next step.
    _ = try session.updateLocation(Trace.sample(x: 300, y: 60, courseDegrees: 0, speed: 10, time: 21))
    let next = try XCTUnwrap(session.deadReckon(at: Trace.time(25)))
    XCTAssertEqual(next.guidance?.stepIndex, 1)
    XCTAssertLessThan(next.snapshot.routeProgress * (session.routeLengthMeters ?? 0), 400)
  }

  // MARK: 2. A rejected fix after dead reckoning keeps the last real match

  func testImplausibleFixAfterDeadReckoningIsHeldAtTheLastRealMatch() throws {
    for withDeadReckoning in [false, true] {
      let core = NavigationCore()
      try core.setRoute(Trace.route([(0, 0), (5_000, 0)]))
      try core.updateLocation(Trace.sample(x: 100, y: 0, courseDegrees: 90, speed: 10, time: 0))
      if withDeadReckoning {
        XCTAssertNotNil(core.deadReckon(at: Trace.time(10)))
      }
      let jump = try core.updateLocation(
        Trace.sample(x: 700, y: 0, courseDegrees: 90, speed: 10, time: 11)
      )
      let jumpAlong = jump.routeProgress * (core.routeLengthMeters ?? 0)
      XCTAssertEqual(jumpAlong, 100, accuracy: 1, "dead reckoning: \(withDeadReckoning)")
      XCTAssertFalse(jump.isDeadReckoning)
      let matched = Trace.local(try XCTUnwrap(jump.matchedCoordinate))
      XCTAssertEqual(matched.x, 100, accuracy: 1)

      let correction = try core.updateLocation(
        Trace.sample(x: 220, y: 0, courseDegrees: 90, speed: 10, time: 12)
      )
      XCTAssertEqual(correction.routeProgress * (core.routeLengthMeters ?? 0), 220, accuracy: 1)
      XCTAssertFalse(correction.isOffRoute)
    }
  }

  // MARK: 3. Repeat suppression is per physical maneuver and never consumes a silent prompt

  func testIdenticalWordingForADifferentManeuverIsStillSpoken() {
    let repeated = trip(
      [(0, 0), (2_000, 0)],
      steps: [
        step([(0, 0), (800, 0)], distance: 800, instruction: "Head east"),
        step([(800, 0), (1_000, 0)], distance: 200, instruction: "Turn right"),
        step([(1_000, 0), (2_000, 0)], distance: 1_000, instruction: "Turn right"),
        step([(2_000, 0), (2_000, 0)], distance: 0, instruction: "Arrive"),
      ],
      id: "repeated"
    )
    let planner = NavigationSpeechPlanner()
    XCTAssertEqual(
      planner.prompt(trip: repeated, guidance: guidance(0), hasCurrentLocation: true, speedMetersPerSecond: 12, now: 0)?.text,
      "Turn right"
    )
    XCTAssertEqual(
      planner.prompt(trip: repeated, guidance: guidance(1), hasCurrentLocation: true, speedMetersPerSecond: 12, now: 20)?.key,
      "repeated:2:execute",
      "a different turn with the same words must be spoken"
    )
  }

  func testSuppressedPromptIsNotConsumed() {
    let route = trip(
      [(0, 0), (2_000, 0)],
      steps: [
        step([(0, 0), (1_000, 0)], distance: 1_000, instruction: "Head east"),
        step([(1_000, 0), (2_000, 0)], distance: 1_000, instruction: "Turn right"),
        step([(2_000, 0), (2_000, 0)], distance: 0, instruction: "Arrive"),
      ],
      id: "gap"
    )
    let planner = NavigationSpeechPlanner()
    _ = planner.prompt(trip: route, guidance: guidance(0, distance: 50), hasCurrentLocation: true, speedMetersPerSecond: 12, now: 0)
    // Within the minimum gap a prepare prompt for the next turn is deferred, not dropped.
    XCTAssertNil(planner.prompt(trip: route, guidance: guidance(1, distance: 450, duration: 37), hasCurrentLocation: true, speedMetersPerSecond: 12, now: 1))
    XCTAssertEqual(
      planner.prompt(trip: route, guidance: guidance(1, distance: 440, duration: 36), hasCurrentLocation: true, speedMetersPerSecond: 12, now: 5)?.key,
      "gap:2:prepare"
    )
  }

  /// The original intent still holds: the same physical turn on a replacement route is not
  /// announced twice.
  func testSameManeuverOnAReplacementRouteIsNotRepeated() {
    func route(id: String) -> NavOSSCarPlayTrip {
      trip(
        [(0, 0), (2_000, 0)],
        steps: [
          step([(0, 0), (1_000, 0)], distance: 1_000, instruction: "Head east"),
          step([(1_000, 0), (2_000, 0)], distance: 1_000, instruction: "Turn right"),
          step([(2_000, 0), (2_000, 0)], distance: 0, instruction: "Arrive"),
        ],
        id: id
      )
    }
    let planner = NavigationSpeechPlanner()
    XCTAssertNotNil(planner.prompt(trip: route(id: "a"), guidance: guidance(0, distance: 300, duration: 25), hasCurrentLocation: true, speedMetersPerSecond: 12, now: 0))
    planner.resetForReroute()
    XCTAssertNil(planner.prompt(trip: route(id: "b"), guidance: guidance(0, distance: 280, duration: 23), hasCurrentLocation: true, speedMetersPerSecond: 12, now: 5))
    XCTAssertEqual(
      planner.prompt(trip: route(id: "b"), guidance: guidance(0, distance: 50, duration: 4), hasCurrentLocation: true, speedMetersPerSecond: 12, now: 20)?.key,
      "b:1:execute"
    )
  }

  // MARK: 4. Speech deadlines account for the synthesizer's queue

  func testQueuedUtteranceIsNotExpiredWhileAnEarlierOneIsStillSpeaking() {
    var ledger = NavOSSSpeechUtteranceLedger()
    let utterances = [NSObject(), NSObject()]
    let long = ObjectIdentifier(utterances[0])
    let short = ObjectIdentifier(utterances[1])
    ledger.begin(long, characterCount: 300, now: 0)
    ledger.begin(short, characterCount: 20, now: 1)
    ledger.start(long, now: 0.5)

    XCTAssertFalse(ledger.expireOverdue(now: 10))
    XCTAssertEqual(ledger.count, 2, "the queued prompt has not had its turn yet")
    XCTAssertFalse(ledger.complete(long, now: 20), "the next prompt still holds the session")
    ledger.start(short, now: 20.1)
    XCTAssertFalse(ledger.expireOverdue(now: 21))
    XCTAssertTrue(ledger.complete(short, now: 22))
  }

  func testUtteranceThatNeverStartsIsBoundedSeparately() {
    var ledger = NavOSSSpeechUtteranceLedger()
    let utterance = NSObject()
    ledger.begin(ObjectIdentifier(utterance), characterCount: 200, now: 0)
    XCTAssertFalse(ledger.expireOverdue(now: NavOSSSpeechUtteranceLedger.startTimeoutSeconds - 0.1))
    XCTAssertTrue(ledger.expireOverdue(now: NavOSSSpeechUtteranceLedger.startTimeoutSeconds + 0.1))
  }

  // MARK: 5. The keep-route rejoin point is not a destination
  //
  // The rejoin point is sent as a `/v2/routes` `through` waypoint instead of being merged away
  // after the fact. `NavigationRoutesV2Tests` proves it with real recorded responses.

  // MARK: 8. Step boundary alignment

  func testShortFirstStepKeepsItsOwnStart() throws {
    let a = Trace.coordinate(0, 0)
    let b = Trace.coordinate(2, 0)
    let d = Trace.coordinate(2, 500)
    let route = NavOSSCarPlayTrip(
      destination: NavOSSCarPlayDestination(id: "d", label: "d", latitude: d.latitude, longitude: d.longitude, name: "Destination"),
      distanceMeters: 502,
      durationSeconds: 26,
      geometry: carPlay([a, b, d]),
      id: "short-first-step",
      steps: [
        NavOSSCarPlayRouteStep(distanceMeters: 2, durationSeconds: 1, geometry: carPlay([a, b]), instruction: "Head east", maneuverType: "depart", roadName: "First Road"),
        NavOSSCarPlayRouteStep(distanceMeters: 500, durationSeconds: 25, geometry: carPlay([b, d]), instruction: "Turn left", maneuverType: "turn", roadName: "Second Road"),
        NavOSSCarPlayRouteStep(distanceMeters: 0, durationSeconds: 0, geometry: carPlay([d, d]), instruction: "Arrive", maneuverType: "arrive", roadName: ""),
      ]
    )
    let aligned = NavigationStepGeometry(trip: route)
    XCTAssertTrue(aligned.isAligned)
    XCTAssertEqual(aligned.stepStartAlongMeters[1], 2, accuracy: 0.1)
    let session = NavigationSession()
    try session.start(route)
    let update = try session.updateLocation(NavigationLocationSample(coordinate: a, horizontalAccuracyMeters: 5, speedMetersPerSecond: 0, timestamp: 0))
    XCTAssertEqual(update.guidance?.stepIndex, 0)
    XCTAssertEqual(update.guidance?.instruction, "Turn left")
  }

  func testStepClosingALoopDoesNotShareItsStartWithTheNextStep() {
    let loopCorners: [(Double, Double)] = [(0, 0), (400, 0), (400, 400), (0, 400), (0, 0), (0, -500)]
    let loop = trip(
      loopCorners,
      steps: [
        step(Array(loopCorners.prefix(5)), distance: 1_600, instruction: "Continue around loop"),
        step([(0, 0), (0, -500)], distance: 500, instruction: "Head south"),
        step([(0, -500), (0, -500)], distance: 0, instruction: "Arrive"),
      ],
      id: "loop"
    )
    let aligned = NavigationStepGeometry(trip: loop)
    XCTAssertTrue(aligned.isAligned)
    XCTAssertEqual(aligned.stepStartAlongMeters[1], 1_600, accuracy: 1)
    XCTAssertEqual(aligned.stepIndex(atAlong: 0), 0)
  }

  // MARK: 9. Window fallback on a poor overall match, not just lateral distance

  func testLongOutageEndingAtASelfCrossingFindsTheLaterLeg() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route([(0, 0), (2_000, 0), (2_000, 1_000), (1_000, 1_000), (1_000, -2_000)]))
    try core.updateLocation(Trace.sample(x: 1_000, y: 0, courseDegrees: 90, speed: 20, time: 0))
    let crossing = try core.updateLocation(
      Trace.sample(x: 1_000, y: 0, courseDegrees: 180, speed: 20, time: 200)
    )
    XCTAssertEqual(crossing.routeProgress * (core.routeLengthMeters ?? 0), 5_000, accuracy: 5)
    XCTAssertEqual(crossing.matchedCourseDegrees ?? 0, 180, accuracy: 1)
  }

  func testCourseOnlyHairpinReplayMatchesTheReturnLeg() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route([(0, 0), (205, 0), (205, 35), (-500, 35)], spacing: 1))
    try core.updateLocation(Trace.sample(x: 0, y: 0))
    let resumed = try core.updateLocation(Trace.sample(x: 35, y: 35, courseDegrees: 270))
    XCTAssertEqual(resumed.routeProgress * (core.routeLengthMeters ?? 0), 410, accuracy: 2)
  }

  // MARK: 12. Consent deadlines run on the clock

  func testExpiredProposalCannotBeAcceptedAndExpiresWithoutAFix() {
    var consent = NavigationRerouteConsent()
    let replacement = trip(
      [(0, 0), (1_000, 0)],
      steps: [
        step([(0, 0), (1_000, 0)], distance: 1_000, instruction: "Head east", maneuver: "depart"),
        step([(1_000, 0), (1_000, 0)], distance: 0, instruction: "Arrive"),
      ]
    )
    _ = consent.received(replacement, mode: .askFirst, remainingDurationSeconds: nil, remainingDistanceMeters: nil, now: 0, id: "p1")
    XCTAssertNil(consent.accept(id: "p1", now: 46), "past its response window")

    var ticking = NavigationRerouteConsent()
    _ = ticking.received(replacement, mode: .askFirst, remainingDurationSeconds: nil, remainingDistanceMeters: nil, now: 0, id: "p2")
    // A clock tick during a GPS outage: no request may be made, but the deadline still applies.
    XCTAssertEqual(ticking.evaluate(mode: .askFirst, isOffRoute: true, canRequest: false, now: 46), .expired)
    XCTAssertNil(ticking.proposal)
    XCTAssertTrue(ticking.installsNextReplacement)
  }

  // MARK: 6. The install guard re-checks off-route under the same lock

  func testReplacementIsNotInstalledOnceTheDriverHasRejoinedTheRoute() {
    XCTAssertTrue(navigationShouldInstallReplacement(
      generationMatches: true, requestMatches: true, tripMatches: true, phase: .tracking, isOffRoute: true
    ))
    XCTAssertFalse(navigationShouldInstallReplacement(
      generationMatches: true, requestMatches: true, tripMatches: true, phase: .tracking, isOffRoute: false
    ))
    XCTAssertFalse(navigationShouldInstallReplacement(
      generationMatches: true, requestMatches: true, tripMatches: true, phase: .arrived, isOffRoute: true
    ))
  }

  // MARK: 7. An unroutable rejoin falls back to one plain recovery

  private func recoveryTrip(id: String) -> NavOSSCarPlayTrip {
    trip(
      [(0, 0), (1_000, 0)],
      steps: [
        step([(0, 0), (1_000, 0)], distance: 1_000, instruction: "Head east", maneuver: "depart"),
        step([(1_000, 0), (1_000, 0)], distance: 0, instruction: "Arrive"),
      ],
      id: id
    )
  }

  private let rejoin = NavOSSCarPlayDestination(
    id: "navoss-route-rejoin", label: "", latitude: 51.05, longitude: -114.07, name: "Selected route"
  )

  func testRouterFailureOnTheRejoinTriesOnePlainRecovery() async throws {
    var requests: [[String]] = []
    let recovered = try await navigationFetchRecoveryRoute(
      rejoin: rejoin,
      remainingWaypoints: []
    ) { waypoints, _ in
      requests.append(waypoints.map(\.id))
      if !waypoints.isEmpty { throw NavOSSNavigationAPIError.serviceUnavailable }
      return self.recoveryTrip(id: "plain")
    }
    XCTAssertEqual(recovered?.id, "plain")
    XCTAssertEqual(requests, [["navoss-route-rejoin"], []])
  }

  func testRecoveryFailsNormallyWhenThePlainRouteAlsoFails() async {
    var attempts = 0
    do {
      _ = try await navigationFetchRecoveryRoute(rejoin: rejoin, remainingWaypoints: []) { _, _ in
        attempts += 1
        throw NavOSSNavigationAPIError.serviceUnavailable
      }
      XCTFail("expected the reroute to fail")
    } catch {
      XCTAssertEqual(attempts, 2, "one rejoin attempt and one plain recovery, no more")
    }
  }

  func testSuccessfulRejoinIsUsedWithoutAPlainRequest() async throws {
    var attempts = 0
    let recovered = try await navigationFetchRecoveryRoute(rejoin: rejoin, remainingWaypoints: []) { _, _ in
      attempts += 1
      return self.recoveryTrip(id: "rejoined")
    }
    XCTAssertEqual(recovered?.id, "rejoined")
    XCTAssertEqual(attempts, 1)
  }

  // MARK: 10. Cameras are retried during an active trip

  func testCameraFetchRetriesWithinATripAfterAnOfflineStart() {
    XCTAssertTrue(navigationShouldFetchSafetyCameras(fetchedAt: nil, attemptedAt: nil, isFetching: false, now: 0))
    XCTAssertFalse(navigationShouldFetchSafetyCameras(fetchedAt: nil, attemptedAt: 0, isFetching: false, now: 30))
    XCTAssertTrue(
      navigationShouldFetchSafetyCameras(fetchedAt: nil, attemptedAt: 0, isFetching: false, now: 61),
      "a trip started offline retries within about a minute"
    )
    XCTAssertFalse(navigationShouldFetchSafetyCameras(fetchedAt: nil, attemptedAt: 0, isFetching: true, now: 61))
    XCTAssertFalse(navigationShouldFetchSafetyCameras(fetchedAt: 100, attemptedAt: 100, isFetching: false, now: 3_600))
    XCTAssertTrue(navigationShouldFetchSafetyCameras(fetchedAt: 100, attemptedAt: 100, isFetching: false, now: 100 + 6 * 3_600))
  }
}
