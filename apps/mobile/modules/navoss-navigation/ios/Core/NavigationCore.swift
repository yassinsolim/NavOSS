import Foundation

private let earthRadiusMeters = 6_371_000.0
private let metersPerDegreeLatitude = Double.pi * earthRadiusMeters / 180
private let arrivalConfirmationSampleCount = 2
private let arrivalDistanceThresholdMeters = 30.0
private let arrivalProgressThreshold = 0.98
private let backwardProgressPenaltyFactor = 0.5
private let continuityPenaltyFactor = 0.25
private let continuityToleranceMeters = 75.0
private let maximumCoursePenaltyMeters = 50.0
private let offRouteConfirmationSampleCount = 3
private let offRouteDistanceThresholdMeters = 35.0
private let onRouteRecoveryDistanceThresholdMeters = 20.0
private let onRouteRecoverySampleCount = 2

enum NavigationCoreError: Error, Equatable {
  case invalidCoordinate
  case invalidRoute
}

struct NavigationCoordinate: Equatable, Sendable {
  let latitude: Double
  let longitude: Double

  var isValid: Bool {
    latitude.isFinite && longitude.isFinite &&
      (-90...90).contains(latitude) && (-180...180).contains(longitude)
  }
}

struct NavigationLocationSample: Equatable, Sendable {
  let coordinate: NavigationCoordinate
  let courseDegrees: Double?
  let horizontalAccuracyMeters: Double?

  init(
    coordinate: NavigationCoordinate,
    courseDegrees: Double? = nil,
    horizontalAccuracyMeters: Double?
  ) {
    self.coordinate = coordinate
    self.courseDegrees = courseDegrees
    self.horizontalAccuracyMeters = horizontalAccuracyMeters
  }

  var isValid: Bool {
    guard coordinate.isValid else {
      return false
    }
    if let courseDegrees,
       (!courseDegrees.isFinite || !(0..<360).contains(courseDegrees)) {
      return false
    }
    guard let horizontalAccuracyMeters else {
      return true
    }
    return horizontalAccuracyMeters.isFinite && horizontalAccuracyMeters >= 0
  }
}

enum NavigationPhase: String, Sendable {
  case arrived
  case idle
  case tracking
}

struct NavigationSnapshot: Equatable, Sendable {
  let distanceFromRouteMeters: Double?
  let horizontalAccuracyMeters: Double?
  let isOffRoute: Bool
  let matchedCoordinate: NavigationCoordinate?
  let matchedCourseDegrees: Double?
  let phase: NavigationPhase
  let rawCoordinate: NavigationCoordinate?
  let routeProgress: Double
  let routeVersion: Int
  let sequence: Int
}

private struct RouteProjection {
  let coordinate: NavigationCoordinate
  let courseDegrees: Double
  let distanceMeters: Double
  let progress: Double
}

private struct RouteSegment {
  let cumulativeDistanceMeters: Double
  let courseDegrees: Double
  let end: NavigationCoordinate
  let lengthMeters: Double
  let start: NavigationCoordinate
}

private struct RoutePolyline {
  let destination: NavigationCoordinate
  let segments: [RouteSegment]
  let totalDistanceMeters: Double

