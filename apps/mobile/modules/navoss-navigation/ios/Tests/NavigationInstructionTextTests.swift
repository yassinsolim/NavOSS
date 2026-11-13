import XCTest

@testable import NavOSSNavigationCore

final class NavigationInstructionTextTests: XCTestCase {
  private func step(_ instruction: String, type: String = "turn", spoken: String? = nil)
    -> NavOSSCarPlayRouteStep
  {
    NavOSSCarPlayRouteStep(
      distanceMeters: 100, durationSeconds: 10,
      geometry: [
        NavOSSCarPlayCoordinate(latitude: 51.05, longitude: -114.07),
        NavOSSCarPlayCoordinate(latitude: 51.051, longitude: -114.07),
      ],
      instruction: instruction, maneuverType: type, roadName: "", spokenInstruction: spoken)
  }

  /// Recorded from production `/v1/routes` on 2026-11-13: Highway 1 joined to 16 Avenue NW.
  func testHighwayReferenceIsShownAsHighwayAndSpokenAsTheStreetName() {
    XCTAssertEqual(
      navOSSPresentedInstruction("Turn left onto 1/16 Avenue NW.", maneuverType: "turn"),
      "Turn left onto Highway 1 / 16 Avenue NW.")
    XCTAssertEqual(
      NavigationSpeechPlanner.maneuverPrompt(step("Turn left onto 1/16 Avenue NW.")),
      "Turn left onto 16 Avenue northwest.")
    // The phone already presents the text; speaking it again must give the same single name.
    XCTAssertEqual(
      NavigationSpeechPlanner.maneuverPrompt(step("Turn left onto Highway 1 / 16 Avenue NW.")),
      "Turn left onto 16 Avenue northwest.")
  }

  func testTwoStreetNamesAreShownBothAndSpokenOnce() {
    XCTAssertEqual(
      navOSSReadableRoadNames("Keep right to take Deerfoot Trail/2 toward Airport."),
      "Keep right to take Deerfoot Trail / Highway 2 toward Airport.")
    XCTAssertEqual(
      navOSSSpokenRoadNames("Keep right to take Deerfoot Trail/2 toward Airport."),
      "Keep right to take Deerfoot Trail toward Airport.")
    XCTAssertEqual(
      navOSSSpokenRoadNames("Turn right onto Memorial Drive/Parkdale Boulevard."),
      "Turn right onto Memorial Drive.")
    XCTAssertEqual(
      navOSSReadableRoadNames("Continue on Highway 2/Deerfoot Trail."),
      "Continue on Highway 2 / Deerfoot Trail.")
  }

  func testSingleNamesAreUnchanged() {
    for text in ["Turn left onto Macleod Trail SE.", "Take exit 248 toward Calgary."] {
      XCTAssertEqual(navOSSReadableRoadNames(text), text)
      XCTAssertEqual(navOSSSpokenRoadNames(text), text)
    }
  }

  func testArrivalStepDoesNotSayArrivedWhileAhead() {
    XCTAssertEqual(
      navOSSPresentedInstruction("You have arrived at your destination.", maneuverType: "arrive"),
      "Your destination is ahead.")
    XCTAssertEqual(
      navOSSPresentedInstruction("Your destination is on the right.", maneuverType: "arrive"),
      "Your destination is on the right.")
    XCTAssertEqual(
      NavigationSpeechPlanner.maneuverPrompt(
        step("You have arrived at your destination.", type: "arrive",
             spoken: "You have arrived at your destination.")),
      "Your destination is ahead.")
  }
}
