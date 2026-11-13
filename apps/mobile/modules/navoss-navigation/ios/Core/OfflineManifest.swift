import Foundation

// Offline bundle manifest, contract version 1 (`packages/contracts/src/offline-bundle.ts`).
//
// The manifest is parsed strictly, mirroring the server's Zod schema: unknown keys, mixed data
// dates or graphs, invalid hashes, inverted bounds and unsupported formats are rejected. Formats
// and versions this app cannot read are reported separately as `unsupported`, so the app can tell
// the driver to update NavOSS instead of calling the manifest broken.

/// The offline bundle consumer contract this app implements. A manifest whose
/// `minimumAppContractVersion` is higher was built for a newer app.
public let navOSSOfflineAppContractVersion = 1
/// The Valhalla engine embedded in the app (Rallista valhalla-mobile 0.6.4).
public let navOSSOfflineRoutingEngineVersion = "3.9.1"
public let navOSSOfflineGraphTileFormat = "valhalla-gph"
public let navOSSOfflineGraphTileFormatVersion = "3.9.1"
/// The four styles every resources artifact must carry, in contract order.
public let navOSSOfflineStyleSlugs = ["liberty", "bright", "positron", "dark"]

public enum NavOSSOfflineManifestError: Error, Equatable, Sendable {
  /// The document is not a valid version-1 manifest.
  case malformed(String)
  /// The document is well formed but needs a newer app (schema, contract, engine or format).
  case unsupported(String)
}

public struct NavOSSOfflineArtifact: Codable, Equatable, Sendable {
  public let url: URL
  public let byteSize: Int64
  public let sha256: String

  public init(url: URL, byteSize: Int64, sha256: String) {
    self.url = url
    self.byteSize = byteSize
    self.sha256 = sha256
  }
}

public struct NavOSSOfflineResourcesArtifact: Codable, Equatable, Sendable {
  public let artifact: NavOSSOfflineArtifact
  public let unpackedByteSize: Int64
}

public struct NavOSSOfflineAttribution: Codable, Equatable, Sendable {
  public let text: String
  public let url: String
  public let license: String
}

/// `[west, south, east, north]` in degrees.
public struct NavOSSOfflineBounds: Codable, Equatable, Sendable {
  public let west: Double
  public let south: Double
  public let east: Double
  public let north: Double

  public init(west: Double, south: Double, east: Double, north: Double) {
    self.west = west
    self.south = south
    self.east = east
    self.north = north
  }

  public func contains(_ coordinate: NavOSSCarPlayCoordinate) -> Bool {
    coordinate.longitude >= west && coordinate.longitude <= east
      && coordinate.latitude >= south && coordinate.latitude <= north
  }

  /// Rough area in square degrees, for choosing the widest covering region.
  var area: Double { (east - west) * (north - south) }
}

public struct NavOSSOfflineRegion: Codable, Equatable, Sendable {
  public let id: String
  public let name: String
  /// GeoJSON MultiPolygon: polygons, each a list of rings (outer first), each `[lon, lat]` closed.
  public let polygon: [[[NavOSSCarPlayCoordinate]]]
  public let bounds: NavOSSOfflineBounds
  public let overlapMeters: Int
  public let dataDate: String
  public let maps: NavOSSOfflineArtifact
  public let routing: NavOSSOfflineArtifact
  public let search: NavOSSOfflineArtifact
  public let resources: NavOSSOfflineResourcesArtifact
  public let attribution: [NavOSSOfflineAttribution]

  /// Bytes transferred for this region's own artifacts (resources are shared and counted once).
  public var regionDownloadBytes: Int64 { maps.byteSize + routing.byteSize + search.byteSize }
}

public struct NavOSSOfflineGraph: Codable, Equatable, Sendable {
  public let id: String
  public let routingEngineVersion: String
  public let tileFormat: String
  public let tileFormatVersion: String
  public let speedProfileSha256: String
}

public struct NavOSSOfflineManifest: Codable, Equatable, Sendable {
  public let schemaVersion: Int
  public let bundleVersion: String
  public let dataDate: String
  public let osmTimestamp: String
  public let generatedAt: String
  public let minimumAppContractVersion: Int
  public let graph: NavOSSOfflineGraph
  public let regions: [NavOSSOfflineRegion]

  public func region(id: String) -> NavOSSOfflineRegion? {
    regions.first { $0.id == id }
  }

