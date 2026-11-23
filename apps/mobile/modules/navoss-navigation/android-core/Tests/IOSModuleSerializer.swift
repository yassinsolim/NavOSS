import Foundation

@testable import NavOSSNavigationCore

// The iOS module's serializers (`ios/NavOSSNavigationModule.swift`, `serialize(_ state:)` through
// the end of the class), copied verbatim except for the community alert payload, which Android
// does not have. They write the JSON the phone receives today; the facade must write the same.
// When the module's serializers change, copy them again and regenerate the golden files
// (`NAVOSS_REGENERATE_GOLDEN=1`).
enum IOSModuleSerializer {
  static func serialize(_ state: NavOSSNavigationServiceState) -> [String: Any] {
    let snapshot = state.navigation
    var payload: [String: Any] = [
      "isOffRoute": snapshot.isOffRoute,
      "phase": snapshot.phase.rawValue,
      "rerouteCount": state.rerouteCount,
      "routeProgress": snapshot.routeProgress,
      "routeStatus": state.routeStatus.rawValue,
      "routeVersion": snapshot.routeVersion,
      "sequence": snapshot.sequence,
      "stateVersion": state.stateVersion,
      "isDeadReckoning": snapshot.isDeadReckoning,
      "rerouteMode": state.rerouteMode.rawValue,
      "speedingState": state.speedingState.rawValue,
    ]
    if let tripEndReason = state.tripEndReason {
      payload["tripEndReason"] = tripEndReason.rawValue
    }
    if state.isAcquiringPosition {
      payload["isAcquiringPosition"] = true
    }
    if let tripPause = state.tripPause {
      payload["tripPause"] = tripPause.rawValue
    }
    // Android has no community reports: `NavOSSCommunityBridge.navigationAlertsPayload()` omitted.

    if let speedMetersPerSecond = snapshot.speedMetersPerSecond {
      payload["speedMetersPerSecond"] = speedMetersPerSecond
    }
    if let speedLimitKph = state.roadContext.speedLimitKph {
      payload["speedLimitKph"] = speedLimitKph
    }
    if let currentRoadName = state.roadContext.currentRoadName {
      payload["currentRoadName"] = currentRoadName
    }
    if let proposal = state.rerouteProposal {
      payload["rerouteProposal"] = [
        "createdAtMs": Date(timeIntervalSinceReferenceDate: proposal.createdAt)
          .timeIntervalSince1970 * 1_000,
        "distanceDeltaMeters": proposal.distanceDeltaMeters,
        "distanceMeters": proposal.trip.distanceMeters,
        "durationDeltaSeconds": proposal.durationDeltaSeconds,
        "durationSeconds": proposal.trip.durationSeconds,
        "id": proposal.id,
        "respondWithinSeconds": NavigationRerouteConsent.askFirstResponseSeconds,
        "trip": IOSModuleSerializer.serialize(proposal.trip),
      ] as [String: Any]
    }
    if let alert = state.safetyCameraAlert {
      payload["safetyCameraAlert"] = [
        "cameraId": alert.cameraId,
        "distanceAheadMeters": alert.distanceAheadMeters,
        "location": alert.location,
        "sequence": alert.sequence,
      ] as [String: Any]
    }

    if let rawCoordinate = snapshot.rawCoordinate {
      payload["rawCoordinate"] = IOSModuleSerializer.serialize(rawCoordinate)
    }
    if let matchedCoordinate = snapshot.matchedCoordinate {
      payload["matchedCoordinate"] = IOSModuleSerializer.serialize(matchedCoordinate)
    }
    if let matchedCourseDegrees = snapshot.matchedCourseDegrees {
      payload["matchedCourseDegrees"] = matchedCourseDegrees
    }
    if let distanceFromRouteMeters = snapshot.distanceFromRouteMeters {
      payload["distanceFromRouteMeters"] = distanceFromRouteMeters
    }
    if let horizontalAccuracyMeters = snapshot.horizontalAccuracyMeters {
      payload["horizontalAccuracyMeters"] = horizontalAccuracyMeters
    }
    if snapshot.phase != .idle, let guidance = state.guidance {
      payload["guidance"] = IOSModuleSerializer.serialize(guidance)
    }
    if snapshot.phase != .idle, let trip = state.trip {
      payload["trip"] = IOSModuleSerializer.serialize(trip)
    }

    return payload
  }

