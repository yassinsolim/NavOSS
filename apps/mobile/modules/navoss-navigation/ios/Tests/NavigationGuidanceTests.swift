import Foundation
import XCTest

@testable import NavOSSNavigationCore

final class NavigationGuidanceTests: XCTestCase {
  private typealias Trace = NavigationTrace

  private func carPlay(_ coordinates: [NavigationCoordinate]) -> [NavOSSCarPlayCoordinate] {
    coordinates.map { NavOSSCarPlayCoordinate(latitude: $0.latitude, longitude: $0.longitude) }
  }

  private func step(
    _ corners: [(Double, Double)],
    distance: Double,
    duration: Double,
    instruction: String,
    maneuver: String = "turn",
    road: String,
    spoken: String? = nil
  ) -> NavOSSCarPlayRouteStep {
    NavOSSCarPlayRouteStep(
      distanceMeters: distance,
      durationSeconds: duration,
      geometry: carPlay(Trace.route(corners)),
      instruction: instruction,
      maneuverType: maneuver,
      roadName: road,
      spokenInstruction: spoken
    )
  }

  private func trip(
    id: String = "trip",
    corners: [(Double, Double)],
    steps: [NavOSSCarPlayRouteStep],
    speedLimitsKph: [Int]? = nil
  ) -> NavOSSCarPlayTrip {
    NavOSSCarPlayTrip(
      destination: NavOSSCarPlayDestination(
        id: "destination",
        label: "Destination",
        latitude: Trace.coordinate(corners.last!.0, corners.last!.1).latitude,
        longitude: Trace.coordinate(corners.last!.0, corners.last!.1).longitude,
        name: "Destination"
      ),
      distanceMeters: steps.reduce(0) { $0 + $1.distanceMeters },
      durationSeconds: steps.reduce(0) { $0 + $1.durationSeconds },
      geometry: carPlay(Trace.route(corners)),
      id: id,
      speedLimitsKph: speedLimitsKph,
      steps: steps
    )
  }

  // MARK: - Geometry-derived step progress

  /// Step 0's reported distance (2 km) is far longer than its geometry (500 m), as happens on
  /// curved ramps or with provider rounding. Proportional progress would still place the
  /// driver on step 0 after the turn; geometry knows they are on step 1.
  func testCurrentStepComesFromGeometryNotProportionalProgress() throws {
    let corners: [(Double, Double)] = [(0, 0), (500, 0), (500, 1_500)]
    let trip = trip(
      corners: corners,
      steps: [
        step([(0, 0), (500, 0)], distance: 2_000, duration: 120, instruction: "Head east", road: "1 Ave"),
        step([(500, 0), (500, 1_500)], distance: 100, duration: 10, instruction: "Turn left", road: "2 St"),
        step([(500, 1_500), (500, 1_500)], distance: 0, duration: 0, instruction: "Arrive", maneuver: "arrive", road: ""),
      ]
    )
    XCTAssertTrue(NavigationStepGeometry(trip: trip).isAligned)
    let session = NavigationSession()
    try session.start(trip)

    let afterTurn = try session.updateLocation(Trace.sample(x: 500, y: 200, courseDegrees: 0))
    XCTAssertEqual(afterTurn.guidance?.stepIndex, 1)
    XCTAssertEqual(afterTurn.guidance?.instruction, "Arrive")
    XCTAssertEqual(afterTurn.roadContext.currentRoadName, "2 St")
    // 1,300 of step 1's 1,500 m of geometry remain, so 13/15 of its reported 100 m.
    XCTAssertEqual(afterTurn.guidance?.distanceToManeuverMeters ?? 0, 100 * 1_300 / 1_500, accuracy: 1)
    XCTAssertEqual(afterTurn.guidance?.remainingDistanceMeters ?? 0, 100 * 1_300 / 1_500, accuracy: 1)

    let beforeTurn = try NavigationSession().start(trip)
    XCTAssertEqual(beforeTurn.guidance?.distanceToManeuverMeters, 2_000)
    XCTAssertEqual(beforeTurn.guidance?.remainingDistanceMeters, 2_100)
  }