  /// Parses and validates a version-1 manifest document.
  public static func parse(_ data: Data) throws -> NavOSSOfflineManifest {
    guard let object = try? JSONSerialization.jsonObject(with: data) else {
      throw NavOSSOfflineManifestError.malformed("The manifest is not JSON.")
    }
    var reader = ManifestReader()
    return try reader.manifest(object)
  }
}

// MARK: - Strict reader

private let sha256Pattern = try! NSRegularExpression(pattern: "^[0-9a-f]{64}$")
private let datePattern = try! NSRegularExpression(pattern: "^\\d{4}-\\d{2}-\\d{2}$")
private let bundleVersionPattern = try! NSRegularExpression(
  pattern: "^\\d{4}-\\d{2}-\\d{2}-v1-[0-9a-f]{12}$")
private let regionIdPattern = try! NSRegularExpression(pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
private let schemaVersionPattern = try! NSRegularExpression(pattern: "^\\d+\\.\\d+(?:\\.\\d+)?$")
private let maxSafeInteger: Int64 = 9_007_199_254_740_991

private func matches(_ pattern: NSRegularExpression, _ value: String) -> Bool {
  pattern.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
}

private struct ManifestReader {
  func manifest(_ value: Any) throws -> NavOSSOfflineManifest {
    let object = try strictObject(
      value, path: "manifest",
      keys: [
        "schemaVersion", "bundleVersion", "dataDate", "osmTimestamp", "generatedAt",
        "minimumAppContractVersion", "graph", "regions",
      ])
    // Version gates first: a newer document may legitimately fail every later check.
    let schemaVersion = try integer(object["schemaVersion"], path: "schemaVersion")
    guard schemaVersion == 1 else {
      throw NavOSSOfflineManifestError.unsupported("Offline manifest schema \(schemaVersion)")
    }
    let minimumAppContractVersion = try integer(
      object["minimumAppContractVersion"], path: "minimumAppContractVersion")
    guard minimumAppContractVersion >= 1 else {
      throw malformed("minimumAppContractVersion")
    }
    guard minimumAppContractVersion <= navOSSOfflineAppContractVersion else {
      throw NavOSSOfflineManifestError.unsupported(
        "Offline bundle consumer contract \(minimumAppContractVersion)")
    }
    let graph = try graph(object["graph"])
    let bundleVersion = try string(object["bundleVersion"], path: "bundleVersion")
    guard matches(bundleVersionPattern, bundleVersion) else { throw malformed("bundleVersion") }
    let dataDate = try date(object["dataDate"], path: "dataDate")
    let osmTimestamp = try timestamp(object["osmTimestamp"], path: "osmTimestamp")
    let generatedAt = try timestamp(object["generatedAt"], path: "generatedAt")
    guard let regionValues = object["regions"] as? [Any], (1...64).contains(regionValues.count)
    else {
      throw malformed("regions")
    }
    var regions: [NavOSSOfflineRegion] = []
    var ids = Set<String>()
    for (index, value) in regionValues.enumerated() {
      let region = try region(value, path: "regions[\(index)]", graphId: graph.id)
      guard ids.insert(region.id).inserted else { throw malformed("regions[\(index)].id") }
      guard region.dataDate == dataDate else { throw malformed("regions[\(index)].dataDate") }
      regions.append(region)
    }
    guard osmTimestamp.prefix(10) == dataDate else { throw malformed("osmTimestamp") }
    guard bundleVersion.hasPrefix("\(dataDate)-v1-") else { throw malformed("bundleVersion") }
    return NavOSSOfflineManifest(
      schemaVersion: schemaVersion,
      bundleVersion: bundleVersion,
      dataDate: dataDate,
      osmTimestamp: osmTimestamp,
      generatedAt: generatedAt,
      minimumAppContractVersion: minimumAppContractVersion,
      graph: graph,
      regions: regions
    )
  }

  func graph(_ value: Any?) throws -> NavOSSOfflineGraph {
    let object = try strictObject(
      value, path: "graph",
      keys: ["id", "routingEngineVersion", "tileFormat", "tileFormatVersion", "speedProfileSha256"])
    let engine = try string(object["routingEngineVersion"], path: "graph.routingEngineVersion")
    let tileFormat = try string(object["tileFormat"], path: "graph.tileFormat")
    let tileFormatVersion = try string(object["tileFormatVersion"], path: "graph.tileFormatVersion")
    try requireEngine(engine, tileFormat, tileFormatVersion)
    return NavOSSOfflineGraph(
      id: try sha256(object["id"], path: "graph.id"),
      routingEngineVersion: engine,
      tileFormat: tileFormat,
      tileFormatVersion: tileFormatVersion,
      speedProfileSha256: try sha256(object["speedProfileSha256"], path: "graph.speedProfileSha256")
    )
  }

  func requireEngine(_ engine: String, _ tileFormat: String, _ tileFormatVersion: String) throws {
    guard engine == navOSSOfflineRoutingEngineVersion,
      tileFormat == navOSSOfflineGraphTileFormat,
      tileFormatVersion == navOSSOfflineGraphTileFormatVersion
    else {
      throw NavOSSOfflineManifestError.unsupported(
        "Routing engine \(engine) with \(tileFormat) \(tileFormatVersion)")
    }
  }

  func region(_ value: Any?, path: String, graphId: String) throws -> NavOSSOfflineRegion {
    let object = try strictObject(
      value, path: path,
      keys: ["id", "name", "polygon", "bounds", "overlapMeters", "dataDate", "artifacts", "attribution"])
    let id = try string(object["id"], path: "\(path).id")
    guard id.count <= 64, matches(regionIdPattern, id) else { throw malformed("\(path).id") }
    let name = try string(object["name"], path: "\(path).name")
    guard (1...120).contains(name.count) else { throw malformed("\(path).name") }
    let bounds = try bounds(object["bounds"], path: "\(path).bounds")
    let polygon = try multiPolygon(object["polygon"], path: "\(path).polygon")
    for point in polygon.joined().joined()
    where point.longitude < bounds.west - 1e-7 || point.longitude > bounds.east + 1e-7
      || point.latitude < bounds.south - 1e-7 || point.latitude > bounds.north + 1e-7
    {
      throw malformed("\(path).bounds")
    }
    let overlap = try integer(object["overlapMeters"], path: "\(path).overlapMeters")
    guard (0...100_000).contains(overlap) else { throw malformed("\(path).overlapMeters") }
    let artifacts = try strictObject(
      object["artifacts"], path: "\(path).artifacts",
      keys: ["maps", "routing", "search", "resources"])
    guard let attributionValues = object["attribution"] as? [Any],
      (1...32).contains(attributionValues.count)
    else {
      throw malformed("\(path).attribution")
    }
    return NavOSSOfflineRegion(
      id: id,
      name: name,
      polygon: polygon,
      bounds: bounds,
      overlapMeters: overlap,
      dataDate: try date(object["dataDate"], path: "\(path).dataDate"),
      maps: try maps(artifacts["maps"], path: "\(path).artifacts.maps"),
      routing: try routing(artifacts["routing"], path: "\(path).artifacts.routing", graphId: graphId),
      search: try search(artifacts["search"], path: "\(path).artifacts.search"),
      resources: try resources(artifacts["resources"], path: "\(path).artifacts.resources"),
      attribution: try attributionValues.enumerated().map {
        try attribution($0.element, path: "\(path).attribution[\($0.offset)]")
      }
    )
  }

  func artifact(_ object: [String: Any], path: String) throws -> NavOSSOfflineArtifact {
    let urlString = try string(object["url"], path: "\(path).url")
    guard let url = URL(string: urlString), let host = url.host, !host.isEmpty,
      url.user == nil, url.password == nil, url.fragment == nil, url.query == nil
    else {
      throw malformed("\(path).url")
    }
    let loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
    guard url.scheme == "https" || (loopback && url.scheme == "http") else {
      throw malformed("\(path).url")
    }
    let byteSize = try integer64(object["byteSize"], path: "\(path).byteSize")
    guard byteSize > 0, byteSize <= maxSafeInteger else { throw malformed("\(path).byteSize") }
    return NavOSSOfflineArtifact(
      url: url, byteSize: byteSize, sha256: try sha256(object["sha256"], path: "\(path).sha256"))
  }

  func maps(_ value: Any?, path: String) throws -> NavOSSOfflineArtifact {
    let object = try strictObject(
      value, path: path,
      keys: [
        "url", "byteSize", "sha256", "format", "formatVersion", "schema", "schemaVersion",
        "minZoom", "maxZoom",
      ])
    try requireFormat(object, path: path, format: "pmtiles", version: 3)
    guard try string(object["schema"], path: "\(path).schema") == "openmaptiles" else {
      throw NavOSSOfflineManifestError.unsupported("Map schema")
    }
    let schemaVersion = try string(object["schemaVersion"], path: "\(path).schemaVersion")
    guard matches(schemaVersionPattern, schemaVersion) else {
      throw malformed("\(path).schemaVersion")
    }
    // The styles ship with the tiles, so any OpenMapTiles 3.x schema renders with its own styles.
    guard schemaVersion.hasPrefix("3.") else {
      throw NavOSSOfflineManifestError.unsupported("OpenMapTiles \(schemaVersion)")
    }
    let minZoom = try integer(object["minZoom"], path: "\(path).minZoom")
    let maxZoom = try integer(object["maxZoom"], path: "\(path).maxZoom")
    guard (0...16).contains(minZoom), (0...16).contains(maxZoom), minZoom <= maxZoom else {
      throw malformed("\(path).zoom")
    }
    return try artifact(object, path: path)
  }

  func routing(_ value: Any?, path: String, graphId: String) throws -> NavOSSOfflineArtifact {
    let object = try strictObject(
      value, path: path,
      keys: [
        "url", "byteSize", "sha256", "format", "formatVersion", "routingEngineVersion",
        "tileFormat", "tileFormatVersion", "graphId",
      ])
    try requireFormat(object, path: path, format: "valhalla-tar", version: 1)
    try requireEngine(
      try string(object["routingEngineVersion"], path: "\(path).routingEngineVersion"),
      try string(object["tileFormat"], path: "\(path).tileFormat"),
      try string(object["tileFormatVersion"], path: "\(path).tileFormatVersion")
    )
    guard try sha256(object["graphId"], path: "\(path).graphId") == graphId else {
      throw malformed("\(path).graphId")
    }
    return try artifact(object, path: path)
  }

  func search(_ value: Any?, path: String) throws -> NavOSSOfflineArtifact {
    let object = try strictObject(
      value, path: path,
      keys: ["url", "byteSize", "sha256", "format", "formatVersion", "schemaVersion"])
    try requireFormat(object, path: path, format: "sqlite-fts5", version: 1)
    guard try integer(object["schemaVersion"], path: "\(path).schemaVersion") == 1 else {
      throw NavOSSOfflineManifestError.unsupported("Search schema")
    }
    return try artifact(object, path: path)
  }

  func resources(_ value: Any?, path: String) throws -> NavOSSOfflineResourcesArtifact {
    let object = try strictObject(
      value, path: path,
      keys: [
        "url", "byteSize", "sha256", "format", "formatVersion", "schemaVersion",
        "unpackedByteSize", "styles",
      ])
    try requireFormat(object, path: path, format: "tar-gzip", version: 1)
    guard try integer(object["schemaVersion"], path: "\(path).schemaVersion") == 1 else {
      throw NavOSSOfflineManifestError.unsupported("Resource schema")
    }
    guard (object["styles"] as? [String]) == navOSSOfflineStyleSlugs else {
      throw malformed("\(path).styles")
    }
    let unpacked = try integer64(object["unpackedByteSize"], path: "\(path).unpackedByteSize")
    guard unpacked > 0, unpacked <= maxSafeInteger else {
      throw malformed("\(path).unpackedByteSize")
    }
    return NavOSSOfflineResourcesArtifact(
      artifact: try artifact(object, path: path), unpackedByteSize: unpacked)
  }

  func requireFormat(_ object: [String: Any], path: String, format: String, version: Int) throws {
    let actualFormat = try string(object["format"], path: "\(path).format")
    let actualVersion = try integer(object["formatVersion"], path: "\(path).formatVersion")
    guard actualFormat == format, actualVersion == version else {
      throw NavOSSOfflineManifestError.unsupported("\(actualFormat) \(actualVersion)")
    }
  }

  func attribution(_ value: Any, path: String) throws -> NavOSSOfflineAttribution {
    let object = try strictObject(value, path: path, keys: ["text", "url", "license"])
    let text = try string(object["text"], path: "\(path).text")
    let url = try string(object["url"], path: "\(path).url")
    let license = try string(object["license"], path: "\(path).license")
    guard (1...1000).contains(text.count), (1...100).contains(license.count),
      let parsed = URL(string: url), ["http", "https"].contains(parsed.scheme ?? "")
    else {
      throw malformed(path)
    }
    return NavOSSOfflineAttribution(text: text, url: url, license: license)
  }

  func bounds(_ value: Any?, path: String) throws -> NavOSSOfflineBounds {
    guard let values = value as? [Any], values.count == 4 else { throw malformed(path) }
    let numbers = try values.map { try number($0, path: path) }
    let bounds = NavOSSOfflineBounds(
      west: numbers[0], south: numbers[1], east: numbers[2], north: numbers[3])
    guard (-180...180).contains(bounds.west), (-180...180).contains(bounds.east),
      (-90...90).contains(bounds.south), (-90...90).contains(bounds.north),
      bounds.west < bounds.east, bounds.south < bounds.north
    else {
      throw malformed(path)
    }
    return bounds
  }

  func multiPolygon(_ value: Any?, path: String) throws -> [[[NavOSSCarPlayCoordinate]]] {
    let object = try strictObject(value, path: path, keys: ["type", "coordinates"])
    guard object["type"] as? String == "MultiPolygon",
      let polygons = object["coordinates"] as? [Any], (1...1000).contains(polygons.count)
    else {
      throw malformed(path)
    }
    return try polygons.map { polygon in
      guard let rings = polygon as? [Any], (1...100).contains(rings.count) else {
        throw malformed(path)
      }
      return try rings.map { ring in
        guard let positions = ring as? [Any], (4...100_000).contains(positions.count) else {
          throw malformed(path)
        }
        let points = try positions.map { position -> NavOSSCarPlayCoordinate in
          guard let pair = position as? [Any], pair.count == 2 else { throw malformed(path) }
          let coordinate = NavOSSCarPlayCoordinate(
            latitude: try number(pair[1], path: path), longitude: try number(pair[0], path: path))
          guard coordinate.isValid else { throw malformed(path) }
          return coordinate
        }
        guard points.first == points.last else { throw malformed(path) }
        var twiceArea = 0.0
        for index in 1..<points.count {
          twiceArea += points[index - 1].longitude * points[index].latitude
            - points[index].longitude * points[index - 1].latitude
        }
        guard abs(twiceArea) >= 1e-12 else { throw malformed(path) }
        return points
      }
    }
  }

  // MARK: Primitives

  func strictObject(_ value: Any?, path: String, keys: Set<String>) throws -> [String: Any] {
    guard let object = value as? [String: Any] else { throw malformed(path) }
    if let unknown = object.keys.first(where: { !keys.contains($0) }) {
      throw malformed("\(path).\(unknown)")
    }
    if let missing = keys.first(where: { object[$0] == nil }) {
      throw malformed("\(path).\(missing)")
    }
    return object
  }

  func string(_ value: Any?, path: String) throws -> String {
    guard let string = value as? String, !string.isEmpty else { throw malformed(path) }
    return string
  }

  func number(_ value: Any?, path: String) throws -> Double {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
      number.doubleValue.isFinite
    else {
      throw malformed(path)
    }
    return number.doubleValue
  }

  func integer64(_ value: Any?, path: String) throws -> Int64 {
    let value = try number(value, path: path)
    guard value.rounded() == value, abs(value) <= Double(maxSafeInteger) else {
      throw malformed(path)
    }
    return Int64(value)
  }

  func integer(_ value: Any?, path: String) throws -> Int {
    Int(try integer64(value, path: path))
  }

  func sha256(_ value: Any?, path: String) throws -> String {
    let value = try string(value, path: path)
    guard matches(sha256Pattern, value) else { throw malformed(path) }
    return value
  }

  func date(_ value: Any?, path: String) throws -> String {
    let value = try string(value, path: path)
    guard matches(datePattern, value), Self.dateFormatter.date(from: value) != nil else {
      throw malformed(path)
    }
    return value
  }

  func timestamp(_ value: Any?, path: String) throws -> String {
    let value = try string(value, path: path)
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard formatter.date(from: value) != nil || fractional.date(from: value) != nil else {
      throw malformed(path)
    }
    return value
  }

  func malformed(_ path: String) -> NavOSSOfflineManifestError {
    .malformed("Invalid offline manifest field \(path).")
  }

  static let dateFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .iso8601)
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: "UTC")
    formatter.dateFormat = "yyyy-MM-dd"
    formatter.isLenient = false
    return formatter
  }()
}
