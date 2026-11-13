import Foundation

extension Notification.Name {
  /// Posted by `NavOSSCommunityService.shared` when reports, availability or traffic-sharing
  /// state change, on an arbitrary queue.
  public static let navOSSCommunityStateDidChange = Notification.Name(
    "org.navoss.mobile.community-state-did-change"
  )
}

/// What the community features can do right now, for the phone and CarPlay.
public struct NavOSSCommunityAvailability: Equatable, Sendable {
  /// `features.communityReports` from `/v2/config`; `nil` until the server has answered.
  public let reportsLive: Bool?
  /// This device and build can sign writes (App Attest, or the DEBUG development key).
  public let canWrite: Bool
  /// An installation key id is stored.
  public let hasIdentity: Bool
  public let trafficSharing: NavOSSTrafficSharingState
}

/// Alert and prompt state during guidance, for presenters.
public struct NavOSSCommunityNavigationAlerts: Equatable, Sendable {
  public let reportAlert: NavOSSCommunityReportAlert?
  public let stillTherePrompt: NavOSSCommunityStillTherePrompt?
}

/// Shared by the phone and CarPlay: community reports (fetch, submit, vote, withdraw, reset)
/// and the community-traffic uploader, driven by the navigation service's hooks. Reports are
/// published to `NavOSSCarPlayMapAlertStore` so the CarPlay map draws them. Holds reports,
/// own-report ids, credentials and probes in memory only; the only persisted state is the
/// Keychain key id and the preferences in `NavOSSCommunityPreferencesStore`.
public final class NavOSSCommunityService: @unchecked Sendable {
  public static let shared = NavOSSCommunityService()

  /// `/v2/config` is re-read at most this often.
  static let featuresRefreshSeconds: TimeInterval = 600

  private var cache = NavOSSCommunityReportCache()
  private let client: NavOSSCommunityClient?
  private var corridorFetchInFlight = false
  private var featuresFetchedAt: Date?
  private var featuresTask: Task<Bool?, Never>?
  private let lock = NSRecursiveLock()
  private var monitor = NavigationCommunityReportMonitor()
  private var navigationActive = false
  private let notificationCenter: NotificationCenter
  private var ownReportIds: Set<String> = []
  private let preferencesStore: NavOSSCommunityPreferencesStore
  private var preferencesObserver: NSObjectProtocol?
  private var protectedPoints: [NavOSSCarPlayCoordinate] = []
  private var reportsLive: Bool?
  private var routeGeometry: [NavOSSCarPlayCoordinate] = []
  private var routeLengthMeters = 0.0
  private var routeProgress = 0.0
  private var lastTrafficTick: Date?
  private let traffic: NavOSSTrafficSharingSession?
  private var trafficState: NavOSSTrafficSharingState = .off
  private let alertStore: NavOSSCarPlayMapAlertStore
  /// Saved Home and Work, which a public report must not reveal without confirmation.
  var homeAndWork: () -> [NavOSSCarPlayCoordinate] = {
    let catalog = NavOSSCarPlayDestinationStore.shared.snapshot()
    return [catalog.home, catalog.work].compactMap { $0 }.map {
      NavOSSCarPlayCoordinate(latitude: $0.latitude, longitude: $0.longitude)
    }
  }

  init(
    client: NavOSSCommunityClient? = NavOSSCommunityService.defaultClient(),
    preferencesStore: NavOSSCommunityPreferencesStore = .shared,
    alertStore: NavOSSCarPlayMapAlertStore = .shared,
    notificationCenter: NotificationCenter = .default
  ) {
    self.client = client
    self.preferencesStore = preferencesStore
    self.alertStore = alertStore
    self.notificationCenter = notificationCenter
    let sink = TrafficStateSink()
    traffic = client.map { client in
      NavOSSTrafficSharingSession(
        transport: client,
        onStateChange: { state in sink.service?.trafficStateDidChange(state) }
      )
    }
    sink.service = self
    preferencesObserver = notificationCenter.addObserver(
      forName: .navOSSCommunityPreferencesDidChange,
      object: preferencesStore,
      queue: nil
    ) { [weak self] _ in
      self?.preferencesDidChange()
    }
    preferencesDidChange()
  }

