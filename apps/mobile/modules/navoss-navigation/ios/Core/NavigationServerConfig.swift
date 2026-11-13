import Foundation

// The native client's view of `/v2/config`, from any server generation.
//
// The API contract stays strict about what the current server emits; a shipped app must keep
// working against older and newer servers. Every field newer than the oldest deployed server is
// optional, unknown fields are ignored, and anything absent or malformed means "not available":
// a config that cannot be read never stops routing, it only leaves coverage unknown.
// Mirrors `serverConfigFromPayload` in packages/contracts/src/client-config.ts.

/// Which `routes` endpoint a server offers.
enum NavigationRoutesAPIVersion: Equatable, Sendable {
  case v1
  case v2
}

/// The service areas a server declares. Eligibility uses an area's boundary polygon when the
/// server sent one, otherwise the declared rectangle itself.
struct NavigationServiceCoverage: Equatable, Sendable {
  struct Area: Equatable, Sendable {
    let id: String
    let northEast: NavOSSCarPlayCoordinate
    let southWest: NavOSSCarPlayCoordinate
    /// MultiPolygon rings as `[polygon][ring][position]`; the first ring of each polygon is its
    /// exterior, the rest are holes.
    let polygons: [[[NavOSSCarPlayCoordinate]]]?

    func contains(_ coordinate: NavOSSCarPlayCoordinate) -> Bool {
      guard coordinate.latitude >= southWest.latitude, coordinate.latitude <= northEast.latitude,
        coordinate.longitude >= southWest.longitude, coordinate.longitude <= northEast.longitude
      else {
        return false
      }
      guard let polygons else { return true }
      return polygons.contains { polygon in
        guard let exterior = polygon.first, ringContains(exterior, coordinate) else { return false }
        return !polygon.dropFirst().contains { ringContains($0, coordinate) }
      }
    }
  }

  let displayName: String
  let areas: [Area]

  func serves(_ coordinate: NavOSSCarPlayCoordinate) -> Bool {
    areas.contains { $0.contains(coordinate) }
  }
}

/// Even-odd ring test that counts the recorded boundary itself as inside, like the server.
private func ringContains(
  _ ring: [NavOSSCarPlayCoordinate],
  _ coordinate: NavOSSCarPlayCoordinate
) -> Bool {
  let x = coordinate.longitude
  let y = coordinate.latitude
  var inside = false
  for index in ring.indices.dropFirst() {
    let (x1, y1) = (ring[index - 1].longitude, ring[index - 1].latitude)
    let (x2, y2) = (ring[index].longitude, ring[index].latitude)
    let cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1)
    if abs(cross) <= 1e-10, x >= min(x1, x2), x <= max(x1, x2), y >= min(y1, y2), y <= max(y1, y2) {
      return true
    }
    if (y1 > y) != (y2 > y), x < x1 + (y - y1) * (x2 - x1) / (y2 - y1) {
      inside.toggle()
    }
  }
  return inside
}

struct NavigationServerConfig: Decodable, Equatable, Sendable {
  /// `.v1` only when the server declares `/v1/routes`. A newer or missing declaration is asked
  /// `/v2/routes` first, with the usual 404 fallback.
  let routesVersion: NavigationRoutesAPIVersion
  /// Nil when the server declared none this client can read: nothing is refused locally then.
  let coverage: NavigationServiceCoverage?
  let communityReports: Bool
  let liveTraffic: Bool

  init(
    routesVersion: NavigationRoutesAPIVersion,
    coverage: NavigationServiceCoverage? = nil,
    communityReports: Bool = false,
    liveTraffic: Bool = false
  ) {
    self.routesVersion = routesVersion
    self.coverage = coverage
    self.communityReports = communityReports
    self.liveTraffic = liveTraffic
  }

  private enum CodingKeys: String, CodingKey {
    case coverage, endpoints, features
  }

  private struct Endpoints: Decodable {
    let routes: String?
  }

  private enum FeatureKeys: String, CodingKey {
    case communityReports, liveTraffic
  }

  private struct Bounds: Decodable {
    let northEast: NavOSSCarPlayCoordinate
    let southWest: NavOSSCarPlayCoordinate
  }

  private struct Boundary: Decodable {
    let type: String
    let coordinates: [[[[Double]]]]
  }

  private struct AreaWire: Decodable {
    let id: String
    let bounds: Bounds
    let boundary: Boundary?
  }

  /// Decodes one array element without letting a malformed one fail the rest.
  private struct Lenient<Value: Decodable>: Decodable {
    let value: Value?
    init(from decoder: Decoder) throws {
      value = try? Value(from: decoder)
    }
  }

