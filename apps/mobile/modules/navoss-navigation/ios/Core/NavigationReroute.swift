import Foundation

/// A replacement route waiting for the driver's decision in ask-first mode.
struct NavigationRerouteProposal: Equatable, Sendable {
  let id: String
  let createdAt: TimeInterval
  /// Replacement duration minus the selected route's remaining duration. Positive is slower.
  let durationDeltaSeconds: Double
  /// Replacement distance minus the selected route's remaining distance. Positive is longer.
  let distanceDeltaMeters: Double
  let trip: NavOSSCarPlayTrip
}

enum NavigationRerouteAction: Equatable, Sendable {
  case none
  /// Fetch a replacement route now.
  case request
  /// The driver is back on the selected route; the pending proposal was withdrawn.
  case withdrew
  /// The pending proposal passed its response window while no request could be made (a clock
  /// tick during a GPS outage). It is gone; the next replacement installs directly.
  case expired
  /// Install the pending proposal now (the mode no longer asks).
  case installProposal(NavigationRerouteProposal)
}

enum NavigationRerouteDecision: Equatable, Sendable {
  case install
  case propose(NavigationRerouteProposal)
}

/// Reroute consent as a pure state machine, evaluated on every navigation update.
///
/// Safety rules that hold in every mode:
/// - Nothing happens while the driver is on the selected route; NavOSS never swaps a route just
///   to save time.
/// - In ask-first mode a proposal is withdrawn as soon as the driver returns to the selected
///   route, and it cannot strand the driver: if they stay off route for
///   `askFirstResponseSeconds` without answering (CarPlay-only, hands on the wheel), the stale
///   proposal is dropped and a fresh replacement is installed directly. A decline is honoured
///   for `declineCooldownSeconds`, then a new proposal is offered if they are still off route.
/// - Off route, the selected route's maneuver prompts are silenced (see
///   `NavigationSpeechPlanner`), so the driver is never told to make a turn that the old route
///   needed but that is no longer ahead of them.
struct NavigationRerouteConsent {
  static let askFirstResponseSeconds = 45.0
  static let declineCooldownSeconds = 90.0

  private(set) var proposal: NavigationRerouteProposal?
  private(set) var declinedAt: TimeInterval?
  /// Set when an ask-first proposal timed out: the next replacement installs directly.
  private(set) var installsNextReplacement = false

  mutating func reset() {
    proposal = nil
    declinedAt = nil
    installsNextReplacement = false
  }

  mutating func evaluate(
    mode: NavOSSRerouteMode,
    isOffRoute: Bool,
    canRequest: Bool,
    now: TimeInterval
  ) -> NavigationRerouteAction {
    guard isOffRoute else {
      let hadProposal = proposal != nil
      reset()
      return hadProposal ? .withdrew : .none
    }
    if let proposal {
      if mode != .askFirst {
        self.proposal = nil
        return .installProposal(proposal)
      }
      guard now - proposal.createdAt >= Self.askFirstResponseSeconds else {
        return .none
      }
      self.proposal = nil
      installsNextReplacement = true
      return canRequest ? .request : .expired
    }
    guard canRequest else {
      return .none
    }
    if mode == .askFirst, !installsNextReplacement, let declinedAt,
      now - declinedAt < Self.declineCooldownSeconds
    {
      return .none
    }
    return .request
  }

  /// What to do with a replacement route that just arrived.
  mutating func received(
    _ trip: NavOSSCarPlayTrip,
    mode: NavOSSRerouteMode,
    remainingDurationSeconds: Double?,
    remainingDistanceMeters: Double?,
    now: TimeInterval,
    id: String = UUID().uuidString
  ) -> NavigationRerouteDecision {
    guard mode == .askFirst, !installsNextReplacement else {
      return .install
    }
    let proposal = NavigationRerouteProposal(
      id: id,
      createdAt: now,
      durationDeltaSeconds: trip.durationSeconds - (remainingDurationSeconds ?? trip.durationSeconds),
      distanceDeltaMeters: trip.distanceMeters - (remainingDistanceMeters ?? trip.distanceMeters),
      trip: trip
    )
    self.proposal = proposal
    return .propose(proposal)
  }

