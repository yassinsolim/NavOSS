import Foundation

/// A fixed intersection safety camera from `/v1/cameras`.
public struct NavOSSSafetyCamera: Equatable, Sendable {
  public enum Direction: String, Sendable {
    case eastbound
    case northbound
    case southbound
    case westbound

    var bearingDegrees: Double {
      switch self {
      case .northbound: 0
      case .eastbound: 90
      case .southbound: 180
      case .westbound: 270
      }
    }
  }

  public let id: String
  public let latitude: Double
  public let longitude: Double
  public let direction: Direction
  public let location: String

  public init(
    id: String,
    latitude: Double,
    longitude: Double,
    direction: Direction,
    location: String
  ) {
    self.id = id
    self.latitude = latitude
    self.longitude = longitude
    self.direction = direction
    self.location = location
  }

  var coordinate: NavigationCoordinate {
    NavigationCoordinate(latitude: latitude, longitude: longitude)
  }
}

/// Cameras are refreshed at most this often; the source updates monthly.
let navigationSafetyCameraRefreshSeconds: TimeInterval = 6 * 60 * 60
/// A failed camera fetch is retried this often while a trip is active, so a trip started
/// offline gains alerts once connectivity returns.
let navigationSafetyCameraRetrySeconds: TimeInterval = 60

/// Whether to fetch cameras now. Called at trip start and on every navigation clock tick; the
/// gates keep that to one request per retry interval.
func navigationShouldFetchSafetyCameras(
  fetchedAt: TimeInterval?,
  attemptedAt: TimeInterval?,
  isFetching: Bool,
  now: TimeInterval
) -> Bool {
  guard !isFetching else { return false }
  if let fetchedAt, now - fetchedAt < navigationSafetyCameraRefreshSeconds { return false }
  if let attemptedAt, now - attemptedAt < navigationSafetyCameraRetrySeconds { return false }
  return true
}

/// The camera alert the driver was given, while that camera is still ahead.
struct NavigationSafetyCameraAlert: Equatable, Sendable {
  let cameraId: String
  let distanceAheadMeters: Double
  let location: String
  /// Increases with every new alert this process, so a presenter can tell a new alert from an
  /// update to the same one.
  let sequence: Int
}

/// Lookahead for an alert, matching the camera's approach rather than its line-of-sight.
let navigationSafetyCameraAlertDistanceMeters = 450.0
/// Lateral allowance between the route centreline and a roadside camera.
let navigationSafetyCameraMaximumRouteOffsetMeters = 45.0
/// A camera enforces one approach; the route must head within this of that direction.
let navigationSafetyCameraMaximumDirectionDeltaDegrees = 60.0

/// Every place along a route where a camera sits beside it, precomputed once per route so the
/// per-fix check is a binary search over a short list instead of a camera × segment scan.
struct NavigationSafetyCameraIndex {
  struct Approach: Equatable {
    let alongMeters: Double
    let cameraIndex: Int
    let courseDegrees: Double
    let offsetMeters: Double
  }

  let cameras: [NavOSSSafetyCamera]
  /// Sorted by `alongMeters`.
  let approaches: [Approach]

  init(cameras: [NavOSSSafetyCamera], route: RoutePolyline) {
    self.cameras = cameras
    var approaches: [Approach] = []
    for (cameraIndex, camera) in cameras.enumerated() where camera.coordinate.isValid {
      for segmentIndex in route.segmentIndices(
        near: camera.coordinate,
        radiusMeters: navigationSafetyCameraMaximumRouteOffsetMeters
      ) {
        guard let approach = Self.approach(
          of: camera.coordinate,
          onto: route.segments[segmentIndex]
        ), approach.offsetMeters <= navigationSafetyCameraMaximumRouteOffsetMeters
        else {
          continue
        }
        approaches.append(
          Approach(
            alongMeters: approach.alongMeters,
            cameraIndex: cameraIndex,
            courseDegrees: route.segments[segmentIndex].courseDegrees,
            offsetMeters: approach.offsetMeters
          )
        )
      }
    }
    self.approaches = approaches.sorted { $0.alongMeters < $1.alongMeters }
  }

  init(cameras: [NavOSSSafetyCamera], routeGeometry: [NavigationCoordinate]) throws {
    self.init(cameras: cameras, route: try RoutePolyline(coordinates: routeGeometry))
  }

  /// The nearest camera ahead whose closest approach within the lookahead is beside the route
  /// and faces the route's direction of travel there.
  ///
  /// The closest approach is chosen before the direction test, so a farther, aligned leg of the
  /// route can never vouch for a camera that physically sits on a nearer cross street.
  func upcoming(
    afterAlongMeters currentAlongMeters: Double,
    excluding announcedIds: Set<String>
  ) -> (camera: NavOSSSafetyCamera, distanceAheadMeters: Double)? {
    var low = 0
    var high = approaches.count
    while low < high {
      let middle = (low + high) / 2
      if approaches[middle].alongMeters <= currentAlongMeters {
        low = middle + 1
      } else {
        high = middle
      }
    }
    var closestByCamera: [Int: Approach] = [:]
    var index = low
    while index < approaches.count,
      approaches[index].alongMeters - currentAlongMeters
        <= navigationSafetyCameraAlertDistanceMeters
    {
      let approach = approaches[index]
      if !announcedIds.contains(cameras[approach.cameraIndex].id),
        closestByCamera[approach.cameraIndex].map({ approach.offsetMeters < $0.offsetMeters })
          ?? true
      {
        closestByCamera[approach.cameraIndex] = approach
      }
      index += 1
    }
    var best: (camera: NavOSSSafetyCamera, distanceAheadMeters: Double)?
    for (cameraIndex, approach) in closestByCamera {
      let camera = cameras[cameraIndex]
      guard navigationCourseDifferenceDegrees(
        camera.direction.bearingDegrees,
        approach.courseDegrees
      ) <= navigationSafetyCameraMaximumDirectionDeltaDegrees
      else {
        continue
      }
      let distanceAhead = approach.alongMeters - currentAlongMeters
      if best.map({ distanceAhead < $0.distanceAheadMeters }) ?? true {
        best = (camera, distanceAhead)
      }
    }
    return best
  }

