import Foundation

#if canImport(SQLite3)
  import SQLite3
#endif

// Read-only search over an installed region's SQLite FTS5/RTree index (schema 1). The SQL recipes
// ship inside the bundle's shared resources (`search-query.sql`, `category-query.sql`); this file
// builds their bound parameters exactly like the pipeline's `query-search.py`, so the device and
// the reference produce the same ranking. Query text and origin never leave the device and are
// never written to the database (it is opened `mode=ro&immutable=1`).

public let navOSSOfflineSearchSource = "offline-osm"

public enum NavOSSOfflineSearchError: Error, Equatable, Sendable {
  case unavailable
  case incompatibleDatabase
  case queryFailed
}

/// Text normalisation shared with the index build: NFKD, combining marks removed, lowercase,
/// `&` → `and`, non-word runs as separators, then the packaged street/direction alias table.
public struct NavOSSOfflineSearchNormalizer: Sendable {
  public let aliases: [String: String]

  public init(aliases: [String: String]) {
    self.aliases = aliases
  }

  public init(normalizationJSON data: Data) throws {
    guard let aliases = try JSONSerialization.jsonObject(with: data) as? [String: String] else {
      throw NavOSSOfflineSearchError.incompatibleDatabase
    }
    self.init(aliases: aliases)
  }

  public func tokens(_ value: String) -> [String] {
    var scalars = String.UnicodeScalarView()
    for scalar in value.decomposedStringWithCompatibilityMapping.unicodeScalars
    where scalar.properties.canonicalCombiningClass == .notReordered {
      scalars.append(scalar)
    }
    let lowered = String(scalars).lowercased().replacingOccurrences(of: "&", with: " and ")
    var tokens: [String] = []
    var current = String.UnicodeScalarView()
    for scalar in lowered.unicodeScalars {
      if Self.isWordScalar(scalar) {
        current.append(scalar)
      } else if !current.isEmpty {
        tokens.append(String(current))
        current = String.UnicodeScalarView()
      }
    }
    if !current.isEmpty { tokens.append(String(current)) }
    return tokens.map { aliases[$0] ?? $0 }
  }

  public func normalize(_ value: String) -> String {
    tokens(value).joined(separator: " ")
  }

  /// Every token quoted; text tokens are prefixes. A completed number in a multi-token query is
  /// exact, so `101 9 Avenue` cannot match `1012 96 Avenue`.
  public func ftsQuery(_ value: String) -> String {
    let tokens = tokens(value)
    return tokens.map { token in
      let exact = tokens.count > 1 && token.unicodeScalars.allSatisfy {
        $0.properties.numericType == .decimal
      }
      return "\"\(token.replacingOccurrences(of: "\"", with: "\"\""))\"" + (exact ? "" : "*")
    }.joined(separator: " AND ")
  }

  /// Python's `\w` without the underscore (which `query-search.py` also treats as a separator):
  /// letters and numbers of any script.
  private static func isWordScalar(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.properties.generalCategory {
    case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
      .decimalNumber, .letterNumber, .otherNumber:
      return true
    default:
      return scalar.properties.numericType != nil
    }
  }
}

public struct NavOSSOfflinePlace: Equatable, Sendable {
  public let osmType: String
  public let osmId: Int64
  public let name: String
  /// `osm`, `address` or `category` (a name generated from the place's tag, not a real name).
  public let nameSource: String
  public let category: String?
  public let osmClass: String
  public let osmSubtype: String
  public let latitude: Double
  public let longitude: Double
  public let address: String
  /// Equirectangular ranking distance; not a driving distance.
  public let straightLineMeters: Double

  /// The index's row ID: `osm_id * 4 + {node: 0, way: 1, relation: 2}`.
  public var databaseId: Int64 {
    osmId * 4 + (osmType == "way" ? 1 : osmType == "relation" ? 2 : 0)
  }

  /// The same identifier the online Nominatim search uses, so recents and favourites match.
  public var id: String { "nominatim:\(osmType):\(osmId)" }

  /// Contract search category (`address`, `landmark`, `neighborhood`, `poi`).
  public var resultCategory: String {
    if nameSource == "address" { return "address" }
    if osmClass == "place" {
      return ["city", "town", "village", "hamlet", "suburb", "quarter", "neighbourhood", "borough"]
        .contains(osmSubtype) ? "neighborhood" : "landmark"
    }
    return ["amenity", "shop", "tourism", "leisure", "aeroway", "healthcare", "office"]
      .contains(osmClass) ? "poi" : "landmark"
  }