  /// The driver accepted proposal `id`. Returns the route to install, or `nil` if that proposal
  /// is no longer pending or its response window has passed.
  mutating func accept(id: String, now: TimeInterval) -> NavOSSCarPlayTrip? {
    guard let proposal, proposal.id == id,
      now - proposal.createdAt < Self.askFirstResponseSeconds
    else {
      return nil
    }
    self.proposal = nil
    declinedAt = nil
    return proposal.trip
  }

  /// The driver declined proposal `id`; they keep the selected route.
  mutating func decline(id: String, now: TimeInterval) -> Bool {
    guard let proposal, proposal.id == id else {
      return false
    }
    self.proposal = nil
    declinedAt = now
    installsNextReplacement = false
    return true
  }
}

/// How far ahead on the selected route a keep-route recovery rejoins it.
let navigationKeepRouteRejoinAheadMeters = 800.0
/// Closer than this to the destination there is nothing left to keep; recover directly.
let navigationKeepRouteMinimumRemainingMeters = 300.0

/// Along-route point where a keep-route recovery should rejoin the selected route: ahead of the
/// last confirmed position, never behind it, so the replacement cannot send the driver back.
/// `nil` when the selected route is nearly finished.
func navigationKeepRouteRejoinAlongMeters(
  fixAlongMeters: Double,
  routeLengthMeters: Double
) -> Double? {
  let target = fixAlongMeters + navigationKeepRouteRejoinAheadMeters
  guard target <= routeLengthMeters - navigationKeepRouteMinimumRemainingMeters else {
    return nil
  }
  return target
}

/// Whether a replacement route may still be installed. Evaluated under the service lock in the
/// same transaction as the install, so a driver who rejoined the selected route after the
/// replacement was fetched or accepted keeps the selected route.
func navigationShouldInstallReplacement(
  generationMatches: Bool,
  requestMatches: Bool,
  tripMatches: Bool,
  phase: NavigationPhase,
  isOffRoute: Bool
) -> Bool {
  generationMatches && requestMatches && tripMatches && phase == .tracking && isOffRoute
}

/// Routes a reroute asks the server for. Once the vehicle has been matched on the route it
/// left, the fastest route from where it is (one route, as always). Before that, the driver has
/// not driven any of the route they chose yet, so the server's alternatives are asked for and
/// the one closest to that choice is taken (`navigationReplacement`). Stops ask for one route:
/// the router offers no alternatives through them.
func navigationRerouteAlternatives(hasMatchedRoute: Bool, waypointCount: Int) -> Int {
  hasMatchedRoute || waypointCount > 0 ? 0 : 2
}

/// Route geometry from one router follows the same road to well within this; separate
/// carriageways (Highway 401's Express and Collector lanes) are 20 m or more apart.
let navigationSharedRoadToleranceMeters = 10.0

/// The replacement to take from a reroute's answer. Once matched, the server's first. Before
/// the first match, the one that follows most of the driver's chosen route and least road it
/// does not (shared length less unshared length, sampled every
/// `navigationSharedRoadToleranceMeters`); ties keep the server's order.
func navigationReplacement(
  from candidates: [NavOSSCarPlayTrip],
  closestTo selected: NavOSSCarPlayTrip,
  hasMatchedRoute: Bool
) -> NavOSSCarPlayTrip? {
  guard !hasMatchedRoute, candidates.count > 1,
    let chosen = try? RoutePolyline(coordinates: selected.geometry.map {
      NavigationCoordinate(latitude: $0.latitude, longitude: $0.longitude)
    })
  else {
    return candidates.first
  }
  func similarityMeters(_ candidate: NavOSSCarPlayTrip) -> Double {
    var score = 0.0
    for (start, end) in zip(candidate.geometry, candidate.geometry.dropFirst()) {
      let from = NavigationCoordinate(latitude: start.latitude, longitude: start.longitude)
      let to = NavigationCoordinate(latitude: end.latitude, longitude: end.longitude)
      let length = navigationDistanceMeters(from: from, to: to)
      let count = max(1, Int((length / navigationSharedRoadToleranceMeters).rounded(.up)))
      for index in 0..<count {
        let fraction = (Double(index) + 0.5) / Double(count)
        let point = NavigationCoordinate(
          latitude: from.latitude + (to.latitude - from.latitude) * fraction,
          longitude: from.longitude + (to.longitude - from.longitude) * fraction)
        let isShared = chosen.segmentIndices(
          near: point, radiusMeters: navigationSharedRoadToleranceMeters
        ).contains {
          chosen.project(point, ontoSegment: $0).distanceMeters
            <= navigationSharedRoadToleranceMeters
        }
        score += isShared ? length / Double(count) : -length / Double(count)
      }
    }
    return score
  }
  var best: (trip: NavOSSCarPlayTrip, score: Double)?
  for candidate in candidates {
    let score = similarityMeters(candidate)
    if best.map({ score > $0.score }) ?? true {
      best = (candidate, score)
    }
  }
  return best?.trip
}