  deinit {
    if let preferencesObserver { notificationCenter.removeObserver(preferencesObserver) }
  }

  /// The configured API (`NavOSSAPIURL`) with the best attestation this build has.
  static func defaultClient() -> NavOSSCommunityClient? {
    guard let value = Bundle.main.object(forInfoDictionaryKey: "NavOSSAPIURL") as? String,
      let url = URL(string: value)
    else {
      return nil
    }
    let keychain = NavOSSCommunityKeychain()
    // Ephemeral: no disk URL cache, so report answers and credentials stay in memory only.
    let configuration = URLSessionConfiguration.ephemeral
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    return NavOSSCommunityClient(
      baseURL: url, provider: defaultProvider(store: keychain), store: keychain,
      session: URLSession(configuration: configuration))
  }

  static func defaultProvider(store: NavOSSCommunitySecretStore) -> NavOSSCommunityAttestationProvider {
    #if canImport(DeviceCheck) && os(iOS)
      let appAttest = NavOSSAppAttestProvider()
      if appAttest.isSupported { return appAttest }
    #endif
    #if DEBUG
      // Simulator and other DEBUG builds without App Attest: a software key, accepted only by a
      // server in allow-development mode, as an untrusted installation. Compiled out of Release.
      if let teamId = Bundle.main.object(forInfoDictionaryKey: "NavOSSDevelopmentAppAttestTeamID")
        as? String,
        teamId.count == 10,
        let bundleId = Bundle.main.bundleIdentifier
      {
        return NavOSSDevelopmentAttestationProvider(teamId: teamId, bundleId: bundleId, store: store)
      }
    #endif
    return NavOSSUnavailableAttestationProvider()
  }

  // MARK: State

  public func availability() async -> NavOSSCommunityAvailability {
    let hasIdentity = await client?.hasIdentity ?? false
    return lock.withLock {
      NavOSSCommunityAvailability(
        reportsLive: client == nil ? false : reportsLive,
        canWrite: client?.canWrite ?? false,
        hasIdentity: hasIdentity,
        trafficSharing: trafficState
      )
    }
  }

  /// The traffic-sharing state as last reported, for synchronous presenters (CarPlay lists).
  public func trafficSharingState() -> NavOSSTrafficSharingState {
    lock.withLock { trafficState }
  }

  public func preferences() -> NavOSSCommunityPreferences {
    preferencesStore.load()
  }

  /// Reads `/v2/config` when it is unknown or old. Returns whether reports are live.
  @discardableResult
  public func refreshFeatures(force: Bool = false) async -> Bool {
    guard let client else { return false }
    let task: Task<Bool?, Never> = lock.withLock {
      // A failed or negative answer is remembered as long as a positive one, so a server
      // without community features (404, offline) is asked at most once per interval.
      if !force, let featuresFetchedAt,
        Date().timeIntervalSince(featuresFetchedAt) < Self.featuresRefreshSeconds
      {
        let known = reportsLive ?? false
        return Task { known }
      }
      if let featuresTask { return featuresTask }
      let task = Task<Bool?, Never> { try? await client.features().communityReports }
      featuresTask = task
      return task
    }
    let live = await task.value
    var changed = false
    lock.withLock {
      featuresTask = nil
      featuresFetchedAt = Date()
      if let live {
        changed = reportsLive != live
        reportsLive = live
        if !live {
          cache.clear()
          monitor.setReports([])
        }
      }
    }
    if changed {
      publishReports()
    }
    return live ?? lock.withLock { reportsLive ?? false }
  }

  /// Probe uploads by server outcome this process: counts only.
  public func trafficOutcomeCounts() async -> [String: Int] {
    await traffic?.outcomeCounts ?? [:]
  }

  public func reports() -> [NavOSSCommunityReport] {
    lock.withLock { cache.active(now: Date()) }
  }

  public func isOwn(_ reportId: String) -> Bool {
    lock.withLock { ownReportIds.contains(reportId) }
  }

