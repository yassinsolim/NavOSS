import Foundation

@testable import NavOSSNavigationCore

/// Synthetic, recorded-style drive traces in a local metre frame around Calgary.
///
/// `x` grows east and `y` north from the origin. Traces are generated deterministically so a
/// failure reproduces exactly.
enum NavigationTrace {
  static let originLatitude = 51.04
  static let originLongitude = -114.08
  static let metersPerDegreeLatitude = Double.pi * 6_371_000 / 180

  static func coordinate(_ x: Double, _ y: Double) -> NavigationCoordinate {
    NavigationCoordinate(
      latitude: originLatitude + y / metersPerDegreeLatitude,
      longitude: originLongitude
        + x / (metersPerDegreeLatitude * cos(originLatitude * .pi / 180))
    )
  }

  static func local(_ coordinate: NavigationCoordinate) -> (x: Double, y: Double) {
    (
      (coordinate.longitude - originLongitude)
        * metersPerDegreeLatitude * cos(originLatitude * .pi / 180),
      (coordinate.latitude - originLatitude) * metersPerDegreeLatitude
    )
  }

  /// Polyline corners densified to vertices every `spacing` metres, like routing output.
  static func route(_ corners: [(Double, Double)], spacing: Double = 20) -> [NavigationCoordinate] {
    var result = [coordinate(corners[0].0, corners[0].1)]
    for (start, end) in zip(corners, corners.dropFirst()) {
      let length = hypot(end.0 - start.0, end.1 - start.1)
      let count = max(1, Int((length / spacing).rounded(.up)))
      for step in 1...count {
        let fraction = Double(step) / Double(count)
        result.append(
          coordinate(start.0 + (end.0 - start.0) * fraction, start.1 + (end.1 - start.1) * fraction)
        )
      }
    }
    return result
  }

  struct Position {
    let x: Double
    let y: Double
    let courseDegrees: Double
    /// Distance driven along the path to this position.
    let alongMeters: Double
  }

  /// Positions every `stepMeters` along a corner path.
  static func positions(along corners: [(Double, Double)], every stepMeters: Double) -> [Position] {
    var positions: [Position] = []
    var travelled = 0.0
    var nextSample = 0.0
    for (start, end) in zip(corners, corners.dropFirst()) {
      let length = hypot(end.0 - start.0, end.1 - start.1)
      guard length > 0 else { continue }
      let course = (atan2(end.0 - start.0, end.1 - start.1) * 180 / .pi + 360)
        .truncatingRemainder(dividingBy: 360)
      while nextSample <= travelled + length {
        let fraction = (nextSample - travelled) / length
        positions.append(
          Position(
            x: start.0 + (end.0 - start.0) * fraction,
            y: start.1 + (end.1 - start.1) * fraction,
            courseDegrees: course,
            alongMeters: nextSample
          )
        )
        nextSample += stepMeters
      }
      travelled += length
    }
    return positions
  }

  /// Deterministic noise in `-amplitude...amplitude`.
  struct Noise {
    private var state: UInt64

    init(seed: UInt64) {
      state = seed
    }

    mutating func next(amplitude: Double) -> Double {
      state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
      let unit = Double(state >> 11) / Double(1 << 53)
      return (unit * 2 - 1) * amplitude
    }
  }

  static func sample(
    x: Double,
    y: Double,
    courseDegrees: Double? = nil,
    accuracy: Double = 5,
    speed: Double? = nil,
    time: TimeInterval? = nil
  ) -> NavigationLocationSample {
    NavigationLocationSample(
      coordinate: coordinate(x, y),
      courseDegrees: courseDegrees,
      horizontalAccuracyMeters: accuracy,
      speedMetersPerSecond: speed,
      timestamp: time.map { 800_000_000 + $0 }
    )
  }

  static func time(_ seconds: TimeInterval) -> TimeInterval {
    800_000_000 + seconds
  }
}