/// Fetches a recovery route. With a keep-route rejoin point the route goes back onto the
/// selected route first, passing through the rejoin point (a `/v2/routes` `through` waypoint,
/// which adds no arrival or departure there). If that request fails for any reason (the API
/// answers 400 for an unroutable request and 503 when the router fails, and a `/v1/routes`-only
/// server cannot pass through a point at all), one plain recovery route is tried, because
/// recovering matters more than keeping the route. A rejoin route that still stops at the rejoin
/// point (more arrivals than real stops) is treated as a failure too.
func navigationFetchRecoveryRoute(
  rejoin: NavOSSCarPlayDestination?,
  remainingWaypoints: [NavOSSCarPlayDestination],
  fetch: ([NavOSSCarPlayDestination], Set<String>) async throws -> NavOSSCarPlayTrip?
) async throws -> NavOSSCarPlayTrip? {
  if let rejoin {
    do {
      if let fetched = try await fetch([rejoin] + remainingWaypoints, [rejoin.id]),
        fetched.steps.filter({ $0.maneuverType == "arrive" }).count
          <= remainingWaypoints.count + 1
      {
        return fetched
      }
    } catch {
      try Task.checkCancellation()
    }
  }
  return try await fetch(remainingWaypoints, [])
}

/// When another replacement route may be asked for while the driver keeps going their own way.
///
/// Measured on a straight 2.4 km detour up the next avenue of a 200 m street grid, every
/// replacement from where the vehicle was told it to turn back at the next street; the driver
/// went straight on, left that route 35 m past the street on the third fix and got another one:
/// twelve installs in adaptive and keep-route mode, a proposal every block in ask-first mode.
/// The rule:
///
/// - The first request after the driver leaves a route they were established on is never held.
/// - Once a replacement has been answered in this detour (installed, proposed, or found to be the
///   route already followed), the next request waits until the vehicle has travelled
///   `firstSpacingMeters` and `firstSpacingSeconds` have passed since that answer, doubling with
///   every further answer up to `maximumSpacingMeters` and `maximumSpacingSeconds`, and never
///   longer than either of those: whichever comes first, provided the vehicle has moved. Then, still
///   off the route it was given (past its turn back, or further from it than a departure), the
///   driver gets a fresh route from where they are, whichever way they are going: a driver is
///   never left for long with a route whose next turn is behind them.
/// - The replacement owed for an ask-first proposal nobody answered waits for the time spacing
///   only (`allowsRequest(now:isOwed:)`).
/// - The driver is established, and the count starts again, after `establishedMeters` and
///   `establishedSeconds` on a route without leaving it.
///
/// An answer that changes nothing is not installed (`navigationIsMateriallySameRoute`); it still
/// counts as an answer. Failed requests keep their own retry schedule
/// (`navigationRerouteRetryDelaySeconds`) and do not count as answers.
struct NavigationRerouteSpacing {
  static let firstSpacingMeters = 400.0
  static let firstSpacingSeconds = 20.0
  /// The most a driver who keeps going their own way drives, or waits while moving, before the
  /// next fresh route: in town 60 s is about 700 m.
  static let maximumSpacingMeters = 800.0
  static let maximumSpacingSeconds = 60.0
  static let establishedMeters = 500.0
  static let establishedSeconds = 30.0
  /// Travel is counted in steps longer than this or the fix's accuracy, so a parked receiver's
  /// wandering fixes add nothing.
  static let travelStepMeters = 15.0

