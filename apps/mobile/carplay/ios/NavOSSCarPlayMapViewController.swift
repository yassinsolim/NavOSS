import CoreLocation
import MapLibre
internal import NavOSSNavigation
import UIKit

/// Feeds `MLNMapView.showsUserLocation` from a `CLLocationManager` explicitly configured for
/// background delivery, instead of `MLNMapView`'s private default location manager.
///
/// `MLNMapView.locationManager` exists precisely so a host app can supply its own: the SDK's own
/// documentation on the protocol notes a conforming type "does not need to be based on
/// `CLLocationManager`" at all. Nothing in this app ever configured the *default* manager for
/// background delivery (see `docs/architecture/carplay.md`), so once the phone's screen slept the
/// idle CarPlay map's own puck stopped updating and the camera never left its startup default.
/// This manager mirrors `NavOSSNavigationService`'s own location manager configuration —
/// `allowsBackgroundLocationUpdates`, driven by the `location` `UIBackgroundModes` entry every iOS
/// navigation build already declares — so the idle map's live-location source does not depend on
/// another manager's background session keeping the whole process from being suspended.
@MainActor
final class NavOSSCarPlayLocationManager: NSObject, @preconcurrency MLNLocationManager,
  @preconcurrency CLLocationManagerDelegate
{
  private let manager = CLLocationManager()
  weak var delegate: MLNLocationManagerDelegate?

  override init() {
    super.init()
    manager.activityType = .automotiveNavigation
    // Matches `MLNMapView`'s own default manager's accuracy/filter so swapping it in changes
    // nothing about fix cadence, only whether fixes keep arriving once the screen sleeps.
    manager.desiredAccuracy = kCLLocationAccuracyBest
    manager.distanceFilter = kCLDistanceFilterNone
    manager.pausesLocationUpdatesAutomatically = false
    let backgroundLocationEnabled =
      (Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String])?
      .contains("location") == true
    manager.allowsBackgroundLocationUpdates = backgroundLocationEnabled
    manager.showsBackgroundLocationIndicator = backgroundLocationEnabled
    // `MLNMapView` installs itself as `delegate` right after `locationManager` is assigned; do not
    // set it here.
    manager.delegate = self
  }

  var distanceFilter: CLLocationDistance {
    get { manager.distanceFilter }
    set { manager.distanceFilter = newValue }
  }

  var desiredAccuracy: CLLocationAccuracy {
    get { manager.desiredAccuracy }
    set { manager.desiredAccuracy = newValue }
  }

  var accuracyAuthorization: CLAccuracyAuthorization { manager.accuracyAuthorization }

  var activityType: CLActivityType {
    get { manager.activityType }
    set { manager.activityType = newValue }
  }

  var headingOrientation: CLDeviceOrientation {
    get { manager.headingOrientation }
    set { manager.headingOrientation = newValue }
  }

  var authorizationStatus: CLAuthorizationStatus { manager.authorizationStatus }

  func requestAlwaysAuthorization() { manager.requestAlwaysAuthorization() }
  func requestWhenInUseAuthorization() { manager.requestWhenInUseAuthorization() }
  func startUpdatingLocation() { manager.startUpdatingLocation() }
  func stopUpdatingLocation() { manager.stopUpdatingLocation() }
  func startUpdatingHeading() { manager.startUpdatingHeading() }
  func stopUpdatingHeading() { manager.stopUpdatingHeading() }
  func dismissHeadingCalibrationDisplay() { manager.dismissHeadingCalibrationDisplay() }

  func requestTemporaryFullAccuracyAuthorization(withPurposeKey purposeKey: String) {
    manager.requestTemporaryFullAccuracyAuthorization(withPurposeKey: purposeKey)
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    delegate?.locationManager(self, didUpdate: locations)
  }

  func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
    delegate?.locationManager(self, didUpdate: newHeading)
  }

  func locationManagerShouldDisplayHeadingCalibration(_ manager: CLLocationManager) -> Bool {
    delegate?.locationManagerShouldDisplayHeadingCalibration(self) ?? false
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    delegate?.locationManager(self, didFailWithError: error)
  }

  // Only forward: MLNMapView starts and stops updates from `showsUserLocation`. Starting here would
  // keep a background location session alive while the map has not asked for one.
  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    delegate?.locationManagerDidChangeAuthorization(self)
  }
}

/// Optional guidance decorations the scene delegate derives from the active trip. Every field may
/// be empty; the map then simply draws less.
struct NavOSSCarPlayGuidanceOverlay: Equatable {
  /// Road geometry around the next maneuver, drawn as a white arrow.
  var maneuverArrow: [NavOSSCarPlayCoordinate] = []
  /// Road currently being driven, shown in the bottom pill.
  var currentRoadName: String?
  /// Per-segment congestion aligned to the route geometry, when a real source provides it.
  var congestion: [NavOSSCarPlayCongestionLevel]?
  /// The navigation core's speeding verdict (tolerance and hysteresis applied there).
  var speeding = NavOSSSpeedingState.unknown
}

