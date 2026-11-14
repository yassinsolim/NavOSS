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

// MATCHING INVARIANTS
//
// The route can pass the same place more than once (a loop that ends near its start, the two
// carriageways of a divided road, a parkade spiral, a self-crossing). A position cannot say
// which pass the vehicle is on, and a GPS position can be wrong by a city block for as long as
// the vehicle stands still. Everything below follows from taking both seriously.
// `bestProjection` and `updateLocation` implement these rules;
// `NavigationMatchingInvariantTests` asserts them over generated routes.
//
// Terms, for a candidate projection of a fix, relative to the last ACCEPTED match (the anchor):
//   fits        lateral distance within the on-route band (`offRouteDistanceThresholdMeters`
//               plus the fix's accuracy). Heading never decides fitting.
//   direct      no further along the route from the anchor than the fix is from the last
//               accepted fix on the ground, within a detour factor (`directAdvanceMeters`): the
//               same pass of the same road, reached by moving there.
//   explained   no further ahead than reported speed times elapsed time allows, and never
//               further than possible (`explainedAdvanceMeters`). The speed is the slower of the anchor's and the
//               fix's; both must be reported and at most the plausible ceiling, and the gap at
//               most ten minutes. A reported standstill explains only GPS noise.
//   possible    no further ahead than the speed ceiling times elapsed time
//               (`possibleAdvanceMeters`). Possible travel is not evidence of travel.
//   believable  explained, where speeds are reported; where they are not, the multipath margin
//               stands in for them. Never more than possible (`believableAdvanceMeters`).
//   away        the fix is further from the last accepted fix than a GPS position can be wrong
//               (`credibleBiasMeters` plus both accuracies).
//
// A fix that was not captured after the previous one (the same sample delivered again, or an
// older one arriving late) is not a new observation and changes nothing.
//
// What moves progress, and how many fixes it takes:
//   1. Continuation. A direct, believable candidate that fits: one fix. Among such candidates
//      the one that accounts for the fix with the least unexplained travel wins (distance,
//      heading, advance beyond explained, regression). One that is further on than explained
//      is not taken where an earlier pass fits the fix too; the fix is then a departure. This
//      is ordinary driving.
//   While the fix fits where the vehicle is or has been (a continuation, or an earlier pass),
//   its position says nothing about a later pass; the earlier one is kept. Only this applies:
//   2. Heading switch. A later pass, or the same one further on than explained, fits no worse
//      than where the vehicle is or has been (within the fix's accuracy), and the heading of
//      the moving vehicle agrees with it (within 45 degrees) and opposes the pass the vehicle
//      was on (90 degrees or more): one fix, arrival deferred (rule 6). The same pass further
//      on must be possible; a later pass must be believable, because heading says which way
//      the vehicle points, not how far it has driven. An accurate fix on the carriageway the
//      vehicle was on, pointing back along it, is wrong-way travel there however long the gap:
//      that it could have driven round to the return carriageway is not evidence that it did.
//      (The far side of a self-crossing; a fix on, or between, the other carriageway after a
//      gap long enough, at the reported speed, to have driven round.)
//   While the fix fits nowhere the vehicle is or has been:
//   3. Explained switch. The fix is away, and a later pass fits that reported motion explains:
//      one fix. (Leaving a tunnel around a bend.)
//   4. Heading switch without a continuation. The fix is not away, and such a candidate fits,
//      is within the same bounds as in rule 2, and agrees with the heading of the moving
//      vehicle: one fix, arrival deferred. (A cloverleaf or a switchback through a short gap.)
//   5. Jump. A candidate that fits and is possible in the time qualifies if it is direct (the
//      displacement itself is the travel) or the fix is away. Two consecutive qualifying fixes
//      are needed, the second within `heldJumpMaximumAgeSeconds` of the first and agreeing with
//      it along the route. The first is HELD. Arrival is deferred (rule 6). Untimed replay
//      input has no "later" and no elapsed time: there one qualifying fix is taken, a jump has
//      no time bound, and heading is bounded by the eligible window. Live fixes are always
//      timestamped; the service refuses others.
//   Anything else is not progress. It is measured against the best candidate that is not a
//   later pass and feeds off-route hysteresis; a reroute from the real position follows. That
//   includes a sustained, credible position further along the route than any vehicle could
//   have driven since the last accepted fix: agreeing fixes are not proof the route was driven.
//
// What can never happen:
//   6. Arrival straight after a heading switch or a jump. Arrival then needs the vehicle to be
//      seen moving along the route afterwards (`arrivalCorroboration...`): repeated fixes in
//      one place cannot supply that, wherever they are.
//   7. A held fix being published: not as the matched position, not as progress, not as an
//      arrival sample, not as a dead-reckoning anchor, and not by leaving the off-route state.
//   8. Leaving the off-route state on a fix that is itself a departure (wrong way, backward).
//   9. Progress onto a later pass from a fix within `credibleBiasMeters` of the last accepted
//      fix, unless the vehicle is moving and its heading agrees with that pass. Progress along
//      the same pass is bounded by how far the fix itself has moved (direct).
//  10. The first fix of a route choosing a later pass over an earlier one that fits, unless the
//      heading opposes the earlier and agrees with the later; arrival is then deferred like
//      after any heading switch. A restored trip resumes from its saved anchor instead
//      (`NavigationResumeContext`: progress, the anchor's speed and capture time, how far its
//      fix may have been from the route, and any deferred arrival with where it started), so
//      its next fix asks the same evidence as on an uninterrupted trip, or more; a restored
//      capture time that is missing or not before the fix gives no elapsed time. A restored
//      trip without usable progress is placed as a first fix, but its pass is unconfirmed
//      (`isPassConfirmed`) until a fix fits only one pass or the moving vehicle's heading picks
//      it out, and it does not arrive before then. Nothing of a restored trip is guided until
//      a fix is matched on a confirmed pass.
//
// Minimum evidence for each irreversible transition:
//   pass a maneuver  a fix that fits the road past it, no further on than the fix has moved
//                    and than reported speed explains (one fix; without reported speeds, than
//                    the multipath margin and the speed ceiling allow); further than that, two
//                    fresh agreeing fixes; or a switch of pass.
//   switch pass      heading of a moving vehicle agreeing with the later pass, which reported
//                    motion must make believable (one fix); or, when the fix fits nowhere the
//                    vehicle has been and is away from the last accepted fix, reported motion
//                    that covers it (one fix) or two fresh agreeing fixes, possible in the time.
//   arrive           two consecutive accepted fixes within the arrival radius with progress at
//                    the end of the route; after a heading switch or a jump, movement along
//                    the route first.
//
// Not decidable from GPS alone, and resolved conservatively: a vehicle that really drove a loop
// through a GPS outage and stops where an earlier pass also fits stays on the earlier pass; a
// jump that lands on the destination and stays there does not arrive; a trip restored without
// usable progress, where the vehicle stands still in a place more than one pass fits, cannot
// say which pass it is on: it stays unconfirmed, unguided and unsaved until the vehicle moves.
//
// Not decidable, and not prevented: fixes that move along the route, pair after pair, each
// pair directly on from the last, are a vehicle driving it. Round a loop smaller than GPS error
// that is indistinguishable from GPS error; progress then follows the fixes, but arrival still
// needs them to move on along the route after the last jump (rule 6).

