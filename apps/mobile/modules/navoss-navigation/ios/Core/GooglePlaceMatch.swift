import Foundation

/// Geometry for finding the selected place on Google without reading Google's content.
///
/// Google's Place Details callback carries no display name, so NavOSS cannot compare names itself.
/// Instead Google resolves the selected place's name to a place ID with a text search restricted to
/// a small box around the selected coordinate, and the place Google then loads must lie within
/// `maximumDistanceMeters` of that coordinate. Only the place ID and its coordinate are used.
public enum NavOSSGooglePlaceMatch {
  /// Half the side of the search box, and the furthest Google's place may be from the selected
  /// coordinate. Large venues (parks, malls, stadiums) can have their OpenStreetMap point and
  /// Google's pin well apart; 200 m keeps those while excluding the next block's branch.
  public static let maximumDistanceMeters: Double = 200

  public struct Bounds: Equatable {
    public let north: Double
    public let south: Double
    public let east: Double
    public let west: Double
  }

  /// The search box: `maximumDistanceMeters` north, south, east and west of the coordinate.
  /// Nil for an invalid coordinate or one too close to a pole for a longitude span.
  public static func searchBounds(latitude: Double, longitude: Double) -> Bounds? {
    guard
      latitude.isFinite, longitude.isFinite, abs(latitude) < 89, abs(longitude) <= 180
    else {
      return nil
    }
    let metersPerDegreeLatitude = 111_320.0
    let latitudeSpan = maximumDistanceMeters / metersPerDegreeLatitude
    let longitudeSpan =
      maximumDistanceMeters / (metersPerDegreeLatitude * cos(latitude * Double.pi / 180))
    return Bounds(
      north: latitude + latitudeSpan,
      south: latitude - latitudeSpan,
      east: longitude + longitudeSpan,
      west: longitude - longitudeSpan
    )
  }

  /// True when Google's place lies within `maximumDistanceMeters` of the selected coordinate.
  public static func isNearby(
    selectedLatitude: Double,
    selectedLongitude: Double,
    candidateLatitude: Double,
    candidateLongitude: Double
  ) -> Bool {
    let distance = distanceMeters(
      fromLatitude: selectedLatitude,
      fromLongitude: selectedLongitude,
      toLatitude: candidateLatitude,
      toLongitude: candidateLongitude
    )
    return distance.isFinite && distance <= maximumDistanceMeters
  }

  static func distanceMeters(
    fromLatitude: Double,
    fromLongitude: Double,
    toLatitude: Double,
    toLongitude: Double
  ) -> Double {
    let radius = 6_371_000.0
    let toRadians = Double.pi / 180
    let latitudeDelta = (toLatitude - fromLatitude) * toRadians
    let longitudeDelta = (toLongitude - fromLongitude) * toRadians
    let haversine =
      pow(sin(latitudeDelta / 2), 2)
      + cos(fromLatitude * toRadians) * cos(toLatitude * toRadians)
      * pow(sin(longitudeDelta / 2), 2)
    return 2 * radius * asin(min(1, sqrt(haversine)))
  }
}
