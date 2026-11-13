import ExpoModulesCore
import Foundation

struct CommunityBoundsRecord: Record {
  @Field var east: Double = 0
  @Field var north: Double = 0
  @Field var south: Double = 0
  @Field var west: Double = 0

  var bounds: NavOSSCommunityBounds {
    NavOSSCommunityBounds(east: east, north: north, south: south, west: west)
  }
}

/// The phone's own fix behind a vote outside guidance. Accepted only within the bounds the
/// navigation core applies to its own fixes (`navOSSNavigationRouteOrigin`: at most 15 s old,
/// 100 m accuracy), so a stale or coarse position can never back a vote.
struct CommunityVoteObservationRecord: Record {
  @Field var horizontalAccuracyMeters: Double = .nan
  @Field var latitude: Double = .nan
  @Field var longitude: Double = .nan
  @Field var timestampMs: Double = .nan

  func validatedCoordinate(now: Date = Date()) -> NavOSSCarPlayCoordinate? {
    guard latitude.isFinite, longitude.isFinite, (-90...90).contains(latitude),
      (-180...180).contains(longitude), timestampMs.isFinite
    else { return nil }
    let coordinate = NavOSSCarPlayCoordinate(latitude: latitude, longitude: longitude)
    return navOSSNavigationRouteOrigin(
      coordinate: coordinate,
      courseDegrees: nil,
      speedMetersPerSecond: nil,
      horizontalAccuracyMeters: horizontalAccuracyMeters,
      ageSeconds: now.timeIntervalSince1970 - timestampMs / 1_000
    )?.coordinate
  }
}

struct CommunityReportSubmissionRecord: Record {
  /// The driver confirmed sharing a report near home or the trip's start/end.
  @Field var confirmNearPrivatePlace: Bool = false
  @Field var heading: Double?
  @Field var latitude: Double = 0
  @Field var longitude: Double = 0
  @Field var type: String = ""
}

/// Serialisation for the community part of the Expo module. Results are plain objects with
/// `ok`, so the phone can show calm states instead of handling thrown errors.
enum NavOSSCommunityBridge {
  static let stateEvent = "onCommunityStateChanged"

  static func milliseconds(_ date: Date) -> Double {
    (date.timeIntervalSince1970 * 1_000).rounded()
  }

  static func statePayload() async -> [String: Any] {
    let service = NavOSSCommunityService.shared
    let availability = await service.availability()
    let preferences = service.preferences()
    var payload: [String: Any] = [
      "canWrite": availability.canWrite,
      "hasIdentity": availability.hasIdentity,
      "preferences": [
        "announcesRoadReports": preferences.announcesRoadReports,
        "sharesRoadReports": preferences.sharesRoadReports,
        "sharesTrafficSpeeds": preferences.sharesTrafficSpeeds,
      ],
      "reports": service.reports().map(reportPayload),
      "trafficSharing": trafficPayload(availability.trafficSharing),
    ]
    if let live = availability.reportsLive {
      payload["reportsLive"] = live
    }
    return payload
  }

  static func trafficPayload(_ state: NavOSSTrafficSharingState) -> [String: Any] {
    switch state {
    case .off: return ["state": "off"]
    case .ready: return ["state": "ready"]
    case .starting: return ["state": "starting"]
    case .sharing: return ["state": "sharing"]
    case let .paused(until): return ["state": "paused", "untilMs": milliseconds(until)]
    case let .startsLater(until): return ["state": "starts-later", "untilMs": milliseconds(until)]
    case let .unavailable(reason): return ["state": "unavailable", "reason": reason.rawValue]
    }
  }

  static func reportPayload(_ report: NavOSSCommunityReport) -> [String: Any] {
    [
      "confirmations": report.confirmations,
      "expiresAtMs": milliseconds(report.expiresAt),
      "id": report.id,
      "isOwn": NavOSSCommunityService.shared.isOwn(report.id),
      "latitude": report.coordinate.latitude,
      "longitude": report.coordinate.longitude,
      "reportedAtMs": milliseconds(report.reportedAt),
      "state": report.state.rawValue,
      "type": report.type.rawValue,
    ]
  }

  static func navigationAlertsPayload() -> [String: Any] {
    let alerts = NavOSSCommunityService.shared.navigationAlerts()
    var payload: [String: Any] = [:]
    if let alert = alerts.reportAlert {
      payload["communityReportAlert"] = [
        "distanceAheadMeters": alert.distanceAheadMeters,
        "reportId": alert.reportId,
        "sequence": alert.sequence,
        "type": alert.type.rawValue,
      ]
    }
    if let prompt = alerts.stillTherePrompt {
      payload["stillTherePrompt"] = [
        "reportId": prompt.reportId,
        "sequence": prompt.sequence,
        "type": prompt.type.rawValue,
      ]
    }
    return payload
  }

