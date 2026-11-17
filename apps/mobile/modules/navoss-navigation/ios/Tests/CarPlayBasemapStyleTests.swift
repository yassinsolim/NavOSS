import Foundation
import XCTest

@testable import NavOSSNavigationCore

/// The restyle is checked against the real layer lists of OpenFreeMap's hosted `liberty` and
/// `dark` styles (fetched 2026-11-17), which the offline styles are built from.
final class CarPlayBasemapStyleTests: XCTestCase {
  private struct Layer: Decodable {
    let id: String
    let type: String
    let sourceLayer: String?
  }

  private struct Fixture: Decodable {
    let styles: [String: [Layer]]
  }

  private func styles() throws -> [String: [Layer]] {
    let url = try XCTUnwrap(
      Bundle.module.url(
        forResource: "openfreemap-style-layers", withExtension: "json", subdirectory: "Fixtures"))
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

  func testEveryRoadLineInTheHostedStylesIsRestyled() throws {
    for (name, layers) in try styles() {
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
