import Foundation
import XCTest

@testable import NavOSSNavigationCore

final class CarPlayGuidancePresentationTests: XCTestCase {
  // A north-bound approach, a right turn east, then a left turn north 120 m later, then arrival.
  private let origin = NavOSSCarPlayCoordinate(latitude: 51.0400, longitude: -114.0700)
  private let corner = NavOSSCarPlayCoordinate(latitude: 51.0430, longitude: -114.0700)
  private let secondCorner = NavOSSCarPlayCoordinate(latitude: 51.0430, longitude: -114.0683)
  private let destinationCoordinate = NavOSSCarPlayCoordinate(
    latitude: 51.0460, longitude: -114.0683)

  private func trip(
    secondLegMeters: Double = 120,
    lanes: [NavOSSCarPlayLane]? = nil,
    congestion: [NavOSSCarPlayCongestionLevel]? = nil
  ) -> NavOSSCarPlayTrip {
    NavOSSCarPlayTrip(
      destination: NavOSSCarPlayDestination(
        id: "dest", label: "Test", latitude: destinationCoordinate.latitude,
        longitude: destinationCoordinate.longitude, name: "Destination"),
      distanceMeters: 800,
      durationSeconds: 90,
      geometry: [origin, corner, secondCorner, destinationCoordinate],
      id: "trip",
      steps: [
        NavOSSCarPlayRouteStep(
          distanceMeters: 333, durationSeconds: 30, geometry: [origin, corner],
          instruction: "Drive north on 1 Street SW.", maneuverType: "depart",
          roadName: "1 Street SW"),
        NavOSSCarPlayRouteStep(
          distanceMeters: secondLegMeters, durationSeconds: 15, geometry: [corner, secondCorner],
          instruction: "Turn right onto Left Bank Road.", maneuverType: "turn",
          roadName: "Left Bank Road", lanes: lanes),
        NavOSSCarPlayRouteStep(
          distanceMeters: 333, durationSeconds: 40,
          geometry: [secondCorner, destinationCoordinate],
          instruction: "Turn left onto 2 Street SW.", maneuverType: "turn",
          roadName: "2 Street SW"),
        NavOSSCarPlayRouteStep(
          distanceMeters: 0, durationSeconds: 0,
          geometry: [destinationCoordinate, destinationCoordinate],
          instruction: "Your destination is on the right.", maneuverType: "arrive",
          roadName: "2 Street SW"),
      ],
      congestion: congestion
    )
  }

  private func guidance(stepIndex: Int, distance: Double = 200) -> NavOSSCarPlayGuidance {
    NavOSSCarPlayGuidance(
      distanceToManeuverMeters: distance, durationToManeuverSeconds: 20,
      instruction: "unused", maneuverType: "turn", phase: .navigating,
      remainingDistanceMeters: 700, remainingDurationSeconds: 80, roadName: "unused",
      stepIndex: stepIndex)
  }

  // MARK: Maneuver classification

  func testRoadNamesContainingDirectionsDoNotFlipTheTurn() {
    XCTAssertEqual(
      navOSSCarPlayManeuverKind(type: "turn", instruction: "Turn right onto Left Bank Road."),
      .right)
    XCTAssertEqual(
      navOSSCarPlayManeuverKind(type: "turn", instruction: "Turn left onto Wright Avenue."),
      .left)
  }

  func testStructuredModifierWinsOverInstructionText() {
    XCTAssertEqual(
      navOSSCarPlayManeuverKind(type: "turn", modifier: "sharp left", instruction: "Turn right."),
      .sharpLeft)
  }

