import XCTest

@testable import NavOSSNavigationCore

/// Name pairs are what NavOSS search (OpenStreetMap, the City of Calgary business licence index)
/// and Google list for the same or neighbouring places in Calgary and Vancouver.
final class GooglePlaceMatchTests: XCTestCase {
  private let sameBusiness: [(navoss: String, google: String)] = [
    ("Calgary Tower", "Calgary Tower"),
    ("Mt. Royal University", "Mount Royal University"),
    ("St. Mary's Cathedral", "Saint Mary's Cathedral"),
    ("Ft. Calgary", "Fort Calgary"),
    ("Tim Horton's", "Tim Hortons"),
    ("Mcdonald's Restaurants #40123", "McDonald's"),
    ("Shoppers Drug Mart #2345", "Shoppers Drug Mart"),
    ("Starbucks Coffee #4512", "Starbucks"),
    ("Tim Hortons - Kensington", "Tim Hortons"),
    ("Safeway (Signal Hill)", "Safeway"),
    ("IKEA", "IKEA Calgary"),
    ("Superstore", "Real Canadian Superstore"),
    ("Chinook Centre", "CF Chinook Centre"),
    ("Chinook Center", "Chinook Centre"),
    ("The Keg Steakhouse & Bar", "The Keg Steakhouse + Bar"),
    ("The Keg", "The Keg Steakhouse + Bar - Calgary Macleod"),
    ("Earls Kitchen and Bar", "Earls Kitchen + Bar"),
    ("A&W", "A & W Canada"),
    ("Village Ice Cream Unit 5", "Village Ice Cream"),
    ("Peters' Drive-In", "Peters Drive In"),
    ("Café Rosso", "Cafe Rosso"),
    ("Mountain Equipment Co-op Ltd.", "Mountain Equipment Co-op"),
    ("Canada Place", "Canada Place"),
    ("Vancouver Art Gallery", "Vancouver Art Gallery"),
    ("Granville Island Public Market", "Granville Island Public Market"),
    ("Science World", "Science World"),
    ("Stanley Park", "Stanley Park"),
    ("Lee's Donuts", "Lee's Donuts - Granville Island"),
    ("Japadog", "Japadog Burrard"),
  ]

  private let differentBusinesses: [(navoss: String, google: String)] = [
    // Two businesses in one building or one mall.
    ("Calgary Tower", "Sky 360"),
    ("Bankers Hall", "Holt Renfrew"),
    ("The CORE Shopping Centre", "Holt Renfrew"),
    ("Bow Valley Dental", "Bow Valley Physiotherapy"),
    ("Harbour Centre", "Top of Vancouver Revolving Restaurant"),
    ("Pacific Centre", "Nordstrom"),
    // A department listed separately inside the selected business.
    ("Safeway", "Safeway Pharmacy"),
    ("Costco", "Costco Gas Station"),
    ("Calgary Co-op", "Calgary Co-op Liquor"),
    ("Canadian Tire", "Canadian Tire Gas+"),
    // Category words alone never identify a business.
    ("Pizza", "Pizza Hut"),
    ("Parking", "Impark Parking"),
    // Unrelated or one-letter names.
    ("Tim Hortons", "Starbucks"),
    ("A", "A & W"),
    ("", "Starbucks"),
  ]

  func testSameBusinessNamesMatch() {
    for pair in sameBusiness {
      XCTAssertTrue(
        NavOSSGooglePlaceMatch.namesMatch(pair.navoss, pair.google),
        "\(pair.navoss) should match \(pair.google)"
      )
      XCTAssertTrue(
        NavOSSGooglePlaceMatch.namesMatch(pair.google, pair.navoss),
        "matching must be symmetric for \(pair.navoss)"
      )
    }
  }

  func testDifferentBusinessNamesDoNotMatch() {
    for pair in differentBusinesses {
      XCTAssertFalse(
        NavOSSGooglePlaceMatch.namesMatch(pair.navoss, pair.google),
        "\(pair.navoss) must not match \(pair.google)"
      )
      XCTAssertFalse(
        NavOSSGooglePlaceMatch.namesMatch(pair.google, pair.navoss),
        "rejection must be symmetric for \(pair.navoss)"
      )
    }
  }

  func testDistanceBoundsTheMatch() {
    // Calgary Tower, and points about 150 m and about 260 m north of it.
    let tower = (latitude: 51.044_270, longitude: -114.063_082)
    XCTAssertTrue(
      NavOSSGooglePlaceMatch.matches(
        selectedName: "Calgary Tower",
        selectedLatitude: tower.latitude,
        selectedLongitude: tower.longitude,
        candidateName: "Calgary Tower",
        candidateLatitude: tower.latitude + 0.001_35,
        candidateLongitude: tower.longitude
      )
    )
    XCTAssertFalse(
      NavOSSGooglePlaceMatch.matches(
        selectedName: "Tim Hortons",
        selectedLatitude: tower.latitude,
        selectedLongitude: tower.longitude,
        candidateName: "Tim Hortons",
        candidateLatitude: tower.latitude + 0.002_35,
        candidateLongitude: tower.longitude
      ),
      "another branch of the same chain 260 m away is a different place"
    )
    XCTAssertFalse(
      NavOSSGooglePlaceMatch.matches(
        selectedName: "Calgary Tower",
        selectedLatitude: tower.latitude,
        selectedLongitude: tower.longitude,
        candidateName: "Sky 360",
        candidateLatitude: tower.latitude,
        candidateLongitude: tower.longitude
      ),
      "same coordinate, different business"
    )
    XCTAssertFalse(
      NavOSSGooglePlaceMatch.matches(
        selectedName: "Calgary Tower",
        selectedLatitude: .nan,
        selectedLongitude: tower.longitude,
        candidateName: "Calgary Tower",
        candidateLatitude: tower.latitude,
        candidateLongitude: tower.longitude
      )
    )
  }

  func testDistanceIsHaversine() {
    // Calgary Tower to Canada Place, Vancouver: about 676 km.
    let distance = NavOSSGooglePlaceMatch.distanceMeters(
      fromLatitude: 51.044_270,
      fromLongitude: -114.063_082,
      toLatitude: 49.288_830,
      toLongitude: -123.111_480
    )
    XCTAssertEqual(distance / 1000, 676, accuracy: 5)
  }
}
