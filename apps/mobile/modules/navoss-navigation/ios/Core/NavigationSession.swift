import Foundation

enum NavigationSessionError: Error, Equatable {
  case noActiveTrip
}

struct NavigationSessionUpdate: Equatable, Sendable {
  let guidance: NavOSSCarPlayGuidance?
  let roadContext: NavigationRoadContext
  let snapshot: NavigationSnapshot
  let trip: NavOSSCarPlayTrip?
  /// Whether, from when, how fast and how far the CarPlay map may carry the vehicle on past this
  /// update's matched position (`NavOSSCarPlayRunOn`); nil when it must not.
  var carPlayRunOn: NavOSSCarPlayRunOn? = nil

  /// The same update without its guidance or road context: what a restored trip presents until
  /// it is matched again, instead of the maneuver, distances, lanes, road, speed limit and
  /// estimate derived from its checkpoint.
  func withoutGuidance() -> NavigationSessionUpdate {
    NavigationSessionUpdate(
      guidance: nil, roadContext: .unknown, snapshot: snapshot, trip: trip,
      carPlayRunOn: carPlayRunOn)
  }
}

final class NavigationSession {
  private let core: NavigationCore
  private var stepGeometry: NavigationStepGeometry?
  private(set) var trip: NavOSSCarPlayTrip?

  init(core: NavigationCore = NavigationCore()) {
    self.core = core
  }

  /// What resuming the active trip later needs. See `NavigationCore.resumeContext`.
  var resumeContext: NavigationResumeContext? {
    trip == nil ? nil : core.resumeContext
  }

  /// Length of the active route geometry in metres.
  var routeLengthMeters: Double? {
    core.routeLengthMeters
  }

  /// Whether a fix has been matched on the active route. See `NavigationCore.hasMatchedRoute`.
  var hasMatchedRoute: Bool {
    core.hasMatchedRoute
  }

  func currentUpdate() -> NavigationSessionUpdate {
    update(for: core.currentSnapshot())
  }

  /// Starts guiding `trip`. `resume` is how a trip restored after a relaunch carries on; `nil`
  /// starts a new trip, whose first fix is placed on the route from nothing.
  @discardableResult
  func start(
    _ trip: NavOSSCarPlayTrip,
    resume: NavigationResumePoint? = nil
  ) throws -> NavigationSessionUpdate {
    guard trip.isValid else {
      throw NavigationCoreError.invalidRoute
    }
    let snapshot = try core.setRoute(
      trip.geometry.map {
        NavigationCoordinate(latitude: $0.latitude, longitude: $0.longitude)
      },
      resume: resume
    )
    self.trip = trip
    stepGeometry = NavigationStepGeometry(trip: trip)
    return update(for: snapshot)
  }

  @discardableResult
  func clear() -> NavigationSessionUpdate {
    trip = nil
    stepGeometry = nil
    return NavigationSessionUpdate(
      guidance: nil,
      roadContext: .unknown,
      snapshot: core.clearRoute(),
      trip: nil
    )
  }

  /// The latest fix applied to the current route (see `NavigationCore.lastAppliedFix`).
  var lastAppliedFix: NavigationLocationSample? { core.lastAppliedFix }

  @discardableResult
  func updateLocation(_ sample: NavigationLocationSample) throws -> NavigationSessionUpdate {
    guard trip != nil else {
      throw NavigationSessionError.noActiveTrip
    }
    return update(for: try core.updateLocation(sample))
  }

  /// Extrapolates through a gap in fixes; `nil` when the core declines (see
  /// `NavigationCore.deadReckon`).
  ///
  /// Extrapolation stops `deadReckoningManeuverMarginMeters` before the next maneuver after the
  /// last real fix: a driver who loses GPS approaching a turn may slow, stop or miss it, so
  /// guidance must not move on to later maneuvers until a fix confirms the turn.
  func deadReckon(at timestamp: TimeInterval) -> NavigationSessionUpdate? {
    guard trip != nil, let stepGeometry, let fixAlong = core.fixAlongMeters else {
      return nil
    }
    let maneuverCap = stepGeometry.nextStepStart(after: fixAlong).map {
      $0 - Self.deadReckoningManeuverMarginMeters
    }
    guard let snapshot = core.deadReckon(at: timestamp, maximumAlongMeters: maneuverCap) else {
      return nil
    }
    return update(for: snapshot)
  }

  static let deadReckoningManeuverMarginMeters = 15.0

  /// See `NavigationCore.rejoinBaseAlongMeters(near:)`.
  func rejoinBaseAlongMeters(near coordinate: NavigationCoordinate) -> Double? {
    core.rejoinBaseAlongMeters(near: coordinate)
  }

  /// The on-route point `alongMeters` from the active route's origin.
  func routePoint(alongMeters: Double) -> NavigationCoordinate? {
    core.routePoint(alongMeters: alongMeters)
  }

  /// See `NavigationCore.forgetPassConfirmation()`.
  func forgetPassConfirmation() {
    core.forgetPassConfirmation()
  }

  /// See `NavigationCore.acceptedLatestFix`.
  var acceptedLatestFix: Bool { core.acceptedLatestFix }

  /// See `NavigationCore.distances(from:)`.
  func distances(
    from coordinate: NavigationCoordinate
  ) -> (routeMeters: Double, destinationMeters: Double)? {
    trip == nil ? nil : core.distances(from: coordinate)
  }

  private func update(for snapshot: NavigationSnapshot) -> NavigationSessionUpdate {
    guard let trip, let stepGeometry else {
      return NavigationSessionUpdate(
        guidance: nil,
        roadContext: .unknown,
        snapshot: snapshot,
        trip: nil
      )
    }
    let guidance = navigationGuidance(trip: trip, stepGeometry: stepGeometry, snapshot: snapshot)
    return NavigationSessionUpdate(
      guidance: guidance,
      roadContext: navigationRoadContext(trip: trip, guidance: guidance, snapshot: snapshot),
      snapshot: snapshot,
      trip: trip,
      carPlayRunOn: carPlayRunOn(for: snapshot, stepGeometry: stepGeometry)
    )
  }

  /// The CarPlay map may carry the vehicle on only from the latest real fix the matcher accepted on
  /// the route, with the speed that fix reported, and no further than this session's own dead
  /// reckoning would go: `deadReckoningManeuverMarginMeters` short of the next maneuver after the
  /// fix, and short of arrival. A held or rejected fix, a dead-reckoned update, a fix without a
  /// speed or time, and an off-route or unmatched one carry nothing.
  private func carPlayRunOn(
    for snapshot: NavigationSnapshot,
    stepGeometry: NavigationStepGeometry
  ) -> NavOSSCarPlayRunOn? {
    guard snapshot.phase == .tracking, !snapshot.isOffRoute, !snapshot.isDeadReckoning,
      snapshot.matchedCoordinate != nil, core.acceptedLatestFix,
      let fix = core.lastAppliedFix, let timestamp = fix.timestamp, timestamp.isFinite,
      let speed = fix.speedMetersPerSecond, speed.isFinite, speed >= 0, speed <= 100,
      let length = core.routeLengthMeters, length > 0, let fixAlong = core.fixAlongMeters
    else { return nil }
    var limit = length * arrivalProgressThreshold
    if let maneuver = stepGeometry.nextStepStart(after: fixAlong) {
      limit = min(limit, maneuver - Self.deadReckoningManeuverMarginMeters)
    }
    return NavOSSCarPlayRunOn(
      fixTimestamp: timestamp,
      speedMetersPerSecond: speed,
      limitProgress: min(1, max(0, max(fixAlong, limit) / length))
    )
  }
}