  func testOsrmTypesMapToCarPlayManeuvers() {
    XCTAssertEqual(navOSSCarPlayManeuverKind(type: "depart", instruction: "Drive north."), .depart)
    XCTAssertEqual(
      navOSSCarPlayManeuverKind(type: "arrive", instruction: "Your destination is on the left."),
      .arriveLeft)
    XCTAssertEqual(
      navOSSCarPlayManeuverKind(type: "off ramp", instruction: "Take the exit on the left."),
      .offRampLeft)
    XCTAssertEqual(
      navOSSCarPlayManeuverKind(type: "fork", instruction: "Keep right at the fork."), .keepRight)
    XCTAssertEqual(
      navOSSCarPlayManeuverKind(type: "end of road", instruction: "Turn left onto Crowchild."),
      .leftAtEnd)
    XCTAssertEqual(
      navOSSCarPlayManeuverKind(type: "new name", instruction: "Continue onto Glenmore Trail."),
      .followRoad)
    XCTAssertEqual(
      navOSSCarPlayManeuverKind(type: "turn", instruction: "Make a U-turn."), .uTurn)
  }

  func testRoundaboutExitComesFromFieldOrInstruction() {
    XCTAssertEqual(
      navOSSCarPlayManeuverKind(
        type: "roundabout", instruction: "Enter the roundabout and take the 2nd exit."),
      .roundabout(exit: 2))
    XCTAssertEqual(
      navOSSCarPlayManeuverKind(
        type: "rotary", instruction: "Enter the traffic circle and take the third exit."),
      .roundabout(exit: 3))
    XCTAssertEqual(
      navOSSCarPlayManeuverKind(
        type: "roundabout", instruction: "Take the 2nd exit.", roundaboutExit: 4),
      .roundabout(exit: 4))
    XCTAssertEqual(
      navOSSCarPlayManeuverKind(type: "roundabout", instruction: "Enter the roundabout."),
      .roundabout(exit: nil))
  }

  func testTurnAngleIsMeasuredFromGeometry() throws {
    let angle = try XCTUnwrap(
      navOSSCarPlayManeuverTurnAngle(steps: trip().steps, stepIndex: 1))
    XCTAssertEqual(angle, 90, accuracy: 3)
    let left = try XCTUnwrap(navOSSCarPlayManeuverTurnAngle(steps: trip().steps, stepIndex: 2))
    XCTAssertEqual(left, -90, accuracy: 3)
    XCTAssertNil(navOSSCarPlayManeuverTurnAngle(steps: trip().steps, stepIndex: 0))
  }

  // MARK: Guidance presentation

  func testGuidanceShowsCurrentRoadAndNextManeuver() throws {
    let presentation = try XCTUnwrap(
      navOSSCarPlayGuidancePresentation(trip: trip(), guidance: guidance(stepIndex: 0)))
    XCTAssertEqual(presentation.currentRoadName, "1 Street SW")
    XCTAssertEqual(presentation.primary.stepIndex, 1)
    XCTAssertEqual(presentation.primary.kind, .right)
    XCTAssertEqual(presentation.primary.roadName, "Left Bank Road")
    XCTAssertEqual(presentation.primary.legDistanceMeters, 333)
    XCTAssertEqual(presentation.primary.instructionVariants.first, "Turn right onto Left Bank Road.")
  }

  func testThenManeuverOnlyWhenItFollowsClosely() throws {
    let close = try XCTUnwrap(
      navOSSCarPlayGuidancePresentation(trip: trip(), guidance: guidance(stepIndex: 0)))
    XCTAssertEqual(close.then?.stepIndex, 2)
    XCTAssertEqual(close.then?.kind, .left)

    let far = try XCTUnwrap(
      navOSSCarPlayGuidancePresentation(
        trip: trip(secondLegMeters: 900), guidance: guidance(stepIndex: 0)))
    XCTAssertNil(far.then)
  }

  func testLastStepPresentsArrivalWithoutThen() throws {
    let presentation = try XCTUnwrap(
      navOSSCarPlayGuidancePresentation(trip: trip(), guidance: guidance(stepIndex: 2)))
    XCTAssertEqual(presentation.primary.kind, .arriveRight)
    XCTAssertNil(presentation.then)
    XCTAssertEqual(presentation.currentRoadName, "2 Street SW")
  }

