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
    // "Glenmore Trail West" names the road the step already joins, so no "toward".
    XCTAssertEqual(try card(trip, 2), ["Exit 248B · Glenmore Trail SE", "Exit 248B"])
    // "(Hospital)" is new, but "... toward 14 Street West (Hospital)" (50 characters) would be a
    // third card line, so the sign leads.
    XCTAssertEqual(try card(trip, 3), ["14 Street W South", "14 St W South"])
    // A plain "Continue toward ..." shows the road the step joins.
    XCTAssertEqual(try card(trip, 5), ["14 Street SW", "14 St SW"])
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