  public func navigationAlerts() -> NavOSSCommunityNavigationAlerts {
    lock.withLock {
      NavOSSCommunityNavigationAlerts(
        reportAlert: monitor.activeAlert, stillTherePrompt: monitor.stillTherePrompt)
    }
  }

  // MARK: Reports

  /// Fetches the area unless a fresh answer already covers it, and returns the active reports
  /// inside it. The box must be at most 0.5° per side.
  public func fetchReports(in bounds: NavOSSCommunityBounds) async throws -> [NavOSSCommunityReport] {
    guard let client else { throw NavOSSCommunityFailure.serviceUnavailable(retryAfterSeconds: nil) }
    guard bounds.isValid, bounds.north - bounds.south <= 0.5, bounds.east - bounds.west <= 0.5
    else {
      throw NavOSSCommunityFailure.invalidRequest
    }
    guard await refreshFeatures() else { return [] }
    let shouldFetch: Bool = lock.withLock {
      let now = Date()
      guard cache.needsFetch(bounds, now: now) else { return false }
      cache.markFetching(now: now)
      return true
    }
    if shouldFetch {
      let page = try await client.reports(in: bounds)
      lock.withLock { cache.store(page.reports, for: bounds, now: Date()) }
      publishReports()
    }
    return lock.withLock { cache.active(now: Date()).filter { bounds.contains($0.coordinate) } }
  }

  /// Places a public report could reveal: within `tripEndTrimMeters` of the current trip's
  /// start, destination or stops, or of saved Home and Work.
  public func isNearPrivatePlace(_ coordinate: NavOSSCarPlayCoordinate) -> Bool {
    let catalog = homeAndWork()
    let places = lock.withLock { protectedPoints } + catalog
    let point = NavigationCoordinate(latitude: coordinate.latitude, longitude: coordinate.longitude)
    return places.contains {
      navigationDistanceMeters(
        from: point, to: NavigationCoordinate(latitude: $0.latitude, longitude: $0.longitude)) < 400
    }
  }

  /// Submits a public report. Refused, with nothing sent, unless the driver has switched
  /// **Share road reports** on, and near a private place unless `confirmedNearPrivatePlace`.
  public func submitReport(
    type: NavOSSCarPlayReportType,
    coordinate: NavOSSCarPlayCoordinate,
    heading: Int?,
    confirmedNearPrivatePlace: Bool = false
  ) async throws -> NavOSSCommunitySubmission {
    guard let client else { throw NavOSSCommunityFailure.serviceUnavailable(retryAfterSeconds: nil) }
    guard preferencesStore.load().sharesRoadReports else { throw NavOSSCommunityFailure.notShared }
    guard confirmedNearPrivatePlace || !isNearPrivatePlace(coordinate) else {
      throw NavOSSCommunityFailure.nearPrivatePlace
    }
    guard await refreshFeatures() else {
      throw NavOSSCommunityFailure.serviceUnavailable(retryAfterSeconds: nil)
    }
    let submission = try await client.submitReport(type: type, coordinate: coordinate, heading: heading)
    lock.withLock {
      ownReportIds.insert(submission.reportId)
      monitor.markOwn(submission.reportId)
    }
    notifyStateChange()
    return submission
  }

  /// Votes on a report. `observedAt` must be a fresh device position near the report.
  @discardableResult
  public func vote(
    reportId: String,
    vote: NavOSSCommunityVote,
    observedAt: NavOSSCarPlayCoordinate
  ) async throws -> Bool {
    guard let client else { throw NavOSSCommunityFailure.serviceUnavailable(retryAfterSeconds: nil) }
    lock.withLock { monitor.resolvePrompt(reportId: reportId) }
    let active = try await client.vote(reportId: reportId, vote: vote, observedAt: observedAt)
    // Ended on the server, or this driver just said it is gone: stop drawing it here. Other
    // drivers see whatever the server decides on their next read.
    if !active || vote == .notPresent {
      lock.withLock {
        cache.remove(id: reportId)
        monitor.setReports(cache.active(now: Date()))
      }
      publishReports()
    }
    return active
  }