  func testArrivedPhaseHasNoPresentation() {
    let arrived = NavOSSCarPlayGuidance(
      distanceToManeuverMeters: 0, durationToManeuverSeconds: 0, instruction: "Arrived",
      maneuverType: "arrive", phase: .arrived, remainingDistanceMeters: 0,
      remainingDurationSeconds: 0, roadName: "", stepIndex: 3)
    XCTAssertNil(navOSSCarPlayGuidancePresentation(trip: trip(), guidance: arrived))
  }

  func testManeuverPhaseScalesWithSpeed() {
    XCTAssertEqual(
      navOSSCarPlayManeuverPhase(distanceToManeuverMeters: 50, speedMetersPerSecond: 10), .execute)
    XCTAssertEqual(
      navOSSCarPlayManeuverPhase(distanceToManeuverMeters: 150, speedMetersPerSecond: 30), .execute)
    XCTAssertEqual(
      navOSSCarPlayManeuverPhase(distanceToManeuverMeters: 150, speedMetersPerSecond: 10), .prepare)
    XCTAssertEqual(
      navOSSCarPlayManeuverPhase(distanceToManeuverMeters: 700, speedMetersPerSecond: 30), .prepare)
    XCTAssertEqual(
      navOSSCarPlayManeuverPhase(distanceToManeuverMeters: 1_500, speedMetersPerSecond: nil),
      .initial)
    XCTAssertEqual(
      navOSSCarPlayManeuverPhase(distanceToManeuverMeters: 5_000, speedMetersPerSecond: nil),
      .continuing)
  }

  // MARK: Lanes

  func testAbsentOrUnusableLanesProduceNothing() {
    XCTAssertNil(navOSSCarPlayLaneSpecs(nil))
    XCTAssertNil(navOSSCarPlayLaneSpecs([]))
    XCTAssertNil(
      navOSSCarPlayLaneSpecs([NavOSSCarPlayLane(indications: [.left], isValid: false)]))
    XCTAssertNil(navOSSCarPlayLaneSpecs([NavOSSCarPlayLane(indications: [], isValid: true)]))
  }

  func testLaneSpecsHighlightTheActiveArrowAndExcludeItFromAngles() throws {
    let specs = try XCTUnwrap(
      navOSSCarPlayLaneSpecs([
        NavOSSCarPlayLane(indications: [.left], isValid: false),
        NavOSSCarPlayLane(
          indications: [.straight, .right], isValid: true, isPreferred: true,
          activeIndication: .right),
        NavOSSCarPlayLane(indications: [.right], isValid: true),
      ]))
    XCTAssertEqual(specs[0], NavOSSCarPlayLaneSpec(angles: [-90], highlightedAngle: nil, status: .notGood))
    XCTAssertEqual(specs[1], NavOSSCarPlayLaneSpec(angles: [0], highlightedAngle: 90, status: .preferred))
    XCTAssertEqual(specs[2], NavOSSCarPlayLaneSpec(angles: [], highlightedAngle: 90, status: .good))
  }

  func testLanesOnAStepReachTheManeuver() throws {
    let lanes = [
      NavOSSCarPlayLane(indications: [.straight], isValid: false),
      NavOSSCarPlayLane(indications: [.right], isValid: true, isPreferred: true),
    ]
    let info = try XCTUnwrap(navOSSCarPlayManeuverInfo(trip: trip(lanes: lanes), stepIndex: 1))
    XCTAssertEqual(info.lanes?.count, 2)
    XCTAssertNil(navOSSCarPlayManeuverInfo(trip: trip(), stepIndex: 1)?.lanes)
  }

  // MARK: Map overlays

  func testManeuverArrowSpansTheTurn() {
    let arrow = navOSSCarPlayManeuverArrow(trip: trip(), maneuverStepIndex: 1)
    XCTAssertGreaterThanOrEqual(arrow.count, 3)
    // Starts before the corner on the approach and ends east of it on the new road.
    XCTAssertLessThan(arrow.first!.latitude, corner.latitude)
    XCTAssertGreaterThan(arrow.last!.longitude, corner.longitude)
    XCTAssertTrue(arrow.contains(corner))
  }