  func testMisalignedStepGeometryFallsBackToStepDistances() {
    let corners: [(Double, Double)] = [(0, 0), (1_000, 0)]
    let trip = trip(
      corners: corners,
      steps: [
        step([(0, 300), (500, 300)], distance: 250, duration: 20, instruction: "Head east", road: "A"),
        step([(500, 300), (1_000, 300)], distance: 750, duration: 60, instruction: "Continue", road: "B"),
      ]
    )
    let geometry = NavigationStepGeometry(trip: trip)
    XCTAssertFalse(geometry.isAligned)
    XCTAssertEqual(geometry.stepStartAlongMeters[0], 0)
    XCTAssertEqual(geometry.stepStartAlongMeters[1], 250, accuracy: 0.5)
  }

  /// Step alignment walks forward, so on an out-and-back a return-leg step that starts at a
  /// coordinate the outbound leg also passes is placed on the return leg.
  func testStepAlignmentFollowsRouteOrderOnRevisitedVertices() {
    let corners: [(Double, Double)] = [(0, 0), (400, 0), (0, 0), (0, 400)]
    let trip = trip(
      corners: corners,
      steps: [
        step([(0, 0), (400, 0)], distance: 400, duration: 30, instruction: "Head east", road: "A"),
        step([(400, 0), (0, 0)], distance: 400, duration: 30, instruction: "Make a U-turn", road: "A"),
        step([(0, 0), (0, 400)], distance: 400, duration: 30, instruction: "Turn right", road: "B"),
      ]
    )
    let geometry = NavigationStepGeometry(trip: trip)
    XCTAssertTrue(geometry.isAligned)
    XCTAssertEqual(geometry.stepStartAlongMeters[2], 800, accuracy: 1)
  }

  func testRoadContextReportsTheMatchedSegmentLimitAndHidesUnknownOrOffRoute() throws {
    let corners: [(Double, Double)] = [(0, 0), (1_000, 0)]
    let geometry = Trace.route(corners, spacing: 500)
    let trip = NavOSSCarPlayTrip(
      destination: NavOSSCarPlayDestination(
        id: "d", label: "d", latitude: geometry[2].latitude, longitude: geometry[2].longitude, name: "d"
      ),
      distanceMeters: 1_000,
      durationSeconds: 60,
      geometry: carPlay(geometry),
      id: "limits",
      speedLimitsKph: [50, 0],
      steps: [
        NavOSSCarPlayRouteStep(
          distanceMeters: 1_000, durationSeconds: 60, geometry: carPlay(geometry),
          instruction: "Head east", maneuverType: "depart", roadName: " Memorial Drive "
        ),
      ]
    )
    let session = NavigationSession()
    try session.start(trip)
    let first = try session.updateLocation(Trace.sample(x: 200, y: 0))
    XCTAssertEqual(first.roadContext, NavigationRoadContext(currentRoadName: "Memorial Drive", speedLimitKph: 50))
    let unknownLimit = try session.updateLocation(Trace.sample(x: 700, y: 0))
    XCTAssertNil(unknownLimit.roadContext.speedLimitKph, "0 means unknown and must stay hidden")

    var offRoute = unknownLimit
    for _ in 0..<3 {
      offRoute = try session.updateLocation(Trace.sample(x: 700, y: 300))
    }
    XCTAssertTrue(offRoute.snapshot.isOffRoute)
    XCTAssertEqual(offRoute.roadContext, .unknown)
  }

  // MARK: - Speech

  private func guidance(
    distance: Double,
    duration: Double,
    stepIndex: Int = 0
  ) -> NavOSSCarPlayGuidance {
    NavOSSCarPlayGuidance(
      distanceToManeuverMeters: distance,
      durationToManeuverSeconds: duration,
      instruction: "Take exit",
      maneuverType: "off ramp",
      phase: .navigating,
      remainingDistanceMeters: distance + 5_000,
      remainingDurationSeconds: duration + 300,
      roadName: "",
      stepIndex: stepIndex
    )
  }

