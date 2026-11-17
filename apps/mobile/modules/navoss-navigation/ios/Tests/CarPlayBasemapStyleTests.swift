import Foundation
import XCTest

@testable import NavOSSNavigationCore

/// The restyle is checked against the real layer lists of OpenFreeMap's hosted `liberty` and
/// `dark` styles (fetched 2026-11-17) and of the offline styles built from them (the production
/// offline resources artifact), which CarPlay draws without signal.
final class CarPlayBasemapStyleTests: XCTestCase {
  private struct Layer: Decodable {
    let id: String
    let type: String
    let sourceLayer: String?
  }

  private struct Fixture: Decodable {
    let styles: [String: [Layer]]
  }

  private func styles(_ fixture: String = "openfreemap-style-layers") throws -> [String: [Layer]] {
    let url = try XCTUnwrap(
      Bundle.module.url(forResource: fixture, withExtension: "json", subdirectory: "Fixtures"))
    return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url)).styles
  }

  private func role(_ layer: Layer) -> NavOSSCarPlayBasemapRole {
    let type: NavOSSCarPlayBasemapLayerType =
      switch layer.type {
      case "background": .background
      case "fill": .fill
      case "fill-extrusion": .fillExtrusion
      case "line": .line
      case "symbol": .symbol
      default: .other
      }
    return navOSSCarPlayBasemapRole(type: type, identifier: layer.id, sourceLayer: layer.sourceLayer)
  }

  func testEveryRoadLineInTheHostedAndOfflineStylesIsRestyled() throws {
    let all = try styles().merging(
      styles("offline-style-layers").map { ("offline \($0.key)", $0.value) }, uniquingKeysWith: { $1 })
    XCTAssertEqual(all.count, 4)
    for (name, layers) in all {
      var classes: Set<String> = []
      for layer in layers where layer.sourceLayer == "transportation" && layer.type == "line" {
        switch role(layer) {
        case let .road(roadClass, casing):
          classes.insert("\(roadClass)\(casing ? "-casing" : "")")
        case .rail, .hidden:
          break
        default:
          XCTFail("\(name): road layer \(layer.id) keeps the style's own colours")
        }
      }
      for required in ["motorway", "motorway-casing", "major", "major-casing", "minor"] {
        XCTAssertTrue(classes.contains(required), "\(name) has no \(required) road layer")
      }
    }
  }

  func testLayersAreClassifiedByWhatTheyDraw() throws {
    let all = try styles()
    func classify(_ style: String, _ id: String) throws -> NavOSSCarPlayBasemapRole {
      role(try XCTUnwrap(all[style]?.first { $0.id == id }, "\(style) has no \(id)"))
    }
    let expected: [(String, String, NavOSSCarPlayBasemapRole)] = [
      ("liberty", "background", .land),
      ("liberty", "water", .water),
      ("liberty", "waterway_river", .waterway),
      ("liberty", "park", .greenery),
      ("liberty", "landcover_wood", .greenery),
      ("liberty", "landuse_residential", .hidden),
      ("liberty", "landuse_school", .hidden),
      ("liberty", "building", .building),
      ("liberty", "building-3d", .hidden),
      ("liberty", "road_motorway", .road(.motorway, casing: false)),
      ("liberty", "road_motorway_link_casing", .road(.motorway, casing: true)),
      ("liberty", "road_trunk_primary", .road(.major, casing: false)),
      ("liberty", "bridge_secondary_tertiary_casing", .road(.secondary, casing: true)),
      ("liberty", "tunnel_minor", .road(.minor, casing: false)),
      ("liberty", "road_path_pedestrian", .hidden),
      ("liberty", "road_major_rail_hatching", .rail),
      ("liberty", "road_one_way_arrow", .hidden),
      ("liberty", "road_area_pattern", .hidden),
      ("liberty", "highway-name-major", .roadLabel),
      ("liberty", "highway-name-path", .hidden),
      ("liberty", "highway-shield-non-us", .roadShield),
      ("liberty", "poi_r1", .untouched),
      ("liberty", "natural_earth", .untouched),
      ("liberty", "label_city", .placeLabel),
      ("liberty", "water_name_line_label", .waterLabel),
      ("dark", "landuse_park", .greenery),
      ("dark", "highway_major_inner", .road(.major, casing: false)),
      ("dark", "highway_motorway_casing", .road(.motorway, casing: true)),
      ("dark", "highway_minor", .road(.minor, casing: false)),
      ("dark", "highway_path", .hidden),
      ("dark", "railway_transit_dashline", .rail),
      ("dark", "highway_name_other", .roadLabel),
      ("dark", "place_suburb", .placeLabel),
    ]
    for (style, id, expectedRole) in expected {
      XCTAssertEqual(try classify(style, id), expectedRole, "\(style) \(id)")
    }
  }

  /// A driver without signal gets the same map: every layer the offline style draws is restyled
  /// as its hosted twin is, and the offline style lacks nothing the hosted look depends on.
  func testTheOfflineStylesAreRestyledLikeTheHostedOnes() throws {
    let hosted = try styles()
    let offline = try styles("offline-style-layers")
    for name in ["liberty", "dark"] {
      let hostedLayers = try XCTUnwrap(hosted[name])
      let offlineLayers = try XCTUnwrap(offline[name], "no offline \(name) style")
      let hostedRoles = Dictionary(uniqueKeysWithValues: hostedLayers.map { ($0.id, role($0)) })
      for layer in offlineLayers {
        let twin = try XCTUnwrap(hostedRoles[layer.id], "offline \(name) \(layer.id) is not hosted")
        XCTAssertEqual(role(layer), twin, "offline \(name) \(layer.id)")
      }
      // Only the hosted Natural Earth hillshade raster is left out of the offline styles.
      let offlineIds = Set(offlineLayers.map(\.id))
      let missing = hostedLayers.filter { !offlineIds.contains($0.id) && $0.type != "raster" }
      XCTAssertEqual(missing.map(\.id), [], "offline \(name) lacks hosted layers")
    }
  }

  func testUnknownLayersAreLeftAsTheStyleDrewThem() {
    XCTAssertEqual(
      navOSSCarPlayBasemapRole(type: .line, identifier: "contour_lines", sourceLayer: "contour"),
      .untouched)
    XCTAssertEqual(
      navOSSCarPlayBasemapRole(type: .other, identifier: "hillshade", sourceLayer: nil), .untouched)
    XCTAssertEqual(
      navOSSCarPlayBasemapRole(type: .line, identifier: "navoss-carplay-route", sourceLayer: nil),
      .untouched)
  }

  func testTheRouteIsTheOnlySaturatedColour() {
    func chroma(_ color: UInt32) -> Int {
      let channels = [Int(color >> 16 & 0xFF), Int(color >> 8 & 0xFF), Int(color & 0xFF)]
      return channels.max()! - channels.min()!
    }
    for palette in [NavOSSCarPlayMapPalette.light, .dark] {
      let quiet: [UInt32] =
        [
          palette.land, palette.water, palette.greenery, palette.building, palette.aeroway,
          palette.rail, palette.boundary, palette.roadLabel, palette.placeLabel,
          palette.waterLabel, palette.labelHalo, palette.travelledRoute, palette.alternateRoute,
        ] + NavOSSCarPlayRoadClass.allCases.flatMap {
          [palette.road($0).fill, palette.road($0).casing]
        }
      for color in quiet {
        XCTAssertLessThan(
          chroma(color), chroma(palette.route) * 35 / 100,
          String(format: "basemap colour %06X competes with the route", color))
      }
      XCTAssertGreaterThan(chroma(palette.route), 150)
      // Motorways are a little warmer than other roads, never yellow.
      let motorway = palette.motorway.fill
      XCTAssertGreaterThan(Int(motorway >> 16 & 0xFF), Int(motorway & 0xFF))
      XCTAssertGreaterThan(chroma(motorway), chroma(palette.minor.fill))
    }
  }
}
