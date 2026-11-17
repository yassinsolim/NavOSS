import Foundation

// MARK: - CarPlay basemap restyle
//
// CarPlay draws OpenFreeMap's hosted styles, or the offline styles built from the same OpenFreeMap
// release (infra/offline), and restyles them at runtime so the route is the only saturated thing
// on a small car display. Both use the OpenMapTiles schema, so a layer is recognised by its type,
// its source layer, and the road class its identifier names, not by a fixed list of identifiers.
// A layer nothing here recognises is left exactly as the style drew it.

public enum NavOSSCarPlayBasemapLayerType: Sendable {
  case background
  case fill
  case fillExtrusion
  case line
  case symbol
  case other
}

/// Road tiers the restyle distinguishes. Motorways and trunks read slightly warmer; everything
/// else is white (light) or a soft grey (dark).
public enum NavOSSCarPlayRoadClass: CaseIterable, Sendable {
  case motorway
  case major
  case secondary
  case minor
}

public enum NavOSSCarPlayBasemapRole: Equatable, Sendable {
  case land
  case water
  case waterway
  case greenery
  case building
  case aeroway
  case road(NavOSSCarPlayRoadClass, casing: Bool)
  case rail
  case boundary
  case roadLabel
  /// Route-number shields: the style's own artwork, spaced further apart.
  case roadShield
  case placeLabel
  case waterLabel
  /// Detail that only adds noise at driving zooms: land-use fills, building extrusions, footpaths,
  /// one-way arrows, road-area patterns and house numbers.
  case hidden
  /// Not recognised, or deliberately the style's own (POIs, road shields, rasters).
  case untouched
}

public func navOSSCarPlayBasemapRole(
  type: NavOSSCarPlayBasemapLayerType,
  identifier: String,
  sourceLayer: String?
) -> NavOSSCarPlayBasemapRole {
  if identifier.hasPrefix("navoss-") { return .untouched }
  if type == .background { return .land }
  if type == .fillExtrusion { return .hidden }
  let words = Set(
    identifier.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
  )
  func names(_ candidates: String...) -> Bool { candidates.contains(where: words.contains) }
  switch (sourceLayer, type) {
  case ("water", .fill): return .water
  case ("waterway", .line): return .waterway
  case ("waterway", .symbol), ("water_name", .symbol): return .waterLabel
  case ("park", .fill): return .greenery
  case ("park", .line): return .hidden
  case ("landcover", .fill), ("landuse", .fill):
    return names("park", "wood", "grass", "forest", "scrub", "meadow") ? .greenery : .hidden
  case ("building", .fill): return .building
  case ("aeroway", .fill), ("aeroway", .line): return .aeroway
  case ("transportation", .symbol), ("transportation", .fill), ("housenumber", .symbol):
    return .hidden
  case ("transportation", .line):
    if names("path", "pedestrian", "pier", "steps", "footway", "cycleway", "bridleway") {
      return .hidden
    }
    if names("rail", "railway", "transit", "hatching", "dashline") { return .rail }
    let roadClass: NavOSSCarPlayRoadClass =
      if names("motorway") {
        .motorway
      } else if names("trunk", "primary", "major") {
        .major
      } else if names("secondary", "tertiary", "link") {
        .secondary
      } else {
        .minor
      }
    return .road(roadClass, casing: names("casing"))
  case ("transportation_name", .symbol):
    if names("shield") { return .roadShield }
    return names("path", "pedestrian") ? .hidden : .roadLabel
  case ("boundary", .line): return .boundary
  case ("place", .symbol): return .placeLabel
  default: return .untouched
  }
}

/// sRGB colours as `0xRRGGBB`.
public struct NavOSSCarPlayMapPalette: Equatable, Sendable {
  public struct RoadColors: Equatable, Sendable {
    public let fill: UInt32
    public let casing: UInt32
  }

  public let land: UInt32
  public let water: UInt32
  public let greenery: UInt32
  public let building: UInt32
  public let aeroway: UInt32
  public let rail: UInt32
  public let boundary: UInt32
  public let motorway: RoadColors
  public let major: RoadColors
  public let secondary: RoadColors
  public let minor: RoadColors
  public let roadLabel: UInt32
  public let placeLabel: UInt32
  public let waterLabel: UInt32
  public let labelHalo: UInt32
  /// The selected route, its casing, the part already driven, and alternates in preview.
  public let route: UInt32
  public let routeCasing: UInt32
  public let travelledRoute: UInt32
  public let alternateRoute: UInt32
  public let alternateRouteCasing: UInt32

  public func road(_ roadClass: NavOSSCarPlayRoadClass) -> RoadColors {
    switch roadClass {
    case .motorway: motorway
    case .major: major
    case .secondary: secondary
    case .minor: minor
    }
  }

  /// The colour a role is painted, or `nil` for roles that are hidden or left to the style.
  public func color(for role: NavOSSCarPlayBasemapRole) -> UInt32? {
    switch role {
    case .land: land
    case .water, .waterway: water
    case .greenery: greenery
    case .building: building
    case .aeroway: aeroway
    case let .road(roadClass, casing): casing ? road(roadClass).casing : road(roadClass).fill
    case .rail: rail
    case .boundary: boundary
    case .roadLabel: roadLabel
    case .placeLabel: placeLabel
    case .waterLabel: waterLabel
    case .roadShield, .hidden, .untouched: nil
    }
  }

  public static let light = NavOSSCarPlayMapPalette(
    land: 0xEEF0EC, water: 0xBCD2E3, greenery: 0xDCE7D5, building: 0xE5E6E2, aeroway: 0xE7E8E4,
    rail: 0xD2D5D6, boundary: 0xC7CACE,
    motorway: RoadColors(fill: 0xF7E7C4, casing: 0xD9C59C),
    major: RoadColors(fill: 0xFFFFFF, casing: 0xB9C0C5),
    secondary: RoadColors(fill: 0xFFFFFF, casing: 0xC3C9CD),
    minor: RoadColors(fill: 0xFFFFFF, casing: 0xCDD2D5),
    roadLabel: 0x4F585D, placeLabel: 0x6A7276, waterLabel: 0x5F7F99, labelHalo: 0xFFFFFF,
    route: 0x2F7BF6, routeCasing: 0x1B4FB8, travelledRoute: 0xB3BAC0,
    alternateRoute: 0xA3B7D6, alternateRouteCasing: 0x7A90B2)

  public static let dark = NavOSSCarPlayMapPalette(
    land: 0x1C2427, water: 0x14212B, greenery: 0x1F2B27, building: 0x252E31, aeroway: 0x232C2F,
    rail: 0x343D41, boundary: 0x3D464A,
    motorway: RoadColors(fill: 0x5A5348, casing: 0x37332D),
    major: RoadColors(fill: 0x46525A, casing: 0x2C363B),
    secondary: RoadColors(fill: 0x3D484E, casing: 0x293236),
    minor: RoadColors(fill: 0x343E43, casing: 0x262E32),
    roadLabel: 0xBAC3C7, placeLabel: 0x98A2A6, waterLabel: 0x6F8799, labelHalo: 0x1C2427,
    route: 0x5B9BFF, routeCasing: 0x0B2A6B, travelledRoute: 0x4C565B,
    alternateRoute: 0x4D6283, alternateRouteCasing: 0x22324A)
}