  /// Projection of `coordinate` onto `segment` without clamping to it. A camera projecting
  /// before or past a segment does not sit beside that segment; a shared vertex belongs to the
  /// incoming segment, not to the road turned onto.
  private static func approach(
    of coordinate: NavigationCoordinate,
    onto segment: RouteSegment
  ) -> (alongMeters: Double, offsetMeters: Double)? {
    let longitudeScale = cos(coordinate.latitude * .pi / 180)
    let startX = (segment.start.longitude - coordinate.longitude)
      * navigationMetersPerDegreeLatitude * longitudeScale
    let startY = (segment.start.latitude - coordinate.latitude) * navigationMetersPerDegreeLatitude
    let segmentX = (segment.end.longitude - segment.start.longitude)
      * navigationMetersPerDegreeLatitude * longitudeScale
    let segmentY = (segment.end.latitude - segment.start.latitude)
      * navigationMetersPerDegreeLatitude
    let lengthSquared = segmentX * segmentX + segmentY * segmentY
    guard lengthSquared > 0 else {
      return nil
    }
    let fraction = -(startX * segmentX + startY * segmentY) / lengthSquared
    guard fraction > 0, fraction <= 1 else {
      return nil
    }
    return (
      segment.cumulativeDistanceMeters + segment.lengthMeters * fraction,
      hypot(startX + segmentX * fraction, startY + segmentY * fraction)
    )
  }
}

/// Native ownership of fixed-camera alerts: which camera to announce, once per trip, from the
/// matched position. Runs in the navigation service, so it works with the phone locked and with
/// only CarPlay on screen; the phone UI only presents `activeAlert`.
struct NavigationSafetyCameraMonitor {
  private(set) var activeAlert: NavigationSafetyCameraAlert?
  private(set) var announcedIds: Set<String> = []
  private var activeAlertAlongMeters: Double?
  private var alertSequence = 0
  private var cameras: [NavOSSSafetyCamera] = []
  private var index: NavigationSafetyCameraIndex?
  private var lastAlongMeters: Double?
  private var route: RoutePolyline?

  /// The camera with `id`, so a presenter can place the active alert on the map.
  func camera(id: String) -> NavOSSSafetyCamera? {
    cameras.first { $0.id == id }
  }

  var hasCameras: Bool {
    !cameras.isEmpty
  }

  mutating func setCameras(_ cameras: [NavOSSSafetyCamera]) {
    self.cameras = cameras
    index = route.map { NavigationSafetyCameraIndex(cameras: cameras, route: $0) }
  }

  /// A new trip: cameras announced on the previous trip become eligible again.
  mutating func startTrip(geometry: [NavigationCoordinate]) {
    announcedIds.removeAll()
    replaceRoute(geometry: geometry)
  }

  /// A reroute keeps the trip, so a camera already announced stays silent.
  mutating func replaceRoute(geometry: [NavigationCoordinate]) {
    route = try? RoutePolyline(coordinates: geometry)
    index = route.map { NavigationSafetyCameraIndex(cameras: cameras, route: $0) }
    activeAlert = nil
    activeAlertAlongMeters = nil
    lastAlongMeters = nil
  }

  mutating func endTrip() {
    announcedIds.removeAll()
    route = nil
    index = nil
    activeAlert = nil
    activeAlertAlongMeters = nil
    lastAlongMeters = nil
  }

  /// Updates the alert for a new snapshot. Returns `true` when a new camera should be
  /// announced now.
  mutating func update(snapshot: NavigationSnapshot) -> Bool {
    guard let route, let index, snapshot.phase == .tracking, !snapshot.isOffRoute,
      snapshot.rawCoordinate != nil, snapshot.matchedCoordinate != nil
    else {
      activeAlert = nil
      activeAlertAlongMeters = nil
      return false
    }
    let alongMeters = snapshot.routeProgress * route.totalDistanceMeters
    defer { lastAlongMeters = alongMeters }

    if let cameraAlong = activeAlertAlongMeters, let alert = activeAlert {
      if cameraAlong > alongMeters {
        activeAlert = NavigationSafetyCameraAlert(
          cameraId: alert.cameraId,
          distanceAheadMeters: cameraAlong - alongMeters,
          location: alert.location,
          sequence: alert.sequence
        )
      } else {
        activeAlert = nil
        activeAlertAlongMeters = nil
      }
    }
    // Only announce while making forward progress: noise or a reversal near a camera must not
    // produce an alert for a camera that is, in travel terms, behind.
    if let lastAlongMeters, alongMeters < lastAlongMeters {
      return false
    }
    guard let upcoming = index.upcoming(afterAlongMeters: alongMeters, excluding: announcedIds)
    else {
      return false
    }
    announcedIds.insert(upcoming.camera.id)
    alertSequence += 1
    activeAlert = NavigationSafetyCameraAlert(
      cameraId: upcoming.camera.id,
      distanceAheadMeters: upcoming.distanceAheadMeters,
      location: upcoming.camera.location,
      sequence: alertSequence
    )
    activeAlertAlongMeters = alongMeters + upcoming.distanceAheadMeters
    return true
  }
}
