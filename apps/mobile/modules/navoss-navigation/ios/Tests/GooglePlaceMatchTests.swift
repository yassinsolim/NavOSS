import XCTest

@testable import NavOSSNavigationCore

final class GooglePlaceMatchTests: XCTestCase {
  // Calgary Tower.
  private let tower = (latitude: 51.044_270, longitude: -114.063_082)

  func testSearchBoundsExtendTwoHundredMetresEachWay() throws {
    let bounds = try XCTUnwrap(
      NavOSSGooglePlaceMatch.searchBounds(latitude: tower.latitude, longitude: tower.longitude)
    )
    let north = NavOSSGooglePlaceMatch.distanceMeters(
      fromLatitude: tower.latitude, fromLongitude: tower.longitude,
      toLatitude: bounds.north, toLongitude: tower.longitude
    )
    let east = NavOSSGooglePlaceMatch.distanceMeters(
      fromLatitude: tower.latitude, fromLongitude: tower.longitude,
      toLatitude: tower.latitude, toLongitude: bounds.east
    )
    XCTAssertEqual(north, 200, accuracy: 1)
    XCTAssertEqual(east, 200, accuracy: 1)
    XCTAssertEqual(bounds.north - tower.latitude, tower.latitude - bounds.south, accuracy: 1e-12)
    XCTAssertEqual(bounds.east - tower.longitude, tower.longitude - bounds.west, accuracy: 1e-12)
  }

  func testSearchBoundsRejectInvalidCoordinates() {
    XCTAssertNil(NavOSSGooglePlaceMatch.searchBounds(latitude: .nan, longitude: -114))
    XCTAssertNil(NavOSSGooglePlaceMatch.searchBounds(latitude: 51, longitude: .infinity))
    XCTAssertNil(NavOSSGooglePlaceMatch.searchBounds(latitude: 89.5, longitude: 0))
    XCTAssertNil(NavOSSGooglePlaceMatch.searchBounds(latitude: 51, longitude: 181))
  }

  func testGooglePlaceMustBeWithinTwoHundredMetres() {
    XCTAssertTrue(
      NavOSSGooglePlaceMatch.isNearby(
        selectedLatitude: tower.latitude, selectedLongitude: tower.longitude,
        candidateLatitude: tower.latitude + 0.001_35, candidateLongitude: tower.longitude
      ),
      "about 150 m away"
    )
    XCTAssertFalse(
      NavOSSGooglePlaceMatch.isNearby(
        selectedLatitude: tower.latitude, selectedLongitude: tower.longitude,
        candidateLatitude: tower.latitude + 0.002_35, candidateLongitude: tower.longitude
      ),
      "about 260 m away: a corner of the search box, or another branch"
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
