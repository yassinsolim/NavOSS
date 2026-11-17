import XCTest

@testable import NavOSSNavigationCore

/// The CarPlay guidance card text (also the Dashboard, notification and lane-guidance text) for
/// steps recorded from the NavOSS API (`apps/mobile/test/fixtures/routes-v2`) and the on-device
/// Valhalla (`Fixtures/Offline`). The card names what to look for; the spoken prompt and the phone
/// list keep the provider's sentence.
final class CarPlayCardTextTests: XCTestCase {
  private func card(_ trip: NavOSSCarPlayTrip, _ stepIndex: Int) throws -> [String] {
    try XCTUnwrap(navOSSCarPlayManeuverInfo(trip: trip, stepIndex: stepIndex)).instructionVariants
  }

  /// Whole-name occurrences, so "Vancouver" inside "Vancouver-YVR" does not count.
  private func occurrences(of name: String, in text: String) -> Int {
    let pattern = #"(?<![\p{L}\p{N}-])"# + NSRegularExpression.escapedPattern(for: name)
      + #"(?![\p{L}\p{N}-])"#
    let expression = try! NSRegularExpression(pattern: pattern)
    return expression.numberOfMatches(in: text, range: NSRange(text.startIndex..., in: text))
  }

  /// A two-step trip whose second step is `step`, for provider texts no fixture records.
  private func trip(with step: NavOSSCarPlayRouteStep) -> NavOSSCarPlayTrip {
    let start = NavOSSCarPlayCoordinate(latitude: 51.0, longitude: -114.0)
    let turn = NavOSSCarPlayCoordinate(latitude: 51.001, longitude: -114.0)
    let end = NavOSSCarPlayCoordinate(latitude: 51.001, longitude: -114.001)
    let depart = NavOSSCarPlayRouteStep(
      distanceMeters: 110, durationSeconds: 10, geometry: [start, turn], instruction: "Drive north.",
      maneuverType: "depart", roadName: "")
    let maneuver = NavOSSCarPlayRouteStep(
      distanceMeters: 70, durationSeconds: 8, geometry: [turn, end], instruction: step.instruction,
      maneuverType: step.maneuverType, roadName: step.roadName,
      maneuverModifier: step.maneuverModifier, exitNumber: step.exitNumber, signpost: step.signpost,
      signpostBranch: step.signpostBranch, signpostToward: step.signpostToward)
    return NavOSSCarPlayTrip(
      destination: NavOSSCarPlayDestination(
        id: "d", label: "D", latitude: end.latitude, longitude: end.longitude, name: "D"),
      distanceMeters: 180, durationSeconds: 18, geometry: [start, turn, end], id: "t",
      steps: [depart, maneuver])
  }

  private func step(
    _ instruction: String, type: String, road: String = "", modifier: String? = nil,
    toward: [String]? = nil
  ) -> NavOSSCarPlayRouteStep {
    NavOSSCarPlayRouteStep(
      distanceMeters: 0, durationSeconds: 0, geometry: [], instruction: instruction,
      maneuverType: type, roadName: road, maneuverModifier: modifier, signpostToward: toward)
  }

  private func recorded(_ name: String) throws -> NavOSSCarPlayTrip {
    try XCTUnwrap(try NavigationRoutesV2Tests.trips(name, version: .v2).first)
  }

  /// Build 82, Crowchild Trail (owner's TestFlight photo, 2026-11-16): the card showed the spoken
  /// sentence and, with the navigation bar hidden, "...ramp on the left 1A East / Crowchild Trail
  /// toward 1A East, Crowchild Trail".
  func testOwnersCrowchildRampShowsTheSignOnce() throws {
    let origin = NavOSSCarPlayCoordinate(latitude: 51.0900, longitude: -114.1420)
    let ramp = NavOSSCarPlayCoordinate(latitude: 51.0950, longitude: -114.1430)
    let beyond = NavOSSCarPlayCoordinate(latitude: 51.0990, longitude: -114.1470)
    let steps = [
      NavOSSCarPlayRouteStep(
        distanceMeters: 5_700, durationSeconds: 300, geometry: [origin, ramp],
        instruction: "Drive north on Shaganappi Trail NW.", maneuverType: "depart",
        roadName: "Shaganappi Trail NW"),
      NavOSSCarPlayRouteStep(
        distanceMeters: 400, durationSeconds: 20, geometry: [ramp, beyond],
        instruction: "Take the 1A East / Crowchild Trail ramp on the left.",
        maneuverType: "on ramp", roadName: "", maneuverModifier: "slight left",
        signpost: "1A East, Crowchild Trail: 1A East, Crowchild Trail",
        signpostBranch: ["1A East", "Crowchild Trail"],
        signpostToward: ["1A East", "Crowchild Trail"]),
    ]
    let trip = NavOSSCarPlayTrip(
      destination: NavOSSCarPlayDestination(
        id: "d", label: "D", latitude: beyond.latitude, longitude: beyond.longitude, name: "D"),
      distanceMeters: 6_100, durationSeconds: 320, geometry: [origin, ramp, beyond], id: "t",
      steps: steps)

    let variants = try card(trip, 1)
    XCTAssertEqual(variants, ["1A East / Crowchild Trail", "1A East"])
    for variant in variants {
      for name in ["1A East", "Crowchild Trail"] {
        XCTAssertLessThanOrEqual(occurrences(of: name, in: variant), 1, variant)
      }
    }
    // The spoken prompt is the provider's sentence, unchanged by the card.
    XCTAssertEqual(trip.steps[1].instruction, "Take the 1A East / Crowchild Trail ramp on the left.")
  }

