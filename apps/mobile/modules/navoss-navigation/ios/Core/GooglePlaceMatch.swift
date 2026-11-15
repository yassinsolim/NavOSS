import Foundation

/// The only check NavOSS can make on Google's automatic place panel. Google's Place Details
/// component, queried by the selected coordinate, reports the place it chose but no name, so the
/// panel is shown only when that place's own coordinate is within `maximumDistanceMeters` of the
/// selection. Only that coordinate is read.
public enum NavOSSGooglePlaceMatch {
  /// Measured on the simulator with the production key (2026-11-15): Google's listing was 2 m from
  /// the selection for Model Milk and Calgary Tower (the same business), and 8 m for Calgary
  /// Central Library, where it was a different tenant ("Toast Of The Town Club"). Distance cannot
  /// tell tenants of one building apart, so the panel is labelled as Google's nearest listing and
  /// "Find this place on Google" lets the driver pick the right one. 30 m allows for the gap
  /// between an OpenStreetMap point and Google's pin for the same storefront while keeping a
  /// listing across the street or on the next lot from opening automatically.
  public static let maximumDistanceMeters: Double = 30

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