  func testNoManeuverArrowForArrival() {
    XCTAssertEqual(navOSSCarPlayManeuverArrow(trip: trip(), maneuverStepIndex: 3), [])
    XCTAssertEqual(navOSSCarPlayManeuverArrow(trip: trip(), maneuverStepIndex: 0), [])
  }

  func testCongestionRunsSkipUnknownAndFreeSegments() {
    let geometry = trip().geometry
    XCTAssertEqual(navOSSCarPlayCongestionRuns(geometry: geometry, levels: nil), [])
    XCTAssertEqual(navOSSCarPlayCongestionRuns(geometry: geometry, levels: [.heavy]), [])
    XCTAssertEqual(
      navOSSCarPlayCongestionRuns(geometry: geometry, levels: [.free, .unknown, .free]), [])
    let runs = navOSSCarPlayCongestionRuns(geometry: geometry, levels: [.slow, .slow, .stopped])
    XCTAssertEqual(runs.count, 2)
    XCTAssertEqual(runs[0].level, .slow)
    XCTAssertEqual(runs[0].coordinates, Array(geometry[0...2]))
    XCTAssertEqual(runs[1].level, .stopped)
    XCTAssertEqual(runs[1].coordinates, Array(geometry[2...3]))
  }

  func testCongestionBehindTheVehicleIsDropped() {
    let geometry = trip().geometry
    let runs = navOSSCarPlayCongestionRuns(
      geometry: geometry, levels: [.heavy, .heavy, .heavy], startingAtProgress: 0.5)
    XCTAssertEqual(runs.count, 1)
    XCTAssertEqual(runs[0].coordinates.last, geometry[3])
    XCTAssertFalse(runs[0].coordinates.contains(geometry[0]))
    XCTAssertEqual(
      navOSSCarPlayCongestionRuns(geometry: geometry, levels: [.slow, .slow, .slow], startingAtProgress: 1),
      [])
  }

  func testMapAlertStoreDropsInvalidAndDuplicateAlertsAndNotifiesOnChange() {
    let center = NotificationCenter()
    let store = NavOSSCarPlayMapAlertStore(notificationCenter: center)
    var notifications = 0
    let observer = center.addObserver(
      forName: .navOSSCarPlayMapAlertsDidChange, object: store, queue: nil
    ) { _ in notifications += 1 }
    defer { center.removeObserver(observer) }
    let camera = NavOSSCarPlayMapAlert(id: "a", kind: .speedCamera, coordinate: corner)
    store.publish([
      camera,
      NavOSSCarPlayMapAlert(id: "a", kind: .redLightCamera, coordinate: origin),
      NavOSSCarPlayMapAlert(
        id: "bad", kind: .report(.pothole),
        coordinate: NavOSSCarPlayCoordinate(latitude: 200, longitude: 0)),
    ])
    XCTAssertEqual(store.snapshot(), [camera])
    store.publish([camera])
    XCTAssertEqual(notifications, 1)
  }

  // MARK: Camera

  func testCameraWidensWithSpeedAndTightensNearAManeuver() {
    let parked = navOSSCarPlayCameraTarget(speedMetersPerSecond: 0, distanceToManeuverMeters: nil)
    let city = navOSSCarPlayCameraTarget(speedMetersPerSecond: 14, distanceToManeuverMeters: nil)
    let highway = navOSSCarPlayCameraTarget(speedMetersPerSecond: 30, distanceToManeuverMeters: nil)
    XCTAssertLessThan(parked.viewingDistanceMeters, city.viewingDistanceMeters)
    XCTAssertLessThan(city.viewingDistanceMeters, highway.viewingDistanceMeters)
    XCTAssertGreaterThan(parked.pitchDegrees, highway.pitchDegrees)
    let approaching = navOSSCarPlayCameraTarget(
      speedMetersPerSecond: 30, distanceToManeuverMeters: 80)
    XCTAssertLessThan(approaching.viewingDistanceMeters, highway.viewingDistanceMeters)
    for target in [parked, city, highway, approaching] {
      XCTAssertTrue((420...1_350).contains(target.viewingDistanceMeters))
      XCTAssertTrue((36...50).contains(target.pitchDegrees))
    }
    XCTAssertEqual(
      navOSSCarPlayCameraTarget(speedMetersPerSecond: .nan, distanceToManeuverMeters: .infinity),
      parked)
  }