  func testCalgaryDeerfootExitsLeadWithTheExitNumber() throws {
    let trip = try recorded("calgary-deerfoot-glenmore.v2")
    // "Take exit 248 toward Glenmore Trail.": no branch, so the place on the sign is the target.
    XCTAssertEqual(try card(trip, 1), ["Exit 248 · Glenmore Trail", "Exit 248"])
    // The sign names the road the step joins with its direction of travel; that is what the
    // driver picks, so it wins over the address quadrant ("SE").
    XCTAssertEqual(
      try card(trip, 2), ["Exit 248B · Glenmore Trail West", "Exit 248B · Glenmore Trail W", "Exit 248B"])
    // "(Hospital)" is new, but "... toward 14 Street West (Hospital)" (50 characters) would be a
    // third card line, so the sign leads.
    XCTAssertEqual(try card(trip, 3), ["14 Street W South", "14 St W South"])
    // "Continue toward 14 Street W South" on 14 Street SW: the signed direction, not the quadrant.
    XCTAssertEqual(try card(trip, 5), ["14 Street W South", "14 St W South"])
  }

  func testVancouverLanesRouteShowsSignsRoadsAndBareTurns() throws {
    let trip = try recorded("vancouver-bc91-highway99.v2")
    XCTAssertEqual(
      try card(trip, 1),
      ["Exit 23B · 99 North", "Exit 23B"])
    XCTAssertEqual(try card(trip, 2), ["Exit 39 · Vancouver-YVR International", "Exit 39"])
    XCTAssertEqual(try card(trip, 3), ["Bridgeport Road", "Bridgeport Rd"])
    // "Turn right toward No. 3 Rd NORTH." onto Number 3 Road: the road, once.
    XCTAssertEqual(try card(trip, 4), ["Number 3 Road", "Number 3 Rd"])
    // An unnamed turn is a two-word action without a period.
    XCTAssertEqual(try card(trip, 5), ["Turn left"])
    XCTAssertEqual(try card(trip, 6), ["Turn right"])
  }

  func testLongTorontoSignsShortenByAbbreviationThenByDroppingNames() throws {
    let trip = try recorded("square-one-scarborough.v2")
    XCTAssertEqual(
      try card(trip, 7),
      [
        "Kennedy Rd / Brimley Rd S / McCowan Rd", "Kennedy Road / Brimley Road South",
        "Kennedy Rd / Brimley Rd S", "Kennedy Road", "Kennedy Rd",
      ])
    XCTAssertEqual(
      try card(trip, 8),
      [
        "Exit 380 · Brimley Rd S / Progress Ave", "Exit 380 · Brimley Road South",
        "Exit 380 · Brimley Rd S", "Exit 380",
      ])
    // "Highway 403" and "403 East" are one road; the sign's direction is kept.
    XCTAssertEqual(try card(trip, 3), ["403 East toward Toronto", "403 East"])
    XCTAssertEqual(try card(trip, 12), ["Bear left"])
  }

  func testQuebecFrenchNamesAndRoundaboutExit() throws {
    let trip = try recorded("montreal-a520-a40-a15.v2")
    // The roundabout step names the ring; the card names the exit and the road taken.
    XCTAssertEqual(
      try card(trip, 6), ["Exit 6 · Autoroute de la Côte-de-Liesse", "Exit 6"])
    // French street types lead the name and are not English abbreviations.
    XCTAssertEqual(try card(trip, 3), ["Boulevard Fénelon"])
    XCTAssertEqual(try card(trip, 15), ["Boulevard de la Concorde Ouest"])
    XCTAssertEqual(try card(trip, 10), ["Exit 70 · 15 Nord toward Laval", "Exit 70 · 15 Nord", "Exit 70"])
    // Three signed boulevards are a third line; the first one leads.
    XCTAssertEqual(
      try card(trip, 11),
      ["Exit 7 · Boulevard de la Concorde", "Exit 7"])
    // A bare route number reads as a highway.
    XCTAssertEqual(try card(trip, 9), ["Highway 40"])
  }