  /// Replacements answered since the driver was last established on a route.
  private(set) var answers = 0
  private var lastAnswer: (time: TimeInterval, travelMeters: Double)?
  private var onRouteSince: (time: TimeInterval, travelMeters: Double)?
  private var travelAnchor: NavigationCoordinate?
  /// Distance the vehicle has covered since the trip started.
  private(set) var travelMeters = 0.0

  /// The spacing after `answers` answers.
  static func spacing(answers: Int) -> (meters: Double, seconds: Double) {
    let factor = pow(2, Double(max(0, min(answers, 8) - 1)))
    return (
      min(maximumSpacingMeters, firstSpacingMeters * factor),
      min(maximumSpacingSeconds, firstSpacingSeconds * factor)
    )
  }

  /// A published fix: where the vehicle is and whether it is on its route.
  mutating func observe(
    coordinate: NavigationCoordinate?,
    accuracyMeters: Double?,
    isOffRoute: Bool,
    isMatched: Bool,
    now: TimeInterval
  ) {
    if let coordinate {
      if let anchor = travelAnchor {
        let step = navigationDistanceMeters(from: anchor, to: coordinate)
        if step > max(Self.travelStepMeters, accuracyMeters ?? 0) {
          travelMeters += step
          travelAnchor = coordinate
        }
      } else {
        travelAnchor = coordinate
      }
    }
    guard !isOffRoute, isMatched else {
      onRouteSince = nil
      return
    }
    let since = onRouteSince ?? (now, travelMeters)
    onRouteSince = since
    if now - since.time >= Self.establishedSeconds,
      travelMeters - since.travelMeters >= Self.establishedMeters
    {
      answers = 0
      lastAnswer = nil
    }
  }

  /// Whether a request may be made now, for a vehicle off its route. `isOwed` for the
  /// replacement an unanswered ask-first proposal is owed
  /// (`NavigationRerouteConsent.installsNextReplacement`): it waits for the time spacing only,
  /// which the 45 s response window has always covered, so a driver who could not answer (or
  /// whose GPS dropped out meanwhile) is not left without a route.
  func allowsRequest(now: TimeInterval, isOwed: Bool = false) -> Bool {
    guard answers > 0, let lastAnswer else {
      return true
    }
    let spacing = Self.spacing(answers: answers)
    let elapsed = now - lastAnswer.time
    let travelled = travelMeters - lastAnswer.travelMeters
    // The ceilings bound the wait whichever is reached first; a vehicle that has not moved since
    // the answer is not routed again from the same place.
    if travelled >= Self.maximumSpacingMeters
      || (elapsed >= Self.maximumSpacingSeconds && travelled > 0)
    {
      return true
    }
    guard elapsed >= spacing.seconds else {
      return false
    }
    return isOwed || travelled >= spacing.meters
  }

  /// A replacement was answered: installed, proposed, or found to be the route followed.
  mutating func answered(now: TimeInterval) {
    answers += 1
    lastAnswer = (now, travelMeters)
  }

  /// The route was replaced: time on the old one does not count towards the new one.
  mutating func routeReplaced() {
    onRouteSince = nil
  }
}

/// A replacement may leave the route it is compared with for this long and still be that route:
/// the router snapping the origin onto the road, or a step back onto it from right beside it (the
/// shoulder, a lay-by). A way back from a road 100 m away is a real instruction and is not this.
let navigationSameRouteUnsharedMeters = 50.0
/// Within this of a route, in its direction, a replacement is on the same road.
let navigationSameRouteToleranceMeters = 20.0
/// Further than this from a route's course, a replacement drives that road the other way.
let navigationSameRouteCourseToleranceDegrees = 60.0

/// An answer along the route followed is the rest of it from the vehicle's match (and dropped)
/// when its length is within this of the route left from that match: the router started where
/// the matcher's anchor is. Longer, the vehicle is behind its match (a GPS gap); shorter, it is
/// ahead of it or past a loop. Either way the matcher, which only moves forwards and only so far,
/// may not find it on the route, so the answer is installed as any other.
let navigationRestOfRouteToleranceMeters = 50.0