  /// "Still there?" dismissed: nothing is sent.
  public func dismissStillThere(reportId: String) {
    lock.withLock { monitor.resolvePrompt(reportId: reportId) }
    notifyStateChange()
  }

  public func withdraw(reportId: String) async throws {
    guard let client else { throw NavOSSCommunityFailure.serviceUnavailable(retryAfterSeconds: nil) }
    try await client.withdraw(reportId: reportId)
    lock.withLock {
      ownReportIds.remove(reportId)
      cache.remove(id: reportId)
      monitor.setReports(cache.active(now: Date()))
    }
    publishReports()
  }

  /// "Reset community identity": deletes the installation and its reports and votes on the
  /// server, then forgets the key. The next write registers a new, unrelated installation.
  public func resetIdentity() async throws {
    guard let client else { return }
    try await client.deleteInstallation()
    lock.withLock {
      ownReportIds.removeAll()
      cache.clear()
      monitor.setReports([])
    }
    await traffic?.endTrip()
    publishReports()
    if lock.withLock({ navigationActive }) {
      await startTrafficTrip()
    }
  }

  // MARK: Navigation hooks (called by NavOSSNavigationService)

  /// Turn-by-turn guidance started on `trip`.
  public func navigationDidStart(_ trip: NavOSSCarPlayTrip) {
    lock.withLock {
      navigationActive = true
      routeGeometry = trip.geometry
      routeLengthMeters = navOSSRouteLengthMeters(trip.geometry)
      routeProgress = 0
      protectedPoints = Self.protectedPoints(trip)
      monitor.setReports(cache.active(now: Date()))
      monitor.startTrip(geometry: trip.geometry, maneuverAlongMeters: Self.maneuvers(trip))
    }
    // Independent: a slow credential request must not delay the reports on the route ahead.
    Task { await startTrafficTrip() }
    Task { await refreshCorridor() }
  }

  /// A reroute or edited stops on the same trip.
  public func navigationRouteDidChange(_ trip: NavOSSCarPlayTrip) {
    let points: [NavOSSCarPlayCoordinate] = lock.withLock {
      routeGeometry = trip.geometry
      routeLengthMeters = navOSSRouteLengthMeters(trip.geometry)
      routeProgress = 0
      monitor.replaceRoute(geometry: trip.geometry, maneuverAlongMeters: Self.maneuvers(trip))
      let added = Self.protectedPoints(trip).filter { !protectedPoints.contains($0) }
      protectedPoints += added
      return added
    }
    Task {
      await traffic?.protect(points)
      await refreshCorridor()
    }
  }

  /// Arrival or the end of guidance: trip-scoped traffic state is discarded.
  public func navigationDidEnd() {
    let wasActive: Bool = lock.withLock {
      let wasActive = navigationActive
      navigationActive = false
      routeGeometry = []
      protectedPoints = []
      monitor.endTrip()
      return wasActive
    }
    guard wasActive else { return }
    Task { await traffic?.endTrip() }
    notifyStateChange()
  }

  /// A new matched position. Returns the report to announce now, if any (the caller speaks it
  /// subject to the sound mode and `announcesRoadReports`).
  public func navigationDidUpdate(routeProgress: Double, isTracking: Bool) -> NavOSSCommunityReportAlert? {
    lock.withLock {
      guard navigationActive else { return nil }
      self.routeProgress = routeProgress
      return monitor.update(
        alongMeters: routeLengthMeters > 0 ? routeProgress * routeLengthMeters : nil,
        isTracking: isTracking,
        now: Date().timeIntervalSinceReferenceDate
      )
    }
  }

  /// A real positioning fix during guidance (never a replayed or JavaScript-supplied one).
  public func navigationDidReceiveFix(_ fix: NavOSSTrafficFix) {
    guard let traffic, lock.withLock({ navigationActive }) else { return }
    Task { await traffic.ingest(fix) }
  }

