import Foundation

extension Notification.Name {
  public static let navOSSCommunityPreferencesDidChange = Notification.Name(
    "org.navoss.mobile.community-preferences-did-change"
  )
}

/// Community choices shared by the phone and CarPlay, persisted natively.
public struct NavOSSCommunityPreferences: Equatable, Sendable {
  /// "Share traffic speeds". Off by default; only an explicit choice turns it on.
  public let sharesTrafficSpeeds: Bool
  /// Speak a short alert for a road report ahead (still subject to the guidance sound mode).
  public let announcesRoadReports: Bool
  /// "Share road reports": the driver knowingly chose to send reports to other drivers. Off by
  /// default; while off every report stays a private draft on this iPhone.
  public let sharesRoadReports: Bool

  public init(
    sharesTrafficSpeeds: Bool = false,
    announcesRoadReports: Bool = true,
    sharesRoadReports: Bool = false
  ) {
    self.sharesTrafficSpeeds = sharesTrafficSpeeds
    self.announcesRoadReports = announcesRoadReports
    self.sharesRoadReports = sharesRoadReports
  }
}

public final class NavOSSCommunityPreferencesStore: @unchecked Sendable {
  public static let shared = NavOSSCommunityPreferencesStore()

  private let sharesTrafficSpeedsKey = "org.navoss.mobile.community.share-traffic-speeds"
  private let announcesRoadReportsKey = "org.navoss.mobile.community.announce-road-reports"
  private let sharesRoadReportsKey = "org.navoss.mobile.community.share-road-reports"
  private let defaults: UserDefaults
  private let lock = NSLock()
  private let notificationCenter: NotificationCenter

  public init(defaults: UserDefaults = .standard, notificationCenter: NotificationCenter = .default) {
    self.defaults = defaults
    self.notificationCenter = notificationCenter
  }

  public func load() -> NavOSSCommunityPreferences {
    lock.withLock {
      NavOSSCommunityPreferences(
        sharesTrafficSpeeds: defaults.bool(forKey: sharesTrafficSpeedsKey),
        announcesRoadReports: defaults.object(forKey: announcesRoadReportsKey) == nil
          ? true : defaults.bool(forKey: announcesRoadReportsKey),
        sharesRoadReports: defaults.bool(forKey: sharesRoadReportsKey)
      )
    }
  }

  public func setSharesTrafficSpeeds(_ value: Bool) {
    lock.withLock { defaults.set(value, forKey: sharesTrafficSpeedsKey) }
    notificationCenter.post(name: .navOSSCommunityPreferencesDidChange, object: self)
  }

  public func setSharesRoadReports(_ value: Bool) {
    lock.withLock { defaults.set(value, forKey: sharesRoadReportsKey) }
    notificationCenter.post(name: .navOSSCommunityPreferencesDidChange, object: self)
  }

  public func setAnnouncesRoadReports(_ value: Bool) {
    lock.withLock { defaults.set(value, forKey: announcesRoadReportsKey) }
    notificationCenter.post(name: .navOSSCommunityPreferencesDidChange, object: self)
  }
}

// MARK: - Cache

/// Reports already fetched, by area. A fresh answer for an area replaces what was known inside
/// it (reports the server no longer returns there are gone); expired reports drop out by time.
/// Memory only.
public struct NavOSSCommunityReportCache: Sendable {
  /// An area is refetched after this long.
  public static let maximumAgeSeconds: TimeInterval = 120
  /// Never more often than this, whatever the caller asks (the server shares a read budget per
  /// network, and carrier NAT can put many phones in one).
  public static let minimumIntervalSeconds: TimeInterval = 20

  private struct Area {
    let bounds: NavOSSCommunityBounds
    let fetchedAt: Date
  }

  private var areas: [Area] = []
  private var lastFetchAt: Date?
  private(set) var reportsById: [String: NavOSSCommunityReport] = [:]

  public init() {}

