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
    // Steps run in route order, so each search resumes after the previous step. That keeps an
    // out-and-back (or a loop closing on its own start) from matching an earlier visit of the
    // same coordinate, and makes alignment a single forward pass over the geometry.
    var searchFrom = 0
    // Where the previous step's geometry ended, when it was an exact slice of the route.
    var expectedStart: Int?
    var aligned = true
    for step in trip.steps {
      guard let first = step.geometry.first else {
        aligned = false
        break
      }
      let target = NavigationCoordinate(latitude: first.latitude, longitude: first.longitude)
      let found: Int?
      if let expectedStart, expectedStart < geometry.count, geometry[expectedStart] == target {
        found = expectedStart
      } else {
        // Exact matches first: a nearby earlier vertex (a 2 m first step) must not win over
        // the vertex the step actually starts at.
        found = geometry[searchFrom...].firstIndex(of: target)
          ?? geometry[searchFrom...].firstIndex {
            navigationDistanceMeters(from: $0, to: target) <= Self.vertexMatchToleranceMeters
          }
      }
      guard let found else {
        aligned = false
        break
      }
      starts.append(cumulative[found])

      // Only a zero-length step (an arrival or a maneuver point) shares its start with the
      // next step; anything longer consumes at least one vertex.
      if step.geometry.allSatisfy({ $0 == first }) {
        searchFrom = found
        expectedStart = found
        continue
      }
      let isExactSlice = found + step.geometry.count <= geometry.count
        && step.geometry.indices.allSatisfy { offset in
          let vertex = geometry[found + offset]
          return vertex.latitude == step.geometry[offset].latitude
            && vertex.longitude == step.geometry[offset].longitude
        }
      if isExactSlice {
        expectedStart = found + step.geometry.count - 1
        searchFrom = found + step.geometry.count - 1
      } else {
        expectedStart = nil
        searchFrom = min(found + 1, geometry.count - 1)
      }
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

  /// Along-route start of the first step beginning after `alongMeters`: the next maneuver ahead.
  func nextStepStart(after alongMeters: Double) -> Double? {
    stepStartAlongMeters.first { $0 > alongMeters + 0.5 }
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
  /// Name of the road being driven: the current step's `currentRoadName` (the road its geometry
  /// follows) when the route states it, else the step's road name. `nil` when neither names it.
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
  let drivenStep = trip.steps[min(guidance.stepIndex, trip.steps.count - 1)]
  let roadName = (drivenStep.currentRoadName ?? drivenStep.roadName)
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