  static func serialize(_ guidance: NavOSSCarPlayGuidance) -> [String: Any] {
    [
      "distanceToManeuverMeters": guidance.distanceToManeuverMeters,
      "durationToManeuverSeconds": guidance.durationToManeuverSeconds,
      "instruction": guidance.instruction,
      "maneuverType": guidance.maneuverType,
      "phase": guidance.phase.rawValue,
      "remainingDistanceMeters": guidance.remainingDistanceMeters,
      "remainingDurationSeconds": guidance.remainingDurationSeconds,
      "roadName": guidance.roadName,
      "stepIndex": guidance.stepIndex,
    ]
  }

  static func serialize(_ trip: NavOSSCarPlayTrip) -> [String: Any] {
    var payload: [String: Any] = [
      "destination": [
        "id": trip.destination.id,
        "label": trip.destination.label,
        "latitude": trip.destination.latitude,
        "longitude": trip.destination.longitude,
        "name": trip.destination.name,
      ],
      "distanceMeters": trip.distanceMeters,
      "durationSeconds": trip.durationSeconds,
      "geometry": trip.geometry.map { IOSModuleSerializer.serialize($0) },
      "id": trip.id,
      "preferences": [
        "avoidFerries": trip.preferences.avoidFerries,
        "avoidHighways": trip.preferences.avoidHighways,
        "avoidTolls": trip.preferences.avoidTolls,
        "avoidUnpaved": trip.preferences.avoidUnpaved,
      ],
      "steps": trip.steps.map { step in
        var payload: [String: Any] = [
          "distanceMeters": step.distanceMeters,
          "durationSeconds": step.durationSeconds,
          "geometry": step.geometry.map { IOSModuleSerializer.serialize($0) },
          "instruction": step.instruction,
          "maneuverType": step.maneuverType,
          "roadName": step.roadName,
        ]
        if let spokenInstruction = step.spokenInstruction {
          payload["spokenInstruction"] = spokenInstruction
        }
        if let lanes = step.lanes {
          payload["lanes"] = lanes.map { lane in
            var value: [String: Any] = [
              "active": lane.isPreferred,
              "indications": lane.indications.map(\.rawValue),
              "valid": lane.isValid,
            ]
            if let activeIndication = lane.activeIndication {
              value["validIndication"] = activeIndication.rawValue
            }
            return value
          }
        }
        let optionalFields: [String: Any?] = [
          "bearingAfterDegrees": step.bearingAfterDegrees,
          "bearingBeforeDegrees": step.bearingBeforeDegrees,
          "currentRoadName": step.currentRoadName,
          "exitNumber": step.exitNumber,
          "junctionName": step.junctionName,
          "maneuverModifier": step.maneuverModifier,
          "roundaboutExit": step.roundaboutExit,
          "signpost": step.signpost,
          "signpostBranch": step.signpostBranch,
          "signpostToward": step.signpostToward,
        ]
        for case let (key, value?) in optionalFields {
          payload[key] = value
        }
        return payload
      },
    ]
    if let source = trip.source {
      payload["source"] = source
    }
    if let speedLimitsKph = trip.speedLimitsKph {
      payload["speedLimitsKph"] = speedLimitsKph
    }
    if let traffic = trip.traffic {
      var trafficPayload: [String: Any] = [
        "delaySeconds": traffic.delaySeconds,
        "typicalDurationSeconds": traffic.typicalDurationSeconds,
      ]
      if let observedAt = traffic.oldestObservedAt {
        trafficPayload["oldestObservedAt"] = ISO8601DateFormatter().string(from: observedAt)
      }
      payload["traffic"] = trafficPayload
    }
    if let congestion = trip.congestion {
      payload["congestion"] = congestion.map(\.rawValue)
    }
    if let trafficSource = trip.trafficSource {
      payload["trafficSource"] = trafficSource
    }
    if let waypoints = trip.waypoints {
      payload["waypoints"] = waypoints.map { waypoint in
        var destination: [String: Any] = [
          "id": waypoint.id,
          "label": waypoint.label,
          "latitude": waypoint.latitude,
          "longitude": waypoint.longitude,
          "name": waypoint.name,
        ]
        if let category = waypoint.category {
          destination["category"] = category
        }
        return destination
      }
    }
    return payload
  }

  static func serialize(_ coordinate: NavigationCoordinate) -> [String: Double] {
    return [
      "latitude": coordinate.latitude,
      "longitude": coordinate.longitude,
    ]
  }

  static func serialize(_ coordinate: NavOSSCarPlayCoordinate) -> [String: Double] {
    [
      "latitude": coordinate.latitude,
      "longitude": coordinate.longitude,
    ]
  }
}