/// The length of `trip`'s geometry.
func navigationRouteLengthMeters(_ trip: NavOSSCarPlayTrip) -> Double {
  zip(trip.geometry, trip.geometry.dropFirst()).reduce(0.0) { total, leg in
    total
      + navigationDistanceMeters(
        from: NavigationCoordinate(latitude: leg.0.latitude, longitude: leg.0.longitude),
        to: NavigationCoordinate(latitude: leg.1.latitude, longitude: leg.1.longitude))
  }
}

/// Whether `candidate` is materially `reference`: all of it but `navigationSameRouteUnsharedMeters`
/// follows `reference`'s roads in `reference`'s direction (sampled every
/// `navigationSharedRoadToleranceMeters`). Such a replacement changes nothing the driver is
/// told, so it is not installed or offered.
func navigationIsMateriallySameRoute(
  _ candidate: NavOSSCarPlayTrip,
  as reference: NavOSSCarPlayTrip
) -> Bool {
  guard candidate.destination.latitude == reference.destination.latitude,
    candidate.destination.longitude == reference.destination.longitude,
    let route = try? RoutePolyline(coordinates: reference.geometry.map {
      NavigationCoordinate(latitude: $0.latitude, longitude: $0.longitude)
    })
  else {
    return false
  }
  var unsharedMeters = 0.0
  for (start, end) in zip(candidate.geometry, candidate.geometry.dropFirst()) {
    let from = NavigationCoordinate(latitude: start.latitude, longitude: start.longitude)
    let to = NavigationCoordinate(latitude: end.latitude, longitude: end.longitude)
    let length = navigationDistanceMeters(from: from, to: to)
    guard length > 0 else { continue }
    let course = navigationCourseDegrees(from: from, to: to)
    let count = max(1, Int((length / navigationSharedRoadToleranceMeters).rounded(.up)))
    for index in 0..<count {
      let fraction = (Double(index) + 0.5) / Double(count)
      let point = NavigationCoordinate(
        latitude: from.latitude + (to.latitude - from.latitude) * fraction,
        longitude: from.longitude + (to.longitude - from.longitude) * fraction)
      let isShared = route.segmentIndices(
        near: point, radiusMeters: navigationSameRouteToleranceMeters
      ).contains {
        let projection = route.project(point, ontoSegment: $0)
        return projection.distanceMeters <= navigationSameRouteToleranceMeters
          && navigationCourseDifferenceDegrees(course, projection.courseDegrees)
            <= navigationSameRouteCourseToleranceDegrees
      }
      if !isShared {
        unsharedMeters += length / Double(count)
        if unsharedMeters > navigationSameRouteUnsharedMeters {
          return false
        }
      }
    }
  }
  return true
}

/// The vehicle's direction of travel from its recent fixes, for a reroute origin the platform
/// gives no heading for (a course reported invalid, or too slow to trust): the bearing from the
/// latest fix back to the most recent one at least `navigationTrackHeadingMinimumMeters` away
/// and no more than `navigationTrackHeadingMaximumSeconds` older. `nil` when the vehicle has not
/// moved that far lately. Without a heading the router may start the route either way along
/// the road, and one that starts with a U-turn is left again on its first fixes.
let navigationTrackHeadingMinimumMeters = 20.0
let navigationTrackHeadingMaximumSeconds = 10.0

func navigationTrackHeadingDegrees(
  _ track: [(coordinate: NavigationCoordinate, time: TimeInterval)]
) -> Double? {
  guard let latest = track.last else {
    return nil
  }
  for earlier in track.dropLast().reversed() {
    guard latest.time - earlier.time <= navigationTrackHeadingMaximumSeconds else {
      return nil
    }
    if navigationDistanceMeters(from: earlier.coordinate, to: latest.coordinate)
      >= navigationTrackHeadingMinimumMeters
    {
      return navigationCourseDegrees(from: earlier.coordinate, to: latest.coordinate)
    }
  }
  return nil
}