  func testArrivalShowsTheDestinationName() throws {
    let trip = try recorded("montreal-a520-a40-a15.v2")
    let arrival = trip.steps.count - 1
    XCTAssertEqual(trip.steps[arrival].maneuverType, "arrive")
    XCTAssertEqual(try card(trip, arrival).first, trip.destination.name)
  }

  /// Review of #140: a stop's arrival named the final destination. The recorded Glenmore break
  /// route arrives at the Glenmore Trail stop (step 3) with maneuvers still ahead.
  func testIntermediateArrivalNamesTheStopNotTheFinalDestination() throws {
    let trip = try recorded("calgary-deerfoot-glenmore-break.v2")
    let arrivals = trip.steps.indices.filter { trip.steps[$0].maneuverType == "arrive" }
    XCTAssertEqual(arrivals, [3, trip.steps.count - 1])
    // No stop list on the trip: the stop is not given the destination's name.
    XCTAssertEqual(try card(trip, 3), ["Stop"])
    let stop = NavOSSCarPlayDestination(
      id: "glenmore", label: "", latitude: 50.98, longitude: -114.07, name: "Glenmore Landing")
    let withStop = trip.replacingWaypoints([stop])
    XCTAssertEqual(try card(withStop, 3).first, "Glenmore Landing")
    XCTAssertEqual(try card(withStop, trip.steps.count - 1).first, trip.destination.name)
    // A stop without a usable name is "Stop", numbered when the trip has more than one.
    let unnamed = NavOSSCarPlayDestination(
      id: "a", label: " ", latitude: 50.98, longitude: -114.07, name: " ")
    XCTAssertEqual(try card(trip.replacingWaypoints([unnamed]), 3), ["Stop"])
    XCTAssertEqual(try card(trip.replacingWaypoints([unnamed, stop]), 3), ["Stop 1"])
  }

  /// Review of #140: without structured sign fields (the `/v1/routes` fallback, some on-device
  /// steps) exits read "Exit right". What the provider's own instruction says is used instead.
  func testExitsWithoutSignFieldsKeepTheirNumberAndNameFromTheInstruction() throws {
    let v1 = try XCTUnwrap(try NavigationRoutesV2Tests.trips("calgary-deerfoot-glenmore.v1", version: .v1).first)
    XCTAssertNil(v1.steps[1].exitNumber)
    XCTAssertEqual(v1.steps[1].instruction, "Take exit 248 toward Glenmore Trail.")
    XCTAssertEqual(try card(v1, 1), ["Exit 248 · Glenmore Trail", "Exit 248"])
    // "toward 14 Street West (Hospital)" would be a third card line.
    XCTAssertEqual(try card(v1, 3), ["14 Street W South", "14 St W South"])
    XCTAssertEqual(try card(v1, 4), ["14 Street W South", "14 St W South"])

    // On-device: nothing to name, so the sentence (it says which side) and then the action.
    let destination = NavOSSCarPlayDestination(
      id: "dest", label: "Destination", latitude: 51.0866, longitude: -114.1305, name: "Destination")
    let offline = try navOSSOfflineTrips(
      fromValhallaJSON: OfflineFixtures.data("calgary-stoney-airport.response.json"),
      destination: destination, waypoints: [], preferences: NavOSSRoutePreferences())
    XCTAssertEqual(offline[1].steps[3].instruction, "Take the exit on the left.")
    XCTAssertEqual(try card(offline[1], 3), ["Take the exit on the left", "Exit left"])
  }

  /// Review of #140: Bow Trail to Crowchild (on-device route, step 7) joins "Crowchild Trail SW"
  /// under a "Crowchild Trail North" sign; the card dropped the northbound the driver must pick.
  func testSignedDirectionOfTravelWinsOverTheAddressQuadrant() throws {
    let destination = NavOSSCarPlayDestination(
      id: "dest", label: "Destination", latitude: 51.0866, longitude: -114.1305, name: "Destination")
    let trip = try XCTUnwrap(
      try navOSSOfflineTrips(
        fromValhallaJSON: OfflineFixtures.data("calgary-downtown-north.response.json"),
        destination: destination, waypoints: [], preferences: NavOSSRoutePreferences()
      ).first)
    XCTAssertEqual(trip.steps[7].roadName, "Crowchild Trail SW")
    XCTAssertEqual(trip.steps[7].signpostToward, ["Crowchild Trail North"])
    XCTAssertEqual(try card(trip, 7), ["Crowchild Trail North", "Crowchild Trail N"])
  }

