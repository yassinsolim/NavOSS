import Foundation

enum NavigationSessionError: Error, Equatable {
  case noActiveTrip
}

struct NavigationSessionUpdate: Equatable, Sendable {
  let guidance: NavOSSCarPlayGuidance?
  let roadContext: NavigationRoadContext
  let snapshot: NavigationSnapshot
  let trip: NavOSSCarPlayTrip?
}

final class NavigationSession {
  private let core: NavigationCore
  private var stepGeometry: NavigationStepGeometry?
  private(set) var trip: NavOSSCarPlayTrip?

  init(core: NavigationCore = NavigationCore()) {
    self.core = core
  }

  /// Length of the active route geometry in metres.
  var routeLengthMeters: Double? {
    core.routeLengthMeters
  }

  func currentUpdate() -> NavigationSessionUpdate {
    update(for: core.currentSnapshot())
  }

  @discardableResult
  func start(_ trip: NavOSSCarPlayTrip) throws -> NavigationSessionUpdate {
    guard trip.isValid else {
      throw NavigationCoreError.invalidRoute
    }
    let snapshot = try core.setRoute(
      trip.geometry.map {
        NavigationCoordinate(latitude: $0.latitude, longitude: $0.longitude)
      }
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

  @discardableResult
  func updateLocation(_ sample: NavigationLocationSample) throws -> NavigationSessionUpdate {
    guard trip != nil else {
      throw NavigationSessionError.noActiveTrip
    }
    return update(for: try core.updateLocation(sample))
  }

  /// Extrapolates through a gap in fixes; `nil` when the core declines (see
  /// `NavigationCore.deadReckon`).
  func deadReckon(at timestamp: TimeInterval) -> NavigationSessionUpdate? {
    guard trip != nil, let snapshot = core.deadReckon(at: timestamp) else {
      return nil
    }
    return update(for: snapshot)
  }

  /// The on-route point `alongMeters` from the active route's origin.
  func routePoint(alongMeters: Double) -> NavigationCoordinate? {
    core.routePoint(alongMeters: alongMeters)
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
      trip: trip
    )
  }
}