/// How wrong a GPS position can credibly be while the vehicle stands still (urban multipath).
private let credibleBiasMeters = 300.0
/// A candidate is direct when it is no further along the route from the anchor than this many
/// times the distance the fix itself is from the last accepted fix, plus both accuracies and
/// this slack. The displacement of the fix is then the travel.
private let directRouteDetourFactor = 1.25
private let directRouteSlackMeters = 10.0
/// A held jump is confirmed only by a fix captured within this long after it.
private let heldJumpMaximumAgeSeconds = 10.0
/// Heading opposes a candidate from this difference, and agrees with one up to the next.
private let headingOpposesMinimumDifferenceDegrees = 90.0
private let headingAgreesMaximumDifferenceDegrees = 45.0
/// After a heading switch or a jump, arrival waits until the vehicle has advanced this far
/// along the route and moved this far on the ground (plus both accuracies).
private let arrivalCorroborationAlongMeters = 20.0
private let arrivalCorroborationGroundMeters = 50.0

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

/// What to do with a restored trip on a fix. Being beside the route is not enough to resume
/// guidance: the first fix of a resumed trip can be held (a jump along the route while the app
/// was not running), until a fix is matched the restored step is where the vehicle was, not
/// where it is, and a trip without usable progress may be placed on a pass the fix cannot
/// tell from another. Nothing is guided or spoken while this waits; the service shows the trip
/// as finding its place on the route instead.
func navOSSPersistedNavigationDecision(
  _ snapshot: NavigationSnapshot
) -> NavOSSPersistedNavigationDecision {
  guard let distanceFromRouteMeters = snapshot.distanceFromRouteMeters,
    let horizontalAccuracyMeters = snapshot.horizontalAccuracyMeters,
    horizontalAccuracyMeters <= 50
  else {
    return .wait
  }
  if snapshot.isOffRoute || distanceFromRouteMeters > offRouteDistanceThresholdMeters
    + horizontalAccuracyMeters
  {
    return .discard
  }
  return snapshot.matchedCoordinate != nil && snapshot.isPassConfirmed ? .publish : .wait
}

/// Whether an update is one to checkpoint trip progress from: a real fix on the route with a
/// matched position on a known pass. Progress itself is always the confirmed progress, never a
/// held fix's.
func navOSSIsProgressCheckpoint(_ snapshot: NavigationSnapshot) -> Bool {
  snapshot.phase == .tracking && !snapshot.isOffRoute && !snapshot.isDeadReckoning
    && snapshot.matchedCoordinate != nil && snapshot.isPassConfirmed
}

/// Whether to write `progress` now. At once when an arrival starts or stops waiting for
/// movement since the last write (`lastPersisted`), so a relaunch cannot lose it; otherwise at
/// most every `intervalSeconds`, and a wall clock that has moved backward since the last write
/// does not postpone the next one.
func navOSSShouldPersistProgress(
  _ progress: NavigationResumeContext,
  lastPersisted: NavigationResumeContext?,
  now: Date,
  lastPersistedAt: Date?,
  intervalSeconds: TimeInterval = 15
) -> Bool {
  guard progress.arrivalDeferral == lastPersisted?.arrivalDeferral, let lastPersistedAt else {
    return true
  }
  let elapsed = now.timeIntervalSince(lastPersistedAt)
  return elapsed >= intervalSeconds || elapsed < 0
}

/// How long to wait before asking for a replacement route again after `consecutiveFailures`
/// requests in a row have failed: 10 s, doubling to two minutes. A vehicle that stays off route
/// where no route can be had (offline, a parked car whose fixes fit only a later pass) asks
/// less and less often instead of every ten seconds for as long as it stands there.
func navigationRerouteRetryDelaySeconds(consecutiveFailures: Int) -> TimeInterval {
  min(120, 10 * pow(2, Double(max(0, min(consecutiveFailures, 8) - 1))))
}

enum NavigationCoreError: Error, Equatable {
  case invalidCoordinate
  case invalidRoute
  /// A live fix without a capture time. Only replay input may be untimed.
  case untimedLiveFix
}

/// The fix as live ingestion may pass it on. Untimed input is for replays: the matcher takes a
/// qualifying jump from it on one fix, because it has no way to ask for a later one (matching
/// invariant 4). Everything that feeds the matcher from a device goes through here.
func navOSSLiveNavigationFix(
  _ sample: NavigationLocationSample
) throws -> NavigationLocationSample {
  guard sample.timestamp != nil else {
    throw NavigationCoreError.untimedLiveFix
  }
  return sample
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
  /// Whether the pass of the route the vehicle is on is known. False only on a restored trip
  /// without usable progress, while its fixes fit more than one pass (the start and end of a
  /// loop, a parkade spiral) and nothing else tells them apart: its matched position is then a
  /// placement, not an identification, and nothing is guided or saved from it.
  var isPassConfirmed = true
}