  init(coordinates: [NavigationCoordinate]) throws {
    guard coordinates.count >= 2, coordinates.allSatisfy(\.isValid) else {
      throw NavigationCoreError.invalidRoute
    }

    var cumulativeDistanceMeters = 0.0
    var segments: [RouteSegment] = []

    for index in 0..<(coordinates.count - 1) {
      let start = coordinates[index]
      let end = coordinates[index + 1]
      let lengthMeters = Self.distanceMeters(from: start, to: end)

      if lengthMeters > 0 {
        segments.append(
          RouteSegment(
            cumulativeDistanceMeters: cumulativeDistanceMeters,
            courseDegrees: Self.courseDegrees(from: start, to: end),
            end: end,
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

    self.destination = coordinates[coordinates.count - 1]
    self.segments = segments
    self.totalDistanceMeters = cumulativeDistanceMeters
  }

  func distanceToDestination(from coordinate: NavigationCoordinate) -> Double {
    Self.distanceMeters(from: coordinate, to: destination)
  }

  func project(
    _ coordinate: NavigationCoordinate,
    courseDegrees: Double?,
    previousProgress: Double?
  ) -> RouteProjection {
    let longitudeScale = cos(coordinate.latitude * .pi / 180)
    var nearestProjection: RouteProjection?
    var nearestScore = Double.infinity

    for segment in segments {
      let startX = (segment.start.longitude - coordinate.longitude) *
        metersPerDegreeLatitude * longitudeScale
      let startY = (segment.start.latitude - coordinate.latitude) * metersPerDegreeLatitude
      let segmentX = (segment.end.longitude - segment.start.longitude) *
        metersPerDegreeLatitude * longitudeScale
      let segmentY = (segment.end.latitude - segment.start.latitude) * metersPerDegreeLatitude
      let segmentLengthSquared = segmentX * segmentX + segmentY * segmentY
      let segmentProgress = segmentLengthSquared == 0
        ? 0
        : max(0, min(1, -(startX * segmentX + startY * segmentY) / segmentLengthSquared))
      let projectedX = startX + segmentX * segmentProgress
      let projectedY = startY + segmentY * segmentProgress
      let distanceMeters = hypot(projectedX, projectedY)
      let matchedCoordinate = NavigationCoordinate(
        latitude: segment.start.latitude +
          (segment.end.latitude - segment.start.latitude) * segmentProgress,
        longitude: segment.start.longitude +
          (segment.end.longitude - segment.start.longitude) * segmentProgress
      )
      let progress = (
        segment.cumulativeDistanceMeters + segment.lengthMeters * segmentProgress
      ) / totalDistanceMeters
      let projection = RouteProjection(
        coordinate: matchedCoordinate,
        courseDegrees: segment.courseDegrees,
        distanceMeters: distanceMeters,
        progress: max(0, min(1, progress))
      )
      let coursePenalty = courseDegrees.map { courseDegrees in
        Self.courseDifferenceDegrees(courseDegrees, segment.courseDegrees) / 180 *
          maximumCoursePenaltyMeters
      } ?? 0
      let continuityPenalty = previousProgress.map { previousProgress in
        let progressDeltaMeters = abs(projection.progress - previousProgress) *
          totalDistanceMeters
        let backwardProgressMeters = max(
          0,
          (previousProgress - projection.progress) * totalDistanceMeters
        )
        return max(0, progressDeltaMeters - continuityToleranceMeters) *
          continuityPenaltyFactor +
          max(0, backwardProgressMeters - continuityToleranceMeters) *
          backwardProgressPenaltyFactor
      } ?? 0
      let score = distanceMeters + coursePenalty + continuityPenalty

      if score < nearestScore {
        nearestProjection = projection
        nearestScore = score
      }
    }

    return nearestProjection!
  }

  private static func courseDegrees(
    from origin: NavigationCoordinate,
    to destination: NavigationCoordinate
  ) -> Double {
    let latitudeDelta = destination.latitude - origin.latitude
    let meanLatitude = (origin.latitude + destination.latitude) / 2 * .pi / 180
    let longitudeDelta = (destination.longitude - origin.longitude) * cos(meanLatitude)
    let degrees = atan2(longitudeDelta, latitudeDelta) * 180 / .pi
    return degrees >= 0 ? degrees : degrees + 360
  }

  private static func courseDifferenceDegrees(_ first: Double, _ second: Double) -> Double {
    let difference = abs(first - second).truncatingRemainder(dividingBy: 360)
    return min(difference, 360 - difference)
  }

  private static func distanceMeters(
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

    return 2 * earthRadiusMeters * asin(sqrt(haversine))
  }
}

final class NavigationCore {
  private var arrivalSampleCount = 0
  private var departureSampleCount = 0
  private var hasArrived = false
  private var isOffRoute = false
  private var recoverySampleCount = 0
  private var route: RoutePolyline?
  private var routeVersion = 0
  private var sequence = 0
  private var snapshot: NavigationSnapshot

  init() {
    snapshot = NavigationSnapshot(
      distanceFromRouteMeters: nil,
      horizontalAccuracyMeters: nil,
      isOffRoute: false,
      matchedCoordinate: nil,
      matchedCourseDegrees: nil,
      phase: .idle,
      rawCoordinate: nil,
      routeProgress: 0,
      routeVersion: 0,
      sequence: 0
    )
  }

  func currentSnapshot() -> NavigationSnapshot {
    snapshot
  }

  @discardableResult
  func setRoute(_ coordinates: [NavigationCoordinate]) throws -> NavigationSnapshot {
    route = try RoutePolyline(coordinates: coordinates)
    arrivalSampleCount = 0
    departureSampleCount = 0
    hasArrived = false
    isOffRoute = false
    recoverySampleCount = 0
    routeVersion += 1
    sequence += 1
    snapshot = NavigationSnapshot(
      distanceFromRouteMeters: nil,
      horizontalAccuracyMeters: nil,
      isOffRoute: false,
      matchedCoordinate: nil,
      matchedCourseDegrees: nil,
      phase: .tracking,
      rawCoordinate: nil,
      routeProgress: 0,
      routeVersion: routeVersion,
      sequence: sequence
    )
    return snapshot
  }

  @discardableResult
  func clearRoute() -> NavigationSnapshot {
    arrivalSampleCount = 0
    departureSampleCount = 0
    hasArrived = false
    isOffRoute = false
    recoverySampleCount = 0
    route = nil
    routeVersion += 1
    sequence += 1
    snapshot = NavigationSnapshot(
      distanceFromRouteMeters: nil,
      horizontalAccuracyMeters: nil,
      isOffRoute: false,
      matchedCoordinate: nil,
      matchedCourseDegrees: nil,
      phase: .idle,
      rawCoordinate: nil,
      routeProgress: 0,
      routeVersion: routeVersion,
      sequence: sequence
    )
    return snapshot
  }

  @discardableResult
  func updateLocation(_ coordinate: NavigationCoordinate) throws -> NavigationSnapshot {
    try updateLocation(
      NavigationLocationSample(coordinate: coordinate, horizontalAccuracyMeters: nil)
    )
  }

  @discardableResult
  func updateLocation(_ sample: NavigationLocationSample) throws -> NavigationSnapshot {
    guard sample.isValid else {
      throw NavigationCoreError.invalidCoordinate
    }

    sequence += 1
    guard let route else {
      snapshot = NavigationSnapshot(
        distanceFromRouteMeters: nil,
        horizontalAccuracyMeters: sample.horizontalAccuracyMeters,
        isOffRoute: false,
        matchedCoordinate: nil,
        matchedCourseDegrees: nil,
        phase: .idle,
        rawCoordinate: sample.coordinate,
        routeProgress: 0,
        routeVersion: routeVersion,
        sequence: sequence
      )
      return snapshot
    }

    let projection = route.project(
      sample.coordinate,
      courseDegrees: sample.courseDegrees,
      previousProgress: snapshot.rawCoordinate == nil ? nil : snapshot.routeProgress
    )

    if hasArrived {
      snapshot = NavigationSnapshot(
        distanceFromRouteMeters: projection.distanceMeters,
        horizontalAccuracyMeters: sample.horizontalAccuracyMeters,
        isOffRoute: false,
        matchedCoordinate: route.destination,
        matchedCourseDegrees: projection.courseDegrees,
        phase: .arrived,
        rawCoordinate: sample.coordinate,
        routeProgress: 1,
        routeVersion: routeVersion,
        sequence: sequence
      )
      return snapshot
    }

    let accuracyAllowanceMeters = sample.horizontalAccuracyMeters ?? 0
    let isDepartureSample = projection.distanceMeters >
      offRouteDistanceThresholdMeters + accuracyAllowanceMeters
    let isRecoverySample = projection.distanceMeters + accuracyAllowanceMeters <=
      onRouteRecoveryDistanceThresholdMeters

    if isOffRoute {
      departureSampleCount = 0
      recoverySampleCount = isRecoverySample ? recoverySampleCount + 1 : 0
      if recoverySampleCount >= onRouteRecoverySampleCount {
        isOffRoute = false
        recoverySampleCount = 0
      }
    } else {
      recoverySampleCount = 0
      departureSampleCount = isDepartureSample ? departureSampleCount + 1 : 0
      if departureSampleCount >= offRouteConfirmationSampleCount {
        departureSampleCount = 0
        isOffRoute = true
      }
    }

    let isArrivalSample = !isOffRoute &&
      projection.progress >= arrivalProgressThreshold &&
      sample.horizontalAccuracyMeters != nil &&
      route.distanceToDestination(from: sample.coordinate) + accuracyAllowanceMeters <=
      arrivalDistanceThresholdMeters
    arrivalSampleCount = isArrivalSample ? arrivalSampleCount + 1 : 0

    if arrivalSampleCount >= arrivalConfirmationSampleCount {
      arrivalSampleCount = 0
      departureSampleCount = 0
      hasArrived = true
      isOffRoute = false
      recoverySampleCount = 0
      snapshot = NavigationSnapshot(
        distanceFromRouteMeters: projection.distanceMeters,
        horizontalAccuracyMeters: sample.horizontalAccuracyMeters,
        isOffRoute: false,
        matchedCoordinate: route.destination,
        matchedCourseDegrees: projection.courseDegrees,
        phase: .arrived,
        rawCoordinate: sample.coordinate,
        routeProgress: 1,
        routeVersion: routeVersion,
        sequence: sequence
      )
      return snapshot
    }

    let shouldAcceptProjection = !isOffRoute && !isDepartureSample
    let previousMatchedCoordinate = snapshot.matchedCoordinate
    let previousMatchedCourseDegrees = snapshot.matchedCourseDegrees
    let provisionalMatchedCoordinate = previousMatchedCoordinate ?? projection.coordinate
    let provisionalMatchedCourseDegrees = previousMatchedCourseDegrees ?? projection.courseDegrees
    let provisionalRouteProgress = previousMatchedCoordinate == nil
      ? projection.progress
      : snapshot.routeProgress
    snapshot = NavigationSnapshot(
      distanceFromRouteMeters: projection.distanceMeters,
      horizontalAccuracyMeters: sample.horizontalAccuracyMeters,
      isOffRoute: isOffRoute,
      matchedCoordinate: shouldAcceptProjection
        ? projection.coordinate
        : isOffRoute ? nil : provisionalMatchedCoordinate,
      matchedCourseDegrees: shouldAcceptProjection
        ? projection.courseDegrees
        : isOffRoute ? nil : provisionalMatchedCourseDegrees,
      phase: .tracking,
      rawCoordinate: sample.coordinate,
      routeProgress: shouldAcceptProjection
        ? projection.progress
        : isOffRoute ? snapshot.routeProgress : provisionalRouteProgress,
      routeVersion: routeVersion,
      sequence: sequence
    )
    return snapshot
  }
}