  /// Only a trailing direction or quadrant is a suffix; a leading or interior one is the name.
  func testOnlyATrailingDirectionMakesTwoNamesTheSameRoad() throws {
    let northShore = trip(
      with: step(
        "Turn right onto North Shore Road toward South Shore Road East.", type: "turn",
        road: "North Shore Road", modifier: "right", toward: ["South Shore Road East"]))
    XCTAssertEqual(try card(northShore, 1).first, "North Shore Road")
    let crowchild = trip(
      with: step(
        "Keep right to take Crowchild Trail SW toward Crowchild Trail North.", type: "fork",
        road: "Crowchild Trail SW", modifier: "slight right", toward: ["Crowchild Trail North"]))
    XCTAssertEqual(try card(crowchild, 1).first, "Crowchild Trail North")
  }

  func testOfflineRoundaboutNamesTheExitRoad() throws {
    let destination = NavOSSCarPlayDestination(
      id: "dest", label: "Destination", latitude: 51.0866, longitude: -114.1305, name: "Destination")
    let trip = try XCTUnwrap(
      try navOSSOfflineTrips(
        fromValhallaJSON: OfflineFixtures.data("calgary-roundabout.response.json"),
        destination: destination, waypoints: [], preferences: NavOSSRoutePreferences()
      ).first)
    XCTAssertEqual(trip.steps[1].maneuverType, "roundabout")
    XCTAssertEqual(try card(trip, 1), ["Exit 1 · Peacekeepers Way SW", "Exit 1"])
  }

  /// Owner's head unit: about 20 characters a card line, so more than
  /// `navOSSCarPlayCardMaximumCharacters` is a third line and the card grows over the map.
  func testCardVariantsStayWithinTwoLines() throws {
    XCTAssertEqual(navOSSCarPlayCardMaximumCharacters, 40)
    let toronto = try recorded("square-one-scarborough.v2")
    // 38 characters survive once abbreviated; the 48-character full names do not.
    XCTAssertEqual(try card(toronto, 7).first, "Kennedy Rd / Brimley Rd S / McCowan Rd")
    // A short "toward" still fits and stays.
    XCTAssertEqual(try card(toronto, 3).first, "403 East toward Toronto")
    XCTAssertEqual(
      try card(try recorded("vancouver-bc91-highway99.v2"), 1).first, "Exit 23B · 99 North")
    for name in [
      "calgary-deerfoot-glenmore.v2", "vancouver-bc91-highway99.v2", "square-one-scarborough.v2",
      "montreal-a520-a40-a15.v2",
    ] {
      let trip = try recorded(name)
      for index in trip.steps.indices.dropFirst() {
        let variants = try card(trip, index)
        XCTAssertTrue(
          variants.count == 1 || variants.allSatisfy { $0.count <= 40 }, "\(name) #\(index): \(variants)")
      }
    }
  }

  func testAbbreviationKeepsLeadingTypesRouteDirectionsAndTrail() {
    XCTAssertEqual(navOSSCarPlayCardAbbreviated("John Laurie Boulevard NW"), "John Laurie Blvd NW")
    XCTAssertEqual(
      navOSSCarPlayCardAbbreviated("John Laurie Boulevard Northwest"), "John Laurie Blvd NW")
    XCTAssertEqual(navOSSCarPlayCardAbbreviated("Deerfoot Trail South"), "Deerfoot Trail S")
    XCTAssertEqual(navOSSCarPlayCardAbbreviated("Avenue Road"), "Avenue Rd")
    XCTAssertEqual(
      navOSSCarPlayCardAbbreviated("Boulevard René-Lévesque Est"), "Boulevard René-Lévesque Est")
    XCTAssertEqual(navOSSCarPlayCardAbbreviated("1A East / Crowchild Trail"), "1A East / Crowchild Trail")
    XCTAssertEqual(navOSSCarPlayCardAbbreviated("Highway 403"), "Highway 403")
  }

  /// Every recorded step: no period at the end and no sign or road name said twice in one variant.
  func testNoRecordedStepRepeatsANameOrEndsWithAPeriod() throws {
    for name in [
      "calgary-deerfoot-glenmore.v2", "vancouver-bc91-highway99.v2", "square-one-scarborough.v2",
      "square-one-scarborough-reroute.v2", "montreal-a520-a40-a15.v2",
    ] {
      for trip in try NavigationRoutesV2Tests.trips(name, version: .v2) {
        for index in trip.steps.indices.dropFirst() {
          let step = trip.steps[index]
          let variants = try card(trip, index)
          XCTAssertFalse(variants.isEmpty)
          let names = (step.signpostBranch ?? []) + (step.signpostToward ?? []) + [step.roadName]
          for variant in variants {
            XCTAssertFalse(variant.hasSuffix("."), "\(name) #\(index): \(variant)")
            for road in names where road.count > 3 {
              XCTAssertLessThanOrEqual(
                occurrences(of: road, in: variant), 1, "\(name) #\(index): \(variant)")
            }
          }
        }
      }
    }
  }
}