  func testSmoothingIsFrameRateIndependent() {
    var sixty = 0.0
    for _ in 0..<60 {
      sixty = navOSSCarPlaySmoothed(sixty, toward: 100, elapsedSeconds: 1 / 60, timeConstantSeconds: 0.5)
    }
    var thirty = 0.0
    for _ in 0..<30 {
      thirty = navOSSCarPlaySmoothed(thirty, toward: 100, elapsedSeconds: 1 / 30, timeConstantSeconds: 0.5)
    }
    XCTAssertEqual(sixty, thirty, accuracy: 0.001)
    XCTAssertEqual(sixty, 100 * (1 - exp(-2)), accuracy: 0.001)
  }

  func testBearingSmoothingTakesTheShortWayAcrossNorth() {
    let next = navOSSCarPlaySmoothedBearing(
      350, toward: 10, elapsedSeconds: 10, timeConstantSeconds: 0.1)
    XCTAssertEqual(next, 10, accuracy: 0.01)
    let halfway = navOSSCarPlaySmoothedBearing(
      350, toward: 10, elapsedSeconds: log(2) * 0.5, timeConstantSeconds: 0.5)
    XCTAssertEqual(halfway, 0, accuracy: 0.01)
  }

  // MARK: Speed

  func testRerouteProposalTextStatesTheRealChange() {
    typealias Proposal = NavOSSCarPlayLiveGuidance.RerouteProposal
    XCTAssertEqual(
      navOSSCarPlayRerouteProposalText(
        Proposal(id: "a", durationDeltaSeconds: 185, distanceDeltaMeters: 1_240)
      ).subtitle,
      "3 min slower, 1.2 km longer.")
    XCTAssertEqual(
      navOSSCarPlayRerouteProposalText(
        Proposal(id: "b", durationDeltaSeconds: -120, distanceDeltaMeters: -400)
      ).subtitle,
      "2 min faster, 400 m shorter.")
    XCTAssertEqual(
      navOSSCarPlayRerouteProposalText(
        Proposal(id: "c", durationDeltaSeconds: 10, distanceDeltaMeters: 20)
      ).subtitle,
      "About the same time, similar distance.")
  }
  // MARK: Search and stops

  func testDistanceLabels() {
    XCTAssertEqual(navOSSCarPlayDistanceLabel(3), "10 m")
    XCTAssertEqual(navOSSCarPlayDistanceLabel(347), "350 m")
    XCTAssertEqual(navOSSCarPlayDistanceLabel(1_240), "1.2 km")
    XCTAssertEqual(navOSSCarPlayDistanceLabel(12_400), "12 km")
    XCTAssertEqual(navOSSCarPlayDistanceLabel(.nan), "")
  }

  func testCategoryResultsSortNearestFirstKeepingProviderOrderForTies() {
    func place(_ id: String, _ latitude: Double) -> NavOSSCarPlayDestination {
      NavOSSCarPlayDestination(id: id, label: "", latitude: latitude, longitude: -114, name: id)
    }
    let here = NavOSSCarPlayCoordinate(latitude: 51, longitude: -114)
    let ordered = navOSSCarPlayDestinationsOrderedByDistance(
      [place("far", 51.05), place("near-a", 51.01), place("near-b", 51.01), place("mid", 51.02)],
      from: here)
    XCTAssertEqual(ordered.map(\.id), ["near-a", "near-b", "mid", "far"])
    XCTAssertEqual(
      navOSSCarPlayDestinationsOrderedByDistance([place("b", 52), place("a", 51)], from: nil)
        .map(\.id),
      ["b", "a"])
  }

