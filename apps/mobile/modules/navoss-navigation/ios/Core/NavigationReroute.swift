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