  /// Whether `bounds` needs a request now.
  public func needsFetch(_ bounds: NavOSSCommunityBounds, now: Date) -> Bool {
    if let lastFetchAt, now.timeIntervalSince(lastFetchAt) < Self.minimumIntervalSeconds {
      return false
    }
    return !areas.contains {
      $0.bounds.contains(bounds) && now.timeIntervalSince($0.fetchedAt) < Self.maximumAgeSeconds
    }
  }

  public mutating func markFetching(now: Date) {
    lastFetchAt = now
  }

  public mutating func store(
    _ reports: [NavOSSCommunityReport],
    for bounds: NavOSSCommunityBounds,
    now: Date
  ) {
    reportsById = reportsById.filter { !bounds.contains($0.value.coordinate) }
    for report in reports where report.expiresAt > now && bounds.contains(report.coordinate) {
      reportsById[report.id] = report
    }
    areas.removeAll {
      bounds.contains($0.bounds) || now.timeIntervalSince($0.fetchedAt) >= Self.maximumAgeSeconds
    }
    areas.append(Area(bounds: bounds, fetchedAt: now))
  }

  /// A report this installation withdrew, or that a vote ended.
  public mutating func remove(id: String) {
    reportsById.removeValue(forKey: id)
  }

  public mutating func clear() {
    areas.removeAll()
    reportsById.removeAll()
    lastFetchAt = nil
  }

  /// Active reports, ordered by id like the server (never by time).
  public func active(now: Date) -> [NavOSSCommunityReport] {
    reportsById.values.filter { $0.expiresAt > now }.sorted { $0.id < $1.id }
  }
}

/// The box to fetch during guidance: the route ahead of the vehicle, padded, cut where it would
/// exceed the server's 0.5° per side. `nil` when nothing is left ahead.
public func navOSSCommunityCorridorBounds(
  routeGeometry: [NavOSSCarPlayCoordinate],
  routeProgress: Double,
  lookAheadMeters: Double = 20_000,
  paddingDegrees: Double = 0.01,
  maximumSpanDegrees: Double = 0.5
) -> NavOSSCommunityBounds? {
  let geometry = routeGeometry.filter(\.isValid)
  guard geometry.count >= 2 else { return nil }
  var cumulative = [0.0]
  for index in 1..<geometry.count {
    cumulative.append(
      cumulative[index - 1]
        + navigationDistanceMeters(
          from: NavigationCoordinate(
            latitude: geometry[index - 1].latitude, longitude: geometry[index - 1].longitude),
          to: NavigationCoordinate(
            latitude: geometry[index].latitude, longitude: geometry[index].longitude)
        )
    )
  }
  let total = cumulative.last ?? 0
  let start = max(0, min(1, routeProgress)) * total
  var south = Double.infinity
  var north = -Double.infinity
  var west = Double.infinity
  var east = -Double.infinity
  var included = 0
  for (index, coordinate) in geometry.enumerated() {
    let nextAlong = index + 1 < cumulative.count ? cumulative[index + 1] : cumulative[index]
    guard nextAlong >= start else { continue }
    guard cumulative[index] <= start + lookAheadMeters else { break }
    let candidate = (
      min(south, coordinate.latitude - paddingDegrees),
      max(north, coordinate.latitude + paddingDegrees),
      min(west, coordinate.longitude - paddingDegrees),
      max(east, coordinate.longitude + paddingDegrees)
    )
    if included > 0,
      candidate.1 - candidate.0 > maximumSpanDegrees || candidate.3 - candidate.2 > maximumSpanDegrees
    {
      break
    }
    (south, north, west, east) = candidate
    included += 1
  }
  guard included > 0 else { return nil }
  let bounds = NavOSSCommunityBounds(
    east: min(180, east), north: min(90, north), south: max(-90, south), west: max(-180, west))
  return bounds.isValid ? bounds : nil
}

// MARK: - Alerts along the route