/// Where a trip had got to, for resuming it after a relaunch: the state of the last accepted
/// fix that later fixes are judged against, in distances along the route, a capture time and a
/// speed. It holds no coordinate: each point is a distance along the stored route, and each
/// uncertainty says how far the real fix may have been from that point, so that restoring can
/// only make the evidence a later fix needs larger, never smaller.
struct NavigationResumeContext: Equatable, Sendable {
  /// Where arrival was deferred (matching invariant 6), until the vehicle is seen moving on.
  struct ArrivalDeferral: Equatable, Sendable {
    /// Where the fix that deferred it matched.
    let alongMeters: Double
    /// That fix's accuracy plus its distance from the route there.
    let uncertaintyMeters: Double
  }

  /// Confirmed progress: where the last accepted fix matched.
  let alongMeters: Double
  /// The furthest progress accepted on this route, which regression is measured from.
  let highWaterAlongMeters: Double
  /// The accepted fix's accuracy plus its distance from the route at `alongMeters`.
  let uncertaintyMeters: Double
  /// Capture time of the accepted fix. A time that is missing, or not before the next fix
  /// (the clock was set back), is no evidence of elapsed time.
  let timestamp: TimeInterval?
  /// Its reported speed, when there was a believable one.
  let speedMetersPerSecond: Double?
  let arrivalDeferral: ArrivalDeferral?

  var isArrivalDeferred: Bool {
    arrivalDeferral != nil
  }

  /// Whether every value is one a matcher could have saved. Anything else is no progress.
  var isUsable: Bool {
    func isDistance(_ value: Double) -> Bool { value.isFinite && value >= 0 }
    return isDistance(alongMeters) && isDistance(uncertaintyMeters)
      && isDistance(highWaterAlongMeters) && highWaterAlongMeters >= alongMeters
      && (timestamp?.isFinite ?? true)
      && (speedMetersPerSecond.map {
        isDistance($0) && $0 <= maximumPlausibleSpeedMetersPerSecond
      } ?? true)
      && (arrivalDeferral.map {
        isDistance($0.alongMeters) && isDistance($0.uncertaintyMeters)
      } ?? true)
  }
}

/// How a restored trip starts matching.
enum NavigationResumePoint: Equatable, Sendable {
  /// From where it had got to.
  case progress(NavigationResumeContext)
  /// The trip was saved without progress (by a build that did not record it). Its first fix is
  /// placed like a new route's, but the pass it is placed on must be confirmed (see
  /// `NavigationSnapshot.isPassConfirmed`) before anything is guided from it.
  case withoutProgress
  /// A progress record was saved for the trip but cannot be used (damaged, or written in a
  /// form this build does not read). As `withoutProgress`, and arrival also waits for the
  /// vehicle to be seen moving: the record may have held a deferred arrival.
  case unusable
}

final class NavigationCore {
  // The anchor: the last accepted match. Everything a new fix is judged against.
  /// Whether there is one. False until the first fix of a route, unless the route was resumed.
  private var hasAnchor = false
  /// Raw position and accuracy of the last accepted fix: where the vehicle was last known to be.
  private var anchorRawCoordinate: NavigationCoordinate?
  private var anchorAccuracyMeters = 0.0
  /// Reported speed of the last accepted fix, when it is one that can be trusted.
  private var anchorSpeed: Double?
  private var anchorTimestamp: TimeInterval?
  /// The anchor was restored, not observed in this process. Its capture time is evidence of
  /// elapsed time only while it is before the next fix's: a clock set back since it was saved
  /// leaves the time unknown, which limits nothing and explains nothing.
  private var isAnchorRestored = false
  /// Where arrival was deferred (invariant 6), until the vehicle is seen moving on from there.
  private var arrivalDeferral: (alongMeters: Double, raw: NavigationCoordinate, accuracyMeters: Double)?
  /// The next accepted fix defers arrival, as a jump would: set for a restored trip whose saved
  /// progress could not be used.
  private var defersArrivalOnNextAcceptedFix = false
  /// A restored trip placed without progress has not yet shown which pass it is on.
  private var requiresPassConfirmation = false
  private var arrivalSampleCount = 0
  private var departureSampleCount = 0
  /// Progress established by the latest real fix. Dead reckoning moves the published snapshot
  /// without touching this, so the next fix is judged against where the vehicle was last seen.
  private var fixProgress = 0.0
  private var hasArrived = false
  /// The held first fix of a jump (invariant 4): where it matched and when it was captured.
  private var heldJump: (alongMeters: Double, timestamp: TimeInterval?)?
  private var isOffRoute = false
  /// Whether the latest real fix was accepted. Dead reckoning extrapolates only from one that
  /// was, using the anchor's own time and speed.
  private var isLatestFixAccepted = false
  /// Capture time of the latest real fix, accepted or not.
  private var latestFixTimestamp: TimeInterval?
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

