import XCTest

@testable import NavOSSNavigationCore

final class GooglePlaceMatchTests: XCTestCase {
  // Calgary Tower.
  private let tower = (latitude: 51.044_270, longitude: -114.063_082)

  func testGooglePlaceMustBeWithinThirtyMetres() {
    XCTAssertTrue(
      NavOSSGooglePlaceMatch.isNearby(
        selectedLatitude: tower.latitude, selectedLongitude: tower.longitude,
        candidateLatitude: tower.latitude + 0.000_018, candidateLongitude: tower.longitude
      ),
      "2 m, as observed for Calgary Tower"
    )
    XCTAssertTrue(
      NavOSSGooglePlaceMatch.isNearby(
        selectedLatitude: tower.latitude, selectedLongitude: tower.longitude,
        candidateLatitude: tower.latitude + 0.000_26, candidateLongitude: tower.longitude
      ),
      "about 29 m"
    )
    XCTAssertFalse(
      NavOSSGooglePlaceMatch.isNearby(
        selectedLatitude: tower.latitude, selectedLongitude: tower.longitude,
        candidateLatitude: tower.latitude + 0.000_29, candidateLongitude: tower.longitude
      ),
      "about 32 m: the next lot over"
    )
    XCTAssertFalse(
      NavOSSGooglePlaceMatch.isNearby(
        selectedLatitude: .nan, selectedLongitude: tower.longitude,
        candidateLatitude: tower.latitude, candidateLongitude: tower.longitude
      )
    )
  }

  func testDistanceIsHaversine() {
    // Calgary Tower to Canada Place, Vancouver: about 676 km.
    let distance = NavOSSGooglePlaceMatch.distanceMeters(
      fromLatitude: tower.latitude,
      fromLongitude: tower.longitude,
      toLatitude: 49.288_830,
      toLongitude: -123.111_480
    )
    XCTAssertEqual(distance / 1000, 676, accuracy: 5)
  }
}
