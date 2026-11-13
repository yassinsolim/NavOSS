import Foundation

private let arrivalConfirmationSampleCount = 2
private let arrivalDistanceThresholdMeters = 30.0
private let arrivalProgressThreshold = 0.98
private let backwardProgressPenaltyFactor = 0.5
private let backwardProgressToleranceMeters = 15.0
private let continuityPenaltyFactor = 0.25
private let continuityToleranceMeters = 75.0
/// Total regression from the high-water progress mark that counts as real reverse travel. Sits
/// above measured stationary-noise regression (23 m at sigma 4, 47 m at sigma 8, 48 m at
/// sigma 12) so a parked vehicle cannot trip it.
private let cumulativeBackwardToleranceMeters = 50.0
private let maximumCoursePenaltyMeters = 50.0
private let offRouteConfirmationSampleCount = 3
private let offRouteDistanceThresholdMeters = 35.0
private let onRouteRecoveryDistanceThresholdMeters = 20.0
private let onRouteRecoverySampleCount = 2

// Matching window. Each fix is matched against the road near the previous match instead of the
// whole route; the grid is consulted only when that window has nothing close to the fix.
/// Road behind the previous match that stays eligible, so stationary noise and the bounded
/// backward checks below still see the true position.
private let matchWindowBackwardMeters = 150.0
/// Road ahead of the previous match that is always eligible, whatever the reported speed.
private let matchWindowMinimumForwardMeters = 400.0
/// Upper bound on the forward window, so a long gap or a wild speed reading stays bounded.
private let matchWindowMaximumForwardMeters = 3_000.0
/// Believable speed ceiling (about 160 km/h) used when fixes are timestamped but carry no speed.
private let maximumPlausibleSpeedMetersPerSecond = 45.0
private let globalSearchInitialRadiusMeters = 250.0
private let globalSearchMaximumRadiusMeters = 1_000.0
/// Route ahead this much further from the vehicle than the closest route ahead still counts as
/// "where the vehicle is" when choosing a keep-route rejoin base.
private let rejoinBaseDistanceBandMeters = 100.0

// Transition plausibility. Only applies when fixes carry timestamps and a speed, which every
// Core Location fix does; untimed replay input keeps the original continuity scoring.
private let plausibilityBaseToleranceMeters = 25.0
private let plausibilityForwardPenaltyFactor = 0.5
private let plausibilityLagPenaltyFactor = 0.15
/// A single accurate fix landing this far beyond the plausible travel is held as a multipath
/// jump until a second fix agrees.
private let implausibleJumpMarginMeters = 150.0
private let implausibleJumpConfirmationCount = 2
/// A candidate "fits" a fix when its lateral distance plus heading disagreement is inside the
/// band that counts as on route. Travel plausibility only ranks candidates that fit: it decides
/// which of two roads under the fix is meant, never whether the road under the fix is believed.
private let fittingCandidateToleranceMeters = offRouteDistanceThresholdMeters
/// Course and speed at which travel against the matched road counts as leaving the route.
private let wrongWayMinimumCourseDifferenceDegrees = 150.0
private let wrongWayMinimumSpeedMetersPerSecond = 4.0

// Dead reckoning through short signal loss (tunnels, underpasses, urban canyons).
private let deadReckoningMinimumGapSeconds = 2.5
private let deadReckoningMaximumGapSeconds = 20.0
private let deadReckoningMaximumDistanceMeters = 400.0
private let deadReckoningMinimumSpeedMetersPerSecond = 3.0

struct NavOSSLocationTrackingLeases {
  private var identifiers: Set<UUID> = []

  var isActive: Bool {
    !identifiers.isEmpty
  }

  mutating func acquire() -> UUID {
    let identifier = UUID()
    identifiers.insert(identifier)
    return identifier
  }

  mutating func release(_ identifier: UUID) {
    identifiers.remove(identifier)
  }

  mutating func removeAll() {
    identifiers.removeAll()
  }
}

/// Which CarPlay scenes currently report a connected display.
///
/// The template scene and the Dashboard scene connect and disconnect independently, and either
/// alone is a live map in a vehicle. A single flag let whichever disconnected first clear the
/// state while the other was still on screen, dropping location under it.
struct NavOSSCarPlayConnectedScenes {
  private var scenes: Set<String> = []