  /// A short factual description from the OSM tag, e.g. `fast food`; nil for vague tags.
  public var detailCategory: String? {
    guard osmSubtype != "yes", nameSource != "address" else { return nil }
    let words = osmSubtype.split(whereSeparator: { $0 == "_" || $0 == "-" || $0 == " " })
    guard (1...3).contains(words.count), words.allSatisfy({ $0.allSatisfy(\.isLetter) }) else {
      return nil
    }
    return words.joined(separator: " ")
  }

  /// The line under the name: the explicit OSM address, saying so when a name was generated
  /// from the tag rather than published.
  public var label: String {
    if nameSource == "category" {
      return address.isEmpty ? "Unnamed \(detailCategory ?? "place") · OpenStreetMap" : address
    }
    return address.isEmpty ? name : address
  }

  public var destination: NavOSSCarPlayDestination {
    NavOSSCarPlayDestination(
      category: resultCategory, id: id, label: label, latitude: latitude, longitude: longitude,
      name: name)
  }
}

/// Bound parameters for `search-query.sql`, matching `query-search.py`.
public struct NavOSSOfflineSearchParameters: Equatable, Sendable {
  public let ftsQuery: String
  public let nameFtsQuery: String
  public let addressFtsQuery: String
  public let normalized: String
  public let latitude: Double
  public let longitude: Double
  public let longitudeKm: Double
  public let limit: Int

  public init?(
    query: String,
    origin: NavOSSCarPlayCoordinate,
    limit: Int,
    normalizer: NavOSSOfflineSearchNormalizer
  ) {
    let fts = normalizer.ftsQuery(query)
    guard !fts.isEmpty, (1...100).contains(limit), origin.isValid else { return nil }
    ftsQuery = fts
    nameFtsQuery = "{name_tokens variant_tokens} : (\(fts))"
    addressFtsQuery = "address_tokens : (\(fts))"
    normalized = normalizer.normalize(query)
    latitude = origin.latitude
    longitude = origin.longitude
    longitudeKm = 111.32 * cos(origin.latitude * .pi / 180)
    self.limit = limit
  }
}

/// Bound parameters for `category-query.sql`: an exact category inside a radius bounding box.
public struct NavOSSOfflineCategoryParameters: Equatable, Sendable {
  public let category: String
  public let latitude: Double
  public let longitude: Double
  public let longitudeKm: Double
  public let west: Double
  public let east: Double
  public let south: Double
  public let north: Double
  public let limit: Int

  public init?(category: String, origin: NavOSSCarPlayCoordinate, radiusKm: Double, limit: Int) {
    guard !category.isEmpty, origin.isValid, radiusKm > 0, radiusKm <= 200,
      (1...100).contains(limit)
    else {
      return nil
    }
    self.category = category
    latitude = origin.latitude
    longitude = origin.longitude
    longitudeKm = 111.32 * cos(origin.latitude * .pi / 180)
    west = origin.longitude - radiusKm / longitudeKm
    east = origin.longitude + radiusKm / longitudeKm
    south = origin.latitude - radiusKm / 111.32
    north = origin.latitude + radiusKm / 111.32
    self.limit = limit
  }
}