  /// The navigation service's one-second clock.
  public func navigationClockTick() {
    let now = Date()
    let due: Bool = lock.withLock {
      guard navigationActive else { return false }
      if let lastTrafficTick, now.timeIntervalSince(lastTrafficTick) < 5 { return false }
      lastTrafficTick = now
      return true
    }
    guard due else { return }
    Task {
      await traffic?.tick()
      await refreshCorridor()
    }
  }

  #if targetEnvironment(simulator)
    /// CarPlay visual harness only: publishes fixture reports through the production cache and
    /// map-alert path, without the network.
    public func publishHarnessReports(_ reports: [NavOSSCommunityReport]) {
      lock.withLock {
        reportsLive = true
        cache.store(
          reports,
          for: NavOSSCommunityBounds(east: 180, north: 90, south: -90, west: -180),
          now: Date()
        )
      }
      publishReports()
    }
  #endif

  // MARK: Private

  private func startTrafficTrip() async {
    guard let traffic else { return }
    let points = lock.withLock { protectedPoints }
    await traffic.startTrip(protectedPoints: points)
  }

  /// Keeps the route ahead fetched during guidance, so CarPlay and alerts see reports on it.
  private func refreshCorridor() async {
    guard client != nil else { return }
    let bounds: NavOSSCommunityBounds? = lock.withLock {
      guard navigationActive, !corridorFetchInFlight else { return nil }
      return navOSSCommunityCorridorBounds(routeGeometry: routeGeometry, routeProgress: routeProgress)
    }
    guard let bounds, lock.withLock({ cache.needsFetch(bounds, now: Date()) }) else { return }
    lock.withLock { corridorFetchInFlight = true }
    defer { lock.withLock { corridorFetchInFlight = false } }
    _ = try? await fetchReports(in: bounds)
  }

  private func preferencesDidChange() {
    let enabled = preferencesStore.load().sharesTrafficSpeeds
    let active = lock.withLock { navigationActive }
    Task {
      await traffic?.setEnabled(enabled)
      if enabled, active { await startTrafficTrip() }
    }
    notifyStateChange()
  }

  private func trafficStateDidChange(_ state: NavOSSTrafficSharingState) {
    lock.withLock { trafficState = state }
    notifyStateChange()
  }

  /// Publishes active reports to the CarPlay map and the alert monitor.
  private func publishReports() {
    let reports: [NavOSSCommunityReport] = lock.withLock {
      let reports = cache.active(now: Date())
      monitor.setReports(reports)
      return reports
    }
    alertStore.publish(
      reports.map {
        NavOSSCarPlayMapAlert(id: "report-\($0.id)", kind: .report($0.type), coordinate: $0.coordinate)
      },
      source: .communityReports
    )
    notifyStateChange()
  }

  private func notifyStateChange() {
    notificationCenter.post(name: .navOSSCommunityStateDidChange, object: self)
  }

  private static func protectedPoints(_ trip: NavOSSCarPlayTrip) -> [NavOSSCarPlayCoordinate] {
    var points: [NavOSSCarPlayCoordinate] = []
    if let first = trip.geometry.first { points.append(first) }
    if let last = trip.geometry.last { points.append(last) }
    points.append(
      NavOSSCarPlayCoordinate(latitude: trip.destination.latitude, longitude: trip.destination.longitude))
    for waypoint in trip.waypoints ?? [] {
      points.append(NavOSSCarPlayCoordinate(latitude: waypoint.latitude, longitude: waypoint.longitude))
    }
    return points.filter(\.isValid)
  }

  private static func maneuvers(_ trip: NavOSSCarPlayTrip) -> [Double] {
    navOSSCommunityManeuverAlongMeters(trip)
  }
}

private final class TrafficStateSink: @unchecked Sendable {
  weak var service: NavOSSCommunityService?
}

func navOSSRouteLengthMeters(_ geometry: [NavOSSCarPlayCoordinate]) -> Double {
  zip(geometry, geometry.dropFirst()).reduce(0) { total, pair in
    total
      + navigationDistanceMeters(
        from: NavigationCoordinate(latitude: pair.0.latitude, longitude: pair.0.longitude),
        to: NavigationCoordinate(latitude: pair.1.latitude, longitude: pair.1.longitude)
      )
  }
}