@MainActor
final class NavOSSCarPlayMapViewController: UIViewController,
  @preconcurrency MLNMapViewDelegate
{
  /// Layout constants for the speed and speed-limit readouts. Shared with the visual harness so its
  /// layout assertions follow the production values.
  static let hudMargin: CGFloat = 8
  static let hudGap: CGFloat = 6
  static let speedBadgeSize = CGSize(width: 52, height: 52)
  static let speedLimitBadgeSize = CGSize(width: 46, height: 56)

  private let calgaryCenter = CLLocationCoordinate2D(latitude: 51.0447, longitude: -114.0719)
  private let destinationLayerIdentifier = "navoss-carplay-destination"
  private let destinationSourceIdentifier = "navoss-carplay-destination-source"
  private let originLayerIdentifier = "navoss-carplay-origin"
  private let originSourceIdentifier = "navoss-carplay-origin-source"
  private let alternateRouteLayerIdentifier = "navoss-carplay-alternate-route"
  private let alternateRouteCasingLayerIdentifier = "navoss-carplay-alternate-route-casing"
  private let alternateRouteSourceIdentifier = "navoss-carplay-alternate-route-source"
  private let travelledRouteLayerIdentifier = "navoss-carplay-travelled-route"
  private let travelledRouteSourceIdentifier = "navoss-carplay-travelled-route-source"
  private let congestionLayerIdentifier = "navoss-carplay-congestion"
  private let congestionSourceIdentifier = "navoss-carplay-congestion-source"
  private let maneuverArrowCasingLayerIdentifier = "navoss-carplay-maneuver-arrow-casing"
  private let maneuverArrowLayerIdentifier = "navoss-carplay-maneuver-arrow"
  private let maneuverArrowHeadLayerIdentifier = "navoss-carplay-maneuver-arrow-head"
  private let maneuverArrowSourceIdentifier = "navoss-carplay-maneuver-arrow-source"
  private let maneuverArrowHeadSourceIdentifier = "navoss-carplay-maneuver-arrow-head-source"
  private let maneuverArrowHeadImageIdentifier = "navoss-carplay-maneuver-arrow-head-image"
  private let mapAlertLayerIdentifier = "navoss-carplay-map-alerts"
  private let mapAlertSourceIdentifier = "navoss-carplay-map-alerts-source"
  private let headingConeLayerIdentifier = "navoss-carplay-heading-cone"
  private let headingConeSourceIdentifier = "navoss-carplay-heading-cone-source"
  private let headingConeRadiusMeters = 30.0
  private let headingConeSpreadDegrees = 60.0
  private let carImageIdentifier = "navoss-carplay-vehicle-car"
  private let positionImageIdentifier = "navoss-carplay-vehicle-arrow"
  private let neutralImageIdentifier = "navoss-carplay-vehicle-neutral"
  private let shadowImageIdentifier = "navoss-carplay-vehicle-shadow"
  private let shadowLayerIdentifier = "navoss-carplay-position-shadow"
  private let positionLayerIdentifier = "navoss-carplay-position"
  private let positionSourceIdentifier = "navoss-carplay-position-source"
  private let routeCasingLayerIdentifier = "navoss-carplay-route-casing"
  private let routeLayerIdentifier = "navoss-carplay-route"
  private let routeSourceIdentifier = "navoss-carplay-route-source"
  private let routeHeadSourceIdentifier = "navoss-carplay-route-head-source"
  private let routeHeadCasingLayerIdentifier = "navoss-carplay-route-head-casing"
  private let routeHeadLayerIdentifier = "navoss-carplay-route-head"
  private var activeGuidance = false
  private var appearance = NavOSSCarPlayAppearance.automatic
  /// The vehicle's suggested map style from `CPTemplateApplicationScene.contentStyle`. It takes
  /// precedence over the window's trait collection in Automatic mode, because the car may keep
  /// maps dark while its other chrome is light.
  private var systemContentStyle: UIUserInterfaceStyle?
  private var displayLink: CADisplayLink?
  private var displayLinkScreen: UIScreen?
  private var interpolationFromPosition: NavOSSCarPlayPosition?
  private var interpolationStartedAt: CFTimeInterval = 0
  private var interpolationDuration: CFTimeInterval = navOSSCarPlayDefaultInterpolationSeconds
  private var lastTargetAt: CFTimeInterval?
  private var latestDestination: NavOSSCarPlayCoordinate?
  private var latestOrigin: NavOSSCarPlayCoordinate?
  private var latestPosition: NavOSSCarPlayPosition?
  private var mapOrientation = NavOSSCarPlayMapOrientation.headingUp
  private var idleLocationFollowEnabled = true
  private var renderedPosition: NavOSSCarPlayPosition?
  private var lastRenderedCourseDegrees: Double?
  private var lastHeadingConeApex: NavOSSCarPlayCoordinate?
  private var lastHeadingConeHeadingDegrees: Double?
  /// Where the follow camera is heading, and where it is now. The camera eases toward the target
  /// every frame instead of jumping when speed or the next maneuver changes the ideal view.
  private var cameraTarget = navOSSCarPlayCameraTarget(
    speedMetersPerSecond: nil,
    distanceToManeuverMeters: nil
  )
  private var cameraDistance = Double.nan
  private var cameraPitch = Double.nan
  private var cameraHeading = Double.nan
  private var cameraFrameAt: CFTimeInterval?
  /// Driver zoom on top of the automatic camera distance; 1 is automatic.
  private var navigationZoomScale = 1.0
  private var latestDistanceToManeuverMeters: Double?
  private var presentsRouteOverview = false
  private var guidanceHiddenLayerIdentifiers: Set<String> = []
  /// Original text sizes of road-label layers, kept so guidance can enlarge them and restore them.
  private var roadLabelFontSizes: [String: NSExpression] = [:]
  private var roadLabelHaloWidths: [String: NSExpression] = [:]
  private var lastLaidOutMapSize = CGSize.zero
  private var routeFitGeneration: UInt64 = 0
  private var alternateRouteCoordinates: [CLLocationCoordinate2D] = []
  private var routeCoordinates: [CLLocationCoordinate2D] = []
  private var routeGeometry: [NavOSSCarPlayCoordinate] = []
  private var routeProgress = 0.0
  private var guidanceOverlay = NavOSSCarPlayGuidanceOverlay()
  private var mapAlerts: [NavOSSCarPlayMapAlert] = []
  nonisolated(unsafe) private var mapAlertObserver: NSObjectProtocol?
  private var routeId: String?
  private var showsPointsOfInterest = true
  private var styleLoadRetryCount = 0
  private var styleLoadWatchdog: DispatchWorkItem?
  private var styleSlug = "liberty"
  /// The style URL last given to the map: hosted OpenFreeMap, or a bound offline style file.
  private var loadedStyleURL: URL?
  /// Set when the hosted style could not load and an installed offline region took over; cleared
  /// when connectivity returns so the hosted map comes back.
  private var offlineStyleFallback = false
  nonisolated(unsafe) private var offlineStateObserver: NSObjectProtocol?
  /// Draws the installed offline map regardless of connectivity (the visual harness's offline
  /// scenarios). Set before the view loads.
  var forcesOfflineStyle = false
  private let attributionLabel = UILabel()
  private var vehicleMarker = NavOSSCarPlayVehicleMarker.arrow
  private(set) var mapView: MLNMapView!
  private let speedLabel = UILabel()
  private let speedLimitLabel = UILabel()
  private let roadNameLabel = NavOSSCarPlayInsetLabel()
  private weak var overlayContentView: UIView?
  private var overlayTopConstraint: NSLayoutConstraint?
  private var overlayTrailingConstraint: NSLayoutConstraint?
  private var speedTrailingConstraint: NSLayoutConstraint?
  /// When `true`, the speed / speed-limit readouts anchor to this view controller's own
  /// content bounds (the map view controller's `topAnchor`/`trailingAnchor`) instead of the
  /// live `safeAreaLayoutGuide`. The main CarPlay map template's window IS the app's full
  /// content region, so its content bounds already sit at the persistent top-right corner
  /// of the display; unlike the live safe area, they do not shift when CarPlay transiently
  /// grows safe-area insets around chrome it draws over the map — for example the trip/back
  /// affordance it surfaces at the top-left when the driver touches the map. Defaults to
  /// `false`, which keeps the previous live-safe-area behavior used by the dashboard scene
  /// (a plain `UIWindow` without that transient-chrome quirk) and the visual harness. May be
  /// set before or after the view loads.
  var anchorsSpeedHUDToViewBounds = false {
    didSet { updateOverlayAnchors() }
  }
  /// Whether the speed-limit sign may be drawn. The instrument cluster turns this off when the
  /// vehicle's own cluster setting hides speed limits.
  var showsSpeedLimit = true
  /// Whether the current-road pill may be drawn. Small surfaces such as the cluster turn it off.
  var showsRoadName = true
  /// Whether the current-speed badge may be drawn. The instrument cluster already shows the
  /// vehicle's own speedometer.
  var showsCurrentSpeed = true
  var onStyleLoaded: (() -> Void)?
  var reservesRouteChoiceSheet = true
  private(set) var requestsUserLocation = true

  override func loadView() {
    styleSlug = resolvedStyleSlug()
    let styleURL = resolvedStyleURL()
    loadedStyleURL = styleURL
    let mapView = MLNMapView(frame: .zero, styleURL: styleURL)
    mapView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    mapView.isPitchEnabled = false
    mapView.isRotateEnabled = false
    // The vehicle and camera are animated every frame; let MapLibre render as fast as the car
    // display allows instead of its adaptive default.
    mapView.preferredFramesPerSecond = MLNMapViewPreferredFramesPerSecond.maximum
    // MapLibre reports real gesture reasons to the delegate, so an explicit idle pan can pause
    // follow without treating our own camera animations as a driver gesture.
    mapView.isScrollEnabled = true
    mapView.isZoomEnabled = false
    mapView.compassView.isHidden = true
    mapView.logoView.isHidden = true
    mapView.attributionButton.isHidden = true
    mapView.delegate = self
    // `MLNMapView`'s own default location manager is a private `CLLocationManager` this app never
    // configures for background delivery; set the custom one before `showsUserLocation` per
    // `MLNMapView.locationManager`'s documented requirement.
    mapView.locationManager = NavOSSCarPlayLocationManager()
    mapView.showsUserLocation = requestsUserLocation
    mapView.setCenter(calgaryCenter, zoomLevel: 10.5, animated: false)
    self.mapView = mapView
    scheduleStyleLoadWatchdog()
    let container = UIView(frame: .zero)
    overlayContentView = container
    container.addSubview(mapView)
    attributionLabel.backgroundColor = UIColor.secondarySystemBackground.withAlphaComponent(0.78)
    attributionLabel.font = UIFont.systemFont(ofSize: 9, weight: .medium)
    attributionLabel.layer.cornerRadius = 3
    attributionLabel.clipsToBounds = true
    updateAttribution()
    attributionLabel.textColor = .secondaryLabel
    attributionLabel.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(attributionLabel)
    speedLabel.font = UIFont.monospacedDigitSystemFont(ofSize: 20, weight: .bold)
    speedLabel.layer.borderWidth = 2
    speedLabel.layer.cornerRadius = Self.speedBadgeSize.width / 2
    speedLabel.clipsToBounds = true
    speedLabel.numberOfLines = 2
    speedLabel.textAlignment = .center
    speedLabel.translatesAutoresizingMaskIntoConstraints = false
    speedLabel.isHidden = true
    speedLabel.accessibilityIdentifier = "carplay-speed"
    container.addSubview(speedLabel)
    // Canadian regulatory signs are black on white with a black border; the badge stays that way
    // in both appearances so it reads as a sign rather than app chrome.
    speedLimitLabel.backgroundColor = .white
    speedLimitLabel.layer.borderColor = UIColor.black.cgColor
    speedLimitLabel.layer.borderWidth = 2.5
    speedLimitLabel.layer.cornerRadius = 6
    speedLimitLabel.clipsToBounds = true
    speedLimitLabel.numberOfLines = 2
    speedLimitLabel.textAlignment = .center
    speedLimitLabel.textColor = .black
    speedLimitLabel.translatesAutoresizingMaskIntoConstraints = false
    speedLimitLabel.isHidden = true
    speedLimitLabel.accessibilityIdentifier = "carplay-speed-limit"
    container.addSubview(speedLimitLabel)
    roadNameLabel.font = UIFont.systemFont(ofSize: 15, weight: .semibold)
    roadNameLabel.textAlignment = .center
    roadNameLabel.lineBreakMode = .byTruncatingTail
    roadNameLabel.layer.cornerRadius = 15
    roadNameLabel.layer.borderWidth = 1
    roadNameLabel.clipsToBounds = true
    roadNameLabel.translatesAutoresizingMaskIntoConstraints = false
    roadNameLabel.isHidden = true
    roadNameLabel.accessibilityIdentifier = "carplay-current-road"
    container.addSubview(roadNameLabel)
    let speedTrailing = speedLabel.trailingAnchor.constraint(
      equalTo: speedLimitLabel.trailingAnchor,
      constant: -(Self.speedLimitBadgeSize.width + Self.hudGap)
    )
    NSLayoutConstraint.activate([
      attributionLabel.leadingAnchor.constraint(
        equalTo: container.safeAreaLayoutGuide.leadingAnchor,
        constant: 8
      ),
      attributionLabel.bottomAnchor.constraint(
        equalTo: container.safeAreaLayoutGuide.bottomAnchor,
        constant: -6
      ),
      attributionLabel.heightAnchor.constraint(equalToConstant: 18),
      speedLimitLabel.widthAnchor.constraint(equalToConstant: Self.speedLimitBadgeSize.width),
      speedLimitLabel.heightAnchor.constraint(equalToConstant: Self.speedLimitBadgeSize.height),
      speedTrailing,
      speedLabel.centerYAnchor.constraint(equalTo: speedLimitLabel.centerYAnchor),
      speedLabel.widthAnchor.constraint(equalToConstant: Self.speedBadgeSize.width),
      speedLabel.heightAnchor.constraint(equalToConstant: Self.speedBadgeSize.height),
      // The road pill sits at the bottom centre of the live safe area, so CarPlay's guidance card
      // and map buttons never cover it; a bottom anchor is unaffected by the transient top chrome.
      roadNameLabel.centerXAnchor.constraint(equalTo: container.safeAreaLayoutGuide.centerXAnchor),
      roadNameLabel.bottomAnchor.constraint(
        equalTo: container.safeAreaLayoutGuide.bottomAnchor,
        constant: -10
      ),
      roadNameLabel.heightAnchor.constraint(equalToConstant: 30),
      roadNameLabel.widthAnchor.constraint(
        lessThanOrEqualTo: container.safeAreaLayoutGuide.widthAnchor,
        multiplier: 0.5
      ),
    ])
    speedTrailingConstraint = speedTrailing
    updateOverlayAnchors()
    applyOverlayColors()
    view = container
    mapAlerts = NavOSSCarPlayMapAlertStore.shared.snapshot()
    mapAlertObserver = NotificationCenter.default.addObserver(
      forName: .navOSSCarPlayMapAlertsDidChange,
      object: NavOSSCarPlayMapAlertStore.shared,
      queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.mapAlerts = NavOSSCarPlayMapAlertStore.shared.snapshot()
        self.installMapAlertsIfReady()
      }
    }
    offlineStateObserver = NotificationCenter.default.addObserver(
      forName: .navOSSOfflineStateDidChange,
      object: NavOSSOfflineStore.shared,
      queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated {
        self?.offlineStateDidChange()
      }
    }
  }

  deinit {
    if let mapAlertObserver {
      NotificationCenter.default.removeObserver(mapAlertObserver)
    }
    if let offlineStateObserver {
      NotificationCenter.default.removeObserver(offlineStateObserver)
    }
  }

  // MARK: - Offline map style

  /// Where the map is, for choosing which installed offline region to draw.
  private var styleFocus: NavOSSCarPlayCoordinate? {
    if let latestPosition { return latestPosition.coordinate }
    if let first = routeGeometry.first { return first }
    guard let mapView else { return nil }
    return NavOSSCarPlayCoordinate(
      latitude: mapView.centerCoordinate.latitude, longitude: mapView.centerCoordinate.longitude)
  }

  /// The installed offline style when one should be drawn (no network, prefer-offline inside
  /// coverage, or the hosted style failed); otherwise the hosted OpenFreeMap style. Offline
  /// styles use the same slugs, so presets and road-label tuning apply unchanged.
  private func resolvedStyleURL() -> URL? {
    let store = NavOSSOfflineStore.shared
    let focus = styleFocus
    if forcesOfflineStyle || offlineStyleFallback || store.shouldUseOfflineMap(near: focus),
      let offline = store.offlineStyleFile(slug: styleSlug, near: focus)
    {
      return offline
    }
    return URL(string: "https://tiles.openfreemap.org/styles/\(styleSlug)")
  }

  /// Offline styles render OpenMapTiles-schema data built from OpenStreetMap; both are credited.
  private func updateAttribution() {
    attributionLabel.text =
      loadedStyleURL?.isFileURL == true
      ? "  Offline map · © OpenMapTiles · © OpenStreetMap contributors  "
      : "  © OpenStreetMap contributors  "
  }

  private func offlineStateDidChange() {
    guard isViewLoaded else { return }
    if offlineStyleFallback, NavOSSOfflineStore.shared.isNetworkAvailable {
      offlineStyleFallback = false
    }
    guard resolvedStyleURL() != loadedStyleURL else { return }
    loadStyle(resetRetryCount: true)
  }

  /// After the hosted style has failed its retries, an installed region keeps the map usable.
  private func fallBackToOfflineStyle() -> Bool {
    guard !offlineStyleFallback,
      NavOSSOfflineStore.shared.offlineStyleFile(slug: styleSlug, near: styleFocus) != nil
    else {
      return false
    }
    offlineStyleFallback = true
    loadStyle(resetRetryCount: true)
    return true
  }

  /// Overlay colours follow the resolved map style, not the system appearance, so a dark map never
  /// carries light chips.
  private func applyOverlayColors() {
    let dark = styleSlug == "dark"
    roadNameLabel.backgroundColor =
      dark
      ? UIColor(red: 0.118, green: 0.169, blue: 0.173, alpha: 0.94)
      : UIColor(white: 1, alpha: 0.95)
    roadNameLabel.textColor = dark ? UIColor(white: 0.96, alpha: 1) : UIColor(red: 0.055, green: 0.082, blue: 0.086, alpha: 1)
    roadNameLabel.layer.borderColor =
      (dark ? UIColor(white: 1, alpha: 0.12) : UIColor(red: 0.85, green: 0.87, blue: 0.86, alpha: 1))
      .cgColor
    applySpeedColors(isSpeeding: speedLabel.tag == 1)
  }

  private func applySpeedColors(isSpeeding: Bool) {
    let dark = styleSlug == "dark"
    speedLabel.tag = isSpeeding ? 1 : 0
    if isSpeeding {
      speedLabel.backgroundColor = UIColor(red: 0.898, green: 0.282, blue: 0.302, alpha: 1)
      speedLabel.layer.borderColor = UIColor.white.cgColor
      speedLabel.textColor = .white
    } else {
      speedLabel.backgroundColor =
        dark ? UIColor(red: 0.118, green: 0.169, blue: 0.173, alpha: 0.96) : UIColor(white: 1, alpha: 0.97)
      speedLabel.layer.borderColor =
        (dark ? UIColor(white: 1, alpha: 0.18) : UIColor(red: 0.85, green: 0.87, blue: 0.86, alpha: 1))
        .cgColor
      speedLabel.textColor = dark ? .white : UIColor(red: 0.055, green: 0.082, blue: 0.086, alpha: 1)
    }
  }

  /// Re-anchors the speed / speed-limit readouts per `anchorsSpeedHUDToViewBounds`, replacing
  /// any previously installed constraints. Safe to call before the view has loaded; it
  /// becomes a no-op until `loadView` supplies `overlayContentView`, at which point the
  /// initial call in `loadView` picks up whichever mode was selected first.
  private func updateOverlayAnchors() {
    guard let container = overlayContentView else { return }
    overlayTopConstraint?.isActive = false
    overlayTrailingConstraint?.isActive = false
    let top: NSLayoutConstraint
    let trailing: NSLayoutConstraint
    let margin = Self.hudMargin
    if anchorsSpeedHUDToViewBounds {
      top = speedLimitLabel.topAnchor.constraint(equalTo: container.topAnchor, constant: margin)
      trailing = speedLimitLabel.trailingAnchor.constraint(
        equalTo: container.trailingAnchor,
        constant: -margin
      )
    } else {
      top = speedLimitLabel.topAnchor.constraint(
        equalTo: container.safeAreaLayoutGuide.topAnchor,
        constant: margin
      )
      trailing = speedLimitLabel.trailingAnchor.constraint(
        equalTo: container.safeAreaLayoutGuide.trailingAnchor,
        constant: -margin
      )
    }
    NSLayoutConstraint.activate([top, trailing])
    overlayTopConstraint = top
    overlayTrailingConstraint = trailing
  }

  /// Toggles whether the speed badge's trailing edge sits `badgeWidth + gap` inside the
  /// speed-limit badge's trailing edge (limit visible, ordering preserved: speed left, limit
  /// right) or flush with it (limit hidden/unknown) — so speed always occupies the true
  /// trailing slot instead of leaving a blank badge-width gap where an unknown limit would
  /// have been.
  private func updateSpeedTrailingConstraint(limitVisible: Bool) {
    speedTrailingConstraint?.constant =
      limitVisible ? -(Self.speedLimitBadgeSize.width + Self.hudGap) : 0
  }

  /// The current-speed readout's frame in `view` coordinates. Exposed (not `private`) so the
  /// visual harness and any future layout regression test can assert the overlay holds its
  /// position at the content's persistent top-right anchor across simulated CarPlay chrome
  /// changes, sliding flush to the trailing edge (no blank slot) whenever the speed limit is
  /// unknown/hidden.
  var speedReadoutFrame: CGRect { speedLabel.frame }

  var speedReadoutIsVisible: Bool { !speedLabel.isHidden }

  /// The speed-limit readout's frame in `view` coordinates, or `nil` while it is hidden — an
  /// unknown limit is never synthesized into a visible-but-blank badge.
  var speedLimitReadoutFrame: CGRect? {
    speedLimitLabel.isHidden ? nil : speedLimitLabel.frame
  }

  /// Road-label layers currently enlarged for guidance, for the visual harness.
  var enlargedRoadLabelLayerCount: Int { activeGuidance ? roadLabelFontSizes.count : 0 }

  /// The current-road pill's text while it is shown, for the visual harness.
  var currentRoadNameReadout: String? {
    roadNameLabel.isHidden ? nil : roadNameLabel.text
  }

  override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    super.traitCollectionDidChange(previousTraitCollection)
    guard traitCollection.hasDifferentColorAppearance(comparedTo: previousTraitCollection) else {
      return
    }
    reloadStyleIfNeeded()
  }

  override func viewSafeAreaInsetsDidChange() {
    super.viewSafeAreaInsetsDidChange()
    updateGuidanceContentInset()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    mapView.frame = view.bounds
    let mapSize = mapView.bounds.size
    guard mapSize.width > 0, mapSize.height > 0, mapSize != lastLaidOutMapSize else { return }
    lastLaidOutMapSize = mapSize
    guard routeCoordinates.count >= 2 else { return }
    if activeGuidance, !presentsRouteOverview, latestPosition != nil {
      recenter()
    } else {
      fitRoute(animated: false)
    }
  }

  /// During guidance the vehicle is centred in the part of the map CarPlay leaves visible beside
  /// the guidance card. Only horizontal insets are used: the top inset changes whenever the
  /// navigation bar appears, and following it would bounce the camera on every touch.
  private func updateGuidanceContentInset() {
    guard isViewLoaded else { return }
    let insets = view.safeAreaInsets
    let target =
      activeGuidance && !presentsRouteOverview
      ? UIEdgeInsets(top: 0, left: insets.left, bottom: 0, right: insets.right)
      : .zero
    guard mapView.contentInset != target else { return }
    mapView.setContentInset(target, animated: false, completionHandler: nil)
  }

  func applyAppearance(_ appearance: NavOSSCarPlayAppearance) {
    self.appearance = appearance
    overrideUserInterfaceStyle =
      switch appearance {
      case .automatic: .unspecified
      case .dark: .dark
      case .light: .light
      }
    reloadStyleIfNeeded()
  }

  /// Applies the vehicle's suggested content style (`CPTemplateApplicationScene.contentStyle`). In
  /// Automatic mode this decides light or dark maps, so the map follows the car's headlights or
  /// night setting rather than only the phone's appearance.
  func applyContentStyle(_ contentStyle: UIUserInterfaceStyle) {
    systemContentStyle = contentStyle == .unspecified ? nil : contentStyle
    reloadStyleIfNeeded()
  }

  private func reloadStyleIfNeeded() {
    guard isViewLoaded else {
      return
    }
    let nextStyleSlug = resolvedStyleSlug()
    guard nextStyleSlug != styleSlug else {
      return
    }
    styleSlug = nextStyleSlug
    applyOverlayColors()
    loadStyle(resetRetryCount: true)
  }

  func setIdleLocationTrackingEnabled(_ enabled: Bool) {
    requestsUserLocation = enabled
    guard isViewLoaded, !activeGuidance else { return }
    mapView.showsUserLocation = enabled
    if enabled {
      // A route preview owns its camera until the driver explicitly recenters.
      if routeCoordinates.count >= 2 {
        idleLocationFollowEnabled = false
        mapView.setUserTrackingMode(.none, animated: false, completionHandler: nil)
      } else {
        recenter()
      }
    } else {
      idleLocationFollowEnabled = false
      mapView.setUserTrackingMode(.none, animated: false, completionHandler: nil)
    }
  }

  func applyMapPreferences(
    showsPointsOfInterest: Bool,
    vehicleMarker: NavOSSCarPlayVehicleMarker
  ) {
    self.showsPointsOfInterest = showsPointsOfInterest
    self.vehicleMarker = vehicleMarker
    guard isViewLoaded else { return }
    updatePointOfInterestVisibility()
    installPositionOverlayIfReady()
  }

  func applyMapOrientation(_ mapOrientation: NavOSSCarPlayMapOrientation) {
    self.mapOrientation = mapOrientation
    guard isViewLoaded, activeGuidance || idleLocationFollowEnabled else { return }
    recenter()
  }

  private func resolvedStyleSlug() -> String {
    switch appearance {
    case .automatic:
      (systemContentStyle ?? traitCollection.userInterfaceStyle) == .dark ? "dark" : "liberty"
    case .dark:
      "dark"
    case .light:
      "liberty"
    }
  }

  private var idleLocationTrackingMode: MLNUserTrackingMode {
    mapOrientation == .northUp ? .follow : .followWithCourse
  }

  func recenter() {
    presentsRouteOverview = false
    if activeGuidance {
      if let latestPosition {
        follow(latestPosition, duration: 0.35)
      } else {
        fitRoute(animated: true)
      }
      return
    }

    guard requestsUserLocation else {
      idleLocationFollowEnabled = false
      mapView.setUserTrackingMode(.none, animated: false, completionHandler: nil)
      return
    }

    idleLocationFollowEnabled = true
    flattenCamera()
    // Do not let MapLibre center on an old cached `userLocation`. It takes over as soon as its
    // delegate supplies a fresh fix; until then, a separately validated service coordinate can
    // center the camera without becoming a fake live puck.
    if currentLocationCoordinate() != nil {
      mapView.setUserTrackingMode(
        idleLocationTrackingMode,
        animated: true,
        completionHandler: nil
      )
    } else {
      mapView.setUserTrackingMode(.none, animated: false, completionHandler: nil)
      if let fallbackCoordinate = NavOSSNavigationService.shared.currentCoordinate() {
        displayIdleLocation(fallbackCoordinate, animated: true)
      }
    }
  }

  func displayIdleLocation(
    _ coordinate: NavOSSCarPlayCoordinate,
    animated: Bool
  ) {
    guard !activeGuidance, coordinate.latitude.isFinite, coordinate.longitude.isFinite,
      (-90...90).contains(coordinate.latitude), (-180...180).contains(coordinate.longitude)
    else { return }
    // This is a camera fallback only. It deliberately does not synthesize a MapLibre user location
    // or change tracking mode, so an old service cache can never masquerade as a live puck.
    flattenCamera()
    mapView.setCenter(
      CLLocationCoordinate2D(latitude: coordinate.latitude, longitude: coordinate.longitude),
      zoomLevel: 15.5,
      animated: animated
    )
  }

  /// The idle map is flat: leaving guidance must not keep its tilted driving camera, which with
  /// 3D buildings restored made the idle map read as a skyline instead of a map. Heading is kept
  /// so heading-up idle tracking does not spin.
  private func flattenCamera() {
    guard mapView.camera.pitch != 0 else { return }
    let flat = mapView.camera
    flat.pitch = 0
    mapView.setCamera(flat, withDuration: 0, animationTimingFunction: nil)
    cameraPitch = .nan
  }

  func currentLocationCoordinate() -> NavOSSCarPlayCoordinate? {
    guard let location = mapView.userLocation?.location,
      navOSSNavigationRouteOrigin(
        coordinate: NavOSSCarPlayCoordinate(
          latitude: location.coordinate.latitude,
          longitude: location.coordinate.longitude
        ),
        courseDegrees: location.course,
        speedMetersPerSecond: location.speed,
        horizontalAccuracyMeters: location.horizontalAccuracy,
        ageSeconds: Date().timeIntervalSince(location.timestamp)
      ) != nil
    else { return nil }
    return NavOSSCarPlayCoordinate(
      latitude: location.coordinate.latitude,
      longitude: location.coordinate.longitude
    )
  }

  func toggleRouteOverview() -> Bool {
    presentsRouteOverview.toggle()
    updateGuidanceContentInset()
    updateGuidanceDecorations()
    if presentsRouteOverview {
      fitRoute(animated: true)
    } else {
      recenter()
    }
    return presentsRouteOverview
  }

  func display(
    route: [NavOSSCarPlayCoordinate],
    routeId: String,
    activeGuidance: Bool,
    position: NavOSSCarPlayPosition? = nil,
    routeProgress: Double = 0,
    alternateRoute: [NavOSSCarPlayCoordinate]? = nil,
    distanceToManeuverMeters: Double? = nil,
    speedLimitKph: Int? = nil,
    overlay: NavOSSCarPlayGuidanceOverlay = NavOSSCarPlayGuidanceOverlay()
  ) {
    let routeOriginPosition = route.first.map {
      NavOSSCarPlayPosition(
        coordinate: $0,
        courseDegrees: nil,
        speedMetersPerSecond: nil
      )
    }
    let effectivePosition =
      position ?? latestPosition ?? (activeGuidance ? routeOriginPosition : nil)
    let shouldEnterFollowMode = activeGuidance && (!self.activeGuidance || renderedPosition == nil)
    self.activeGuidance = activeGuidance
    mapView.isScrollEnabled = !activeGuidance
    if !activeGuidance {
      idleLocationFollowEnabled = false
      mapView.setUserTrackingMode(.none, animated: false, completionHandler: nil)
    }
    latestOrigin = activeGuidance ? nil : route.first
    latestDestination = route.last
    if let effectivePosition {
      updateTargetPosition(effectivePosition)
    } else if !activeGuidance {
      latestPosition = nil
      renderedPosition = nil
      lastRenderedCourseDegrees = nil
      lastTargetAt = nil
    }
    latestDistanceToManeuverMeters = activeGuidance ? distanceToManeuverMeters : nil
    cameraTarget = navOSSCarPlayCameraTarget(
      speedMetersPerSecond: effectivePosition?.speedMetersPerSecond,
      distanceToManeuverMeters: latestDistanceToManeuverMeters
    )
    self.routeProgress = routeProgress
    guidanceOverlay = activeGuidance ? overlay : NavOSSCarPlayGuidanceOverlay()
    updateGuidanceContentInset()
    mapView.showsUserLocation = requestsUserLocation && !activeGuidance
    self.routeId = routeId
    let displayedRoute =
      activeGuidance
      ? navOSSRemainingRouteGeometry(
        route,
        routeProgress: routeProgress,
        matchedCoordinate: (renderedPosition ?? effectivePosition)?.coordinate
      )
      : route
    // The true road geometry, not `displayedRoute`. `navOSSRemainingRouteGeometry` prepends the
    // puck as element 0, so measuring against it would put the vehicle 0 m from the "route" and
    // make the distance gate in `navOSSRouteBearingDegrees` unreachable.
    routeGeometry = route
    routeCoordinates = displayedRoute.map {
      CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude)
    }
    alternateRouteCoordinates =
      activeGuidance
      ? []
      : (alternateRoute ?? []).map {
        CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude)
      }
    installAlternateRouteOverlayIfReady()
    installRouteOverlayIfReady()
    installOriginOverlayIfReady()
    installDestinationOverlayIfReady()
    installPositionOverlayIfReady()
    installTravelledRouteIfReady()
    installCongestionIfReady()
    installManeuverArrowIfReady()
    installMapAlertsIfReady()
    updateSpeedDisplay(
      effectivePosition?.speedMetersPerSecond,
      speeding: overlay.speeding
    )
    updateSpeedLimitDisplay(speedLimitKph)
    updateRoadNameDisplay()
    updateGuidanceDeclutter()
    updatePointOfInterestVisibility()
    if activeGuidance, let effectivePosition {
      if presentsRouteOverview {
        fitRoute(animated: false)
      } else if shouldEnterFollowMode {
        follow(effectivePosition, duration: 0)
      }
    } else if activeGuidance {
      fitRoute(animated: true)
    } else if !activeGuidance {
      fitRoute(animated: true)
    }
  }

  func clearRoute() {
    routeFitGeneration &+= 1
    if activeGuidance {
      flattenCamera()
    }
    activeGuidance = false
    latestOrigin = nil
    latestDestination = nil
    latestPosition = nil
    renderedPosition = nil
    lastRenderedCourseDegrees = nil
    lastHeadingConeApex = nil
    lastHeadingConeHeadingDegrees = nil
    lastTargetAt = nil
    invalidateDisplayLink()
    speedLabel.isHidden = true
    speedLimitLabel.isHidden = true
    roadNameLabel.isHidden = true
    updateSpeedTrailingConstraint(limitVisible: false)
    resetCamera()
    presentsRouteOverview = false
    routeId = nil
    alternateRouteCoordinates = []
    routeCoordinates = []
    routeGeometry = []
    routeProgress = 0
    guidanceOverlay = NavOSSCarPlayGuidanceOverlay()
    latestDistanceToManeuverMeters = nil
    updateGuidanceContentInset()
    mapView.isScrollEnabled = true
    mapView.showsUserLocation = requestsUserLocation
    for identifier in [
      travelledRouteSourceIdentifier, congestionSourceIdentifier, maneuverArrowSourceIdentifier,
      maneuverArrowHeadSourceIdentifier,
    ] {
      (mapView.style?.source(withIdentifier: identifier) as? MLNShapeSource)?.shape = nil
    }
    updateGuidanceDeclutter()
    if let source = mapView.style?.source(withIdentifier: routeSourceIdentifier)
      as? MLNShapeSource
    {
      source.shape = nil
    }
    if let source = mapView.style?.source(withIdentifier: routeHeadSourceIdentifier)
      as? MLNShapeSource
    {
      source.shape = nil
    }
    if let source = mapView.style?.source(withIdentifier: headingConeSourceIdentifier)
      as? MLNShapeSource
    {
      source.shape = nil
    }
    if let source = mapView.style?.source(withIdentifier: alternateRouteSourceIdentifier)
      as? MLNShapeSource
    {
      source.shape = nil
    }
    if let source = mapView.style?.source(withIdentifier: positionSourceIdentifier)
      as? MLNShapeSource
    {
      source.shape = nil
    }
    if let source = mapView.style?.source(withIdentifier: destinationSourceIdentifier)
      as? MLNShapeSource
    {
      source.shape = nil
    }
    if let source = mapView.style?.source(withIdentifier: originSourceIdentifier)
      as? MLNShapeSource
    {
      source.shape = nil
    }
    updatePointOfInterestVisibility()
    recenter()
  }

  func deactivate() {
    routeFitGeneration &+= 1
    invalidateDisplayLink()
    latestPosition = nil
    renderedPosition = nil
    lastRenderedCourseDegrees = nil
    lastHeadingConeApex = nil
    lastHeadingConeHeadingDegrees = nil
    lastTargetAt = nil
    idleLocationFollowEnabled = false
    mapView.isScrollEnabled = false
    mapView.showsUserLocation = false
    mapView.setUserTrackingMode(.none, animated: false, completionHandler: nil)
    mapView.delegate = nil
  }

  func zoom(by delta: Double) {
    if activeGuidance {
      navigationZoomScale = max(0.4, min(4, navigationZoomScale * pow(2, -delta)))
      recenter()
    } else {
      idleLocationFollowEnabled = false
      mapView.setUserTrackingMode(.none, animated: false, completionHandler: nil)
      mapView.setZoomLevel(max(8, min(18, mapView.zoomLevel + delta)), animated: true)
    }
  }

  /// Forgets the follow camera's eased state so the next follow starts from the ideal view.
  private func resetCamera() {
    cameraDistance = .nan
    cameraPitch = .nan
    cameraHeading = .nan
    cameraFrameAt = nil
    navigationZoomScale = 1
  }

  func mapView(_ mapView: MLNMapView, didFinishLoading style: MLNStyle) {
    styleLoadWatchdog?.cancel()
    styleLoadWatchdog = nil
    styleLoadRetryCount = 0
    lastHeadingConeApex = nil
    lastHeadingConeHeadingDegrees = nil
    roadLabelFontSizes = [:]
    roadLabelHaloWidths = [:]
    guidanceHiddenLayerIdentifiers = []
    applyOverlayColors()
    installAlternateRouteOverlayIfReady()
    installRouteOverlayIfReady()
    installTravelledRouteIfReady()
    installCongestionIfReady()
    installManeuverArrowIfReady()
    installOriginOverlayIfReady()
    installDestinationOverlayIfReady()
    installMapAlertsIfReady()
    installPositionOverlayIfReady()
    updateGuidanceDeclutter()
    updatePointOfInterestVisibility()
    if activeGuidance {
      if presentsRouteOverview {
        fitRoute(animated: false)
      } else if latestPosition != nil {
        recenter()
      } else {
        fitRoute(animated: false)
      }
    } else if routeCoordinates.count >= 2 {
      fitRoute(animated: false)
    } else {
      recenter()
    }
    onStyleLoaded?()
  }

  func mapView(_ mapView: MLNMapView, didUpdate userLocation: MLNUserLocation?) {
    guard
      navOSSShouldFollowIdleCarPlayLocation(
        hasActiveGuidance: activeGuidance,
        idleFollowEnabled: idleLocationFollowEnabled,
        requestsUserLocation: requestsUserLocation
      ),
      let location = userLocation?.location,
      navOSSNavigationRouteOrigin(
        coordinate: NavOSSCarPlayCoordinate(
          latitude: location.coordinate.latitude,
          longitude: location.coordinate.longitude
        ),
        courseDegrees: location.course,
        speedMetersPerSecond: location.speed,
        horizontalAccuracyMeters: location.horizontalAccuracy,
        ageSeconds: Date().timeIntervalSince(location.timestamp)
      ) != nil
    else { return }
    if mapView.userTrackingMode != idleLocationTrackingMode {
      mapView.setUserTrackingMode(
        idleLocationTrackingMode,
        animated: false,
        completionHandler: nil
      )
    }
  }

  func mapView(_ mapView: MLNMapView, regionIsChangingWith reason: MLNCameraChangeReason) {
    guard !activeGuidance, requestsUserLocation, reason.contains(.gesturePan) else { return }
    idleLocationFollowEnabled = false
    mapView.setUserTrackingMode(.none, animated: false, completionHandler: nil)
  }

  func mapViewDidFailLoadingMap(_ mapView: MLNMapView, withError error: Error) {
    retryStyleLoad()
  }

  private func loadStyle(resetRetryCount: Bool) {
    if resetRetryCount {
      styleLoadRetryCount = 0
    }
    styleLoadWatchdog?.cancel()
    let styleURL = resolvedStyleURL()
    loadedStyleURL = styleURL
    updateAttribution()
    mapView.styleURL = styleURL
    scheduleStyleLoadWatchdog()
  }

  private func scheduleStyleLoadWatchdog() {
    styleLoadWatchdog?.cancel()
    let workItem = DispatchWorkItem { [weak self] in
      self?.retryStyleLoad()
    }
    styleLoadWatchdog = workItem
    DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: workItem)
  }

  private func retryStyleLoad() {
    guard styleLoadRetryCount < 2 else {
      styleLoadWatchdog?.cancel()
      styleLoadWatchdog = nil
      _ = fallBackToOfflineStyle()
      return
    }
    styleLoadRetryCount += 1
    styleLoadWatchdog?.cancel()
    mapView.styleURL = nil
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
      self?.loadStyle(resetRetryCount: false)
    }
  }

  private func fitRoute(animated: Bool) {
    guard routeCoordinates.count >= 2 else {
      return
    }
    let fittedCoordinates =
      activeGuidance
      ? routeCoordinates
      : previewCoordinatesWithBreathingRoom(routeCoordinates)
    let previewSheetInset = max(64, mapView.bounds.width * 0.66)
    let edgePadding =
      activeGuidance
      ? UIEdgeInsets(top: 56, left: 48, bottom: 96, right: 48)
      : reservesRouteChoiceSheet
        ? UIEdgeInsets(top: 56, left: previewSheetInset, bottom: 56, right: 48)
        : UIEdgeInsets(top: 32, left: 32, bottom: 32, right: 32)
    routeFitGeneration &+= 1
    let fitGeneration = routeFitGeneration
    fittedCoordinates.withUnsafeBufferPointer { coordinates in
      guard let baseAddress = coordinates.baseAddress else {
        return
      }
      mapView.setVisibleCoordinates(
        baseAddress,
        count: UInt(coordinates.count),
        edgePadding: edgePadding,
        direction: -1,
        duration: animated ? 0.35 : 0,
        animationTimingFunction: nil
      ) { [weak self] in
        guard let self, self.routeFitGeneration == fitGeneration, !self.activeGuidance else {
          return
        }
        let maximumZoomLevel = self.reservesRouteChoiceSheet ? 9.25 : 12.5
        if self.mapView.zoomLevel > maximumZoomLevel {
          self.mapView.setZoomLevel(maximumZoomLevel, animated: false)
        }
      }
    }
  }

  private func previewCoordinatesWithBreathingRoom(
    _ coordinates: [CLLocationCoordinate2D]
  ) -> [CLLocationCoordinate2D] {
    let latitudes = coordinates.map(\.latitude)
    let longitudes = coordinates.map(\.longitude)
    guard let minimumLatitude = latitudes.min(), let maximumLatitude = latitudes.max(),
      let minimumLongitude = longitudes.min(), let maximumLongitude = longitudes.max()
    else { return coordinates }
    let latitudeMargin = max((maximumLatitude - minimumLatitude) * 0.25, 0.002)
    let longitudeMargin = max((maximumLongitude - minimumLongitude) * 0.25, 0.002)
    return coordinates + [
      CLLocationCoordinate2D(
        latitude: minimumLatitude - latitudeMargin,
        longitude: minimumLongitude - longitudeMargin
      ),
      CLLocationCoordinate2D(
        latitude: maximumLatitude + latitudeMargin,
        longitude: maximumLongitude + longitudeMargin
      ),
    ]
  }

  /// Points the follow camera at `position`.
  ///
  /// A positive `duration` is an explicit recenter: the camera jumps its eased state to the ideal
  /// view and animates there. Zero is a render-loop frame: distance, pitch, and heading each ease
  /// toward the target with a frame-rate-independent time constant, so speed changes, a nearing
  /// maneuver, or a corner never snap the view. Returns whether the camera has settled.
  @discardableResult
  private func follow(_ position: NavOSSCarPlayPosition, duration: TimeInterval) -> Bool {
    let center = CLLocationCoordinate2D(
      latitude: position.coordinate.latitude,
      longitude: position.coordinate.longitude
    )
    let travelHeading =
      validCourseDegrees(position.courseDegrees) ?? lastRenderedCourseDegrees ?? mapView.direction
    let targetHeading = mapOrientation == .northUp ? 0 : travelHeading
    let targetDistance = cameraTarget.viewingDistanceMeters * navigationZoomScale
    let targetPitch = cameraTarget.pitchDegrees
    let now = CACurrentMediaTime()
    if duration > 0 || !cameraDistance.isFinite || !cameraPitch.isFinite || !cameraHeading.isFinite {
      cameraDistance = targetDistance
      cameraPitch = targetPitch
      cameraHeading = targetHeading
    } else {
      let elapsed = min(0.1, max(0, now - (cameraFrameAt ?? now)))
      cameraDistance = navOSSCarPlaySmoothed(
        cameraDistance, toward: targetDistance, elapsedSeconds: elapsed, timeConstantSeconds: 1.4)
      cameraPitch = navOSSCarPlaySmoothed(
        cameraPitch, toward: targetPitch, elapsedSeconds: elapsed, timeConstantSeconds: 1.4)
      cameraHeading = navOSSCarPlaySmoothedBearing(
        cameraHeading, toward: targetHeading, elapsedSeconds: elapsed, timeConstantSeconds: 0.35)
    }
    cameraFrameAt = now
    let lookAheadCenter = coordinate(
      from: center,
      distanceMeters: cameraDistance * cameraTarget.lookAheadFraction,
      bearingDegrees: travelHeading
    )
    let camera = MLNMapCamera(
      lookingAtCenter: lookAheadCenter,
      acrossDistance: cameraDistance,
      pitch: cameraPitch,
      heading: cameraHeading
    )
    mapView.setUserTrackingMode(.none, animated: false, completionHandler: nil)
    mapView.setCamera(
      camera,
      withDuration: duration,
      animationTimingFunction: CAMediaTimingFunction(name: duration > 0 ? .easeInEaseOut : .linear)
    )
    let headingDelta = abs((targetHeading - cameraHeading + 540).truncatingRemainder(dividingBy: 360) - 180)
    return abs(cameraDistance - targetDistance) < 2 && abs(cameraPitch - targetPitch) < 0.2
      && headingDelta < 0.2
  }

  private func updateTargetPosition(_ position: NavOSSCarPlayPosition) {
    interpolationFromPosition = renderedPosition ?? latestPosition ?? position
    latestPosition = position
    let now = CACurrentMediaTime()
    // Match the animation span to how often targets actually arrive, so the vehicle neither
    // stalls at its target nor is still catching up when the next fix lands.
    interpolationDuration = navOSSCarPlayInterpolationSeconds(
      sinceLastTargetSeconds: lastTargetAt.map { now - $0 }
    )
    lastTargetAt = now
    interpolationStartedAt = now
    if renderedPosition == nil {
      renderedPosition = position
      installPositionOverlayIfReady()
    }
    let screen = renderScreen()
    switch navOSSCarPlayDisplayLinkAction(
      hasLink: displayLink != nil,
      linkedScreenMatchesWindow: displayLinkScreen === screen
    ) {
    case .keep:
      break
    case .rebuild:
      invalidateDisplayLink()
      displayLink = makeRenderDisplayLink(on: screen)
    case .create:
      displayLink = makeRenderDisplayLink(on: screen)
    }
  }

  private func renderScreen() -> UIScreen? {
    view.window?.windowScene?.screen ?? view.window?.screen
  }

  /// A display link driven by the screen the CarPlay window is actually on.
  ///
  /// `CADisplayLink(target:selector:)` is driven by the handset's own display, which stops once the
  /// phone screen sleeps. This is the loop that advances the vehicle, the route head, and the
  /// camera, so binding it to the handset froze the car's map mid-route whenever the driver locked
  /// the phone, even though fixes kept arriving and MapLibre kept rendering. The car's screen stays
  /// awake, so the link has to come from it.
  private func makeRenderDisplayLink(on screen: UIScreen?) -> CADisplayLink {
    displayLinkScreen = screen
    let link =
      screen?.displayLink(withTarget: self, selector: #selector(renderPositionFrame))
      ?? CADisplayLink(target: self, selector: #selector(renderPositionFrame))
    // 60 fps keeps the vehicle and the eased camera smooth on car displays that run at 60 Hz;
    // the system may still lower it under thermal or power pressure, never below 30.
    link.preferredFrameRateRange = CAFrameRateRange(
      minimum: 30,
      maximum: 60,
      preferred: 60
    )
    link.add(to: .main, forMode: .common)
    return link
  }

  private func invalidateDisplayLink() {
    displayLink?.invalidate()
    displayLink = nil
    displayLinkScreen = nil
  }

  @objc private func renderPositionFrame() {
    guard activeGuidance, let target = latestPosition, let start = interpolationFromPosition else {
      invalidateDisplayLink()
      return
    }
    let progress = min(
      1,
      max(0, (CACurrentMediaTime() - interpolationStartedAt) / interpolationDuration)
    )
    // Follow the carriageway between the two fixes where the road can describe the movement, so
    // the vehicle rounds a corner instead of cutting the chord across it and then snapping back.
    let roadPath = navOSSCarPlayPathInterpolation(
      from: start.coordinate,
      to: target.coordinate,
      along: routeGeometry,
      progress: progress
    )
    renderedPosition = NavOSSCarPlayPosition(
      coordinate: roadPath?.coordinate
        ?? NavOSSCarPlayCoordinate(
          latitude: start.coordinate.latitude
            + (target.coordinate.latitude - start.coordinate.latitude) * progress,
          longitude: start.coordinate.longitude
            + (target.coordinate.longitude - start.coordinate.longitude) * progress
        ),
      // The road's own bearing turns the arrow through the bend as the vehicle travels it. Course
      // reported between two fixes only changes once the turn is already over.
      courseDegrees: roadPath?.bearingDegrees
        ?? interpolatedCourse(
          from: start.courseDegrees,
          to: target.courseDegrees,
          progress: progress
        ),
      compassHeadingDegrees: target.compassHeadingDegrees,
      speedMetersPerSecond: target.speedMetersPerSecond
    )
    if let renderedPosition, routeCoordinates.count >= 2 {
      routeCoordinates[0] = CLLocationCoordinate2D(
        latitude: renderedPosition.coordinate.latitude,
        longitude: renderedPosition.coordinate.longitude
      )
      // Only the head moves between frames. Rebuilding the static tail here would re-tessellate
      // the entire polyline at display-link rate, which is what this split exists to stop.
      installRouteHeadIfReady()
    }
    installPositionOverlayIfReady()
    var cameraSettled = true
    if !presentsRouteOverview, let renderedPosition {
      cameraSettled = follow(renderedPosition, duration: 0)
    }
    // Keep rendering until both the vehicle has reached its fix and the camera has finished
    // easing; stopping at the fix alone froze a half-finished zoom until the next GPS sample.
    if progress >= 1, cameraSettled {
      invalidateDisplayLink()
    }
  }

  /// Restarts the render loop so the eased camera can reach a new target between fixes.
  private func ensureRenderLoop() {
    guard activeGuidance, latestPosition != nil, displayLink == nil else { return }
    displayLink = makeRenderDisplayLink(on: renderScreen())
  }

  private func interpolatedCourse(from: Double?, to: Double?, progress: Double) -> Double? {
    guard let target = to else { return from }
    guard let start = from else { return target }
    let delta = (target - start + 540).truncatingRemainder(dividingBy: 360) - 180
    return (start + delta * progress + 360).truncatingRemainder(dividingBy: 360)
  }

  private func updateSpeedDisplay(
    _ speedMetersPerSecond: Double?,
    speeding: NavOSSSpeedingState
  ) {
    guard activeGuidance, showsCurrentSpeed, let speedMetersPerSecond else {
      speedLabel.isHidden = true
      return
    }
    let speedKph = Int((speedMetersPerSecond * 3.6).rounded())
    let isSpeeding = speeding == .overLimit
    applySpeedColors(isSpeeding: isSpeeding)
    let text = NSMutableAttributedString(
      string: "\(speedKph)",
      attributes: [.font: UIFont.monospacedDigitSystemFont(ofSize: 21, weight: .bold)]
    )
    text.append(
      NSAttributedString(
        string: "\nkm/h",
        attributes: [.font: UIFont.systemFont(ofSize: 10, weight: .semibold)]
      )
    )
    speedLabel.attributedText = text
    speedLabel.accessibilityLabel = isSpeeding
      ? "\(speedKph) kilometres per hour, over the limit"
      : "\(speedKph) kilometres per hour"
    speedLabel.isHidden = false
  }

  private func updateSpeedLimitDisplay(_ speedLimitKph: Int?) {
    guard activeGuidance, showsSpeedLimit, let speedLimitKph else {
      speedLimitLabel.isHidden = true
      updateSpeedTrailingConstraint(limitVisible: false)
      return
    }
    let text = NSMutableAttributedString(
      string: "MAX\n",
      attributes: [.font: UIFont.systemFont(ofSize: 10, weight: .heavy)]
    )
    text.append(
      NSAttributedString(
        string: "\(speedLimitKph)",
        attributes: [.font: UIFont.monospacedDigitSystemFont(ofSize: 22, weight: .heavy)]
      )
    )
    speedLimitLabel.attributedText = text
    speedLimitLabel.accessibilityLabel = "Speed limit \(speedLimitKph)"
    speedLimitLabel.isHidden = false
    updateSpeedTrailingConstraint(limitVisible: true)
  }

  /// The current road, shown only while following: the overview has no single current road.
  private func updateRoadNameDisplay() {
    guard showsRoadName, activeGuidance, !presentsRouteOverview,
      let name = guidanceOverlay.currentRoadName?.trimmingCharacters(in: .whitespacesAndNewlines),
      !name.isEmpty
    else {
      roadNameLabel.isHidden = true
      return
    }
    roadNameLabel.text = name
    roadNameLabel.isHidden = false
  }

  /// Decorations that depend on follow vs overview.
  private func updateGuidanceDecorations() {
    updateRoadNameDisplay()
    installManeuverArrowIfReady()
  }

  private func updatePointOfInterestVisibility() {
    guard let style = mapView.style else { return }
    for layer in style.layers where layer.identifier.lowercased().contains("poi") {
      layer.isVisible = showsPointsOfInterest && !activeGuidance
    }
  }

  private func updateGuidanceDeclutter() {
    guard let style = mapView.style else {
      return
    }
    if activeGuidance {
      for layer in style.layers where layer is MLNFillExtrusionStyleLayer && layer.isVisible {
        guidanceHiddenLayerIdentifiers.insert(layer.identifier)
        layer.isVisible = false
      }
    } else {
      for identifier in guidanceHiddenLayerIdentifiers {
        style.layer(withIdentifier: identifier)?.isVisible = true
      }
      guidanceHiddenLayerIdentifiers.removeAll()
    }
    updateRoadLabelLegibility(in: style)
  }

  /// Colours and widths shared by the route line and its moving head, so the two sources render
  /// as one continuous line.
  /// Widths for both casings and both lines. Only depends on `activeGuidance`, so it runs on
  /// route/state changes rather than on the display link.
  private func applyRouteLineWidths(in style: MLNStyle) {
    let casingWidth = NSExpression(forConstantValue: activeGuidance ? 15 : 8)
    let lineWidth = NSExpression(forConstantValue: activeGuidance ? 10 : 5)
    for identifier in [routeCasingLayerIdentifier, routeHeadCasingLayerIdentifier] {
      (style.layer(withIdentifier: identifier) as? MLNLineStyleLayer)?.lineWidth = casingWidth
    }
    for identifier in [routeLayerIdentifier, routeHeadLayerIdentifier] {
      (style.layer(withIdentifier: identifier) as? MLNLineStyleLayer)?.lineWidth = lineWidth
    }
  }

  private func polylineFeature(_ coordinates: [CLLocationCoordinate2D]) -> MLNPolylineFeature {
    var mutable = coordinates
    return mutable.withUnsafeMutableBufferPointer { buffer in
      MLNPolylineFeature(coordinates: buffer.baseAddress!, count: UInt(buffer.count))
    }
  }

  /// Creates the heading cone, tail, and head layers together, once, in a fixed order: the cone,
  /// both casings, then both lines. Creating each pair lazily made z-order depend on install
  /// history, and appending casing-then-line per pair left a casing above a line, which painted a
  /// white nick across the route at the shared join. Visibility is driven purely by the source
  /// shapes, which are nil when a part has nothing to draw.
  private func installRouteLayersIfNeeded(
    headingConeSource: MLNShapeSource,
    tailSource: MLNShapeSource,
    headSource: MLNShapeSource,
    in style: MLNStyle
  ) {
    func headingCone(_ source: MLNShapeSource) -> MLNFillStyleLayer {
      let layer = MLNFillStyleLayer(identifier: headingConeLayerIdentifier, source: source)
      layer.fillColor = NSExpression(
        forConstantValue: UIColor(
          red: 0.0941176471,
          green: 0.4745098039,
          blue: 0.4352941176,
          alpha: 1
        )
      )
      layer.fillOpacity = NSExpression(forConstantValue: 0.25)
      return layer
    }
    func casing(_ identifier: String, _ source: MLNShapeSource) -> MLNLineStyleLayer {
      let layer = MLNLineStyleLayer(identifier: identifier, source: source)
      layer.lineCap = NSExpression(forConstantValue: "round")
      layer.lineJoin = NSExpression(forConstantValue: "round")
      layer.lineColor = NSExpression(forConstantValue: routeCasingColor)
      layer.lineOpacity = NSExpression(forConstantValue: 0.96)
      return layer
    }
    func line(_ identifier: String, _ source: MLNShapeSource) -> MLNLineStyleLayer {
      let layer = MLNLineStyleLayer(identifier: identifier, source: source)
      layer.lineCap = NSExpression(forConstantValue: "round")
      layer.lineJoin = NSExpression(forConstantValue: "round")
      layer.lineColor = NSExpression(forConstantValue: routeLineColor)
      return layer
    }
    // Any missing layer means the set is being built for the first time on this style, or the
    // style was reloaded. Rebuild the whole set so the order is always the same.
    let identifiers = [
      headingConeLayerIdentifier,
      routeCasingLayerIdentifier, routeHeadCasingLayerIdentifier,
      routeLayerIdentifier, routeHeadLayerIdentifier,
    ]
    guard identifiers.contains(where: { style.layer(withIdentifier: $0) == nil }) else { return }
    for identifier in identifiers {
      if let existing = style.layer(withIdentifier: identifier) {
        style.removeLayer(existing)
      }
    }
    // When a puck is already present, retain its priority even if this set is rebuilt after a
    // partial style change. Otherwise the later position layers append above this fixed group.
    let insertionLayer = style.layer(withIdentifier: shadowLayerIdentifier)
      ?? style.layer(withIdentifier: positionLayerIdentifier)
    func add(_ layer: MLNStyleLayer) {
      if let insertionLayer {
        style.insertLayer(layer, below: insertionLayer)
      } else {
        style.addLayer(layer)
      }
    }
    add(headingCone(headingConeSource))
    add(casing(routeCasingLayerIdentifier, tailSource))
    add(casing(routeHeadCasingLayerIdentifier, headSource))
    add(line(routeLayerIdentifier, tailSource))
    add(line(routeHeadLayerIdentifier, headSource))
  }

  /// Returns the source, creating it with no shape if it does not exist yet. Lets the layer set
  /// be built before either part has geometry, without drawing anything.
  private func ensureShapeSource(_ identifier: String, in style: MLNStyle) -> MLNShapeSource {
    if let existing = style.source(withIdentifier: identifier) as? MLNShapeSource {
      return existing
    }
    let created = MLNShapeSource(identifier: identifier, shape: nil, options: nil)
    style.addSource(created)
    return created
  }

  private func shapeSource(
    _ identifier: String,
    coordinates: [CLLocationCoordinate2D],
    in style: MLNStyle
  ) -> MLNShapeSource {
    var mutable = coordinates
    let polyline = mutable.withUnsafeMutableBufferPointer { buffer in
      MLNPolylineFeature(coordinates: buffer.baseAddress!, count: UInt(buffer.count))
    }
    if let existing = style.source(withIdentifier: identifier) as? MLNShapeSource {
      existing.shape = polyline
      return existing
    }
    let created = MLNShapeSource(identifier: identifier, shape: polyline, options: nil)
    style.addSource(created)
    return created
  }

  /// Installs the static part of the route: everything from the first fixed vertex onward.
  ///
  /// `routeCoordinates[0]` is the moving head and is deliberately excluded, because rebuilding
  /// this source re-tessellates the whole polyline. Splitting the head into its own two-point
  /// source turns the per-frame cost from O(route vertices) into O(1); this source is then only
  /// rebuilt when the route itself changes.
  private func installRouteOverlayIfReady() {
    guard let style = mapView.style else {
      return
    }
    guard routeCoordinates.count >= 2,
      routeCoordinates.dropFirst().contains(where: {
        $0.latitude != routeCoordinates[0].latitude
          || $0.longitude != routeCoordinates[0].longitude
      })
    else {
      (style.source(withIdentifier: routeSourceIdentifier) as? MLNShapeSource)?.shape = nil
      (style.source(withIdentifier: routeHeadSourceIdentifier) as? MLNShapeSource)?.shape = nil
      return
    }
    // With exactly two coordinates the head already spans the whole remaining route, so the
    // static source would duplicate it and reintroduce the moving vertex it exists to avoid.
    // Sources and layers first, then styling. Styling before the layers exist left the tail at
    // MapLibre's default 1 pt width on the first install after any style load, which is permanent
    // in route preview because `display` runs once there.
    let headingConeSource = ensureShapeSource(headingConeSourceIdentifier, in: style)
    let tailSource = ensureShapeSource(routeSourceIdentifier, in: style)
    let headSource = ensureShapeSource(routeHeadSourceIdentifier, in: style)
    installRouteLayersIfNeeded(
      headingConeSource: headingConeSource,
      tailSource: tailSource,
      headSource: headSource,
      in: style
    )
    applyRouteLineWidths(in: style)

    let tail = Array(routeCoordinates.dropFirst())
    if tail.count >= 2 {
      tailSource.shape = polylineFeature(tail)
    } else {
      tailSource.shape = nil
    }
    installRouteHeadIfReady()
  }

  /// The moving head: a two-point line from the interpolated puck to the first fixed vertex.
  /// This is the only geometry that changes between animation frames.
  /// The moving head: a two-point line from the interpolated puck to the first fixed vertex.
  /// This is the only geometry that changes between animation frames, so it does the minimum
  /// possible work: one shape assignment. Layer creation and width styling happen in
  /// `installRouteOverlayIfReady`, which runs on route changes rather than per frame.
  private func installRouteHeadIfReady() {
    guard let style = mapView.style,
      let source = style.source(withIdentifier: routeHeadSourceIdentifier) as? MLNShapeSource
    else {
      return
    }
    // Same distinctness test as `installRouteOverlayIfReady`, so the two entry points cannot
    // disagree about whether there is anything to draw. Without it, remaining geometry that has
    // collapsed to one repeated point at arrival paints a zero-length feature, which with round
    // caps is an 11 pt casing dot and a 7 pt green dot sitting on the puck.
    guard routeCoordinates.count >= 2,
      routeCoordinates[1].latitude != routeCoordinates[0].latitude
        || routeCoordinates[1].longitude != routeCoordinates[0].longitude
    else {
      source.shape = nil
      return
    }
    source.shape = polylineFeature([routeCoordinates[0], routeCoordinates[1]])
  }

  private func installHeadingConeOverlayIfReady(
    apex: NavOSSCarPlayCoordinate,
    headingDegrees: Double?
  ) {
    guard let source = mapView.style?.source(withIdentifier: headingConeSourceIdentifier)
      as? MLNShapeSource
    else {
      return
    }
    guard activeGuidance, let headingDegrees else {
      source.shape = nil
      lastHeadingConeApex = nil
      lastHeadingConeHeadingDegrees = nil
      return
    }
    // The source follows the interpolated puck; skip the allocation only when neither input
    // changed since the last render.
    guard lastHeadingConeApex != apex || lastHeadingConeHeadingDegrees != headingDegrees else {
      return
    }
    let polygon = navOSSHeadingConePolygon(
      apex: apex,
      headingDegrees: headingDegrees,
      radiusMeters: headingConeRadiusMeters,
      spreadDegrees: headingConeSpreadDegrees
    )
    guard polygon.count >= 4 else {
      source.shape = nil
      lastHeadingConeApex = nil
      lastHeadingConeHeadingDegrees = nil
      return
    }
    var coordinates = polygon.map {
      CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude)
    }
    source.shape = coordinates.withUnsafeMutableBufferPointer { buffer in
      MLNPolygonFeature(coordinates: buffer.baseAddress!, count: UInt(buffer.count))
    }
    lastHeadingConeApex = apex
    lastHeadingConeHeadingDegrees = headingDegrees
  }

  private func installAlternateRouteOverlayIfReady() {
    guard let style = mapView.style else {
      return
    }
    guard alternateRouteCoordinates.count >= 2 else {
      (style.source(withIdentifier: alternateRouteSourceIdentifier) as? MLNShapeSource)?.shape = nil
      return
    }
    let polyline = alternateRouteCoordinates.withUnsafeMutableBufferPointer { coordinates in
      MLNPolylineFeature(coordinates: coordinates.baseAddress!, count: UInt(coordinates.count))
    }
    let source: MLNShapeSource
    if let existingSource = style.source(withIdentifier: alternateRouteSourceIdentifier)
      as? MLNShapeSource
    {
      source = existingSource
      source.shape = polyline
    } else {
      source = MLNShapeSource(
        identifier: alternateRouteSourceIdentifier,
        shape: polyline,
        options: nil
      )
      style.addSource(source)
    }

    if style.layer(withIdentifier: alternateRouteLayerIdentifier) == nil {
      // Alternates sit under the selected route, with a casing so they stay legible on busy tiles.
      let below = style.layer(withIdentifier: routeCasingLayerIdentifier)
      let casing = MLNLineStyleLayer(identifier: alternateRouteCasingLayerIdentifier, source: source)
      casing.lineCap = NSExpression(forConstantValue: "round")
      casing.lineJoin = NSExpression(forConstantValue: "round")
      casing.lineColor = NSExpression(forConstantValue: routeCasingColor)
      casing.lineWidth = NSExpression(forConstantValue: 8)
      let alternateRoute = MLNLineStyleLayer(
        identifier: alternateRouteLayerIdentifier,
        source: source
      )
      alternateRoute.lineCap = NSExpression(forConstantValue: "round")
      alternateRoute.lineJoin = NSExpression(forConstantValue: "round")
      alternateRoute.lineColor = NSExpression(
        forConstantValue: styleSlug == "dark"
          ? UIColor(red: 0.42, green: 0.50, blue: 0.50, alpha: 1)
          : UIColor(red: 0.60, green: 0.66, blue: 0.65, alpha: 1)
      )
      alternateRoute.lineWidth = NSExpression(forConstantValue: 5)
      if let below {
        style.insertLayer(casing, below: below)
        style.insertLayer(alternateRoute, below: below)
      } else {
        style.addLayer(casing)
        style.addLayer(alternateRoute)
      }
    }
  }

  // MARK: Route colours

  /// Selected route. Teal-green from the NavOSS palette, tuned to stay distinct from park fills.
  private var routeLineColor: UIColor {
    styleSlug == "dark"
      ? UIColor(red: 0.239, green: 0.839, blue: 0.710, alpha: 1)  // #3DD6B5
      : UIColor(red: 0.055, green: 0.541, blue: 0.416, alpha: 1)  // #0E8A6A
  }

  private var routeCasingColor: UIColor {
    styleSlug == "dark"
      ? UIColor(red: 0.055, green: 0.082, blue: 0.086, alpha: 1)  // ink
      : UIColor.white
  }

  private var travelledRouteColor: UIColor {
    styleSlug == "dark"
      ? UIColor(red: 0.33, green: 0.40, blue: 0.40, alpha: 1)
      : UIColor(red: 0.66, green: 0.71, blue: 0.70, alpha: 1)
  }

  private func congestionColor(_ level: NavOSSCarPlayCongestionLevel) -> UIColor {
    switch level {
    case .slow: UIColor(red: 0.961, green: 0.647, blue: 0.141, alpha: 1)  // #F5A524
    case .heavy: UIColor(red: 0.898, green: 0.282, blue: 0.302, alpha: 1)  // #E5484D
    case .stopped: UIColor(red: 0.545, green: 0.118, blue: 0.176, alpha: 1)  // #8B1E2D
    case .free, .unknown: routeLineColor
    }
  }

  /// Inserts `layer` just under the vehicle so route decorations never cover the puck, or appends
  /// it when no vehicle layer exists yet.
  private func insertBelowVehicle(_ layer: MLNStyleLayer, in style: MLNStyle) {
    if let vehicle = style.layer(withIdentifier: shadowLayerIdentifier)
      ?? style.layer(withIdentifier: positionLayerIdentifier)
    {
      style.insertLayer(layer, below: vehicle)
    } else {
      style.addLayer(layer)
    }
  }

  // MARK: Travelled route

  /// The whole route in grey under the remaining route, so road already driven reads as done
  /// rather than disappearing. Static per route: it never changes between frames.
  private func installTravelledRouteIfReady() {
    guard let style = mapView.style else { return }
    let source = ensureShapeSource(travelledRouteSourceIdentifier, in: style)
    guard activeGuidance, routeGeometry.count >= 2 else {
      source.shape = nil
      return
    }
    if style.layer(withIdentifier: travelledRouteLayerIdentifier) == nil {
      let layer = MLNLineStyleLayer(identifier: travelledRouteLayerIdentifier, source: source)
      layer.lineCap = NSExpression(forConstantValue: "round")
      layer.lineJoin = NSExpression(forConstantValue: "round")
      layer.lineColor = NSExpression(forConstantValue: travelledRouteColor)
      layer.lineWidth = NSExpression(forConstantValue: 8)
      if let casing = style.layer(withIdentifier: routeCasingLayerIdentifier) {
        style.insertLayer(layer, below: casing)
      } else {
        insertBelowVehicle(layer, in: style)
      }
    }
    source.shape = polylineFeature(
      routeGeometry.map { CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude) }
    )
  }

  // MARK: Congestion

  /// Colours slow, heavy, and stopped stretches of the remaining route. Draws nothing unless the
  /// trip carries real per-segment congestion.
  private func installCongestionIfReady() {
    guard let style = mapView.style else { return }
    let source = ensureShapeSource(congestionSourceIdentifier, in: style)
    let runs =
      activeGuidance
      ? navOSSCarPlayCongestionRuns(
        geometry: routeGeometry,
        levels: guidanceOverlay.congestion,
        startingAtProgress: routeProgress
      )
      : []
    guard !runs.isEmpty else {
      source.shape = nil
      return
    }
    if style.layer(withIdentifier: congestionLayerIdentifier) == nil {
      let layer = MLNLineStyleLayer(identifier: congestionLayerIdentifier, source: source)
      layer.lineCap = NSExpression(forConstantValue: "round")
      layer.lineJoin = NSExpression(forConstantValue: "round")
      layer.lineWidth = NSExpression(forConstantValue: 10)
      layer.lineColor = NSExpression(
        forMLNMatchingKey: NSExpression(forKeyPath: "level"),
        in: [
          NSExpression(forConstantValue: "slow"): NSExpression(forConstantValue: congestionColor(.slow)),
          NSExpression(forConstantValue: "heavy"): NSExpression(forConstantValue: congestionColor(.heavy)),
          NSExpression(forConstantValue: "stopped"):
            NSExpression(forConstantValue: congestionColor(.stopped)),
        ],
        default: NSExpression(forConstantValue: routeLineColor)
      )
      if let head = style.layer(withIdentifier: routeHeadLayerIdentifier) {
        style.insertLayer(layer, above: head)
      } else {
        insertBelowVehicle(layer, in: style)
      }
    }
    source.shape = MLNShapeCollectionFeature(
      shapes: runs.map { run in
        let feature = polylineFeature(
          run.coordinates.map {
            CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude)
          }
        )
        feature.attributes = ["level": run.level.rawValue]
        return feature
      }
    )
  }

  // MARK: Maneuver arrow

  /// Distance from the next maneuver at which its arrow appears on the road.
  private let maneuverArrowVisibleMeters = 1_000.0

  /// A white arrow on the road at the next turn, like the card's symbol but placed where it
  /// happens. Hidden in overview, far from the maneuver, and when there is no maneuver geometry.
  private func installManeuverArrowIfReady() {
    guard let style = mapView.style else { return }
    let lineSource = ensureShapeSource(maneuverArrowSourceIdentifier, in: style)
    let headSource = ensureShapeSource(maneuverArrowHeadSourceIdentifier, in: style)
    let arrow = guidanceOverlay.maneuverArrow
    guard activeGuidance, !presentsRouteOverview, arrow.count >= 2,
      let distance = latestDistanceToManeuverMeters, distance <= maneuverArrowVisibleMeters
    else {
      lineSource.shape = nil
      headSource.shape = nil
      return
    }
    if style.image(forName: maneuverArrowHeadImageIdentifier) == nil {
      style.setImage(maneuverArrowHeadImage(), forName: maneuverArrowHeadImageIdentifier)
    }
    if style.layer(withIdentifier: maneuverArrowLayerIdentifier) == nil {
      let casing = MLNLineStyleLayer(identifier: maneuverArrowCasingLayerIdentifier, source: lineSource)
      casing.lineCap = NSExpression(forConstantValue: "butt")
      casing.lineJoin = NSExpression(forConstantValue: "round")
      casing.lineColor = NSExpression(
        forConstantValue: UIColor(red: 0.055, green: 0.082, blue: 0.086, alpha: 0.85))
      casing.lineWidth = NSExpression(forConstantValue: 14)
      let line = MLNLineStyleLayer(identifier: maneuverArrowLayerIdentifier, source: lineSource)
      line.lineCap = NSExpression(forConstantValue: "butt")
      line.lineJoin = NSExpression(forConstantValue: "round")
      line.lineColor = NSExpression(forConstantValue: UIColor.white)
      line.lineWidth = NSExpression(forConstantValue: 9)
      let head = MLNSymbolStyleLayer(identifier: maneuverArrowHeadLayerIdentifier, source: headSource)
      head.iconImageName = NSExpression(forConstantValue: maneuverArrowHeadImageIdentifier)
      head.iconAllowsOverlap = NSExpression(forConstantValue: true)
      head.iconIgnoresPlacement = NSExpression(forConstantValue: true)
      head.iconRotationAlignment = NSExpression(forConstantValue: "map")
      head.iconPitchAlignment = NSExpression(forConstantValue: "map")
      head.iconRotation = NSExpression(forKeyPath: "bearing")
      head.iconScale = NSExpression(forConstantValue: 0.62)
      for layer in [casing, line, head] as [MLNStyleLayer] {
        insertBelowVehicle(layer, in: style)
      }
    }
    let coordinates = arrow.map {
      CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude)
    }
    lineSource.shape = polylineFeature(coordinates)
    let tip = MLNPointFeature()
    tip.coordinate = coordinates[coordinates.count - 1]
    tip.attributes = [
      "bearing": navOSSCarPlayBearingDegreesForDisplay(
        from: arrow[arrow.count - 2], to: arrow[arrow.count - 1])
    ]
    headSource.shape = tip
  }

  private func maneuverArrowHeadImage() -> UIImage {
    let size = CGSize(width: 56, height: 56)
    return UIGraphicsImageRenderer(size: size).image { context in
      let path = UIBezierPath()
      path.move(to: CGPoint(x: 28, y: 6))
      path.addLine(to: CGPoint(x: 50, y: 44))
      path.addLine(to: CGPoint(x: 6, y: 44))
      path.close()
      UIColor(red: 0.055, green: 0.082, blue: 0.086, alpha: 0.85).setStroke()
      path.lineWidth = 5
      path.lineJoinStyle = .round
      path.stroke()
      UIColor.white.setFill()
      path.fill()
      _ = context
    }
  }

  // MARK: Cameras and reports

  /// Camera and road-report markers from `NavOSSCarPlayMapAlertStore`. The store is empty until a
  /// real data source publishes into it, so this normally draws nothing.
  private func installMapAlertsIfReady() {
    guard let style = mapView.style else { return }
    let source = ensureShapeSource(mapAlertSourceIdentifier, in: style)
    guard !mapAlerts.isEmpty else {
      source.shape = nil
      return
    }
    for kind in NavOSSCarPlayMapAlertIcon.allCases where style.image(forName: kind.imageName) == nil {
      style.setImage(kind.image(), forName: kind.imageName)
    }
    if style.layer(withIdentifier: mapAlertLayerIdentifier) == nil {
      let layer = MLNSymbolStyleLayer(identifier: mapAlertLayerIdentifier, source: source)
      layer.iconImageName = NSExpression(forKeyPath: "icon")
      layer.iconAllowsOverlap = NSExpression(forConstantValue: true)
      layer.iconScale = NSExpression(forConstantValue: 0.5)
      layer.iconPitchAlignment = NSExpression(forConstantValue: "viewport")
      layer.iconRotationAlignment = NSExpression(forConstantValue: "viewport")
      layer.iconAnchor = NSExpression(forConstantValue: "bottom")
      insertBelowVehicle(layer, in: style)
    }
    source.shape = MLNShapeCollectionFeature(
      shapes: mapAlerts.map { alert in
        let point = MLNPointFeature()
        point.coordinate = CLLocationCoordinate2D(
          latitude: alert.coordinate.latitude,
          longitude: alert.coordinate.longitude
        )
        point.identifier = alert.id
        point.attributes = ["icon": NavOSSCarPlayMapAlertIcon(alert.kind).imageName]
        return point
      }
    )
  }

  // MARK: Road labels

  /// Enlarges road names during guidance so they stay readable at driving zoom and pitch, and
  /// restores the style's own sizes afterwards. Only constant sizes and zoom-interpolated stops
  /// are scaled; any other expression is left alone rather than risking an invalid style.
  private func updateRoadLabelLegibility(in style: MLNStyle) {
    let scale = 1.22
    for layer in style.layers {
      guard let symbol = layer as? MLNSymbolStyleLayer,
        symbol.sourceLayerIdentifier == "transportation_name"
      else { continue }
      let identifier = symbol.identifier
      if activeGuidance {
        if roadLabelFontSizes[identifier] == nil {
          roadLabelFontSizes[identifier] = symbol.textFontSize
          roadLabelHaloWidths[identifier] = symbol.textHaloWidth
        }
        if let original = roadLabelFontSizes[identifier],
          let scaled = navOSSScaledSizeExpression(original, by: scale)
        {
          symbol.textFontSize = scaled
        }
        symbol.textHaloWidth = NSExpression(forConstantValue: 1.6)
      } else if let original = roadLabelFontSizes.removeValue(forKey: identifier) {
        symbol.textFontSize = original
        if let halo = roadLabelHaloWidths.removeValue(forKey: identifier) {
          symbol.textHaloWidth = halo
        }
      }
    }
  }

  private func installDestinationOverlayIfReady() {
    guard let latestDestination, let style = mapView.style else {
      return
    }
    let point = MLNPointFeature()
    point.coordinate = CLLocationCoordinate2D(
      latitude: latestDestination.latitude,
      longitude: latestDestination.longitude
    )
    let source: MLNShapeSource
    if let existingSource = style.source(withIdentifier: destinationSourceIdentifier)
      as? MLNShapeSource
    {
      source = existingSource
      source.shape = point
    } else {
      source = MLNShapeSource(identifier: destinationSourceIdentifier, shape: point, options: nil)
      style.addSource(source)
    }

    if style.layer(withIdentifier: destinationLayerIdentifier) == nil {
      let destinationLayer = MLNCircleStyleLayer(
        identifier: destinationLayerIdentifier,
        source: source
      )
      destinationLayer.circleColor = NSExpression(
        forConstantValue: UIColor.systemBlue
      )
      destinationLayer.circleRadius = NSExpression(forConstantValue: 6)
      destinationLayer.circleStrokeColor = NSExpression(forConstantValue: UIColor.white)
      destinationLayer.circleStrokeWidth = NSExpression(forConstantValue: 2)
      style.addLayer(destinationLayer)
    }
  }

  private func installOriginOverlayIfReady() {
    guard let latestOrigin, let style = mapView.style else {
      (mapView.style?.source(withIdentifier: originSourceIdentifier) as? MLNShapeSource)?.shape = nil
      return
    }
    let point = MLNPointFeature()
    point.coordinate = CLLocationCoordinate2D(
      latitude: latestOrigin.latitude,
      longitude: latestOrigin.longitude
    )
    let source: MLNShapeSource
    if let existingSource = style.source(withIdentifier: originSourceIdentifier)
      as? MLNShapeSource
    {
      source = existingSource
      source.shape = point
    } else {
      source = MLNShapeSource(identifier: originSourceIdentifier, shape: point, options: nil)
      style.addSource(source)
    }

    if style.layer(withIdentifier: originLayerIdentifier) == nil {
      let originLayer = MLNCircleStyleLayer(identifier: originLayerIdentifier, source: source)
      originLayer.circleColor = NSExpression(forConstantValue: UIColor.systemGreen)
      originLayer.circleRadius = NSExpression(forConstantValue: 6)
      originLayer.circleStrokeColor = NSExpression(forConstantValue: UIColor.white)
      originLayer.circleStrokeWidth = NSExpression(forConstantValue: 2)
      style.addLayer(originLayer)
    }
  }

  private func installPositionOverlayIfReady() {
    guard let style = mapView.style else {
      return
    }
    guard activeGuidance, let latestPosition = renderedPosition ?? latestPosition else {
      (style.source(withIdentifier: positionSourceIdentifier) as? MLNShapeSource)?.shape = nil
      (style.source(withIdentifier: headingConeSourceIdentifier) as? MLNShapeSource)?.shape = nil
      lastHeadingConeApex = nil
      lastHeadingConeHeadingDegrees = nil
      return
    }
    let point = MLNPointFeature()
    point.coordinate = CLLocationCoordinate2D(
      latitude: latestPosition.coordinate.latitude,
      longitude: latestPosition.coordinate.longitude
    )
    let source: MLNShapeSource
    if let existingSource = style.source(withIdentifier: positionSourceIdentifier)
      as? MLNShapeSource
    {
      source = existingSource
      source.shape = point
    } else {
      source = MLNShapeSource(identifier: positionSourceIdentifier, shape: point, options: nil)
      style.addSource(source)
    }

    if style.image(forName: positionImageIdentifier) == nil,
      let vehicleArrow = UIImage(named: "vehicle-arrow")
    {
      style.setImage(vehicleArrow, forName: positionImageIdentifier)
    }
    if style.image(forName: carImageIdentifier) == nil {
      style.setImage(carMarkerImage(), forName: carImageIdentifier)
    }
    if style.image(forName: neutralImageIdentifier) == nil {
      style.setImage(neutralMarkerImage(), forName: neutralImageIdentifier)
    }
    if style.image(forName: shadowImageIdentifier) == nil {
      style.setImage(vehicleShadowImage(), forName: shadowImageIdentifier)
    }

    // Ground shadow is its own layer pinned to rotation 0, so the light stays fixed while the
    // vehicle turns. It shares the position source, so it follows the puck for free and is
    // cleared with it.
    let shadow: MLNSymbolStyleLayer
    if let existingShadow = style.layer(withIdentifier: shadowLayerIdentifier)
      as? MLNSymbolStyleLayer
    {
      shadow = existingShadow
    } else {
      shadow = MLNSymbolStyleLayer(identifier: shadowLayerIdentifier, source: source)
      shadow.iconAllowsOverlap = NSExpression(forConstantValue: true)
      shadow.iconIgnoresPlacement = NSExpression(forConstantValue: true)
      shadow.iconRotationAlignment = NSExpression(forConstantValue: "map")
      shadow.iconPitchAlignment = NSExpression(forConstantValue: "map")
      shadow.iconImageName = NSExpression(forConstantValue: shadowImageIdentifier)
      shadow.iconRotation = NSExpression(forConstantValue: 0)
      style.addLayer(shadow)
    }

    let position: MLNSymbolStyleLayer
    if let existingLayer = style.layer(withIdentifier: positionLayerIdentifier)
      as? MLNSymbolStyleLayer
    {
      position = existingLayer
    } else {
      position = MLNSymbolStyleLayer(identifier: positionLayerIdentifier, source: source)
      position.iconAllowsOverlap = NSExpression(forConstantValue: true)
      position.iconIgnoresPlacement = NSExpression(forConstantValue: true)
      position.iconRotationAlignment = NSExpression(forConstantValue: "map")
      // Keep the marker on the ground plane; without this an implementation default change
      // would billboard it and break the perspective compensation baked into the artwork.
      position.iconPitchAlignment = NSExpression(forConstantValue: "map")
      style.addLayer(position)
    }
    // Heading fallback chain. Pointing a directional marker due north when the heading is
    // unknown is worse than showing no direction at all, so the terminal case swaps in a
    // non-directional marker instead of inventing a bearing.
    //   1. validated course from the published position (matched route bearing, else GPS course)
    //   2. bearing of the route segment nearest the puck
    //   3. last heading actually rendered this trip
    //   4. none -> neutral, non-directional marker
    let resolvedCourseDegrees =
      validCourseDegrees(latestPosition.courseDegrees)
      ?? navOSSRouteBearingDegrees(near: latestPosition.coordinate, in: routeGeometry)
      ?? lastRenderedCourseDegrees
    if let resolvedCourseDegrees {
      lastRenderedCourseDegrees = resolvedCourseDegrees
    }
    // The marker keeps its course-based rotation above; only the cone prefers the compass, which
    // is the one bearing that still answers "which way is the car pointing" while stopped.
    installHeadingConeOverlayIfReady(
      apex: latestPosition.coordinate,
      headingDegrees: navOSSCarPlayConeHeadingDegrees(
        compassHeadingDegrees: latestPosition.compassHeadingDegrees,
        fallbackCourseDegrees: resolvedCourseDegrees
      )
    )
    let markerImageIdentifier: String
    if resolvedCourseDegrees == nil {
      markerImageIdentifier = neutralImageIdentifier
    } else {
      markerImageIdentifier = vehicleMarker == .car ? carImageIdentifier : positionImageIdentifier
    }
    position.iconImageName = NSExpression(forConstantValue: markerImageIdentifier)
    position.iconScale = NSExpression(
      forConstantValue: markerImageIdentifier == carImageIdentifier ? 0.55 : 0.72
    )
    shadow.iconScale = NSExpression(
      forConstantValue: markerImageIdentifier == carImageIdentifier ? 0.72 : 0.62
    )
    position.iconRotation = NSExpression(forConstantValue: resolvedCourseDegrees ?? 0)
    bringPositionLayerToFront(position, in: style)
  }

  private func validCourseDegrees(_ courseDegrees: Double?) -> Double? {
    guard let courseDegrees, courseDegrees.isFinite, (0..<360).contains(courseDegrees) else {
      return nil
    }
    return courseDegrees
  }

  // Route bearing lives in NavOSSNavigationCore (`navOSSRouteBearingDegrees`) so its
  // distance-to-route gate is unit tested; an off-route vehicle must not inherit the road's
  // heading.

  /// Non-directional marker used only when no heading can be resolved.
  private func neutralMarkerImage() -> UIImage {
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: 64, height: 64))
    return renderer.image { context in
      let graphics = context.cgContext
      graphics.saveGState()
      graphics.setShadow(offset: CGSize(width: 0, height: 3), blur: 5, color: UIColor.black.cgColor)
      UIColor.white.setFill()
      UIBezierPath(ovalIn: CGRect(x: 16, y: 16, width: 32, height: 32)).fill()
      graphics.restoreGState()
      UIColor(red: 0.03, green: 0.48, blue: 0.65, alpha: 1).setFill()
      UIBezierPath(ovalIn: CGRect(x: 20, y: 20, width: 24, height: 24)).fill()
    }
  }

  private func bringPositionLayerToFront(
    _ positionLayer: MLNSymbolStyleLayer,
    in style: MLNStyle
  ) {
    guard style.layers.last?.identifier != positionLayerIdentifier else { return }
    style.removeLayer(positionLayer)
    style.addLayer(positionLayer)
  }

  /// Ground shadow, drawn by its own layer so it never rotates with the vehicle. A shadow baked
  /// into the vehicle sprite spins with the heading, which reads as a lighting error.
  private func vehicleShadowImage() -> UIImage {
    let size = CGSize(width: 96, height: 96)
    return UIGraphicsImageRenderer(size: size).image { context in
      let graphics = context.cgContext
      let center = CGPoint(x: size.width / 2, y: size.height / 2)
      let colors =
        [
          UIColor.black.withAlphaComponent(0.30).cgColor,
          UIColor.black.withAlphaComponent(0.16).cgColor,
          UIColor.black.withAlphaComponent(0).cgColor,
        ] as CFArray
      guard
        let gradient = CGGradient(
          colorsSpace: CGColorSpaceCreateDeviceRGB(),
          colors: colors,
          locations: [0, 0.55, 1]
        )
      else { return }
      graphics.saveGState()
      // Squash into an ellipse so the pool sits on the ground plane rather than reading as a ball.
      graphics.translateBy(x: center.x, y: center.y)
      graphics.scaleBy(x: 1, y: 0.62)
      graphics.translateBy(x: -center.x, y: -center.y)
      graphics.drawRadialGradient(
        gradient,
        startCenter: center,
        startRadius: 0,
        endCenter: center,
        endRadius: size.width / 2,
        options: []
      )
      graphics.restoreGState()
    }
  }

  /// Three-quarter shaded vehicle, pre-stretched along its axis so that the map's guidance pitch
  /// (38 degrees) foreshortens it back to the intended proportions instead of squashing it.
  private func carMarkerImage() -> UIImage {
    let width = 96.0
    let height = 128.0
    return UIGraphicsImageRenderer(size: CGSize(width: width, height: height)).image { context in
      let graphics = context.cgContext

      // Wheels first so the body overlaps them.
      UIColor(red: 0.05, green: 0.07, blue: 0.10, alpha: 1).setFill()
      for rect in [
        CGRect(x: 20, y: 30, width: 12, height: 26),
        CGRect(x: 64, y: 30, width: 12, height: 26),
        CGRect(x: 20, y: 76, width: 12, height: 26),
        CGRect(x: 64, y: 76, width: 12, height: 26),
      ] {
        UIBezierPath(roundedRect: rect, cornerRadius: 5).fill()
      }

      let body = UIBezierPath(
        roundedRect: CGRect(x: 24, y: 8, width: 48, height: 112),
        cornerRadius: 20
      )

      // Body paint: light from the upper left, shadow to the lower right.
      graphics.saveGState()
      body.addClip()
      let paint =
        [
          UIColor(red: 0.42, green: 0.78, blue: 0.95, alpha: 1).cgColor,
          UIColor(red: 0.11, green: 0.52, blue: 0.78, alpha: 1).cgColor,
          UIColor(red: 0.03, green: 0.24, blue: 0.42, alpha: 1).cgColor,
        ] as CFArray
      if let gradient = CGGradient(
        colorsSpace: CGColorSpaceCreateDeviceRGB(),
        colors: paint,
        locations: [0, 0.55, 1]
      ) {
        graphics.drawLinearGradient(
          gradient,
          start: CGPoint(x: 26, y: 10),
          end: CGPoint(x: 74, y: 118),
          options: []
        )
      }
      // Specular sweep along the upper-left flank sells the curved metal.
      UIColor.white.withAlphaComponent(0.30).setFill()
      let highlight = UIBezierPath()
      highlight.move(to: CGPoint(x: 30, y: 22))
      highlight.addQuadCurve(
        to: CGPoint(x: 34, y: 106),
        controlPoint: CGPoint(x: 25, y: 64)
      )
      highlight.addLine(to: CGPoint(x: 41, y: 104))
      highlight.addQuadCurve(
        to: CGPoint(x: 37, y: 26),
        controlPoint: CGPoint(x: 32, y: 64)
      )
      highlight.close()
      highlight.fill()
      graphics.restoreGState()

      // Cabin glass, darker than the paint, with a windscreen and rear screen.
      UIColor(red: 0.05, green: 0.13, blue: 0.22, alpha: 0.95).setFill()
      let windscreen = UIBezierPath()
      windscreen.move(to: CGPoint(x: 33, y: 40))
      windscreen.addLine(to: CGPoint(x: 63, y: 40))
      windscreen.addLine(to: CGPoint(x: 58, y: 56))
      windscreen.addLine(to: CGPoint(x: 38, y: 56))
      windscreen.close()
      windscreen.fill()
      let rearScreen = UIBezierPath()
      rearScreen.move(to: CGPoint(x: 38, y: 82))
      rearScreen.addLine(to: CGPoint(x: 58, y: 82))
      rearScreen.addLine(to: CGPoint(x: 62, y: 96))
      rearScreen.addLine(to: CGPoint(x: 34, y: 96))
      rearScreen.close()
      rearScreen.fill()

      // Roof panel between the screens.
      UIColor(red: 0.16, green: 0.60, blue: 0.84, alpha: 1).setFill()
      UIBezierPath(
        roundedRect: CGRect(x: 36, y: 58, width: 24, height: 22),
        cornerRadius: 6
      ).fill()

      // Lamps: warm at the nose, red at the tail.
      UIColor(red: 1, green: 0.96, blue: 0.82, alpha: 0.95).setFill()
      UIBezierPath(roundedRect: CGRect(x: 31, y: 13, width: 12, height: 6), cornerRadius: 3).fill()
      UIBezierPath(roundedRect: CGRect(x: 53, y: 13, width: 12, height: 6), cornerRadius: 3).fill()
      UIColor(red: 0.90, green: 0.16, blue: 0.16, alpha: 0.95).setFill()
      UIBezierPath(roundedRect: CGRect(x: 31, y: 109, width: 12, height: 6), cornerRadius: 3).fill()
      UIBezierPath(roundedRect: CGRect(x: 53, y: 109, width: 12, height: 6), cornerRadius: 3).fill()

      // Crisp rim so the vehicle separates from busy map tiles.
      UIColor.white.withAlphaComponent(0.55).setStroke()
      body.lineWidth = 2
      body.stroke()
    }
  }

  private func coordinate(
    from start: CLLocationCoordinate2D,
    distanceMeters: Double,
    bearingDegrees: Double
  ) -> CLLocationCoordinate2D {
    let angularDistance = distanceMeters / 6_371_000
    let bearing = bearingDegrees * .pi / 180
    let latitude = start.latitude * .pi / 180
    let longitude = start.longitude * .pi / 180
    let destinationLatitude = asin(
      sin(latitude) * cos(angularDistance)
        + cos(latitude) * sin(angularDistance) * cos(bearing)
    )
    let destinationLongitude =
      longitude
      + atan2(
        sin(bearing) * sin(angularDistance) * cos(latitude),
        cos(angularDistance) - sin(latitude) * sin(destinationLatitude)
      )
    return CLLocationCoordinate2D(
      latitude: destinationLatitude * 180 / .pi,
      longitude: destinationLongitude * 180 / .pi
    )
  }
}