  static func failurePayload(_ error: Error) -> [String: Any] {
    guard let failure = error as? NavOSSCommunityFailure else {
      return ["ok": false, "error": "unavailable"]
    }
    switch failure {
    case .attestationUnsupported: return ["ok": false, "error": "unsupported"]
    case let .installationTooNew(retryAfter):
      return withRetryAfter(["ok": false, "error": "too-new"], retryAfter)
    case let .rateLimited(retryAfter):
      return withRetryAfter(["ok": false, "error": "rate-limited"], retryAfter)
    case .serviceUnavailable: return ["ok": false, "error": "unavailable"]
    case .outOfCoverage: return ["ok": false, "error": "out-of-coverage"]
    case .tooFar: return ["ok": false, "error": "too-far"]
    case .notFound: return ["ok": false, "error": "not-found"]
    case .duplicateVote: return ["ok": false, "error": "already-voted"]
    case .selfVote: return ["ok": false, "error": "own-report"]
    case .rejected: return ["ok": false, "error": "rejected"]
    case .invalidRequest: return ["ok": false, "error": "invalid-request"]
    case .identityUnavailable: return ["ok": false, "error": "identity-lost"]
    case .notShared: return ["ok": false, "error": "not-shared"]
    case .nearPrivatePlace: return ["ok": false, "error": "near-private-place"]
    case .network: return ["ok": false, "error": "offline"]
    case .invalidResponse: return ["ok": false, "error": "unavailable"]
    }
  }

  private static func withRetryAfter(_ payload: [String: Any], _ seconds: Int?) -> [String: Any] {
    var payload = payload
    if let seconds { payload["retryAfterSeconds"] = seconds }
    return payload
  }

  static func fetchReports(_ record: CommunityBoundsRecord) async -> [String: Any] {
    do {
      let reports = try await NavOSSCommunityService.shared.fetchReports(in: record.bounds)
      return ["ok": true, "reports": reports.map(reportPayload)]
    } catch {
      return failurePayload(error)
    }
  }

  static func submitReport(_ record: CommunityReportSubmissionRecord) async -> [String: Any] {
    guard let type = NavOSSCarPlayReportType(rawValue: record.type) else {
      return ["ok": false, "error": "invalid-request"]
    }
    do {
      let submission = try await NavOSSCommunityService.shared.submitReport(
        type: type,
        coordinate: NavOSSCarPlayCoordinate(latitude: record.latitude, longitude: record.longitude),
        heading: record.heading.flatMap { $0.isFinite ? Int($0.rounded()) : nil },
        confirmedNearPrivatePlace: record.confirmNearPrivatePlace
      )
      return [
        "expiresAtMs": milliseconds(submission.expiresAt),
        "merged": submission.merged,
        "ok": true,
        "reportId": submission.reportId,
      ]
    } catch {
      return failurePayload(error)
    }
  }

  /// Votes with the device's current position, which the server uses only for its proximity
  /// check and then discards. The navigation core's fix wins; outside guidance, where the core
  /// may have none, the phone passes the fix from its own foreground location watch.
  static func vote(
    reportId: String, rawVote: String, phoneCoordinate: NavOSSCarPlayCoordinate? = nil
  ) async -> [String: Any] {
    guard let vote = NavOSSCommunityVote(rawValue: rawVote) else {
      return ["ok": false, "error": "invalid-request"]
    }
    guard
      let coordinate = NavOSSNavigationService.shared.currentCoordinate() ?? phoneCoordinate
    else {
      return ["ok": false, "error": "location-unavailable"]
    }
    do {
      let active = try await NavOSSCommunityService.shared.vote(
        reportId: reportId, vote: vote, observedAt: coordinate)
      return ["active": active, "ok": true]
    } catch {
      return failurePayload(error)
    }
  }

  static func withdraw(reportId: String) async -> [String: Any] {
    do {
      try await NavOSSCommunityService.shared.withdraw(reportId: reportId)
      return ["ok": true]
    } catch {
      return failurePayload(error)
    }
  }

  static func resetIdentity() async -> [String: Any] {
    do {
      try await NavOSSCommunityService.shared.resetIdentity()
      return ["ok": true]
    } catch {
      return failurePayload(error)
    }
  }
}