  var isConnected: Bool {
    !scenes.isEmpty
  }

  mutating func set(_ connected: Bool, scene: String) {
    if connected {
      scenes.insert(scene)
    } else {
      scenes.remove(scene)
    }
  }
}

/// Whether Core Location should be running.
///
/// A connected CarPlay display counts. The driver is looking at a map in a vehicle and the phone is
/// usually locked in a pocket or cradle, so tracking only during an active trip leaves the idle
/// CarPlay map frozen until the phone is woken by hand.
func navOSSShouldTrackLocation(
  hasActiveNavigation: Bool,
  isCarPlayRoutePlanning: Bool,
  isCarPlayConnected: Bool
) -> Bool {
  hasActiveNavigation || isCarPlayRoutePlanning || isCarPlayConnected
}

/// Whether to hold a `CLBackgroundActivitySession`.
///
/// Under When In Use authorization this is what keeps location alive once the screen sleeps. Both
/// conditions are cases where the driver still depends on position with the phone untouched: an
/// active trip, or a connected CarPlay display. Idle phone use is excluded, because the map is not
/// visible then and the session would cost battery and show the indicator for nothing.
func navOSSShouldHoldBackgroundLocationSession(
  hasActiveNavigation: Bool,
  isCarPlayConnected: Bool
) -> Bool {
  hasActiveNavigation || isCarPlayConnected
}

/// The CarPlay map may follow only while it is idle, the display still requests location, and the
/// driver has not explicitly panned or opened an overview. MapLibre owns the actual live tracking.
public func navOSSShouldFollowIdleCarPlayLocation(
  hasActiveGuidance: Bool,
  idleFollowEnabled: Bool,
  requestsUserLocation: Bool
) -> Bool {
  !hasActiveGuidance && idleFollowEnabled && requestsUserLocation
}

func navOSSCarPlayPublishedPosition(
  matchedCoordinate: NavigationCoordinate?,
  rawCoordinate: NavigationCoordinate?,
  matchedCourseDegrees: Double?,
  rawCourseDegrees: Double? = nil,
  speedMetersPerSecond: Double?,
  fallback: NavOSSCarPlayPosition?
) -> NavOSSCarPlayPosition? {
  guard let coordinate = matchedCoordinate ?? rawCoordinate else { return fallback }
  return NavOSSCarPlayPosition(
    coordinate: NavOSSCarPlayCoordinate(
      latitude: coordinate.latitude,
      longitude: coordinate.longitude
    ),
    // Going off route clears the matched course, but the vehicle still has a heading. Fall back
    // to the validated raw GPS course so the arrow keeps pointing where the car is travelling
    // instead of snapping to due north.
    courseDegrees: matchedCourseDegrees ?? rawCourseDegrees ?? fallback?.courseDegrees,
    speedMetersPerSecond: speedMetersPerSecond
  )
}

enum NavOSSPersistedNavigationDecision: Equatable {
  case discard
  case publish
  case wait
}

