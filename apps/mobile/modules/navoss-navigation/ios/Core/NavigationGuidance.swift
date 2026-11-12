import Foundation

/// Where each route step starts along the route geometry.
///
/// Route steps carry their own geometry, which the API slices from the route geometry. Locating
/// each step's first vertex in the route geometry gives its along-route start, so the current
/// step is read straight from the matched position instead of being inferred by spreading route
/// progress proportionally over step distances (which drifts wherever step distances and
/// geometry length disagree, e.g. on long curved ramps).
struct NavigationStepGeometry: Equatable, Sendable {
  /// Along-route metres at which each step starts. Non-decreasing, one entry per step.
  let stepStartAlongMeters: [Double]
  let routeLengthMeters: Double
  /// Whether every step was located in the route geometry. When not, starts are proportional
  /// to step distances, which is the best available fallback.
  let isAligned: Bool

  /// A step vertex this close to a route vertex is treated as the same point.
  private static let vertexMatchToleranceMeters = 3.0

  init(trip: NavOSSCarPlayTrip) {
    let geometry = trip.geometry.map {
      NavigationCoordinate(latitude: $0.latitude, longitude: $0.longitude)
    }
    var cumulative = [0.0]
    cumulative.reserveCapacity(geometry.count)
    for index in geometry.indices.dropFirst() {
      cumulative.append(
        cumulative[index - 1] + navigationDistanceMeters(from: geometry[index - 1], to: geometry[index])
      )
    }
    let routeLength = cumulative.last ?? 0
    routeLengthMeters = routeLength

    var starts: [Double] = []
    starts.reserveCapacity(trip.steps.count)
    var searchFrom = 0
    var aligned = true
    for step in trip.steps {
      guard let first = step.geometry.first else {
        aligned = false
        break
      }
      let target = NavigationCoordinate(latitude: first.latitude, longitude: first.longitude)
      // Steps run in route order, so each search resumes where the previous step started. That
      // keeps an out-and-back from matching the outbound vertex for a return-leg step, and makes
      // the whole alignment a single pass over the geometry.
      var found: Int?
      var index = searchFrom
      while index < geometry.count {
        if geometry[index] == target
          || navigationDistanceMeters(from: geometry[index], to: target)
            <= Self.vertexMatchToleranceMeters
        {
          found = index
          break
        }
        index += 1
      }
      guard let found else {
        aligned = false
        break
      }
      starts.append(cumulative[found])
      searchFrom = found
    }

    if aligned, starts.count == trip.steps.count {
      stepStartAlongMeters = starts
      isAligned = true
    } else {
      let totalStepDistance = trip.steps.reduce(0) { $0 + $1.distanceMeters }
      var traversed = 0.0
      stepStartAlongMeters = trip.steps.map { step in
        defer { traversed += step.distanceMeters }
        return totalStepDistance > 0 ? traversed / totalStepDistance * routeLength : 0
      }
      isAligned = false
    }
  }

  /// Index of the step containing `alongMeters`: the last step that starts at or before it.
  func stepIndex(atAlong alongMeters: Double) -> Int {
    var low = 0
    var high = stepStartAlongMeters.count - 1
    while low < high {
      let middle = (low + high + 1) / 2
      if stepStartAlongMeters[middle] <= alongMeters {
        low = middle
      } else {
        high = middle - 1
      }
    }
    return low
  }

  /// Fraction of step `index`'s geometry still ahead of `alongMeters`, in 0...1.
  func remainingFraction(ofStep index: Int, atAlong alongMeters: Double) -> Double {
    let start = stepStartAlongMeters[index]
    let end = index + 1 < stepStartAlongMeters.count
      ? stepStartAlongMeters[index + 1]
      : routeLengthMeters
    guard end > start else {
      return 0
    }
    return max(0, min(1, (end - alongMeters) / (end - start)))
  }
}

/// Context of the matched position that the route itself can vouch for.
struct NavigationRoadContext: Equatable, Sendable {
  /// Name of the road being driven, from the current step. `nil` when the route has none.
  let currentRoadName: String?
  /// Posted limit at the matched segment from the route's geometry-aligned annotations. `nil`
  /// when unknown, unmatched or off route; never guessed.
  let speedLimitKph: Int?

  static let unknown = NavigationRoadContext(currentRoadName: nil, speedLimitKph: nil)
}

func navigationGuidance(
  trip: NavOSSCarPlayTrip,
  stepGeometry: NavigationStepGeometry,
  snapshot: NavigationSnapshot
) -> NavOSSCarPlayGuidance? {
  guard snapshot.phase != .idle, !trip.steps.isEmpty else {
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

  let alongMeters = max(0, min(1, snapshot.routeProgress)) * stepGeometry.routeLengthMeters
  let currentStepIndex = min(stepGeometry.stepIndex(atAlong: alongMeters), trip.steps.count - 1)
  let currentStep = trip.steps[currentStepIndex]
  // The step's own distance and duration stay authoritative for the numbers shown and spoken;
  // geometry decides which step this is and how much of it is left.
  let remainingFraction = stepGeometry.remainingFraction(
    ofStep: currentStepIndex,
    atAlong: alongMeters
  )
  let distanceToManeuver = currentStep.distanceMeters * remainingFraction
  let durationToManeuver = currentStep.durationSeconds * remainingFraction
  let laterSteps = trip.steps.dropFirst(currentStepIndex + 1)
  let guidanceStep = trip.steps[min(currentStepIndex + 1, trip.steps.count - 1)]

  return NavOSSCarPlayGuidance(
    distanceToManeuverMeters: distanceToManeuver,
    durationToManeuverSeconds: durationToManeuver,
    instruction: guidanceStep.instruction,
    maneuverType: guidanceStep.maneuverType,
    phase: .navigating,
    remainingDistanceMeters: distanceToManeuver + laterSteps.reduce(0) { $0 + $1.distanceMeters },
    remainingDurationSeconds: durationToManeuver
      + laterSteps.reduce(0) { $0 + $1.durationSeconds },
    roadName: guidanceStep.roadName,
    stepIndex: currentStepIndex
  )
}

func navigationRoadContext(
  trip: NavOSSCarPlayTrip,
  guidance: NavOSSCarPlayGuidance?,
  snapshot: NavigationSnapshot
) -> NavigationRoadContext {
  guard snapshot.phase == .tracking, !snapshot.isOffRoute, snapshot.matchedCoordinate != nil,
    let guidance
  else {
    return .unknown
  }
  let roadName = trip.steps[min(guidance.stepIndex, trip.steps.count - 1)].roadName
    .trimmingCharacters(in: .whitespacesAndNewlines)
  let speedLimit = snapshot.geometrySegmentIndex.flatMap { index -> Int? in
    guard let limits = trip.speedLimitsKph, limits.indices.contains(index), limits[index] > 0
    else {
      return nil
    }
    return limits[index]
  }
  return NavigationRoadContext(
    currentRoadName: roadName.isEmpty ? nil : roadName,
    speedLimitKph: speedLimit
  )
}