  func testStopEditing() {
    let stops = ["a", "b", "c"].map {
      NavOSSCarPlayDestination(id: $0, label: "", latitude: 51, longitude: -114, name: $0)
    }
    XCTAssertEqual(navOSSCarPlayWaypoints(stops, removingAt: 1)?.map(\.id), ["a", "c"])
    XCTAssertNil(navOSSCarPlayWaypoints(stops, removingAt: 3))
    XCTAssertEqual(navOSSCarPlayWaypoints(stops, movingEarlierAt: 2)?.map(\.id), ["a", "c", "b"])
    XCTAssertNil(navOSSCarPlayWaypoints(stops, movingEarlierAt: 0))
  }

  // MARK: Voice and scene lifecycle

  func testVoiceInputPrefersTheCarMicrophone() {
    XCTAssertEqual(
      navOSSCarPlayPreferredVoiceInputPort(["MicrophoneBuiltIn", "CarAudio", "BluetoothHFP"]),
      "CarAudio")
    XCTAssertEqual(
      navOSSCarPlayPreferredVoiceInputPort(["MicrophoneBuiltIn", "BluetoothHFP"]), "BluetoothHFP")
    XCTAssertEqual(navOSSCarPlayPreferredVoiceInputPort(["MicrophoneBuiltIn"]), "MicrophoneBuiltIn")
    XCTAssertNil(navOSSCarPlayPreferredVoiceInputPort([]))
  }

  func testPreviewSurvivesResumeUnlessATripChangedWhileAway() {
    XCTAssertEqual(
      navOSSCarPlayPreviewResumeAction(
        isPreviewing: false, previewReplacesActiveTrip: false, guidancePhase: nil), .none)
    XCTAssertEqual(
      navOSSCarPlayPreviewResumeAction(
        isPreviewing: true, previewReplacesActiveTrip: false, guidancePhase: nil), .keep)
    XCTAssertEqual(
      navOSSCarPlayPreviewResumeAction(
        isPreviewing: true, previewReplacesActiveTrip: false, guidancePhase: .navigating),
      .discard)
    XCTAssertEqual(
      navOSSCarPlayPreviewResumeAction(
        isPreviewing: true, previewReplacesActiveTrip: true, guidancePhase: .navigating), .keep)
    XCTAssertEqual(
      navOSSCarPlayPreviewResumeAction(
        isPreviewing: true, previewReplacesActiveTrip: true, guidancePhase: .arrived), .discard)
  }

  // MARK: Persistence compatibility

  func testTripsPersistedBeforeAnnotationsExistedStillDecode() throws {
    let encoded = try JSONEncoder().encode(trip())
    var object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    object.removeValue(forKey: "congestion")
    let legacy = try JSONSerialization.data(withJSONObject: object)
    let decoded = try JSONDecoder().decode(NavOSSCarPlayTrip.self, from: legacy)
    XCTAssertNil(decoded.congestion)
    XCTAssertNil(decoded.steps[1].lanes)
    XCTAssertTrue(decoded.isValid)
  }

  // MARK: Route contract shape

  func testLanesDecodeFromTheRouteContractShape() throws {
    let json = Data(
      """
      [{"indications":["none"],"valid":false},
       {"indications":["straight","right"],"valid":true,"active":true,"validIndication":"right"}]
      """.utf8)
    let lanes = try JSONDecoder().decode([NavOSSCarPlayLane].self, from: json)
    XCTAssertEqual(lanes[0], NavOSSCarPlayLane(indications: [.none], isValid: false))
    XCTAssertEqual(
      lanes[1],
      NavOSSCarPlayLane(
        indications: [.straight, .right], isValid: true, isPreferred: true,
        activeIndication: .right))
    let roundTrip = try JSONDecoder().decode(
      [NavOSSCarPlayLane].self, from: JSONEncoder().encode(lanes))
    XCTAssertEqual(roundTrip, lanes)
  }