/// Scales a text-size expression when it is a constant or a zoom-interpolated curve with constant
/// stops; returns `nil` for anything else.
private func navOSSScaledSizeExpression(_ expression: NSExpression, by scale: Double) -> NSExpression? {
  if expression.expressionType == .constantValue, let value = expression.constantValue as? NSNumber {
    return NSExpression(forConstantValue: value.doubleValue * scale)
  }
  guard expression.expressionType == .function,
    expression.function == "mgl_interpolate:withCurveType:parameters:stops:",
    let arguments = expression.arguments, arguments.count == 4,
    arguments[3].expressionType == .constantValue,
    let stops = arguments[3].constantValue as? [NSNumber: NSExpression]
  else {
    return nil
  }
  var scaledStops: [NSNumber: NSExpression] = [:]
  for (zoom, value) in stops {
    guard value.expressionType == .constantValue, let size = value.constantValue as? NSNumber else {
      return nil
    }
    scaledStops[zoom] = NSExpression(forConstantValue: size.doubleValue * scale)
  }
  return NSExpression(
    forFunction: expression.operand,
    selectorName: "mgl_interpolate:withCurveType:parameters:stops:",
    arguments: [arguments[0], arguments[1], arguments[2], NSExpression(forConstantValue: scaledStops)]
  )
}

