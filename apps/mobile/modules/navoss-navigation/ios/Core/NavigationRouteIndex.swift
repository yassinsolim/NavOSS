import Foundation

let navigationEarthRadiusMeters = 6_371_000.0
let navigationMetersPerDegreeLatitude = Double.pi * navigationEarthRadiusMeters / 180

func navigationDistanceMeters(
  from origin: NavigationCoordinate,
  to destination: NavigationCoordinate
) -> Double {
  let latitudeDelta = (destination.latitude - origin.latitude) * .pi / 180
  let longitudeDelta = (destination.longitude - origin.longitude) * .pi / 180
  let originLatitude = origin.latitude * .pi / 180
  let destinationLatitude = destination.latitude * .pi / 180
  let haversine = sin(latitudeDelta / 2) * sin(latitudeDelta / 2) +
    cos(originLatitude) * cos(destinationLatitude) *
    sin(longitudeDelta / 2) * sin(longitudeDelta / 2)

  return 2 * navigationEarthRadiusMeters * asin(sqrt(haversine))
}

func navigationCourseDegrees(
  from origin: NavigationCoordinate,
  to destination: NavigationCoordinate
) -> Double {
  let latitudeDelta = destination.latitude - origin.latitude
  let meanLatitude = (origin.latitude + destination.latitude) / 2 * .pi / 180
  let longitudeDelta = (destination.longitude - origin.longitude) * cos(meanLatitude)
  let degrees = atan2(longitudeDelta, latitudeDelta) * 180 / .pi
  return degrees >= 0 ? degrees : degrees + 360
}

func navigationCourseDifferenceDegrees(_ first: Double, _ second: Double) -> Double {
  let difference = abs(first - second).truncatingRemainder(dividingBy: 360)
  return min(difference, 360 - difference)
}

struct RouteProjection: Equatable {
  /// Distance from the route origin to the projected point, in metres along the route.
  let alongMeters: Double
  let coordinate: NavigationCoordinate
  let courseDegrees: Double
  let distanceMeters: Double
  /// Index of the segment in the caller's original geometry (`speedLimitsKph` is aligned to it).
  let geometrySegmentIndex: Int
  let progress: Double
}

struct RouteSegment {
  let cumulativeDistanceMeters: Double
  let courseDegrees: Double
  let end: NavigationCoordinate
  let geometrySegmentIndex: Int
  let lengthMeters: Double
  let start: NavigationCoordinate
}

/// Route geometry with a uniform spatial grid over its segments.
///
/// Matching used to score every segment on every fix, so its cost grew with route length. Each
/// fix now evaluates either a window of road around the previous match (bounded in metres, so in
/// segment count for any realistic geometry density) or the grid cells around the fix. Neither
/// depends on how long the route is.
struct RoutePolyline {
  static let gridCellMeters = 200.0

  let destination: NavigationCoordinate
  let segments: [RouteSegment]
  let totalDistanceMeters: Double

  private let grid: [Int64: [Int32]]
  private let originLatitude: Double
  private let originLongitude: Double
  private let metersPerDegreeLongitude: Double

  init(coordinates: [NavigationCoordinate]) throws {
    guard coordinates.count >= 2, coordinates.allSatisfy(\.isValid) else {
      throw NavigationCoreError.invalidRoute
    }

    var cumulativeDistanceMeters = 0.0
    var segments: [RouteSegment] = []
    segments.reserveCapacity(coordinates.count - 1)

    for index in 0..<(coordinates.count - 1) {
      let start = coordinates[index]
      let end = coordinates[index + 1]
      let lengthMeters = navigationDistanceMeters(from: start, to: end)

      if lengthMeters > 0 {
        segments.append(
          RouteSegment(
            cumulativeDistanceMeters: cumulativeDistanceMeters,
            courseDegrees: navigationCourseDegrees(from: start, to: end),
            end: end,
            geometrySegmentIndex: index,
            lengthMeters: lengthMeters,
            start: start
          )
        )
        cumulativeDistanceMeters += lengthMeters
      }
    }

    guard !segments.isEmpty, cumulativeDistanceMeters.isFinite else {
      throw NavigationCoreError.invalidRoute
    }

    let originLatitude = coordinates[0].latitude
    let originLongitude = coordinates[0].longitude
    let metersPerDegreeLongitude =
      navigationMetersPerDegreeLatitude * cos(originLatitude * .pi / 180)
    var grid: [Int64: [Int32]] = [:]
    for (segmentIndex, segment) in segments.enumerated() {
      let startX = (segment.start.longitude - originLongitude) * metersPerDegreeLongitude
      let startY = (segment.start.latitude - originLatitude) * navigationMetersPerDegreeLatitude
      let endX = (segment.end.longitude - originLongitude) * metersPerDegreeLongitude
      let endY = (segment.end.latitude - originLatitude) * navigationMetersPerDegreeLatitude
      // Sampling every half cell guarantees that any cell the segment crosses is adjacent to a
      // sampled cell; queries widen by one cell to cover that.
      let sampleCount = max(1, Int(ceil(segment.lengthMeters / (Self.gridCellMeters / 2))))
      var lastKey: Int64?
      for sample in 0...sampleCount {
        let fraction = Double(sample) / Double(sampleCount)
        let key = Self.cellKey(
          x: Self.cell(startX + (endX - startX) * fraction),
          y: Self.cell(startY + (endY - startY) * fraction)
        )
        guard key != lastKey else { continue }
        lastKey = key
        if grid[key]?.last != Int32(segmentIndex) {
          grid[key, default: []].append(Int32(segmentIndex))
        }
      }
    }

    self.destination = coordinates[coordinates.count - 1]
    self.segments = segments
    self.totalDistanceMeters = cumulativeDistanceMeters
    self.grid = grid
    self.originLatitude = originLatitude
    self.originLongitude = originLongitude
    self.metersPerDegreeLongitude = metersPerDegreeLongitude
  }