  func testProviderBearingsAndCurrentRoadNameWinWhenPresent() throws {
    var steps = trip().steps
    let turn = steps[1]
    steps[1] = NavOSSCarPlayRouteStep(
      distanceMeters: turn.distanceMeters, durationSeconds: turn.durationSeconds,
      geometry: turn.geometry, instruction: turn.instruction, maneuverType: turn.maneuverType,
      roadName: turn.roadName, bearingBeforeDegrees: 350, bearingAfterDegrees: 40)
    let depart = steps[0]
    steps[0] = NavOSSCarPlayRouteStep(
      distanceMeters: depart.distanceMeters, durationSeconds: depart.durationSeconds,
      geometry: depart.geometry, instruction: depart.instruction,
      maneuverType: depart.maneuverType, roadName: depart.roadName,
      currentRoadName: "Macleod Trail")
    let base = trip()
    let annotated = NavOSSCarPlayTrip(
      destination: base.destination, distanceMeters: base.distanceMeters,
      durationSeconds: base.durationSeconds, geometry: base.geometry, id: base.id, steps: steps)
    let presentation = try XCTUnwrap(
      navOSSCarPlayGuidancePresentation(trip: annotated, guidance: guidance(stepIndex: 0)))
    XCTAssertEqual(presentation.primary.turnAngleDegrees, 50, accuracy: 0.001)
    XCTAssertEqual(presentation.currentRoadName, "Macleod Trail")
  }

  func testSignpostAndJunctionTextLeadTheInstructionVariants() throws {
    var steps = trip().steps
    let turn = steps[1]
    steps[1] = NavOSSCarPlayRouteStep(
      distanceMeters: turn.distanceMeters, durationSeconds: turn.durationSeconds,
      geometry: turn.geometry, instruction: "Take the exit.", maneuverType: "off ramp",
      roadName: "Glenmore Trail", signpostBranch: ["AB-8"], signpostToward: ["Banff"],
      junctionName: "Sarcee Interchange")
    let base = trip()
    let annotated = NavOSSCarPlayTrip(
      destination: base.destination, distanceMeters: base.distanceMeters,
      durationSeconds: base.durationSeconds, geometry: base.geometry, id: base.id, steps: steps)
    let info = try XCTUnwrap(navOSSCarPlayManeuverInfo(trip: annotated, stepIndex: 1))
    XCTAssertEqual(
      info.instructionVariants,
      [
        "Take the exit AB-8 toward Banff at Sarcee Interchange",
        "Take the exit AB-8 toward Banff",
        "Take the exit.",
        "Glenmore Trail",
      ])
    XCTAssertEqual(
      navOSSCarPlayManeuverInfo(trip: trip(), stepIndex: 1)?.instructionVariants,
      ["Turn right onto Left Bank Road.", "Left Bank Road"])
  }

  func testRoundaboutAngleUsesTheExitRoadNotTheRing() throws {
    // North into a counter-clockwise ring, out of the second exit still heading north.
    let south = NavOSSCarPlayCoordinate(latitude: 51.0450, longitude: -114.0700)
    let entry = NavOSSCarPlayCoordinate(latitude: 51.04725, longitude: -114.0700)
    let east = NavOSSCarPlayCoordinate(latitude: 51.0475, longitude: -114.06960)
    let top = NavOSSCarPlayCoordinate(latitude: 51.04775, longitude: -114.0700)
    let north = NavOSSCarPlayCoordinate(latitude: 51.0500, longitude: -114.0700)
    let steps = [
      NavOSSCarPlayRouteStep(
        distanceMeters: 250, durationSeconds: 25, geometry: [south, entry],
        instruction: "Drive north.", maneuverType: "depart", roadName: "A"),
      NavOSSCarPlayRouteStep(
        distanceMeters: 60, durationSeconds: 10, geometry: [entry, east, top],
        instruction: "Enter the roundabout and take the 2nd exit.", maneuverType: "roundabout",
        roadName: "A"),
      NavOSSCarPlayRouteStep(
        distanceMeters: 250, durationSeconds: 25, geometry: [top, north],
        instruction: "Exit the roundabout.", maneuverType: "exit roundabout", roadName: "A"),
    ]
    let angle = try XCTUnwrap(
      navOSSCarPlayManeuverTurnAngle(steps: steps, stepIndex: 1, measuresThroughStep: true))
    XCTAssertEqual(angle, 0, accuracy: 3)
  }
}