  private struct CoverageWire: Decodable {
    let displayName: String
    let serviceAreas: [Lenient<AreaWire>]?
    let bounds: Bounds?
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let routes = (try? container.decodeIfPresent(Endpoints.self, forKey: .endpoints))?.routes
    routesVersion = routes == "/v1/routes" ? .v1 : .v2
    let features = try? container.nestedContainer(keyedBy: FeatureKeys.self, forKey: .features)
    communityReports =
      (try? features?.decodeIfPresent(Bool.self, forKey: .communityReports)) == true
    liveTraffic = (try? features?.decodeIfPresent(Bool.self, forKey: .liveTraffic)) == true
    coverage = (try? container.decodeIfPresent(CoverageWire.self, forKey: .coverage))
      .flatMap(Self.coverage)
  }

  private static func coverage(_ wire: CoverageWire) -> NavigationServiceCoverage? {
    let areas: [NavigationServiceCoverage.Area]
    if let serviceAreas = wire.serviceAreas {
      areas = serviceAreas.compactMap { $0.value.flatMap(area) }
    } else if let bounds = wire.bounds, valid(bounds) {
      // `/v1/config`-style: one rectangle is the whole coverage.
      areas = [.init(id: "coverage", northEast: bounds.northEast, southWest: bounds.southWest, polygons: nil)]
    } else {
      areas = []
    }
    return areas.isEmpty ? nil : NavigationServiceCoverage(displayName: wire.displayName, areas: areas)
  }

  private static func valid(_ bounds: Bounds) -> Bool {
    bounds.northEast.isValid && bounds.southWest.isValid
      && bounds.northEast.latitude > bounds.southWest.latitude
      && bounds.northEast.longitude > bounds.southWest.longitude
  }

  /// A malformed area is dropped, never widened to a rectangle the server did not mean.
  private static func area(_ wire: AreaWire) -> NavigationServiceCoverage.Area? {
    guard valid(wire.bounds) else { return nil }
    var polygons: [[[NavOSSCarPlayCoordinate]]]?
    if let boundary = wire.boundary {
      guard boundary.type == "MultiPolygon", !boundary.coordinates.isEmpty else { return nil }
      var decoded: [[[NavOSSCarPlayCoordinate]]] = []
      for polygon in boundary.coordinates {
        var rings: [[NavOSSCarPlayCoordinate]] = []
        for ring in polygon {
          let positions = ring.compactMap { position -> NavOSSCarPlayCoordinate? in
            guard position.count >= 2 else { return nil }
            let coordinate = NavOSSCarPlayCoordinate(latitude: position[1], longitude: position[0])
            return coordinate.isValid ? coordinate : nil
          }
          guard positions.count == ring.count, positions.count >= 4,
            positions.first == positions.last
          else {
            return nil
          }
          rings.append(positions)
        }
        guard !rings.isEmpty else { return nil }
        decoded.append(rings)
      }
      polygons = decoded
    }
    return .init(
      id: wire.id,
      northEast: wire.bounds.northEast,
      southWest: wire.bounds.southWest,
      polygons: polygons
    )
  }
}

/// Remembers, per server, what its `/v2/config` declared. A server is asked again after
/// `timeToLive`, so an upgraded server is picked up without a relaunch.
public final class NavOSSRoutesEndpointDiscovery: @unchecked Sendable {
  public static let shared = NavOSSRoutesEndpointDiscovery()

  private let clock: () -> Date
  private var entries: [String: (config: NavigationServerConfig, expiresAt: Date)] = [:]
  private let lock = NSLock()
  private let timeToLive: TimeInterval

  public init(timeToLive: TimeInterval = 60 * 60, clock: @escaping () -> Date = Date.init) {
    self.clock = clock
    self.timeToLive = timeToLive
  }

  func config(for baseURL: URL) -> NavigationServerConfig? {
    lock.lock()
    defer { lock.unlock() }
    guard let entry = entries[baseURL.absoluteString], entry.expiresAt > clock() else {
      return nil
    }
    return entry.config
  }

  func record(_ config: NavigationServerConfig, for baseURL: URL) {
    lock.lock()
    entries[baseURL.absoluteString] = (config, clock().addingTimeInterval(timeToLive))
    lock.unlock()
  }

  /// A 404 on `/v2/routes` proves the server only has `/v1/routes`; what else it declared stands.
  func record(_ version: NavigationRoutesAPIVersion, for baseURL: URL) {
    lock.lock()
    let known = entries[baseURL.absoluteString]?.config
    entries[baseURL.absoluteString] = (
      NavigationServerConfig(
        routesVersion: version,
        coverage: known?.coverage,
        communityReports: known?.communityReports ?? false,
        liveTraffic: known?.liveTraffic ?? false
      ),
      clock().addingTimeInterval(timeToLive)
    )
    lock.unlock()
  }
}
