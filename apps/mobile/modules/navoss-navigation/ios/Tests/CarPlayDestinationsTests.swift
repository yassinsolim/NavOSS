import XCTest

@testable import NavOSSNavigationCore

final class CarPlayDestinationsTests: XCTestCase {
  private let origin = NavOSSCarPlayCoordinate(latitude: 51.0447, longitude: -114.0719)

  private func destination(
    id: String,
    name: String = "Costco",
    label: String = "Costco, 99, 6 Street SE, East Fairview Industrial, Calgary, Alberta, T2H 3A7, Canada",
    latitude: Double = 50.9897629,
    longitude: Double = -114.0463494,
    category: String? = "poi",
    placeCategory: String? = "warehouse store",
    confidence: Double? = 0.94
  ) -> NavOSSCarPlayDestination {
    NavOSSCarPlayDestination(
      category: category, placeCategory: placeCategory, searchConfidence: confidence,
      id: id, label: label, latitude: latitude, longitude: longitude, name: name
    )
  }

  func testResultRowShowsCategoryStreetCityAndDistance() {
    let place = destination(id: "nominatim:way:123813629")
    XCTAssertEqual(place.searchSubtitle, "99 6 Street SE, Calgary")
    XCTAssertEqual(
      navOSSCarPlayDestinationDetail(place, distanceLabel: "6.4 km"),
      "6.4 km · Warehouse store · 99 6 Street SE, Calgary"
    )
  }

  func testKelownaSubtitleDropsAdministrativeBreadcrumbsAndPostcode() {
    let place = destination(
      id: "nominatim:way:1136603092",
      label: "Costco, Baron Road, Midtown, Kelowna, Westbank First Nation #9, Regional District of Central Okanagan, British Columbia, V1X 4H9, Canada",
      latitude: 49.8799002, longitude: -119.4294067
    )
    XCTAssertEqual(place.searchSubtitle, "Baron Road, Kelowna")
  }

  func testNeighborhoodAndAddressOnlyLegacyLabelsRemainReadable() {
    XCTAssertEqual(destination(id: "a", label: "Costco, Midtown, Kelowna, BC").searchSubtitle, "Midtown, Kelowna")
    XCTAssertEqual(destination(id: "b", label: "99 6 Street SE").searchSubtitle, "99 6 Street SE")
    XCTAssertEqual(destination(id: "c", label: "Costco").searchSubtitle, "")
    let address = destination(
      id: "address", name: "2500 University Drive NW", label: "2500 University Drive NW, Calgary, AB",
      category: "address", placeCategory: nil
    )
    XCTAssertEqual(address.searchSubtitle, "Calgary")
  }

  func testCategoriesKeepAcronymsAndNeverShowPlaceholderJargon() {
    XCTAssertEqual(destination(id: "a", placeCategory: "lrt station").searchCategoryLabel, "LRT station")
    XCTAssertEqual(destination(id: "b", placeCategory: "fuel").searchCategoryLabel, "Gas station")
    XCTAssertEqual(destination(id: "c", placeCategory: "wholesale").searchCategoryLabel, "Warehouse store")
    XCTAssertNil(destination(id: "d", placeCategory: "building").searchCategoryLabel)
    XCTAssertNil(destination(id: "e", placeCategory: nil).searchCategoryLabel)
  }

  func testOldStoredDestinationDecodesWithoutNewOptionalMetadata() throws {
    let data = Data("""
      {"category":"poi","id":"old","label":"Costco, 99 6 Street SE, Calgary, AB", "latitude":50.9897629,"longitude":-114.0463494,"name":"Costco"}
      """.utf8)
    let decoded = try JSONDecoder().decode(NavOSSCarPlayDestination.self, from: data)
    XCTAssertNil(decoded.placeCategory)
    XCTAssertNil(decoded.searchConfidence)
    XCTAssertEqual(navOSSCarPlayDestinationDetail(decoded, distanceLabel: "6.4 km"), "6.4 km · 99 6 Street SE, Calgary")
  }

  func testNewCategorySurvivesStoredDestinationRoundTrip() throws {
    let place = destination(id: "nominatim:way:123813629")
    XCTAssertEqual(try JSONDecoder().decode(NavOSSCarPlayDestination.self, from: JSONEncoder().encode(place)), place)
    XCTAssertNil(try JSONDecoder().decode(NavOSSCarPlayDestination.self, from: JSONEncoder().encode(place)).searchConfidence)
  }

  func testPinnedFavoriteKeepsFreshRemoteMetadataAndDoesNotRepeatItsId() {
    let old = destination(id: "warehouse", label: "Old warehouse label", latitude: 49.8799002, longitude: -119.4294067, placeCategory: nil, confidence: nil)
    let fresh = destination(id: "warehouse", label: "Costco, Baron Road, Kelowna", latitude: 49.8799002, longitude: -119.4294067)
    let closer = destination(id: "nearer")
    let result = navOSSCarPlaySearchPresentation(
      remoteDestinations: [closer, fresh], catalog: .init(favorites: [old]), query: "Costco", origin: origin
    )
    XCTAssertEqual(result.destinations.map(\.id), ["warehouse", "nearer"])
    XCTAssertEqual(result.destinations.first, fresh)
    XCTAssertEqual(result.savedPrefixes, ["warehouse": "Saved"])
  }