  private func speechTrip(gapAfterFirstManeuver: Double = 3_000) -> NavOSSCarPlayTrip {
    let corners: [(Double, Double)] = [(0, 0), (10_000, 0)]
    let geometry = carPlay(Trace.route(corners, spacing: 2_500))
    func plain(_ instruction: String, _ distance: Double, spoken: String? = nil)
      -> NavOSSCarPlayRouteStep
    {
      NavOSSCarPlayRouteStep(
        distanceMeters: distance, durationSeconds: distance / 20, geometry: geometry,
        instruction: instruction, maneuverType: "turn", roadName: "", spokenInstruction: spoken
      )
    }
    return NavOSSCarPlayTrip(
      destination: NavOSSCarPlayDestination(
        id: "d", label: "d", latitude: 51.04, longitude: -113.9, name: "Banff"
      ),
      distanceMeters: 10_000,
      durationSeconds: 500,
      geometry: geometry,
      id: "speech",
      steps: [
        plain("Head west", 5_000),
        plain("Take exit 12", gapAfterFirstManeuver, spoken: "Take exit 12 toward Banff."),
        plain("Turn left onto Bow Trail", 2_000, spoken: "Turn left onto Bow Trail."),
        plain("Arrive", 0),
      ]
    )
  }

  func testHighwaySpeedsAddAnEarlyPromptAndAnnounceEarlier() {
    let planner = NavigationSpeechPlanner()
    let trip = speechTrip()
    let now = 1_000.0

    XCTAssertNil(planner.prompt(trip: trip, guidance: guidance(distance: 2_600, duration: 87), hasCurrentLocation: true, speedMetersPerSecond: 30, now: now))
    let early = planner.prompt(trip: trip, guidance: guidance(distance: 1_950, duration: 65), hasCurrentLocation: true, speedMetersPerSecond: 30, now: now)
    XCTAssertEqual(early?.key, "speech:1:early")
    XCTAssertEqual(early?.text, "In 2 kilometres, take exit 12 toward Banff.")

    let prepare = planner.prompt(trip: trip, guidance: guidance(distance: 990, duration: 33), hasCurrentLocation: true, speedMetersPerSecond: 30, now: now + 32)
    XCTAssertEqual(prepare?.text, "In 1 kilometre, take exit 12 toward Banff.")

    let execute = planner.prompt(trip: trip, guidance: guidance(distance: 200, duration: 7), hasCurrentLocation: true, speedMetersPerSecond: 30, now: now + 59)
    XCTAssertEqual(execute?.key, "speech:1:execute")
    XCTAssertEqual(execute?.text, "Take exit 12 toward Banff.")
  }

  func testCitySpeedsHaveNoEarlyPromptAndKeepTheExistingThresholds() {
    let planner = NavigationSpeechPlanner()
    let trip = speechTrip()
    XCTAssertNil(planner.prompt(trip: trip, guidance: guidance(distance: 1_900, duration: 150), hasCurrentLocation: true, speedMetersPerSecond: 13))
    XCTAssertEqual(
      planner.prompt(trip: trip, guidance: guidance(distance: 480, duration: 37), hasCurrentLocation: true, speedMetersPerSecond: 13)?.key,
      "speech:1:prepare"
    )
    XCTAssertEqual(
      planner.prompt(trip: trip, guidance: guidance(distance: 120, duration: 9.5), hasCurrentLocation: true, speedMetersPerSecond: 13)?.key,
      "speech:1:execute",
      "execute fires within 10 s even beyond 75 m"
    )
  }

  func testCloselySpacedManeuversAreChainedAndTheSecondIsNotPreparedAgain() {
    let planner = NavigationSpeechPlanner()
    let trip = speechTrip(gapAfterFirstManeuver: 120)

    let execute = planner.prompt(trip: trip, guidance: guidance(distance: 60, duration: 5), hasCurrentLocation: true, speedMetersPerSecond: 12, now: 0)
    XCTAssertEqual(execute?.text, "Take exit 12 toward Banff, then turn left onto Bow Trail.")

    // On the next step the turn is 120 m away (prepare range) but was already announced.
    XCTAssertNil(planner.prompt(trip: trip, guidance: guidance(distance: 110, duration: 12, stepIndex: 1), hasCurrentLocation: true, speedMetersPerSecond: 12, now: 6))
    let secondExecute = planner.prompt(trip: trip, guidance: guidance(distance: 60, duration: 5, stepIndex: 1), hasCurrentLocation: true, speedMetersPerSecond: 12, now: 10)
    XCTAssertEqual(secondExecute?.text, "Turn left onto Bow Trail.")
  }