/// A report ahead the driver was alerted to, while it is still ahead.
public struct NavOSSCommunityReportAlert: Equatable, Sendable {
  public let distanceAheadMeters: Double
  public let reportId: String
  /// Changes with every new alert, so a presenter can tell a new alert from an update.
  public let sequence: Int
  public let type: NavOSSCarPlayReportType
}

/// "Still there?" for a report the driver has just passed.
public struct NavOSSCommunityStillTherePrompt: Equatable, Sendable {
  public let reportId: String
  public let sequence: Int
  public let type: NavOSSCarPlayReportType
}

/// Lookahead for a report alert.
let navigationCommunityReportAlertDistanceMeters = 800.0
/// Published positions are snapped to a ~55 m × 35 m grid; a report this far from the route
/// centreline still belongs to it.
let navigationCommunityReportMaximumRouteOffsetMeters = 50.0
/// Ask only once the report is clearly behind, and not after the driver has gone far past it.
let navigationCommunityStillThereMinimumPastMeters = 60.0
let navigationCommunityStillThereMaximumPastMeters = 600.0
/// No prompt with a maneuver this close ahead, or this soon after one.
let navigationCommunityStillThereManeuverClearanceAheadMeters = 500.0
let navigationCommunityStillThereManeuverClearanceBehindMeters = 150.0
/// At most one prompt in this long.
let navigationCommunityStillThereMinimumIntervalSeconds = 180.0

/// Native ownership of community-report alerts and "Still there?" prompts, from the matched
/// position: phone and CarPlay only present them. It never prompts before or near a maneuver
/// (docs/architecture/community-reports.md), never for the installation's own reports, and asks
/// about each report at most once per trip.
public struct NavigationCommunityReportMonitor: Sendable {
  private struct Placement: Sendable {
    let alongMeters: Double
    let report: NavOSSCommunityReport
  }

  public private(set) var activeAlert: NavOSSCommunityReportAlert?
  public private(set) var stillTherePrompt: NavOSSCommunityStillTherePrompt?
  private var activeAlertAlongMeters: Double?
  private var alertedIds: Set<String> = []
  private var askedIds: Set<String> = []
  private var lastAlongMeters: Double?
  private var lastPromptAt: TimeInterval?
  private var maneuverAlongMeters: [Double] = []
  private var ownReportIds: Set<String> = []
  private var placements: [Placement] = []
  private var promptAlongMeters: Double?
  private var reports: [NavOSSCommunityReport] = []
  private var route: RoutePolyline?
  private var sequence = 0
  private var stepStarts: [NavigationCoordinate] = []

  public init() {}

  /// Reports this installation submitted (memory only): no prompt, no alert, no self-vote.
  public mutating func markOwn(_ reportId: String) {
    ownReportIds.insert(reportId)
    placements.removeAll { $0.report.id == reportId }
  }

  public mutating func setReports(_ reports: [NavOSSCommunityReport]) {
    self.reports = reports
    rebuild()
    if let alert = activeAlert, !reports.contains(where: { $0.id == alert.reportId }) {
      activeAlert = nil
      activeAlertAlongMeters = nil
    }
    if let prompt = stillTherePrompt, !reports.contains(where: { $0.id == prompt.reportId }) {
      stillTherePrompt = nil
      promptAlongMeters = nil
    }
  }

  /// `stepStarts` are the first coordinates of each route step after the first: the maneuvers.
  public mutating func startTrip(
    geometry: [NavOSSCarPlayCoordinate],
    maneuverCoordinates: [NavOSSCarPlayCoordinate]
  ) {
    alertedIds.removeAll()
    askedIds.removeAll()
    lastPromptAt = nil
    replaceRoute(geometry: geometry, maneuverCoordinates: maneuverCoordinates)
  }