/// Map-rotation bearing from `start` to `end`, 0° north, clockwise.
private func navOSSCarPlayBearingDegreesForDisplay(
  from start: NavOSSCarPlayCoordinate,
  to end: NavOSSCarPlayCoordinate
) -> Double {
  let meanLatitude = (start.latitude + end.latitude) / 2 * .pi / 180
  let degrees =
    atan2((end.longitude - start.longitude) * cos(meanLatitude), end.latitude - start.latitude)
    * 180 / .pi
  return degrees >= 0 ? degrees : degrees + 360
}

/// Marker artwork for camera and report alerts.
enum NavOSSCarPlayMapAlertIcon: CaseIterable {
  case camera
  case hazard
  case closure
  case construction
  case traffic

  init(_ kind: NavOSSCarPlayMapAlert.Kind) {
    switch kind {
    case .redLightCamera, .speedCamera, .redLightAndSpeedCamera: self = .camera
    case let .report(type):
      switch type {
      case .roadClosure: self = .closure
      case .construction: self = .construction
      case .slowTraffic: self = .traffic
      case .collision, .objectOnRoad, .pothole, .roadHazard, .stalledVehicle: self = .hazard
      }
    }
  }

  var imageName: String { "navoss-carplay-alert-\(self)" }

  private var symbolName: String {
    switch self {
    case .camera: "camera.fill"
    case .hazard: "exclamationmark.triangle.fill"
    case .closure: "xmark.octagon.fill"
    case .construction: "cone.fill"
    case .traffic: "car.2.fill"
    }
  }