  /// What a later `setRoute(_:resume:)` needs to carry on from here. `nil` before the first
  /// fix, once arrived, and without a route.
  var resumeContext: NavigationResumeContext? {
    guard let route, hasAnchor, !hasArrived, let anchorRawCoordinate else {
      return nil
    }
    // A raw position becomes a distance along the route and how far the fix may have been from
    // that point, so nothing more than the route itself places it.
    func uncertainty(alongMeters: Double, raw: NavigationCoordinate, accuracyMeters: Double)
      -> Double
    {
      accuracyMeters
        + navigationDistanceMeters(
          from: route.point(alongMeters: alongMeters).coordinate, to: raw)
    }
    let alongMeters = fixProgress * route.totalDistanceMeters
    return NavigationResumeContext(
      alongMeters: alongMeters,
      highWaterAlongMeters: max(alongMeters, progressHighWaterMark * route.totalDistanceMeters),
      uncertaintyMeters: uncertainty(
        alongMeters: alongMeters, raw: anchorRawCoordinate, accuracyMeters: anchorAccuracyMeters),
      timestamp: anchorTimestamp,
      speedMetersPerSecond: anchorSpeed,
      arrivalDeferral: arrivalDeferral.map {
        NavigationResumeContext.ArrivalDeferral(
          alongMeters: $0.alongMeters,
          uncertaintyMeters: uncertainty(
            alongMeters: $0.alongMeters, raw: $0.raw, accuracyMeters: $0.accuracyMeters)
        )
      }
    )
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
    // The base moves on from the confirmed position no further than the vehicle itself is
    // from it (the same notion of direct as in matching): a vehicle beside the place it left
    // the route has not driven to a later leg that happens to pass there.
    let confirmed = route.point(alongMeters: fixAlongMeters)
    let reachMeters = directRouteDetourFactor
      * navigationDistanceMeters(from: confirmed.coordinate, to: coordinate)
      + rejoinBaseDistanceBandMeters
    var candidates: [(segment: Int, projection: RouteProjection)] = []
    for index in route.segmentIndices(
      near: coordinate,
      radiusMeters: globalSearchMaximumRadiusMeters
    ) {
      let projection = route.project(coordinate, ontoSegment: index)
      if projection.alongMeters >= fixAlongMeters,
        projection.alongMeters - fixAlongMeters <= reachMeters
      {
        candidates.append((index, projection))
      }
    }
    guard let nearestMeters = candidates.map(\.projection.distanceMeters).min(),
      var index = candidates.firstIndex(where: {
        $0.projection.distanceMeters <= nearestMeters + rejoinBaseDistanceBandMeters
      })
    else {
      return fixAlongMeters
    }
    // Candidates are in route order. From the first one inside the band, follow the route to
    // where it stops getting closer. Only consecutive route segments are "following the
    // route": the grid returns what is near the vehicle, so the next candidate can be another
    // leg entirely (the return leg of an out-and-back whose far end is out of range).
    while index + 1 < candidates.count,
      candidates[index + 1].segment == candidates[index].segment + 1,
      candidates[index + 1].projection.distanceMeters
        <= candidates[index].projection.distanceMeters
    {
      index += 1
    }
    return candidates[index].projection.alongMeters
  }

