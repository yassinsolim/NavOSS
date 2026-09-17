import XCTest
import Foundation

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

  func testUsesWorkingEnglishDeviceLocaleBeforeFallbacks() {
    let enUS = Locale(identifier: "en-US")

    XCTAssertEqual(
      navOSSOnDeviceVoiceRecognitionLocale(
        deviceLocale: enUS,
        supportedLocales: [enUS],
        isAvailable: { $0 == enUS }
      ),
      .available(enUS)
    )
  }

  func testPrefersCanadianEnglishBeforeOtherFallbacks() {
    let enCA = Locale(identifier: "en-CA")
    let enUS = Locale(identifier: "en-US")

    XCTAssertEqual(
      navOSSOnDeviceVoiceRecognitionLocale(
        deviceLocale: Locale(identifier: "fr-CA"),
        supportedLocales: [enUS, enCA],
        isAvailable: { $0 == enCA || $0 == enUS }
      ),
      .available(enCA)
    )
  }

  func testReturnsUnavailableWhenNoEnglishLocaleQualifies() {
    XCTAssertEqual(
      navOSSOnDeviceVoiceRecognitionLocale(
        deviceLocale: Locale(identifier: "fr-CA"),
        supportedLocales: [Locale(identifier: "en-NZ")],
        isAvailable: { _ in false }
      ),
      .unavailable
    )
  }
}