  private var fill: UIColor {
    switch self {
    case .camera: UIColor(red: 0.118, green: 0.169, blue: 0.173, alpha: 1)
    case .hazard, .construction, .traffic: UIColor(red: 0.961, green: 0.620, blue: 0.043, alpha: 1)
    case .closure: UIColor(red: 0.898, green: 0.282, blue: 0.302, alpha: 1)
    }
  }

  /// A round badge with a pointer, drawn at 2× so `iconScale = 0.5` stays crisp.
  func image() -> UIImage {
    let size = CGSize(width: 72, height: 88)
    return UIGraphicsImageRenderer(size: size).image { _ in
      let circle = CGRect(x: 6, y: 4, width: 60, height: 60)
      let pointer = UIBezierPath()
      pointer.move(to: CGPoint(x: 24, y: 58))
      pointer.addLine(to: CGPoint(x: 36, y: 84))
      pointer.addLine(to: CGPoint(x: 48, y: 58))
      pointer.close()
      UIColor.white.setFill()
      UIBezierPath(ovalIn: circle.insetBy(dx: -4, dy: -4)).fill()
      pointer.fill()
      fill.setFill()
      UIBezierPath(ovalIn: circle).fill()
      let configuration = UIImage.SymbolConfiguration(pointSize: 28, weight: .bold)
      if let glyph = UIImage(systemName: symbolName, withConfiguration: configuration)?
        .withTintColor(.white, renderingMode: .alwaysOriginal)
      {
        let glyphRect = CGRect(
          x: circle.midX - glyph.size.width / 2,
          y: circle.midY - glyph.size.height / 2,
          width: glyph.size.width,
          height: glyph.size.height
        )
        glyph.draw(in: glyphRect)
      }
    }
  }
}

/// A label with horizontal padding, used for the current-road pill.
final class NavOSSCarPlayInsetLabel: UILabel {
  var contentInsets = UIEdgeInsets(top: 0, left: 14, bottom: 0, right: 14)

  override func drawText(in rect: CGRect) {
    super.drawText(in: rect.inset(by: contentInsets))
  }

  override var intrinsicContentSize: CGSize {
    let size = super.intrinsicContentSize
    return CGSize(
      width: size.width + contentInsets.left + contentInsets.right,
      height: size.height + contentInsets.top + contentInsets.bottom
    )
  }
}