func navOSSPersistedNavigationDecision(
  distanceFromRouteMeters: Double?,
  horizontalAccuracyMeters: Double?,
  isOffRoute: Bool
) -> NavOSSPersistedNavigationDecision {
  guard let distanceFromRouteMeters, let horizontalAccuracyMeters,
    horizontalAccuracyMeters <= 50
  else {
    return .wait
  }
  if isOffRoute || distanceFromRouteMeters > offRouteDistanceThresholdMeters
    + horizontalAccuracyMeters
  {
    return .discard
  }
  return .publish
}

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
  /// Ground speed reported with the fix. Feeds transition plausibility and dead reckoning.
  let speedMetersPerSecond: Double?
  /// Fix time in seconds since the reference date (`Date.timeIntervalSinceReferenceDate`).
  let timestamp: TimeInterval?

  init(
    coordinate: NavigationCoordinate,
    courseDegrees: Double? = nil,
    horizontalAccuracyMeters: Double?,
    speedMetersPerSecond: Double? = nil,
    timestamp: TimeInterval? = nil
  ) {
    self.coordinate = coordinate
    self.courseDegrees = courseDegrees
    self.horizontalAccuracyMeters = horizontalAccuracyMeters
    self.speedMetersPerSecond = speedMetersPerSecond
    self.timestamp = timestamp
  }

  var isValid: Bool {
    guard coordinate.isValid else {
      return false
    }
    if let courseDegrees,
       (!courseDegrees.isFinite || !(0..<360).contains(courseDegrees)) {
      return false
    }
    if let speedMetersPerSecond,
       (!speedMetersPerSecond.isFinite || speedMetersPerSecond < 0) {
      return false
    }
    if let timestamp, !timestamp.isFinite {
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
  /// Original route-geometry segment under the matched position, aligned with
  /// `speedLimitsKph`. `nil` while unmatched or off route.
  var geometrySegmentIndex: Int? = nil
  /// The matched position was extrapolated along the route through a gap in fixes.
  var isDeadReckoning = false
  var speedMetersPerSecond: Double? = nil
}

final class NavigationCore {
  private var anchorTimestamp: TimeInterval?
  private var arrivalSampleCount = 0
  private var departureSampleCount = 0
  /// Progress established by the latest real fix. Dead reckoning moves the published snapshot
  /// without touching this, so the next fix is judged against where the vehicle was last seen.
  private var fixProgress = 0.0
  private var hasArrived = false
  private var implausibleJumpCount = 0
  /// Along-route position and time of the latest fix counted towards `implausibleJumpCount`.
  /// The next one confirms the jump only if it is where that fix could have travelled to.
  private var heldJumpAlongMeters: Double?
  private var heldJumpTimestamp: TimeInterval?
  private var isOffRoute = false
  private var lastFixSpeed: Double?
  private var lastFixTimestamp: TimeInterval?
  /// Snapshot produced by the latest real fix. A held fix falls back to this, never to a
  /// dead-reckoned guess or to the rejected projection.
  private var lastRealSnapshot: NavigationSnapshot?
  private var progressHighWaterMark = 0.0
  private var recoverySampleCount = 0
  private var route: RoutePolyline?
  private var routeVersion = 0
  private var sequence = 0
  private var snapshot: NavigationSnapshot
  /// Segments scored for the most recent fix. Exposed so tests can prove per-fix cost does not
  /// scale with route length.
  private(set) var lastEvaluatedSegmentCount = 0

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

  var routeLengthMeters: Double? {
    route?.totalDistanceMeters
  }

  /// Along-route position established by the latest real fix.
  var fixAlongMeters: Double? {
    route.map { fixProgress * $0.totalDistanceMeters }
  }

  func currentSnapshot() -> NavigationSnapshot {
    snapshot
  }

  /// The on-route point `alongMeters` from the route origin, or `nil` with no route.
  func routePoint(alongMeters: Double) -> NavigationCoordinate? {
    route?.point(alongMeters: alongMeters).coordinate
  }

  /// Where the vehicle is along the route for the purpose of rejoining it: the first place at
  /// or after the last confirmed fix where the route comes about as close to `coordinate` as it
  /// gets nearby. Off route the confirmed progress stays where the vehicle left the route, which
  /// after a long gap can be kilometres behind it; a rejoin measured from there would send the
  /// driver back. Taking the first such place, not the nearest, keeps an out-and-back route from
  /// skipping to its return leg. Falls back to the confirmed fix when the route ahead is not
  /// within the grid search radius.
  func rejoinBaseAlongMeters(near coordinate: NavigationCoordinate) -> Double? {
    guard let route, coordinate.isValid else {
      return nil
    }
    let fixAlongMeters = fixProgress * route.totalDistanceMeters
    var candidates: [RouteProjection] = []
    for index in route.segmentIndices(
      near: coordinate,
      radiusMeters: globalSearchMaximumRadiusMeters
    ) {
      let projection = route.project(coordinate, ontoSegment: index)
      if projection.alongMeters >= fixAlongMeters {
        candidates.append(projection)
      }
    }
    guard let nearestMeters = candidates.map(\.distanceMeters).min(),
      var index = candidates.firstIndex(where: {
        $0.distanceMeters <= nearestMeters + rejoinBaseDistanceBandMeters
      })
    else {
      return fixAlongMeters
    }
    // Candidates are in route order. From the first one inside the band, follow the route to
    // where it stops getting closer.
    while index + 1 < candidates.count,
      candidates[index + 1].distanceMeters <= candidates[index].distanceMeters
    {
      index += 1
    }
    return candidates[index].alongMeters
  }

  @discardableResult
  func setRoute(_ coordinates: [NavigationCoordinate]) throws -> NavigationSnapshot {
    route = try RoutePolyline(coordinates: coordinates)
    resetTrackingState()
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
    resetTrackingState()
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
    defer {
      lastFixTimestamp = sample.timestamp
      lastFixSpeed = sample.speedMetersPerSecond
    }
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
        sequence: sequence,
        speedMetersPerSecond: sample.speedMetersPerSecond
      )
      return snapshot
    }

    let accuracyAllowanceMeters = sample.horizontalAccuracyMeters ?? 0
    let anchorAlongMeters = snapshot.rawCoordinate == nil
      ? nil
      : fixProgress * route.totalDistanceMeters
    let elapsedSeconds = sample.timestamp.flatMap { timestamp in
      anchorTimestamp.map { timestamp - $0 }
    }.flatMap { $0 > 0 && $0 <= 600 ? $0 : nil }
    let knownSpeeds = [sample.speedMetersPerSecond, lastFixSpeed].compactMap { $0 }
    let expectedTravelMeters = elapsedSeconds.flatMap { elapsed in
      knownSpeeds.isEmpty
        ? nil
        : knownSpeeds.reduce(0, +) / Double(knownSpeeds.count) * elapsed
    }
    let projection = bestProjection(
      on: route,
      sample: sample,
      anchorAlongMeters: anchorAlongMeters,
      elapsedSeconds: elapsedSeconds,
      expectedTravelMeters: expectedTravelMeters
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
        sequence: sequence,
        speedMetersPerSecond: sample.speedMetersPerSecond
      )
      return snapshot
    }

    // A single accurate fix far beyond any believable travel since the last accepted one is
    // almost always multipath. Hold the match for it; a second fix that agrees with it is
    // accepted, so a genuinely stale speed reading, a teleport, or the first fix after a long
    // gap delays the match by one sample at most. "Believable" uses the reported speeds when
    // there are any and the speed ceiling otherwise, so a fix without a speed is held too.
    let isImplausibleJump: Bool = {
      guard let anchorAlongMeters, let elapsedSeconds,
        (sample.horizontalAccuracyMeters ?? .infinity) <= 50
      else {
        return false
      }
      let reachMeters = expectedTravelMeters
        ?? elapsedSeconds * maximumPlausibleSpeedMetersPerSecond
      let tolerance = plausibilityBaseToleranceMeters + accuracyAllowanceMeters
        + 0.5 * reachMeters
      return projection.alongMeters - anchorAlongMeters
        > reachMeters + tolerance + implausibleJumpMarginMeters
    }()
    if isImplausibleJump {
      // Two outliers in different places are two outliers, not a confirmation.
      let agreesWithHeldJump: Bool = {
        guard let heldJumpAlongMeters, let heldJumpTimestamp, let timestamp = sample.timestamp
        else {
          return false
        }
        let sinceHeldSeconds = timestamp - heldJumpTimestamp
        guard sinceHeldSeconds >= 0 else {
          return false
        }
        return abs(projection.alongMeters - heldJumpAlongMeters)
          <= plausibilityBaseToleranceMeters + accuracyAllowanceMeters
          + sinceHeldSeconds * maximumPlausibleSpeedMetersPerSecond
      }()
      implausibleJumpCount = agreesWithHeldJump ? implausibleJumpCount + 1 : 1
      heldJumpAlongMeters = projection.alongMeters
      heldJumpTimestamp = sample.timestamp
    } else {
      implausibleJumpCount = 0
      heldJumpAlongMeters = nil
      heldJumpTimestamp = nil
    }
    let isHeldJump = isImplausibleJump && implausibleJumpCount < implausibleJumpConfirmationCount

    let backwardProgressMeters = max(
      0,
      (fixProgress - projection.progress) * route.totalDistanceMeters
    )
    // Per-sample regression catches an abrupt reversal, but not a slow one: each accepted step
    // below the tolerance lowers the baseline for the next comparison, so reversing in small
    // increments rewinds progress without limit. Measured against a real Calgary route, 12 m
    // steps unwound 480 m of progress to zero and never once tripped off-route. Cumulative
    // regression is therefore tracked against a high-water mark as well.
    //
    // The cumulative threshold has to clear GPS noise, which regresses from its own high-water
    // mark even while parked: measured 23 m at sigma 4, 47 m at sigma 8, 48 m at sigma 12. The
    // base sits above that, and the accuracy term scales it for poorer fixes.
    let cumulativeBackwardMeters = max(
      0,
      (progressHighWaterMark - projection.progress) * route.totalDistanceMeters
    )
    let isBackwardTravelSample =
      backwardProgressMeters > backwardProgressToleranceMeters + accuracyAllowanceMeters
      || cumulativeBackwardMeters
        > cumulativeBackwardToleranceMeters + 2 * accuracyAllowanceMeters
    // A moving vehicle whose GPS course opposes the road it is matched to is driving the route
    // backwards (a U-turn). That is visible at once, before any distance regression builds up.
    let isWrongWaySample = (sample.speedMetersPerSecond ?? 0) >= wrongWayMinimumSpeedMetersPerSecond
      && sample.courseDegrees.map {
        navigationCourseDifferenceDegrees($0, projection.courseDegrees)
          >= wrongWayMinimumCourseDifferenceDegrees
      } == true
    let isDepartureSample = projection.distanceMeters >
      offRouteDistanceThresholdMeters + accuracyAllowanceMeters || isBackwardTravelSample
      || isWrongWaySample
    let isRecoverySample = projection.distanceMeters + accuracyAllowanceMeters <=
      onRouteRecoveryDistanceThresholdMeters && projection.progress >= fixProgress

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

    let isArrivalSample = !isOffRoute && !isHeldJump &&
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
      fixProgress = 1
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
        sequence: sequence,
        speedMetersPerSecond: sample.speedMetersPerSecond
      )
      return snapshot
    }

    // Backward regression is accepted inside the accuracy-aware noise band so that a stationary
    // or slow-moving vehicle keeps tracking its true position. `isDepartureSample` already
    // rejects regressions beyond `backwardProgressToleranceMeters + accuracy` and feeds them
    // into off-route hysteresis, so it is the single authority on backward motion. A stricter
    // zero-tolerance gate here would latch `routeProgress` to the forward extreme of GPS noise
    // and hold the matched coordinate until the vehicle physically drove past it.
    let shouldAcceptProjection = !isOffRoute && !isDepartureSample && !isHeldJump
    // Raised only by accepted on-route progress, and read before this line when computing
    // cumulative regression, so the mark is the furthest point genuinely reached this route
    // rather than a value that drifts down with each tolerated backward step.
    if shouldAcceptProjection {
      progressHighWaterMark = max(progressHighWaterMark, projection.progress)
      anchorTimestamp = sample.timestamp
    }
    // A dead-reckoned snapshot is a guess; the held position falls back to the last real match.
    let previous = lastRealSnapshot
    let previousMatchedCoordinate = previous?.matchedCoordinate
    let provisionalMatchedCoordinate = previousMatchedCoordinate ?? projection.coordinate
    let provisionalMatchedCourseDegrees = previous?.matchedCourseDegrees
      ?? projection.courseDegrees
    let provisionalGeometrySegmentIndex = previousMatchedCoordinate == nil
      ? projection.geometrySegmentIndex
      : previous?.geometrySegmentIndex
    let provisionalRouteProgress = previousMatchedCoordinate == nil
      ? projection.progress
      : fixProgress
    let routeProgress = shouldAcceptProjection
      ? projection.progress
      : isOffRoute ? fixProgress : provisionalRouteProgress
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
      routeProgress: routeProgress,
      routeVersion: routeVersion,
      sequence: sequence,
      geometrySegmentIndex: shouldAcceptProjection
        ? projection.geometrySegmentIndex
        : isOffRoute ? nil : provisionalGeometrySegmentIndex,
      speedMetersPerSecond: sample.speedMetersPerSecond
    )
    fixProgress = routeProgress
    lastRealSnapshot = snapshot
    return snapshot
  }

  /// Extrapolates the matched position along the route through a short gap in fixes.
  ///
  /// Without this the puck, the maneuver distance and the voice prompts all freeze in a tunnel
  /// or under a long overpass. Extrapolation needs a recent accepted on-route fix with a usable
  /// speed, never reaches arrival, never moves backward, and stops after
  /// `deadReckoningMaximumGapSeconds` or `deadReckoningMaximumDistanceMeters`, whichever is
  /// first. It never changes off-route, arrival or progress-mark state: the next real fix is
  /// judged against the last real match.
  ///
  /// `maximumAlongMeters` caps extrapolation, so it stops before the next maneuver the vehicle has
  /// not been seen to take; only a real fix can confirm a turn.
  @discardableResult
  func deadReckon(
    at timestamp: TimeInterval,
    maximumAlongMeters: Double? = nil
  ) -> NavigationSnapshot? {
    guard let route, !hasArrived, !isOffRoute, snapshot.phase == .tracking,
      snapshot.matchedCoordinate != nil, let lastFixTimestamp, let lastFixSpeed,
      lastFixTimestamp == anchorTimestamp,
      lastFixSpeed >= deadReckoningMinimumSpeedMetersPerSecond
    else {
      return nil
    }
    let gapSeconds = timestamp - lastFixTimestamp
    guard gapSeconds >= deadReckoningMinimumGapSeconds,
      gapSeconds <= deadReckoningMaximumGapSeconds
    else {
      return nil
    }
    let fixAlongMeters = fixProgress * route.totalDistanceMeters
    // Stop short of the destination: arrival must come from real, accurate fixes.
    let alongMeters = min(
      fixAlongMeters + min(deadReckoningMaximumDistanceMeters, lastFixSpeed * gapSeconds),
      route.totalDistanceMeters * arrivalProgressThreshold,
      maximumAlongMeters ?? .infinity
    )
    guard alongMeters > snapshot.routeProgress * route.totalDistanceMeters else {
      return nil
    }
    let point = route.point(alongMeters: alongMeters)
    sequence += 1
    snapshot = NavigationSnapshot(
      distanceFromRouteMeters: snapshot.distanceFromRouteMeters,
      horizontalAccuracyMeters: snapshot.horizontalAccuracyMeters,
      isOffRoute: false,
      matchedCoordinate: point.coordinate,
      matchedCourseDegrees: point.courseDegrees,
      phase: .tracking,
      rawCoordinate: snapshot.rawCoordinate,
      routeProgress: point.progress,
      routeVersion: routeVersion,
      sequence: sequence,
      geometrySegmentIndex: point.geometrySegmentIndex,
      isDeadReckoning: true,
      speedMetersPerSecond: lastFixSpeed
    )
    return snapshot
  }

  private func resetTrackingState() {
    anchorTimestamp = nil
    lastRealSnapshot = nil
    arrivalSampleCount = 0
    departureSampleCount = 0
    fixProgress = 0
    hasArrived = false
    heldJumpAlongMeters = nil
    heldJumpTimestamp = nil
    implausibleJumpCount = 0
    isOffRoute = false
    lastFixSpeed = nil
    lastFixTimestamp = nil
    progressHighWaterMark = 0
    recoverySampleCount = 0
  }

  private func bestProjection(
    on route: RoutePolyline,
    sample: NavigationLocationSample,
    anchorAlongMeters: Double?,
    elapsedSeconds: Double?,
    expectedTravelMeters: Double?
  ) -> RouteProjection {
    let accuracyAllowanceMeters = sample.horizontalAccuracyMeters ?? 0
    var best: RouteProjection?
    var bestScore = Double.infinity
    // The best candidate among those the fix actually lies on. The transition penalty grows
    // without bound with the distance from the previous match, so on its own it makes road a
    // kilometre to the side of the fix beat the road under it once the vehicle is far enough
    // from where it was last matched (a long gap, a resume, a ferry). The fix would then count
    // as off route while on the route, and every later fix would be judged from the same stale
    // anchor. Whether such a jump is believed is decided by the held-jump confirmation.
    var bestFitting: RouteProjection?
    var bestFittingScore = Double.infinity
    let fittingLimitMeters = fittingCandidateToleranceMeters + accuracyAllowanceMeters
    var evaluated = 0

    func consider(_ index: Int) {
      evaluated += 1
      let projection = route.project(sample.coordinate, ontoSegment: index)
      let fit = projection.distanceMeters
        + coursePenalty(projection, courseDegrees: sample.courseDegrees)
      let score = fit
        + transitionPenalty(
          projection,
          anchorAlongMeters: anchorAlongMeters,
          expectedTravelMeters: expectedTravelMeters,
          accuracyAllowanceMeters: accuracyAllowanceMeters
        )
      if score < bestScore {
        best = projection
        bestScore = score
      }
      if fit <= fittingLimitMeters, score < bestFittingScore {
        bestFitting = projection
        bestFittingScore = score
      }
    }

    if let anchorAlongMeters {
      let reachMeters = expectedTravelMeters
        ?? elapsedSeconds.map { $0 * maximumPlausibleSpeedMetersPerSecond }
        ?? 0
      let forwardMeters = min(
        matchWindowMaximumForwardMeters,
        max(matchWindowMinimumForwardMeters, reachMeters * 1.5 + 2 * accuracyAllowanceMeters + 100)
      )
      let backwardMeters = max(matchWindowBackwardMeters, 50 + 2 * accuracyAllowanceMeters)
      let window = route.segmentRange(
        fromMeters: anchorAlongMeters - backwardMeters,
        toMeters: anchorAlongMeters + forwardMeters
      )
      for index in window {
        consider(index)
      }
      // No convincing match inside the window: the vehicle left the route, rejoined it
      // somewhere else, or the window's best candidate only fits by position while heading or
      // travel time say otherwise (a self-crossing after an outage, a hairpin's other leg).
      // Look around the fix itself, still bounded by the grid radius. The combined score, not
      // lateral distance alone, decides.
      if let local = best,
        bestScore > offRouteDistanceThresholdMeters + accuracyAllowanceMeters
      {
        let radius = min(
          globalSearchMaximumRadiusMeters,
          max(globalSearchInitialRadiusMeters, local.distanceMeters + 50)
        )
        for index in route.segmentIndices(near: sample.coordinate, radiusMeters: radius)
        where !window.contains(index) {
          consider(index)
        }
      }
    } else {
      var radius = globalSearchInitialRadiusMeters
      while true {
        for index in route.segmentIndices(near: sample.coordinate, radiusMeters: radius) {
          consider(index)
        }
        if let found = best, found.distanceMeters + maximumCoursePenaltyMeters <= radius {
          break
        }
        guard radius < globalSearchMaximumRadiusMeters else {
          break
        }
        best = nil
        bestScore = .infinity
        radius = min(globalSearchMaximumRadiusMeters, radius * 4)
      }
      // Only the first fix of a route far from all of it reaches a full scan; every later fix
      // has an anchor.
      if best == nil {
        for index in route.segments.indices {
          consider(index)
        }
      }
    }

    lastEvaluatedSegmentCount = evaluated
    return bestFitting ?? best!
  }

  private func coursePenalty(_ projection: RouteProjection, courseDegrees: Double?) -> Double {
    courseDegrees.map { courseDegrees in
      navigationCourseDifferenceDegrees(courseDegrees, projection.courseDegrees) / 180 *
        maximumCoursePenaltyMeters
    } ?? 0
  }

  /// How implausible it is to have moved from the previous match to `projection`.
  ///
  /// With timed fixes and a speed, the along-route travel is compared with what the speed
  /// allows: overtaking it is penalised hard (that is how a later, parallel or crossing part of
  /// the route steals the match), falling short is penalised lightly (speed lags at junctions),
  /// and going backward keeps the original penalty. Untimed input keeps the original
  /// distance-only continuity penalty.
  private func transitionPenalty(
    _ projection: RouteProjection,
    anchorAlongMeters: Double?,
    expectedTravelMeters: Double?,
    accuracyAllowanceMeters: Double
  ) -> Double {
    guard let anchorAlongMeters else {
      return 0
    }
    let deltaMeters = projection.alongMeters - anchorAlongMeters
    let backwardPenalty = max(0, -deltaMeters - continuityToleranceMeters) *
      backwardProgressPenaltyFactor
    guard let expectedTravelMeters else {
      return max(0, abs(deltaMeters) - continuityToleranceMeters) * continuityPenaltyFactor
        + backwardPenalty
    }
    let tolerance = plausibilityBaseToleranceMeters + accuracyAllowanceMeters
      + 0.5 * expectedTravelMeters
    let overshoot = max(0, deltaMeters - expectedTravelMeters - tolerance)
    let shortfall = max(0, expectedTravelMeters - tolerance - max(0, deltaMeters))
    return overshoot * plausibilityForwardPenaltyFactor
      + shortfall * plausibilityLagPenaltyFactor
      + backwardPenalty
  }
}