  func distanceToDestination(from coordinate: NavigationCoordinate) -> Double {
    navigationDistanceMeters(from: coordinate, to: destination)
  }

  /// Indices of the segments overlapping `[fromMeters, toMeters]` along the route.
  func segmentRange(fromMeters: Double, toMeters: Double) -> ClosedRange<Int> {
    let first = segmentIndex(containingAlong: max(0, fromMeters))
    let last = segmentIndex(containingAlong: min(totalDistanceMeters, toMeters))
    return first...max(first, last)
  }

  /// Segment indices with any part inside the square of `radiusMeters` around `coordinate`.
  func segmentIndices(near coordinate: NavigationCoordinate, radiusMeters: Double) -> [Int] {
    let x = (coordinate.longitude - originLongitude) * metersPerDegreeLongitude
    let y = (coordinate.latitude - originLatitude) * navigationMetersPerDegreeLatitude
    let minimumX = Self.cell(x - radiusMeters) - 1
    let maximumX = Self.cell(x + radiusMeters) + 1
    let minimumY = Self.cell(y - radiusMeters) - 1
    let maximumY = Self.cell(y + radiusMeters) + 1
    var indices: [Int] = []
    for cellX in minimumX...maximumX {
      for cellY in minimumY...maximumY {
        if let bucket = grid[Self.cellKey(x: cellX, y: cellY)] {
          for index in bucket {
            indices.append(Int(index))
          }
        }
      }
    }
    indices.sort()
    var unique = 0
    for index in indices.indices where unique == 0 || indices[index] != indices[unique - 1] {
      indices[unique] = indices[index]
      unique += 1
    }
    indices.removeSubrange(unique...)
    return indices
  }

  func project(_ coordinate: NavigationCoordinate, ontoSegment index: Int) -> RouteProjection {
    let segment = segments[index]
    let longitudeScale = cos(coordinate.latitude * .pi / 180)
    let startX = (segment.start.longitude - coordinate.longitude) *
      navigationMetersPerDegreeLatitude * longitudeScale
    let startY = (segment.start.latitude - coordinate.latitude) * navigationMetersPerDegreeLatitude
    let segmentX = (segment.end.longitude - segment.start.longitude) *
      navigationMetersPerDegreeLatitude * longitudeScale
    let segmentY = (segment.end.latitude - segment.start.latitude) *
      navigationMetersPerDegreeLatitude
    let segmentLengthSquared = segmentX * segmentX + segmentY * segmentY
    let segmentProgress = segmentLengthSquared == 0
      ? 0
      : max(0, min(1, -(startX * segmentX + startY * segmentY) / segmentLengthSquared))
    let projectedX = startX + segmentX * segmentProgress
    let projectedY = startY + segmentY * segmentProgress
    let alongMeters = segment.cumulativeDistanceMeters + segment.lengthMeters * segmentProgress
    return RouteProjection(
      alongMeters: alongMeters,
      coordinate: NavigationCoordinate(
        latitude: segment.start.latitude +
          (segment.end.latitude - segment.start.latitude) * segmentProgress,
        longitude: segment.start.longitude +
          (segment.end.longitude - segment.start.longitude) * segmentProgress
      ),
      courseDegrees: segment.courseDegrees,
      distanceMeters: hypot(projectedX, projectedY),
      geometrySegmentIndex: segment.geometrySegmentIndex,
      progress: max(0, min(1, alongMeters / totalDistanceMeters))
    )
  }

  /// The on-route point `alongMeters` from the origin, clamped to the route.
  func point(alongMeters: Double) -> RouteProjection {
    let clamped = max(0, min(totalDistanceMeters, alongMeters))
    let index = segmentIndex(containingAlong: clamped)
    let segment = segments[index]
    let fraction = max(
      0,
      min(1, (clamped - segment.cumulativeDistanceMeters) / segment.lengthMeters)
    )
    return RouteProjection(
      alongMeters: clamped,
      coordinate: NavigationCoordinate(
        latitude: segment.start.latitude +
          (segment.end.latitude - segment.start.latitude) * fraction,
        longitude: segment.start.longitude +
          (segment.end.longitude - segment.start.longitude) * fraction
      ),
      courseDegrees: segment.courseDegrees,
      distanceMeters: 0,
      geometrySegmentIndex: segment.geometrySegmentIndex,
      progress: clamped / totalDistanceMeters
    )
  }

  private func segmentIndex(containingAlong alongMeters: Double) -> Int {
    var low = 0
    var high = segments.count - 1
    while low < high {
      let middle = (low + high + 1) / 2
      if segments[middle].cumulativeDistanceMeters <= alongMeters {
        low = middle
      } else {
        high = middle - 1
      }
    }
    return low
  }

  private static func cell(_ meters: Double) -> Int {
    Int(floor(meters / gridCellMeters))
  }

  private static func cellKey(x: Int, y: Int) -> Int64 {
    (Int64(x) << 32) | Int64(UInt32(truncatingIfNeeded: y))
  }
}
