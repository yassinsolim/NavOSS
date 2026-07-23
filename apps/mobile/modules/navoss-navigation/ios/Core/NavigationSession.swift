import Foundation

enum NavigationSessionError: Error, Equatable {
  case noActiveTrip
}

struct NavigationSessionUpdate: Equatable, Sendable {
  let guidance: NavOSSCarPlayGuidance?
  let snapshot: NavigationSnapshot
  let trip: NavOSSCarPlayTrip?
}

final class NavigationSession {
  private let core: NavigationCore
  private(set) var trip: NavOSSCarPlayTrip?

  init(core: NavigationCore = NavigationCore()) {
    self.core = core
  }

  func currentUpdate() -> NavigationSessionUpdate {
    let snapshot = core.currentSnapshot()
    return NavigationSessionUpdate(
      guidance: guidance(for: snapshot),
      snapshot: snapshot,
      trip: trip
    )
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
    return NavigationSessionUpdate(
      guidance: guidance(for: snapshot),
      snapshot: snapshot,
      trip: trip
    )
  }

  @discardableResult
  func clear() -> NavigationSessionUpdate {
    trip = nil
    return NavigationSessionUpdate(
      guidance: nil,
      snapshot: core.clearRoute(),
      trip: nil
    )
  }

  @discardableResult
  func updateLocation(_ sample: NavigationLocationSample) throws -> NavigationSessionUpdate {
    guard trip != nil else {
      throw NavigationSessionError.noActiveTrip
    }
    let snapshot = try core.updateLocation(sample)
    return NavigationSessionUpdate(
      guidance: guidance(for: snapshot),
      snapshot: snapshot,
      trip: trip
    )
  }

  private func guidance(for snapshot: NavigationSnapshot) -> NavOSSCarPlayGuidance? {
    guard let trip, snapshot.phase != .idle else {
      return nil
    }
    if snapshot.phase == .arrived {
      let arrivalStep = trip.steps[trip.steps.count - 1]
      return NavOSSCarPlayGuidance(
        distanceToManeuverMeters: 0,
        durationToManeuverSeconds: 0,
        instruction: arrivalStep.instruction,
        maneuverType: arrivalStep.maneuverType,
        phase: .arrived,
        remainingDistanceMeters: 0,
        remainingDurationSeconds: 0,
        roadName: arrivalStep.roadName,
        stepIndex: trip.steps.count - 1
      )
    }

    let totalStepDistance = trip.steps.reduce(0) { $0 + $1.distanceMeters }
    let completedDistance = max(0, min(1, snapshot.routeProgress)) * totalStepDistance
    var traversedDistance = 0.0
    var currentStepIndex = trip.steps.count - 1
    var currentStepProgress = 1.0

    for (index, step) in trip.steps.enumerated() {
      let stepEnd = traversedDistance + step.distanceMeters
      if completedDistance <= stepEnd || index == trip.steps.count - 1 {
        currentStepIndex = index
        currentStepProgress =
          step.distanceMeters == 0
          ? 1
          : max(0, min(1, (completedDistance - traversedDistance) / step.distanceMeters))
        break
      }
      traversedDistance = stepEnd
    }

    let currentStep = trip.steps[currentStepIndex]
    let remainingStepFraction = 1 - currentStepProgress
    let distanceToManeuver = currentStep.distanceMeters * remainingStepFraction
    let durationToManeuver = currentStep.durationSeconds * remainingStepFraction
    let laterSteps = trip.steps.dropFirst(currentStepIndex + 1)
    let remainingDistance =
      distanceToManeuver
      + laterSteps.reduce(0) {
        $0 + $1.distanceMeters
      }
    let remainingDuration =
      durationToManeuver
      + laterSteps.reduce(0) {
        $0 + $1.durationSeconds
      }
    let guidanceStep = trip.steps[min(currentStepIndex + 1, trip.steps.count - 1)]

    return NavOSSCarPlayGuidance(
      distanceToManeuverMeters: distanceToManeuver,
      durationToManeuverSeconds: durationToManeuver,
      instruction: guidanceStep.instruction,
      maneuverType: guidanceStep.maneuverType,
      phase: .navigating,
      remainingDistanceMeters: remainingDistance,
      remainingDurationSeconds: remainingDuration,
      roadName: guidanceStep.roadName,
      stepIndex: currentStepIndex
    )
  }
}