#if canImport(SQLite3)
  private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

  /// One read-only, immutable connection to a region's `search.sqlite`. Not thread-safe; the
  /// owner serialises access.
  public final class NavOSSOfflineSearchDatabase {
    private var handle: OpaquePointer?

    public init(url: URL) throws {
      var components = URLComponents(url: url.standardizedFileURL, resolvingAgainstBaseURL: false)
      components?.queryItems = [
        URLQueryItem(name: "mode", value: "ro"), URLQueryItem(name: "immutable", value: "1"),
      ]
      guard let uri = components?.url?.absoluteString,
        sqlite3_open_v2(uri, &handle, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nil) == SQLITE_OK
      else {
        sqlite3_close(handle)
        throw NavOSSOfflineSearchError.unavailable
      }
      guard try pragma("application_id") == 0x4e56_4f53, try pragma("user_version") == 1 else {
        sqlite3_close(handle)
        handle = nil
        throw NavOSSOfflineSearchError.incompatibleDatabase
      }
    }

    deinit {
      sqlite3_close(handle)
    }

    public func search(sql: String, parameters: NavOSSOfflineSearchParameters) throws
      -> [NavOSSOfflinePlace]
    {
      try query(
        sql,
        bindings: [
          ":fts_query": .text(parameters.ftsQuery),
          ":name_fts_query": .text(parameters.nameFtsQuery),
          ":address_fts_query": .text(parameters.addressFtsQuery),
          ":normalized": .text(parameters.normalized),
          ":latitude": .real(parameters.latitude),
          ":longitude": .real(parameters.longitude),
          ":longitude_km": .real(parameters.longitudeKm),
          ":limit": .integer(Int64(parameters.limit)),
        ])
    }

    public func category(sql: String, parameters: NavOSSOfflineCategoryParameters) throws
      -> [NavOSSOfflinePlace]
    {
      try query(
        sql,
        bindings: [
          ":category": .text(parameters.category),
          ":latitude": .real(parameters.latitude),
          ":longitude": .real(parameters.longitude),
          ":longitude_km": .real(parameters.longitudeKm),
          ":west": .real(parameters.west),
          ":east": .real(parameters.east),
          ":south": .real(parameters.south),
          ":north": .real(parameters.north),
          ":limit": .integer(Int64(parameters.limit)),
        ])
    }

    private enum Binding {
      case text(String)
      case real(Double)
      case integer(Int64)
    }

    private func pragma(_ name: String) throws -> Int64 {
      var statement: OpaquePointer?
      defer { sqlite3_finalize(statement) }
      guard sqlite3_prepare_v2(handle, "PRAGMA \(name)", -1, &statement, nil) == SQLITE_OK,
        sqlite3_step(statement) == SQLITE_ROW
      else {
        throw NavOSSOfflineSearchError.incompatibleDatabase
      }
      return sqlite3_column_int64(statement, 0)
    }

    private func query(_ sql: String, bindings: [String: Binding]) throws -> [NavOSSOfflinePlace] {
      var statement: OpaquePointer?
      defer { sqlite3_finalize(statement) }
      guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK else {
        throw NavOSSOfflineSearchError.queryFailed
      }
      for index in 0..<Int(sqlite3_bind_parameter_count(statement)) {
        let position = Int32(index + 1)
        guard let namePointer = sqlite3_bind_parameter_name(statement, position),
          let binding = bindings[String(cString: namePointer)]
        else {
          throw NavOSSOfflineSearchError.queryFailed
        }
        let status: Int32 =
          switch binding {
          case .text(let value): sqlite3_bind_text(statement, position, value, -1, sqliteTransient)
          case .real(let value): sqlite3_bind_double(statement, position, value)
          case .integer(let value): sqlite3_bind_int64(statement, position, value)
          }
        guard status == SQLITE_OK else { throw NavOSSOfflineSearchError.queryFailed }
      }
      var columns: [String: Int32] = [:]
      for column in 0..<sqlite3_column_count(statement) {
        columns[String(cString: sqlite3_column_name(statement, column))] = column
      }
      func text(_ name: String) -> String? {
        guard let column = columns[name], let value = sqlite3_column_text(statement, column) else {
          return nil
        }
        return String(cString: value)
      }
      func real(_ name: String) -> Double? {
        guard let column = columns[name], sqlite3_column_type(statement, column) != SQLITE_NULL
        else {
          return nil
        }
        return sqlite3_column_double(statement, column)
      }
      var places: [NavOSSOfflinePlace] = []
      while true {
        let step = sqlite3_step(statement)
        if step == SQLITE_DONE { break }
        guard step == SQLITE_ROW,
          let osmType = text("osm_type"), let osmIdColumn = columns["osm_id"],
          let name = text("name"), let nameSource = text("name_source"),
          let osmClass = text("osm_class"), let osmSubtype = text("osm_subtype"),
          let latitude = real("latitude"), let longitude = real("longitude"),
          let distance2 = real("distance2_km")
        else {
          throw NavOSSOfflineSearchError.queryFailed
        }
        places.append(
          NavOSSOfflinePlace(
            osmType: osmType,
            osmId: sqlite3_column_int64(statement, osmIdColumn),
            name: name,
            nameSource: nameSource,
            category: text("category"),
            osmClass: osmClass,
            osmSubtype: osmSubtype,
            latitude: latitude,
            longitude: longitude,
            address: text("address") ?? "",
            straightLineMeters: max(0, distance2).squareRoot() * 1_000
          ))
      }
      return places
    }
  }
#endif

/// Merges per-region result lists in order, dropping a place already listed by an earlier
/// region (regions overlap by design), and keeps at most `limit` results.
public func navOSSOfflineMergeSearchResults(_ lists: [[NavOSSOfflinePlace]], limit: Int)
  -> [NavOSSOfflinePlace]
{
  var seen = Set<String>()
  var merged: [NavOSSOfflinePlace] = []
  for place in lists.joined() where seen.insert(place.id).inserted {
    merged.append(place)
    if merged.count == limit { break }
  }
  return merged
}