  /// A reroute keeps the trip: reports already alerted or asked about stay quiet.
  public mutating func replaceRoute(
    geometry: [NavOSSCarPlayCoordinate],
    maneuverCoordinates: [NavOSSCarPlayCoordinate]
  ) {
    route = try? RoutePolyline(
      coordinates: geometry.map { NavigationCoordinate(latitude: $0.latitude, longitude: $0.longitude) }
    )
    stepStarts = maneuverCoordinates.map {
      NavigationCoordinate(latitude: $0.latitude, longitude: $0.longitude)
    }
    activeAlert = nil
    activeAlertAlongMeters = nil
    stillTherePrompt = nil
    promptAlongMeters = nil
    lastAlongMeters = nil
    rebuild()
  }

  public mutating func endTrip() {
    route = nil
    placements = []
    maneuverAlongMeters = []
    activeAlert = nil
    activeAlertAlongMeters = nil
    stillTherePrompt = nil
    promptAlongMeters = nil
    lastAlongMeters = nil
    alertedIds.removeAll()
    askedIds.removeAll()
  }

  /// The driver answered or dismissed the prompt.
  public mutating func resolvePrompt(reportId: String) {
    askedIds.insert(reportId)
    if stillTherePrompt?.reportId == reportId {
      stillTherePrompt = nil
      promptAlongMeters = nil
    }
  }

  /// Updates for a new position. Returns the report to announce now, if any.
  public mutating func update(
    alongMeters: Double?,
    isTracking: Bool,
    now: TimeInterval
  ) -> NavOSSCommunityReportAlert? {
    guard let alongMeters, isTracking, route != nil else {
      activeAlert = nil
      activeAlertAlongMeters = nil
      stillTherePrompt = nil
      promptAlongMeters = nil
      return nil
    }
    defer { lastAlongMeters = alongMeters }

    if let reportAlong = activeAlertAlongMeters, let alert = activeAlert {
      if reportAlong > alongMeters {
        activeAlert = NavOSSCommunityReportAlert(
          distanceAheadMeters: reportAlong - alongMeters,
          reportId: alert.reportId,
          sequence: alert.sequence,
          type: alert.type
        )
      } else {
        activeAlert = nil
        activeAlertAlongMeters = nil
      }
    }
    if let promptAlong = promptAlongMeters,
      alongMeters - promptAlong > navigationCommunityStillThereMaximumPastMeters
        || nearManeuver(alongMeters)
    {
      if let prompt = stillTherePrompt { askedIds.insert(prompt.reportId) }
      stillTherePrompt = nil
      promptAlongMeters = nil
    }
    // Only forward progress alerts or prompts: GPS noise must not make a report "passed".
    if let lastAlongMeters, alongMeters < lastAlongMeters {
      return nil
    }
    updatePrompt(alongMeters: alongMeters, now: now)

    guard
      let upcoming = placements.first(where: {
        $0.alongMeters > alongMeters
          && $0.alongMeters - alongMeters <= navigationCommunityReportAlertDistanceMeters
          && !alertedIds.contains($0.report.id)
      })
    else {
      return nil
    }
    alertedIds.insert(upcoming.report.id)
    sequence += 1
    let alert = NavOSSCommunityReportAlert(
      distanceAheadMeters: upcoming.alongMeters - alongMeters,
      reportId: upcoming.report.id,
      sequence: sequence,
      type: upcoming.report.type
    )
    activeAlert = alert
    activeAlertAlongMeters = upcoming.alongMeters
    return alert
  }

  private mutating func updatePrompt(alongMeters: Double, now: TimeInterval) {
    guard stillTherePrompt == nil, !nearManeuver(alongMeters) else { return }
    if let lastPromptAt, now - lastPromptAt < navigationCommunityStillThereMinimumIntervalSeconds {
      return
    }
    guard
      let passed = placements.last(where: {
        let past = alongMeters - $0.alongMeters
        let reportAlong = $0.alongMeters
        // A turn between the report and the driver changes the road being asked about.
        return past >= navigationCommunityStillThereMinimumPastMeters
          && past <= navigationCommunityStillThereMaximumPastMeters
          && !askedIds.contains($0.report.id)
          && !maneuverAlongMeters.contains { $0 > reportAlong && $0 <= alongMeters }
      })
    else {
      return
    }
    sequence += 1
    lastPromptAt = now
    stillTherePrompt = NavOSSCommunityStillTherePrompt(
      reportId: passed.report.id, sequence: sequence, type: passed.report.type)
    promptAlongMeters = passed.alongMeters
  }

