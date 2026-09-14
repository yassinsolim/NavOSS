import XCTest

@testable import NavOSSNavigationCore

final class VoiceDestinationQueryTests: XCTestCase {
  func testStripsOnlyExplicitLeadingNavigationCommands() {
    XCTAssertEqual(
      navOSSVoiceDestinationQuery("  Take me to Calgary Tower  "),
      "Calgary Tower"
    )
    XCTAssertEqual(
      navOSSVoiceDestinationQuery("DIRECTIONS TO  123 Main Street"),
      "123 Main Street"
    )
  }

  func testKeepsPhrasesThatAreNotExplicitLeadingCommands() {
    XCTAssertEqual(
      navOSSVoiceDestinationQuery("My directions to work"),
      "My directions to work"
    )
    XCTAssertEqual(
      navOSSVoiceDestinationQuery("navigate toward downtown"),
      "navigate toward downtown"
    )
  }

  func testRejectsEmptyCommandWithoutAGuessedDestination() {
    XCTAssertNil(navOSSVoiceDestinationQuery("navigate to"))
    XCTAssertNil(navOSSVoiceDestinationQuery("   \n"))
  }
}