  /// Starts matching against a route. `resume` continues a trip that was already under way
  /// (restored after a relaunch): the saved anchor is restored, so the next fix is judged from
  /// where the vehicle was, on the same evidence an uninterrupted trip would ask of it.
  @discardableResult
  func setRoute(
    _ coordinates: [NavigationCoordinate],
    resume: NavigationResumePoint? = nil
  ) throws -> NavigationSnapshot {
    let route = try RoutePolyline(coordinates: coordinates)
    self.route = route
    resetTrackingState()
    switch resume {
    case nil:
      break
    case .progress(let saved) where saved.isUsable:
      // The start of the route is as much a place the trip had got to as any other.
      let point = route.point(alongMeters: saved.alongMeters)
      hasAnchor = true
      isAnchorRestored = true
      fixProgress = point.progress
      progressHighWaterMark = max(
        point.progress, route.point(alongMeters: saved.highWaterAlongMeters).progress)
      // The point on the route stands in for the raw fix; its uncertainty covers the distance
      // between them, so every displacement measured from it allows for that.
      anchorRawCoordinate = point.coordinate
      anchorAccuracyMeters = saved.uncertaintyMeters
      anchorTimestamp = saved.timestamp
      anchorSpeed = saved.speedMetersPerSecond
      // An arrival that was waiting for movement still is, from where it started waiting.
      arrivalDeferral = saved.arrivalDeferral.map {
        ($0.alongMeters, route.point(alongMeters: $0.alongMeters).coordinate, $0.uncertaintyMeters)
      }
    case .withoutProgress:
      requiresPassConfirmation = true
    case .progress, .unusable:
      requiresPassConfirmation = true
      defersArrivalOnNextAcceptedFix = true
    }
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
      routeProgress: fixProgress,
      routeVersion: routeVersion,
      sequence: sequence,
      isPassConfirmed: !requiresPassConfirmation
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

    // A fix that was not captured after the last one is the same observation delivered again,
    // or an older one arriving late. It is not evidence of anything new.
    if let timestamp = sample.timestamp, let latestFixTimestamp, timestamp <= latestFixTimestamp,
      route != nil
    {
      return snapshot
    }
    latestFixTimestamp = sample.timestamp ?? latestFixTimestamp
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
        sequence: sequence,
        speedMetersPerSecond: sample.speedMetersPerSecond
      )
      return snapshot
    }

    let accuracyAllowanceMeters = sample.horizontalAccuracyMeters ?? 0
    // A restored anchor whose capture time is unusable (missing, or not before this fix: the
    // clock was set back while the app was not running) bounds and explains nothing, so the
    // speed saved with it is no evidence either: how far the vehicle has gone since is unknown,
    // and so is whether it is still moving. Its pass is still where the vehicle was: a fix that
    // fits it carries on from it, but where that fix lands is not movement, so arrival waits
    // for the vehicle to be seen moving on from it. A fix that fits only another pass cannot be
    // judged against it, and is not grounds to drop the trip: the trip is placed again from
    // this fix, as one restored without progress (its pass confirmed by fixes, arrival waiting
    // for movement). A fix that fits no pass is off the route.
    if isAnchorRestored, let timestamp = sample.timestamp,
      anchorTimestamp.map({ timestamp <= $0 }) ?? true
    {
      defersArrivalOnNextAcceptedFix = true
      if !fitsRestoredPass(sample, on: route, accuracyMeters: accuracyAllowanceMeters),
        fitsAnyPass(sample, on: route, accuracyMeters: accuracyAllowanceMeters)
      {
        resetTrackingState()
        latestFixTimestamp = timestamp
        requiresPassConfirmation = true
        defersArrivalOnNextAcceptedFix = true
      }
    }
    let anchorAlongMeters = hasAnchor ? fixProgress * route.totalDistanceMeters : nil
    // Seconds since the anchor was captured, when both are timestamped and this fix is newer.
    let sinceAnchorSeconds = sample.timestamp.flatMap { timestamp in
      anchorTimestamp.map { timestamp - $0 }
    }.flatMap { $0 > 0 ? $0 : nil }
    let elapsedSeconds = sinceAnchorSeconds.flatMap { $0 <= 600 ? $0 : nil }
    // A reported speed above the ceiling is a bad reading, not a fast vehicle: it is ignored.
    let sampleSpeed = sample.speedMetersPerSecond.flatMap {
      $0 <= maximumPlausibleSpeedMetersPerSecond ? $0 : nil
    }
    let knownSpeeds = [sampleSpeed, anchorSpeed].compactMap { $0 }
    let expectedTravelMeters = elapsedSeconds.flatMap { elapsed in
      knownSpeeds.isEmpty
        ? nil
        : knownSpeeds.reduce(0, +) / Double(knownSpeeds.count) * elapsed
    }
    // The limits of the matching invariants, for this fix. Evidence of travel takes the slower
    // of the two speeds, and needs both: one reading says nothing about the time between.
    let toleranceMeters = plausibilityBaseToleranceMeters + accuracyAllowanceMeters
    let evidencedTravelMeters = elapsedSeconds.flatMap { elapsed in
      sampleSpeed.flatMap { speed in anchorSpeed.map { min(speed, $0) * elapsed } }
    }
    // What the vehicle can have covered at all: the speed ceiling over the time since the
    // anchor. A repeated timestamp allows nothing; untimed replay input, the eligible window.
    // A restored anchor whose capture time is missing or not before this fix (the clock was
    // set back while the app was not running) gives no elapsed time at all: anything is
    // possible and nothing is explained, so a new pass needs heading or two agreeing fixes.
    let isElapsedTimeUnknown = isAnchorRestored && sample.timestamp != nil
      && sinceAnchorSeconds == nil
    let possibleAdvanceMeters = sample.timestamp == nil
      ? matchWindowMinimumForwardMeters + toleranceMeters
      : isElapsedTimeUnknown
        ? route.totalDistanceMeters + toleranceMeters
        : (sinceAnchorSeconds ?? 0) * maximumPlausibleSpeedMetersPerSecond + toleranceMeters
    // Reported speeds explain their travel and half as much again, never more than possible.
    let explainedAdvanceMeters = min(
      possibleAdvanceMeters,
      1.5 * (evidencedTravelMeters ?? 0) + toleranceMeters
    )
    let limits = MatchLimits(
      // Where both speeds are reported they are the evidence, and a fix beyond what they
      // explain is held like any other jump. Where they are not, the multipath margin stands
      // in for them. Never more than is possible.
      believableAdvanceMeters: min(
        possibleAdvanceMeters,
        evidencedTravelMeters == nil
          ? explainedAdvanceMeters + implausibleJumpMarginMeters
          : explainedAdvanceMeters
      ),
      explainedAdvanceMeters: explainedAdvanceMeters,
      possibleAdvanceMeters: possibleAdvanceMeters,
      displacementMeters: anchorRawCoordinate.map {
        navigationDistanceMeters(from: $0, to: sample.coordinate)
      } ?? 0,
      displacementToleranceMeters: accuracyAllowanceMeters + anchorAccuracyMeters,
      isTimed: sample.timestamp != nil
    )
    let match = bestProjection(
      on: route,
      sample: sample,
      anchorAlongMeters: anchorAlongMeters,
      elapsedSeconds: elapsedSeconds,
      expectedTravelMeters: expectedTravelMeters,
      limits: limits
    )
    let projection = match.projection
    let isFirstPlacement = !hasAnchor
    hasAnchor = true

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

    // The first fix of a jump is held; a fix captured shortly after it that agrees with it
    // along the route confirms it. A fix long after, or somewhere else, does not: it becomes
    // the held fix instead. (The same sample delivered again never gets this far.)
    let isHeldJump: Bool = {
      guard match.kind == .jump else {
        heldJump = nil
        return false
      }
      guard let timestamp = sample.timestamp else {
        // Untimed replay input has no "captured later".
        heldJump = nil
        return false
      }
      if let heldJump, let heldTimestamp = heldJump.timestamp,
        timestamp - heldTimestamp <= heldJumpMaximumAgeSeconds,
        abs(projection.alongMeters - heldJump.alongMeters)
          <= toleranceMeters
          + (timestamp - heldTimestamp) * maximumPlausibleSpeedMetersPerSecond
      {
        self.heldJump = nil
        return false
      }
      heldJump = (projection.alongMeters, timestamp)
      return true
    }()

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
      // Invariants 7 and 8: neither a held fix nor a departure ends the off-route state. A held
      // fix still counts towards recovery, so the fix that confirms it recovers at once.
      if recoverySampleCount >= onRouteRecoverySampleCount, !isHeldJump, !isDepartureSample {
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

    let isAcceptableFix = !isOffRoute && !isDepartureSample && !isHeldJump
    // A restored trip placed without progress learns its pass from a fix that only one pass
    // fits, or that the heading of the moving vehicle picks out. Until then it does not arrive.
    if requiresPassConfirmation, isAcceptableFix,
      isPassIdentified(projection, by: sample, on: route)
    {
      requiresPassConfirmation = false
    }
    // Invariant 6: after a heading switch or a jump, arrival waits for the vehicle to be seen
    // moving on along the route. Fixes repeated in one place never satisfy this.
    if isAcceptableFix,
      match.kind == .jump || match.kind == .headingSwitch || defersArrivalOnNextAcceptedFix
    {
      arrivalDeferral = (projection.alongMeters, sample.coordinate, accuracyAllowanceMeters)
      defersArrivalOnNextAcceptedFix = false
    } else if isAcceptableFix, let deferral = arrivalDeferral,
      projection.alongMeters >= deferral.alongMeters + arrivalCorroborationAlongMeters,
      navigationDistanceMeters(from: deferral.raw, to: sample.coordinate)
        >= arrivalCorroborationGroundMeters + accuracyAllowanceMeters + deferral.accuracyMeters
    {
      arrivalDeferral = nil
    }
    let isArrivalSample = !isOffRoute && !isHeldJump && arrivalDeferral == nil &&
      !requiresPassConfirmation &&
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
    }
    // The anchor moves only with an accepted fix, and takes that fix's own time and speed. The
    // first fix of a route is a placement: it becomes the anchor even when it is off the route.
    isLatestFixAccepted = shouldAcceptProjection
    if shouldAcceptProjection || isFirstPlacement {
      anchorRawCoordinate = sample.coordinate
      anchorAccuracyMeters = accuracyAllowanceMeters
      anchorTimestamp = sample.timestamp
      anchorSpeed = sampleSpeed
      isAnchorRestored = false
    }
    // A dead-reckoned snapshot is a guess; the held position falls back to the last real match.
    // A rejected projection is published only as that first placement, never later (after the
    // off-route state, or on a resumed trip, there is simply no matched position).
    let previous = lastRealSnapshot
    let previousMatchedCoordinate = previous?.matchedCoordinate
    let provisionalMatchedCoordinate = isFirstPlacement
      ? projection.coordinate
      : previousMatchedCoordinate
    let provisionalMatchedCourseDegrees = isFirstPlacement
      ? projection.courseDegrees
      : previous?.matchedCourseDegrees
    let provisionalGeometrySegmentIndex = isFirstPlacement
      ? projection.geometrySegmentIndex
      : previous?.geometrySegmentIndex
    let provisionalRouteProgress = isFirstPlacement ? projection.progress : fixProgress
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
      speedMetersPerSecond: sample.speedMetersPerSecond,
      isPassConfirmed: !requiresPassConfirmation
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
      snapshot.matchedCoordinate != nil, isLatestFixAccepted,
      let lastFixTimestamp = anchorTimestamp, let lastFixSpeed = anchorSpeed,
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
    hasAnchor = false
    anchorRawCoordinate = nil
    anchorAccuracyMeters = 0
    anchorSpeed = nil
    anchorTimestamp = nil
    isAnchorRestored = false
    arrivalDeferral = nil
    defersArrivalOnNextAcceptedFix = false
    requiresPassConfirmation = false
    lastRealSnapshot = nil
    arrivalSampleCount = 0
    departureSampleCount = 0
    fixProgress = 0
    hasArrived = false
    heldJump = nil
    isLatestFixAccepted = false
    latestFixTimestamp = nil
    isOffRoute = false
    progressHighWaterMark = 0
    recoverySampleCount = 0
  }

  /// Whether a fix shows which pass of the route `projection` is on: no other pass fits it, or
  /// the moving vehicle's heading agrees with this pass and opposes every other that fits.
  private func isPassIdentified(
    _ projection: RouteProjection,
    by sample: NavigationLocationSample,
    on route: RoutePolyline
  ) -> Bool {
    let fittingLimitMeters = offRouteDistanceThresholdMeters
      + (sample.horizontalAccuracyMeters ?? 0)
    let otherPasses = route.segmentIndices(
      near: sample.coordinate,
      radiusMeters: min(globalSearchMaximumRadiusMeters, fittingLimitMeters)
    )
    .map { route.project(sample.coordinate, ontoSegment: $0) }
    .filter {
      $0.distanceMeters <= fittingLimitMeters
        && !Self.isSamePass($0, as: projection, fittingLimitMeters: fittingLimitMeters)
    }
    guard !otherPasses.isEmpty else {
      return true
    }
    guard let heading = Self.headingEvidenceDegrees(sample),
      navigationCourseDifferenceDegrees(heading, projection.courseDegrees)
        <= headingAgreesMaximumDifferenceDegrees
    else {
      return false
    }
    return otherPasses.allSatisfy {
      navigationCourseDifferenceDegrees(heading, $0.courseDegrees)
        >= headingOpposesMinimumDifferenceDegrees
    }
  }

  /// Fitting candidates of a fix anywhere on the route.
  private func fittingProjections(
    _ sample: NavigationLocationSample, on route: RoutePolyline, accuracyMeters: Double
  ) -> [RouteProjection] {
    let fittingLimitMeters = offRouteDistanceThresholdMeters + accuracyMeters
    return route.segmentIndices(
      near: sample.coordinate,
      radiusMeters: min(globalSearchMaximumRadiusMeters, fittingLimitMeters)
    )
    .map { route.project(sample.coordinate, ontoSegment: $0) }
    .filter { $0.distanceMeters <= fittingLimitMeters }
  }

  private func fitsAnyPass(
    _ sample: NavigationLocationSample, on route: RoutePolyline, accuracyMeters: Double
  ) -> Bool {
    !fittingProjections(sample, on: route, accuracyMeters: accuracyMeters).isEmpty
  }

  /// Whether a fix fits the pass of the route the restored anchor is on.
  private func fitsRestoredPass(
    _ sample: NavigationLocationSample, on route: RoutePolyline, accuracyMeters: Double
  ) -> Bool {
    let anchor = route.point(alongMeters: fixProgress * route.totalDistanceMeters)
    let fittingLimitMeters = offRouteDistanceThresholdMeters + accuracyMeters
    return fittingProjections(sample, on: route, accuracyMeters: accuracyMeters).contains {
      abs($0.alongMeters - anchor.alongMeters)
        <= directRouteDetourFactor
        * navigationDistanceMeters(from: anchor.coordinate, to: $0.coordinate)
        + fittingLimitMeters + anchorAccuracyMeters
    }
  }

  /// The course of a fix, where it is evidence: from a vehicle moving at a believable speed.
  /// Replay input may carry a course and no speed; a live fix never does.
  private static func headingEvidenceDegrees(_ sample: NavigationLocationSample) -> Double? {
    guard let speed = sample.speedMetersPerSecond else {
      return sample.timestamp == nil ? sample.courseDegrees : nil
    }
    return speed >= wrongWayMinimumSpeedMetersPerSecond
      && speed <= maximumPlausibleSpeedMetersPerSecond ? sample.courseDegrees : nil
  }

  /// Two projections of one fix are the same pass when the route between them is about as
  /// long as the straight line between them.
  private static func isSamePass(
    _ projection: RouteProjection,
    as other: RouteProjection,
    fittingLimitMeters: Double
  ) -> Bool {
    abs(projection.alongMeters - other.alongMeters)
      <= directRouteDetourFactor
      * navigationDistanceMeters(from: other.coordinate, to: projection.coordinate)
      + fittingLimitMeters
  }

  /// How far ahead of the anchor a fix may be matched, and on what evidence. See the matching
  /// invariants at the top of this file.
  private struct MatchLimits {
    let believableAdvanceMeters: Double
    let explainedAdvanceMeters: Double
    let possibleAdvanceMeters: Double
    /// Straight-line distance of the fix from the last accepted fix, and the two accuracies.
    let displacementMeters: Double
    let displacementToleranceMeters: Double
    /// Whether the fix carries a capture time, so that `possibleAdvanceMeters` is the speed
    /// ceiling over elapsed time rather than the eligible window that stands in for it.
    let isTimed: Bool

    /// The most route a jump may cover: what is possible in the time. Untimed replay input has
    /// no time to bound it by.
    var jumpAdvanceMeters: Double {
      isTimed ? possibleAdvanceMeters : .infinity
    }

    /// The most route heading may move a fix onto a later pass over: what is believable from
    /// reported motion. Heading says which way the vehicle points, not how far it has driven.
    /// Untimed replay input reports no motion; there it is the eligible window.
    var laterPassHeadingAdvanceMeters: Double {
      isTimed ? believableAdvanceMeters : possibleAdvanceMeters
    }

    var isAwayFromAnchor: Bool {
      displacementMeters > credibleBiasMeters + displacementToleranceMeters
    }

    /// The most route the displacement of the fix can account for.
    var directAdvanceMeters: Double {
      directRouteDetourFactor * displacementMeters + displacementToleranceMeters
        + directRouteSlackMeters
    }
  }

  /// Which rule of the matching invariants produced a projection.
  private enum MatchKind {
    /// Rules 1 and 3, and the first placement: accepted as it is.
    case continuation
    /// Rule 2.
    case headingSwitch
    /// Rule 4: held until confirmed.
    case jump
    /// Rule 5: not progress.
    case unqualified
  }

  private func bestProjection(
    on route: RoutePolyline,
    sample: NavigationLocationSample,
    anchorAlongMeters: Double?,
    elapsedSeconds: Double?,
    expectedTravelMeters: Double?,
    limits: MatchLimits
  ) -> (projection: RouteProjection, kind: MatchKind) {
    let accuracyAllowanceMeters = sample.horizontalAccuracyMeters ?? 0
    let fittingLimitMeters = offRouteDistanceThresholdMeters + accuracyAllowanceMeters
    let headingDegrees = Self.headingEvidenceDegrees(sample)
    func headingDifference(_ projection: RouteProjection) -> Double? {
      headingDegrees.map { navigationCourseDifferenceDegrees($0, projection.courseDegrees) }
    }
    func isSamePass(_ projection: RouteProjection, as other: RouteProjection) -> Bool {
      Self.isSamePass(projection, as: other, fittingLimitMeters: fittingLimitMeters)
    }
    let anchor = anchorAlongMeters.map { route.point(alongMeters: $0) }

    // `best` is the lowest score overall and drives the search, as it always has. The others
    // are the lowest score in each class of the matching invariants.
    var best: RouteProjection?
    var bestScore = Double.infinity
    var continuation: RouteProjection?
    var continuationEvidenceScore = Double.infinity
    var continuationAdvanceMeters = 0.0
    var headingSwitch: RouteProjection?
    var headingSwitchScore = Double.infinity
    var explainedSwitch: RouteProjection?
    var explainedSwitchScore = Double.infinity
    var jump: RouteProjection?
    var jumpScore = Double.infinity
    var unqualified: RouteProjection?
    var unqualifiedScore = Double.infinity
    var earlierPass: RouteProjection?
    var earlierPassScore = Double.infinity
    // Only for the first placement, which has no anchor to classify against.
    var fitting: [(projection: RouteProjection, score: Double)] = []
    var evaluated = 0

    func consider(_ index: Int) {
      evaluated += 1
      let projection = route.project(sample.coordinate, ontoSegment: index)
      let score = projection.distanceMeters
        + coursePenalty(projection, courseDegrees: sample.courseDegrees)
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
      let fits = projection.distanceMeters <= fittingLimitMeters
      guard let anchor else {
        if fits {
          fitting.append((projection, score))
        }
        return
      }
      let advanceMeters = projection.alongMeters - anchor.alongMeters
      let isDirect = abs(advanceMeters) <= limits.directAdvanceMeters
      // How well the candidate accounts for the fix without assuming travel that nothing
      // reported: distance and heading, plus the part of its advance that is not explained and
      // any move backward.
      let evidenceScore = projection.distanceMeters
        + coursePenalty(projection, courseDegrees: sample.courseDegrees)
        + max(0, advanceMeters - limits.explainedAdvanceMeters) * plausibilityForwardPenaltyFactor
        + max(0, -advanceMeters - continuityToleranceMeters) * backwardProgressPenaltyFactor
      guard fits, advanceMeters > 0 || isDirect else {
        // Off the road, or an earlier pass: never progress.
        if evidenceScore < unqualifiedScore {
          unqualified = projection
          unqualifiedScore = evidenceScore
        }
        if fits, evidenceScore < earlierPassScore {
          earlierPass = projection
          earlierPassScore = evidenceScore
        }
        return
      }
      // A later pass, or this one further on than reported motion explains: the heading of a
      // moving vehicle that agrees with it is evidence for it. Further on along the same pass
      // it needs to be possible; onto a later pass, believable from reported motion
      // (`laterPassHeadingAdvanceMeters`): a U-turn on the outbound carriageway points along
      // the return one long before the vehicle can have driven round to it.
      let headingSwitchLimitMeters = isDirect
        ? limits.possibleAdvanceMeters
        : limits.laterPassHeadingAdvanceMeters
      if !isDirect || advanceMeters > limits.explainedAdvanceMeters,
        advanceMeters <= headingSwitchLimitMeters,
        let difference = headingDifference(projection),
        difference <= headingAgreesMaximumDifferenceDegrees, score < headingSwitchScore
      {
        headingSwitch = projection
        headingSwitchScore = score
      }
      if isDirect {
        if advanceMeters <= limits.believableAdvanceMeters {
          if evidenceScore < continuationEvidenceScore {
            continuation = projection
            continuationEvidenceScore = evidenceScore
            continuationAdvanceMeters = advanceMeters
          }
        } else if advanceMeters <= limits.jumpAdvanceMeters, score < jumpScore {
          // The same road further on than anything explains: the displacement is the travel,
          // if any vehicle could have covered it in the time.
          jump = projection
          jumpScore = score
        }
        return
      }
      // A later pass of the route.
      if limits.isAwayFromAnchor, advanceMeters <= limits.explainedAdvanceMeters,
        score < explainedSwitchScore
      {
        explainedSwitch = projection
        explainedSwitchScore = score
      }
      // Further than possible in the time is not a jump: the route was not driven to there,
      // whatever the fixes agree on. The fix is then not progress, and a vehicle that stays
      // there goes off route and is rerouted from where it is.
      if limits.isAwayFromAnchor, advanceMeters <= limits.jumpAdvanceMeters,
        score < jumpScore
      {
        jump = projection
        jumpScore = score
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
      } else if continuation == nil || continuationAdvanceMeters > limits.explainedAdvanceMeters {
        // The window's match is not ordinary driving. Before it is believed, everything else
        // on the route that this fix fits has to be seen: an earlier pass under the fix means
        // its position proves nothing (matching invariants). Ordinary driving never gets here.
        for index in route.segmentIndices(
          near: sample.coordinate,
          radiusMeters: min(globalSearchMaximumRadiusMeters, fittingLimitMeters)
        ) where !window.contains(index) {
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
        fitting.removeAll(keepingCapacity: true)
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

    guard let anchor else {
      // Invariant 10: the first placement takes the earliest pass that fits, unless the
      // vehicle's heading opposes it and agrees with a later one; arrival is then deferred.
      guard let earliest = fitting.min(by: { $0.projection.alongMeters < $1.projection.alongMeters })
      else {
        return (best!, .continuation)
      }
      let earliestPass = fitting
        .filter { isSamePass($0.projection, as: earliest.projection) }
        .min { $0.score < $1.score }!.projection
      let agreeing = fitting
        .filter { candidate in
          (headingDifference(candidate.projection) ?? .infinity)
            <= headingAgreesMaximumDifferenceDegrees
        }
        .min { $0.score < $1.score }
      if let agreeing, let difference = headingDifference(earliestPass),
        difference >= headingOpposesMinimumDifferenceDegrees
      {
        return (agreeing.projection, .headingSwitch)
      }
      return (earliestPass, .continuation)
    }

    // Where an earlier pass fits the fix too, a continuation is only what reported motion
    // explains.
    let isContinuing = continuation != nil
      && (earlierPass == nil || continuationAdvanceMeters <= limits.explainedAdvanceMeters)
    // Where the vehicle is, or has been, on the route also fits this fix: its position cannot
    // say that it is anywhere further on. Only the heading of a moving vehicle can, and only
    // where the later pass fits the fix about as well: a fix on the road the vehicle was on,
    // pointing back along it, is a vehicle driving that road the wrong way, however long the
    // gap. Time that would have allowed driving round to a parallel pass is not evidence that
    // the vehicle did, when the fix is further from that pass than its accuracy.
    if let here = continuation ?? earlierPass {
      let hereDistanceMeters = min(
        continuation?.distanceMeters ?? .infinity, earlierPass?.distanceMeters ?? .infinity
      )
      if let headingSwitch, let difference = headingDifference(here),
        difference >= headingOpposesMinimumDifferenceDegrees,
        headingSwitch.distanceMeters <= hereDistanceMeters + accuracyAllowanceMeters
      {
        return (headingSwitch, .headingSwitch)
      }
      if isContinuing, let continuation {
        return (continuation, .continuation)
      }
    } else {
      if limits.isAwayFromAnchor, let explainedSwitch {
        return (explainedSwitch, .continuation)
      }
      // Near the last accepted fix a position cannot tell two passes apart; heading can. Away
      // from it the position can, and gets the chance to (rule 4).
      if !limits.isAwayFromAnchor, let headingSwitch {
        return (headingSwitch, .headingSwitch)
      }
      if let jump {
        return (jump, .jump)
      }
    }
    if let unqualified {
      return (unqualified, .unqualified)
    }
    // Every candidate is a later pass the fix does not qualify for. The vehicle is taken to be
    // where it was, and the fix is measured from there.
    return (
      RouteProjection(
        alongMeters: anchor.alongMeters,
        coordinate: anchor.coordinate,
        courseDegrees: anchor.courseDegrees,
        distanceMeters: navigationDistanceMeters(from: sample.coordinate, to: anchor.coordinate),
        geometrySegmentIndex: anchor.geometrySegmentIndex,
        progress: anchor.progress
      ),
      .unqualified
    )
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