  func testDistantRecentChainNeverOutranksNearerRemoteBranches() {
    let distant = destination(
      id: "kelowna", label: "Costco, Baron Road, Kelowna", latitude: 49.8799002,
      longitude: -119.4294067, confidence: nil
    )
    let nearest = destination(id: "calgary")
    let other = destination(id: "east-hills", label: "Costco, 75 East Hills Boulevard SE, Calgary", latitude: 51.0432499, longitude: -113.9174518)
    let result = navOSSCarPlaySearchPresentation(
      remoteDestinations: [nearest, other], catalog: .init(recents: [distant]), query: "Costco", origin: origin
    )
    XCTAssertEqual(result.destinations.map(\.id), ["calgary", "east-hills", "kelowna"])
    XCTAssertTrue(result.savedPrefixes.isEmpty)
  }

  func testRecentDuplicateIdUsesFreshRemoteLabelCategoryAndCoordinates() {
    let old = destination(id: "same", label: "Old label", latitude: 51, longitude: -114, placeCategory: nil, confidence: nil)
    let fresh = destination(id: "same")
    let result = navOSSCarPlaySearchPresentation(
      remoteDestinations: [fresh], catalog: .init(recents: [old]), query: "Costco", origin: origin
    )
    XCTAssertEqual(result.destinations, [fresh])
    XCTAssertTrue(result.savedPrefixes.isEmpty)
  }

  func testNameAndProximityMergeAnOlderSourceVariantWithoutHidingAnotherBranch() {
    let old = destination(id: "calgary-business:185298", name: "Costco Wholesale", label: "Costco Wholesale, 99 Heritage Ga SE, Calgary", latitude: 50.9896247, longitude: -114.0463751, placeCategory: nil, confidence: nil)
    let fresh = destination(id: "nominatim:way:123813629")
    let other = destination(id: "other", label: "Costco, 75 East Hills Boulevard SE, Calgary", latitude: 51.0432499, longitude: -113.9174518)
    let result = navOSSCarPlaySearchPresentation(
      remoteDestinations: [fresh, other], catalog: .init(favorites: [old]), query: "Costco", origin: origin
    )
    XCTAssertEqual(result.destinations, [fresh, other])
    XCTAssertEqual(result.savedPrefixes[fresh.id], "Saved")
  }

  func testPinsAtMostTwoExplicitSavedPlacesNotRecents() {
    let home = destination(id: "home", label: "Costco, Baron Road, Kelowna", latitude: 49.8799002, longitude: -119.4294067)
    let work = destination(id: "work", label: "Costco, Southbank Boulevard, Okotoks", latitude: 50.706224, longitude: -113.9459696)
    let favorite = destination(id: "favorite", label: "Costco, 11588 Sarcee Trail NW, Calgary", latitude: 51.1547923, longitude: -114.1553219)
    let nearby = destination(id: "nearby")
    let result = navOSSCarPlaySearchPresentation(
      remoteDestinations: [nearby, favorite, work, home],
      catalog: .init(favorites: [favorite], home: home, recents: [nearby], work: work),
      query: "Costco", origin: origin
    )
    XCTAssertEqual(Array(result.destinations.prefix(2)).map(\.id), ["home", "work"])
    XCTAssertEqual(result.savedPrefixes, ["home": "Saved Home", "work": "Saved Work"])
    XCTAssertEqual(result.destinations[2].id, "nearby")
  }

  func testKeepsSeparateBusinessesAndUnitsAtOneAddress() {
    let warehouse = destination(id: "warehouse", label: "Costco, #101 100 Test Road, Calgary")
    let unit = destination(id: "unit", label: "Costco, #102 100 Test Road, Calgary", confidence: nil)
    let liquor = destination(id: "liquor", name: "Costco Liquor", label: "Costco Liquor, #101 100 Test Road, Calgary", placeCategory: "liquor store", confidence: nil)
    let result = navOSSCarPlaySearchPresentation(
      remoteDestinations: [warehouse], catalog: .init(recents: [unit, liquor]), query: "Costco", origin: origin
    )
    XCTAssertEqual(Set(result.destinations.map(\.id)), Set(["warehouse", "unit", "liquor"]))
  }

  func testUniqueExactPlaceAndFixtureAliasRemainAheadOfCloserIncidentalNames() {
    let exact = destination(id: "campus", name: "University of Calgary", label: "University of Calgary, 2500 University Drive NW, Calgary", latitude: 51.07795, longitude: -114.13073, placeCategory: "university", confidence: 1)
    let station = destination(id: "station", name: "University", label: "University, Crowchild Trail NW, Calgary", latitude: 51.0799978, longitude: -114.1229561, placeCategory: "train station", confidence: 0.98)
    let result = navOSSCarPlaySearchPresentation(
      remoteDestinations: [exact, station], catalog: .init(), query: "University", origin: origin
    )
    XCTAssertEqual(result.destinations.map(\.id), ["campus", "station"])
  }
}

extension CarPlayDestinationsTests {
  func testExactSavedIdWinsOverANameMatchAtItsOldCoordinates() {
    let old = destination(id: "moved", label: "Old label", placeCategory: nil, confidence: nil)
    let fresh = destination(id: "moved", label: "Costco, Baron Road, Kelowna", latitude: 49.8799002, longitude: -119.4294067)
    let nearby = destination(id: "different-branch")
    let result = navOSSCarPlaySearchPresentation(
      remoteDestinations: [nearby, fresh], catalog: .init(favorites: [old]), query: "Costco", origin: origin
    )
    XCTAssertEqual(result.destinations, [fresh, nearby])
    XCTAssertEqual(result.savedPrefixes, ["moved": "Saved"])
  }

  func testDoesNotRecombineDistinctCompleteProviderNodesAtTheSameAddress() {
    let first = destination(id: "nominatim:node:1")
    let second = destination(id: "nominatim:node:2")
    let result = navOSSCarPlaySearchPresentation(
      remoteDestinations: [first, second], catalog: .init(), query: "Costco", origin: origin
    )
    XCTAssertEqual(result.destinations.map(\.id), [first.id, second.id])
  }
}