  func testOffRouteSilencesManeuverPrompts() {
    let planner = NavigationSpeechPlanner()
    XCTAssertNil(planner.prompt(trip: speechTrip(), guidance: guidance(distance: 60, duration: 5), hasCurrentLocation: true, speedMetersPerSecond: 12, isOffRoute: true))
  }

  /// After a reroute the new route usually starts with the same turn the driver was just told
  /// about. It must not be repeated, and a turn first seen at execute range gets only "Turn".
  func testRerouteDoesNotReplayPromptsJustSpoken() {
    let planner = NavigationSpeechPlanner()
    let trip = speechTrip()
    let prepare = planner.prompt(trip: trip, guidance: guidance(distance: 300, duration: 25), hasCurrentLocation: true, speedMetersPerSecond: 12, now: 0)
    XCTAssertNotNil(prepare)

    planner.resetForReroute()
    XCTAssertNil(
      planner.prompt(trip: trip, guidance: guidance(distance: 300, duration: 25), hasCurrentLocation: true, speedMetersPerSecond: 12, now: 8),
      "identical words within 30 s are not repeated"
    )
    let execute = planner.prompt(trip: trip, guidance: guidance(distance: 50, duration: 4), hasCurrentLocation: true, speedMetersPerSecond: 12, now: 30)
    XCTAssertEqual(execute?.key, "speech:1:execute")
    XCTAssertNil(planner.prompt(trip: trip, guidance: guidance(distance: 40, duration: 3), hasCurrentLocation: true, speedMetersPerSecond: 12, now: 31))
  }

  func testLowerUrgencyPromptsWaitForAGapAfterAnotherPrompt() {
    let planner = NavigationSpeechPlanner()
    let trip = speechTrip(gapAfterFirstManeuver: 600)
    _ = planner.prompt(trip: trip, guidance: guidance(distance: 50, duration: 4), hasCurrentLocation: true, speedMetersPerSecond: 12, now: 0)
    XCTAssertNil(planner.prompt(trip: trip, guidance: guidance(distance: 450, duration: 37, stepIndex: 1), hasCurrentLocation: true, speedMetersPerSecond: 12, now: 1))
    XCTAssertEqual(
      planner.prompt(trip: trip, guidance: guidance(distance: 440, duration: 36, stepIndex: 1), hasCurrentLocation: true, speedMetersPerSecond: 12, now: 4)?.key,
      "speech:2:prepare"
    )
  }

  func testArrivalIsAnnouncedOncePerTrip() {
    let planner = NavigationSpeechPlanner()
    let arrived = NavOSSCarPlayGuidance(
      distanceToManeuverMeters: 0, durationToManeuverSeconds: 0, instruction: "Arrive",
      maneuverType: "arrive", phase: .arrived, remainingDistanceMeters: 0,
      remainingDurationSeconds: 0, roadName: "", stepIndex: 3
    )
    XCTAssertEqual(planner.prompt(trip: speechTrip(), guidance: arrived, hasCurrentLocation: true)?.text, "You've arrived at Banff.")
    XCTAssertNil(planner.prompt(trip: speechTrip(), guidance: arrived, hasCurrentLocation: true))
  }

  func testSpokenDistancesUseNaturalCanadianMetricPhrasing() {
    let cases: [(Double, String)] = [
      (40, "40 metres"),
      (430, "450 metres"),
      (980, "1 kilometre"),
      (1_499, "1.5 kilometres"),
      (2_040, "2 kilometres"),
      (2_800, "3 kilometres"),
      (12_400, "12 kilometres"),
    ]
    for (meters, expected) in cases {
      XCTAssertEqual(NavigationSpeechPlanner.spokenDistance(meters), expected, "\(meters) m")
    }
  }
}
