import SQLite3
import XCTest

@testable import NavOSSNavigationCore

/// Expectations come from the pipeline's reference implementation (`build-search.py` normalise
/// and `query-search.py`), run on the same databases, not from this Swift code.
final class OfflineSearchTests: XCTestCase {
  private struct Reference: Decodable {
    struct Case: Decodable {
      let query: String?
      let category: String?
      let radiusKm: Double?
      let ids: [Int64]
    }
    struct Normalization: Decodable {
      let input: String
      let normalized: String
      let ftsQuery: String
    }
    let origin: NavOSSCarPlayCoordinate
    let limit: Int
    let fixtureDatabase: [Case]
    let calgaryDatabase: [Case]
    let normalization: [Normalization]
  }

  private func reference() throws -> Reference {
    try JSONDecoder().decode(Reference.self, from: OfflineFixtures.data("search-reference.json"))
  }

  private func normalizer() throws -> NavOSSOfflineSearchNormalizer {
    try NavOSSOfflineSearchNormalizer(
      normalizationJSON: OfflineFixtures.data("search-normalization.json"))
  }

  private func recipe(_ name: String) throws -> String {
    try String(
      contentsOf: OfflineFixtures.repositoryRoot.appending(path: "infra/offline/\(name)"),
      encoding: .utf8)
  }

  /// Builds a schema-1 database from the pipeline's schema and real Calgary rows.
  private func fixtureDatabase() throws -> URL {
    let directory = try OfflineFixtures.temporaryDirectory()
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appending(path: "search.sqlite")
    var handle: OpaquePointer?
    XCTAssertEqual(sqlite3_open(url.path, &handle), SQLITE_OK)
    defer { sqlite3_close(handle) }
    for sql in [
      try recipe("search-schema.sql"),
      try String(
        contentsOf: OfflineFixtures.directory.appending(path: "calgary-search-rows.sql"),
        encoding: .utf8),
    ] {
      var error: UnsafeMutablePointer<CChar>?
      XCTAssertEqual(sqlite3_exec(handle, sql, nil, nil, &error), SQLITE_OK, error.map { String(cString: $0) } ?? "")
    }
    return url
  }

  private func check(_ cases: [Reference.Case], database url: URL, reference: Reference) throws {
    let database = try NavOSSOfflineSearchDatabase(url: url)
    let normalizer = try normalizer()
    let searchSQL = try recipe("search-query.sql")
    let categorySQL = try recipe("category-query.sql")
    for item in cases {
      let places: [NavOSSOfflinePlace]
      if let query = item.query {
        let parameters = try XCTUnwrap(
          NavOSSOfflineSearchParameters(
            query: query, origin: reference.origin, limit: reference.limit, normalizer: normalizer))
        places = try database.search(sql: searchSQL, parameters: parameters)
      } else {
        let parameters = try XCTUnwrap(
          NavOSSOfflineCategoryParameters(
            category: try XCTUnwrap(item.category), origin: reference.origin,
            radiusKm: try XCTUnwrap(item.radiusKm), limit: reference.limit))
        places = try database.category(sql: categorySQL, parameters: parameters)
      }
      XCTAssertEqual(places.map(\.databaseId), item.ids, item.query ?? item.category ?? "")
    }
  }

  func testNormalisationMatchesTheIndexBuilder() throws {
    let normalizer = try normalizer()
    for vector in try reference().normalization {
      XCTAssertEqual(normalizer.normalize(vector.input), vector.normalized, vector.input)
      XCTAssertEqual(normalizer.ftsQuery(vector.input), vector.ftsQuery, vector.input)
    }
  }

  func testRankingMatchesTheReferenceOnRealRows() throws {
    let reference = try reference()
    try check(reference.fixtureDatabase, database: fixtureDatabase(), reference: reference)
  }

  func testRankingMatchesTheReferenceOnTheFullCalgaryIndex() throws {
    let release = try OfflineFixtures.release()
    let reference = try reference()
    try check(
      reference.calgaryDatabase, database: release.appending(path: "regions/calgary/search.sqlite"),
      reference: reference)
  }

  func testMapsRowsToLabelledDestinations() throws {
    let database = try NavOSSOfflineSearchDatabase(url: fixtureDatabase())
    let parameters = try XCTUnwrap(
      NavOSSOfflineSearchParameters(
        query: "101 9 Avenue SE", origin: .init(latitude: 51.0447, longitude: -114.0631), limit: 5,
        normalizer: normalizer()))
    let tower = try XCTUnwrap(try database.search(sql: recipe("search-query.sql"), parameters: parameters).first)
    XCTAssertEqual(tower.id, "nominatim:way:25719793")
    XCTAssertEqual(tower.destination.name, "Calgary Tower")
    XCTAssertEqual(tower.destination.label, "101 9 Avenue SE Calgary T2P 1J9")
    XCTAssertLessThan(tower.straightLineMeters, 200)

    let category = try XCTUnwrap(
      NavOSSOfflineCategoryParameters(
        category: "parking", origin: .init(latitude: 51.0447, longitude: -114.0631), radiusKm: 50,
        limit: 20))
    let unnamed = try database.category(sql: recipe("category-query.sql"), parameters: category)
      .first { $0.nameSource == "category" }
    if let unnamed {
      // A name generated from the tag must never read like a business name.
      XCTAssertTrue(unnamed.label.hasPrefix("Unnamed") || !unnamed.address.isEmpty)
    }
  }

  func testRefusesDatabasesThatAreNotSchemaOne() throws {
    let directory = try OfflineFixtures.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appending(path: "other.sqlite")
    var handle: OpaquePointer?
    sqlite3_open(url.path, &handle)
    sqlite3_exec(handle, "PRAGMA user_version = 2; CREATE TABLE t(x);", nil, nil, nil)
    sqlite3_close(handle)
    XCTAssertThrowsError(try NavOSSOfflineSearchDatabase(url: url)) { error in
      XCTAssertEqual(error as? NavOSSOfflineSearchError, .incompatibleDatabase)
    }
  }

  func testMergingDropsPlacesRepeatedByOverlappingRegions() {
    func place(_ id: Int64) -> NavOSSOfflinePlace {
      NavOSSOfflinePlace(
        osmType: "node", osmId: id, name: "P\(id)", nameSource: "osm", category: nil,
        osmClass: "amenity", osmSubtype: "cafe", latitude: 51, longitude: -114, address: "",
        straightLineMeters: 0)
    }
    XCTAssertEqual(
      navOSSOfflineMergeSearchResults([[place(1), place(2)], [place(2), place(3)]], limit: 10)
        .map(\.osmId), [1, 2, 3])
    XCTAssertEqual(
      navOSSOfflineMergeSearchResults([[place(1), place(2), place(3)]], limit: 2).map(\.osmId),
      [1, 2])
  }
}