  private func nearManeuver(_ alongMeters: Double) -> Bool {
    maneuverAlongMeters.contains {
      $0 - alongMeters <= navigationCommunityStillThereManeuverClearanceAheadMeters
        && alongMeters - $0 <= navigationCommunityStillThereManeuverClearanceBehindMeters
    }
  }

  private mutating func rebuild() {
    guard let route else {
      placements = []
      maneuverAlongMeters = []
      return
    }
    maneuverAlongMeters = stepStarts.compactMap { Self.along(of: $0, on: route, within: 40) }
    placements = reports.compactMap { report in
      guard !ownReportIds.contains(report.id), report.coordinate.isValid,
        let along = Self.along(
          of: NavigationCoordinate(
            latitude: report.coordinate.latitude, longitude: report.coordinate.longitude),
          on: route,
          within: navigationCommunityReportMaximumRouteOffsetMeters
        )
      else { return nil }
      return Placement(alongMeters: along, report: report)
    }.sorted { $0.alongMeters < $1.alongMeters }
  }

  /// Distance along the route of the closest approach within `within` metres. Where the route
  /// passes the same place twice the first pass is used.
  private static func along(
    of coordinate: NavigationCoordinate,
    on route: RoutePolyline,
    within radius: Double
  ) -> Double? {
    var best: RouteProjection?
    for index in route.segmentIndices(near: coordinate, radiusMeters: radius) {
      let projection = route.project(coordinate, ontoSegment: index)
      guard projection.distanceMeters <= radius else { continue }
      if best == nil {
        best = projection
      }
    }
    return best?.alongMeters
  }
}

/// Short spoken text for a report ahead, matching the CarPlay labels.
public func navOSSCommunityReportSpokenAlert(_ type: NavOSSCarPlayReportType) -> String {
  switch type {
  case .collision: "Reported crash ahead."
  case .construction: "Reported construction ahead."
  case .objectOnRoad: "Reported object on the road ahead."
  case .pothole: "Reported pothole ahead."
  case .roadClosure: "Reported road closure ahead."
  case .roadHazard: "Reported hazard ahead."
  case .slowTraffic: "Reported slow traffic ahead."
  case .stalledVehicle: "Reported stopped vehicle ahead."
  }
}

/// CarPlay banner title for a report ahead.
public func navOSSCarPlayCommunityAlertTitle(_ type: NavOSSCarPlayReportType) -> String {
  "\(type.label) ahead"
}

/// Calm, specific copy for a report that could not be sent.
public func navOSSCarPlayCommunityFailureText(_ failure: NavOSSCommunityFailure) -> String {
  switch failure {
  case .rateLimited: "Too many reports for now. Try again later."
  case .outOfCoverage: "Reports are accepted only inside NavOSS coverage."
  case .network: "No connection. Try again in a moment."
  case .attestationUnsupported: "This iPhone cannot send community reports."
  case .rejected, .installationTooNew, .identityUnavailable: "NavOSS could not verify this report."
  default: "Try again in a moment."
  }
}

/// CarPlay detail line for "Share traffic speeds" while it is switched on.
public func navOSSCarPlayTrafficSharingDetail(_ state: NavOSSTrafficSharingState) -> String {
  switch state {
  case .sharing: "Sharing anonymous speeds, never trip ends"
  case .startsLater: "Starts tomorrow for this iPhone"
  case .paused: "Paused for a few minutes"
  case .unavailable(.notAccepting), .unavailable(.unsupported):
    "Not available yet"
  case .unavailable: "Not sharing on this trip"
  case .off, .ready, .starting: "Shares anonymous speeds during guidance, never trip ends"
  }
}
