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
  /// Layout of the speed unit: one container pinned top-right holding the speed-limit sign and
  /// the current speed side by side. Shared with the visual harness so its layout assertions follow
  /// the production values.
  static let hudMargin: CGFloat = 8
  /// Inset of the sign and the speed cell inside the container.
  static let hudPadding: CGFloat = 3
  static let hudGap: CGFloat = 4
  static let speedCellSize = CGSize(width: 42, height: 42)
  static let speedLimitSignSize = CGSize(width: 32, height: 38)
  /// Where the vehicle sits in the visible map during guidance, from its top (0) to its bottom (1):
  /// the lower third, so most of the view is road ahead.
  static let puckVerticalFraction: CGFloat = 0.72
  /// Space kept between the current-road pill, the attribution, and the visible map's edges.
  static let mapEdgeMargin: CGFloat = 8

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
  private let headingConeImageIdentifier = "navoss-carplay-heading-cone-image"
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
  /// Layers of the loaded style adjusted after the restyle: POIs (hidden in guidance) and road
  /// names (enlarged in guidance), collected once per style load.
  private var pointOfInterestLayers: [MLNStyleLayer] = []
  private var roadLabelLayers: [MLNSymbolStyleLayer] = []
  private struct DeclutterState: Equatable {
    var guidance: Bool
    var pointsOfInterest: Bool
  }
  private var appliedDeclutter: DeclutterState?
  /// What each overlay source last received on the loaded style, so a fix re-uploads only what
  /// changed. All reset when a style loads.
  private struct RouteTailKey: Equatable {
    var routeId: String?
    var count: Int
    var first: NavOSSCarPlayCoordinate?
  }
  private var installedRouteTail: RouteTailKey?
  private var installedAlternateRoute: [NavOSSCarPlayCoordinate]?
  private var installedTravelledRoute: [NavOSSCarPlayCoordinate]?
  private var installedCongestionRuns: [NavOSSCarPlayCongestionRun]?
  private var installedManeuverArrow: [NavOSSCarPlayCoordinate]?
  private var installedDestination: NavOSSCarPlayCoordinate?
  private var installedOrigin: NavOSSCarPlayCoordinate?
  private var appliedRouteLineGuidance: Bool?
  private var appliedMarkerImage: String?
  private var routeHeadSource: MLNShapeSource?
  private struct VehicleLayers {
    let source: MLNShapeSource
    let shadow: MLNSymbolStyleLayer
    let position: MLNSymbolStyleLayer
  }
  private var vehicleLayers: VehicleLayers?
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
  /// Original text sizes of road-label layers, kept so guidance can enlarge them and restore them.
  private var roadLabelFontSizes: [String: NSExpression] = [:]
  private var roadLabelHaloWidths: [String: NSExpression] = [:]
  private var lastLaidOutMapSize = CGSize.zero
  private var routeFitGeneration: UInt64 = 0
  private var alternateRouteCoordinates: [CLLocationCoordinate2D] = []
  private var routeCoordinates: [CLLocationCoordinate2D] = []
  private var routeGeometry: [NavOSSCarPlayCoordinate] = []
  /// `routeGeometry` measured once per route, for the render loop's path lookups.
  private var routePath = NavOSSCarPlayRoutePath([])
  /// The road between the last two fixes, recomputed on the next frame after a fix or new route.
  private var interpolationSpan: NavOSSCarPlayPathSpan?
  private var interpolationSpanIsStale = true
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
  /// The speed unit: a container holding the speed-limit sign then the current speed.
  private let speedHUD = UIView()
  private let speedHUDStack = UIStackView()
  private let speedLabel = UILabel()
  private let speedLimitLabel = UILabel()
  private let roadNamePill = UIView()
  private let roadNameLabel = UILabel()
  private weak var overlayContentView: UIView?
  private var overlayTopConstraint: NSLayoutConstraint?
  private var overlayTrailingConstraint: NSLayoutConstraint?
  private var isSpeeding = false
  private var displayedSpeedKph: Int?
  private var displayedSpeedLimitKph: Int?
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
  /// Visual harness instrumentation: once per render-loop frame, the display link's interval since
  /// that link's previous frame (`nil` on a new link's first frame) and the seconds the frame's
  /// work took.
  var onRenderFrame: ((_ frameIntervalSeconds: Double?, _ renderSeconds: Double) -> Void)?
  private var lastRenderFrameTimestamp: CFTimeInterval?
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
    // Attribution is small text with a halo, no box, in the visible map's bottom-leading corner.
    attributionLabel.font = UIFont.systemFont(ofSize: 9, weight: .semibold)
    attributionLabel.layer.shadowOffset = .zero
    attributionLabel.layer.shadowRadius = 1.5
    attributionLabel.layer.shadowOpacity = 1
    attributionLabel.translatesAutoresizingMaskIntoConstraints = false
    attributionLabel.accessibilityIdentifier = "carplay-attribution"
    updateAttribution()
    container.addSubview(attributionLabel)

    speedHUD.layer.cornerRadius = 10
    speedHUD.layer.borderWidth = 1
    speedHUD.layer.shadowColor = UIColor.black.cgColor
    speedHUD.layer.shadowOpacity = 0.18
    speedHUD.layer.shadowRadius = 4
    speedHUD.layer.shadowOffset = CGSize(width: 0, height: 1)
    speedHUD.translatesAutoresizingMaskIntoConstraints = false
    speedHUD.isHidden = true
    container.addSubview(speedHUD)
    speedHUDStack.axis = .horizontal
    speedHUDStack.alignment = .center
    speedHUDStack.spacing = Self.hudGap
    speedHUDStack.translatesAutoresizingMaskIntoConstraints = false
    speedHUD.addSubview(speedHUDStack)
    // Canadian regulatory signs are black on white with a black border; the sign stays that way in
    // both appearances so it reads as a sign rather than app chrome.
    speedLimitLabel.backgroundColor = .white
    speedLimitLabel.layer.borderColor = UIColor.black.cgColor
    speedLimitLabel.layer.borderWidth = 2
    speedLimitLabel.layer.cornerRadius = 4
    speedLimitLabel.clipsToBounds = true
    speedLimitLabel.numberOfLines = 2
    speedLimitLabel.textAlignment = .center
    speedLimitLabel.textColor = .black
    speedLimitLabel.isHidden = true
    speedLimitLabel.accessibilityIdentifier = "carplay-speed-limit"
    speedLabel.layer.cornerRadius = 7
    speedLabel.clipsToBounds = true
    speedLabel.numberOfLines = 2
    speedLabel.textAlignment = .center
    speedLabel.isHidden = true
    speedLabel.accessibilityIdentifier = "carplay-speed"
    speedHUDStack.addArrangedSubview(speedLimitLabel)
    speedHUDStack.addArrangedSubview(speedLabel)

    roadNamePill.layer.cornerRadius = 14
    roadNamePill.layer.borderWidth = 1
    roadNamePill.translatesAutoresizingMaskIntoConstraints = false
    roadNamePill.isHidden = true
    container.addSubview(roadNamePill)
    roadNameLabel.font = UIFont.systemFont(ofSize: 15, weight: .semibold)
    roadNameLabel.textAlignment = .center
    roadNameLabel.lineBreakMode = .byTruncatingTail
    // A long name shrinks to 80% before it is cut, so "Shaganappi Trail NW" fits a narrow map.
    roadNameLabel.adjustsFontSizeToFitWidth = true
    roadNameLabel.minimumScaleFactor = 0.8
    roadNameLabel.translatesAutoresizingMaskIntoConstraints = false
    roadNameLabel.accessibilityIdentifier = "carplay-current-road"
    roadNamePill.addSubview(roadNameLabel)

    let visible = container.safeAreaLayoutGuide
    let margin = Self.mapEdgeMargin
    let pillWidth = roadNamePill.widthAnchor.constraint(
      equalTo: roadNameLabel.widthAnchor, constant: 24)
    pillWidth.priority = .defaultHigh
    NSLayoutConstraint.activate([
      attributionLabel.leadingAnchor.constraint(equalTo: visible.leadingAnchor, constant: margin),
      attributionLabel.trailingAnchor.constraint(
        lessThanOrEqualTo: visible.trailingAnchor, constant: -margin),
      attributionLabel.bottomAnchor.constraint(equalTo: visible.bottomAnchor, constant: -3),
      speedHUDStack.topAnchor.constraint(equalTo: speedHUD.topAnchor, constant: Self.hudPadding),
      speedHUDStack.bottomAnchor.constraint(
        equalTo: speedHUD.bottomAnchor, constant: -Self.hudPadding),
      speedHUDStack.leadingAnchor.constraint(
        equalTo: speedHUD.leadingAnchor, constant: Self.hudPadding),
      speedHUDStack.trailingAnchor.constraint(
        equalTo: speedHUD.trailingAnchor, constant: -Self.hudPadding),
      speedLimitLabel.widthAnchor.constraint(equalToConstant: Self.speedLimitSignSize.width),
      speedLimitLabel.heightAnchor.constraint(equalToConstant: Self.speedLimitSignSize.height),
      speedLabel.widthAnchor.constraint(equalToConstant: Self.speedCellSize.width),
      speedLabel.heightAnchor.constraint(equalToConstant: Self.speedCellSize.height),
      // The pill sits under the vehicle at the bottom of the visible map, above the attribution,
      // and may use the whole visible width; a bottom anchor ignores the transient top chrome.
      roadNamePill.centerXAnchor.constraint(equalTo: visible.centerXAnchor),
      roadNamePill.bottomAnchor.constraint(
        equalTo: attributionLabel.topAnchor, constant: -3),
      roadNamePill.heightAnchor.constraint(equalToConstant: 28),
      roadNamePill.widthAnchor.constraint(
        lessThanOrEqualTo: visible.widthAnchor, constant: -2 * margin),
      pillWidth,
      roadNameLabel.centerXAnchor.constraint(equalTo: roadNamePill.centerXAnchor),
      roadNameLabel.centerYAnchor.constraint(equalTo: roadNamePill.centerYAnchor),
      roadNameLabel.leadingAnchor.constraint(
        greaterThanOrEqualTo: roadNamePill.leadingAnchor, constant: 12),
      roadNameLabel.trailingAnchor.constraint(
        lessThanOrEqualTo: roadNamePill.trailingAnchor, constant: -12),
    ])
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
    return URL(string: "\(Self.hostedStyleRoot)/\(styleSlug)")
  }

  /// Debug builds may point the hosted style at another root (for example a closed loopback
  /// port) to exercise the offline fallback; release builds always use OpenFreeMap.
  private static var hostedStyleRoot: String {
    #if DEBUG
      if let override = ProcessInfo.processInfo.environment["NAVOSS_DEBUG_MAP_STYLE_ROOT"],
        !override.isEmpty
      {
        return override
      }
    #endif
    return "https://tiles.openfreemap.org/styles"
  }

  /// Offline styles render OpenMapTiles-schema data built from OpenStreetMap; both are credited.
  /// The short form keeps the credit legible without taking a box out of the map.
  private func updateAttribution() {
    attributionLabel.text =
      loadedStyleURL?.isFileURL == true ? "© OpenStreetMap © OpenMapTiles" : "© OpenStreetMap"
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

  private var palette: NavOSSCarPlayMapPalette { styleSlug == "dark" ? .dark : .light }

  /// Overlay colours follow the resolved map style, not the system appearance, so a dark map never
  /// carries light chips.
  private func applyOverlayColors() {
    let dark = styleSlug == "dark"
    let chip = dark ? UIColor(rgb: 0x1E2B2C, alpha: 0.95) : UIColor(white: 1, alpha: 0.96)
    let chipBorder = dark ? UIColor(white: 1, alpha: 0.12) : UIColor(rgb: 0xD9DFDB)
    let ink = dark ? UIColor(white: 0.96, alpha: 1) : UIColor(rgb: 0x0E1516)
    roadNamePill.backgroundColor = chip
    roadNamePill.layer.borderColor = chipBorder.cgColor
    roadNameLabel.textColor = ink
    speedHUD.backgroundColor = chip
    speedHUD.layer.borderColor = chipBorder.cgColor
    attributionLabel.textColor = dark ? UIColor(rgb: 0xA9B3B7) : UIColor(rgb: 0x515A5E)
    attributionLabel.layer.shadowColor = UIColor(rgb: palette.labelHalo).cgColor
    applySpeedColors()
  }

  /// Speeding turns the speed cell coral with white figures; otherwise it is plain ink on the
  /// container.
  private func applySpeedColors() {
    if isSpeeding {
      speedLabel.backgroundColor = UIColor(rgb: 0xE5484D)
      speedLabel.textColor = .white
    } else {
      speedLabel.backgroundColor = .clear
      speedLabel.textColor = styleSlug == "dark" ? .white : UIColor(rgb: 0x0E1516)
    }
  }

  /// Re-anchors the speed unit per `anchorsSpeedHUDToViewBounds`, replacing any previously
  /// installed constraints. Safe to call before the view has loaded; it becomes a no-op until
  /// `loadView` supplies `overlayContentView`, at which point the initial call in `loadView`
  /// picks up whichever mode was selected first.
  private func updateOverlayAnchors() {
    guard let container = overlayContentView else { return }
    overlayTopConstraint?.isActive = false
    overlayTrailingConstraint?.isActive = false
    let margin = Self.hudMargin
    let top: NSLayoutConstraint
    let trailing: NSLayoutConstraint
    if anchorsSpeedHUDToViewBounds {
      top = speedHUD.topAnchor.constraint(equalTo: container.topAnchor, constant: margin)
      trailing = speedHUD.trailingAnchor.constraint(
        equalTo: container.trailingAnchor, constant: -margin)
    } else {
      top = speedHUD.topAnchor.constraint(
        equalTo: container.safeAreaLayoutGuide.topAnchor, constant: margin)
      trailing = speedHUD.trailingAnchor.constraint(
        equalTo: container.safeAreaLayoutGuide.trailingAnchor, constant: -margin)
    }
    NSLayoutConstraint.activate([top, trailing])
    overlayTopConstraint = top
    overlayTrailingConstraint = trailing
  }

  /// Shows the container while it holds anything. The stack collapses a hidden sign, so with an
  /// unknown limit the speed sits flush with the trailing edge instead of beside a blank slot.
  private func updateSpeedHUDVisibility() {
    speedHUD.isHidden = speedLabel.isHidden && speedLimitLabel.isHidden
  }

  /// The current-speed readout's frame in `view` coordinates. Exposed (not `private`) so the
  /// visual harness can assert the unit holds its position at the content's persistent top-right
  /// anchor across simulated CarPlay chrome changes, with the speed flush to the trailing edge
  /// whenever the speed limit is unknown or hidden.
  var speedReadoutFrame: CGRect { view.convert(speedLabel.frame, from: speedHUDStack) }

  var speedReadoutIsVisible: Bool { !speedHUD.isHidden && !speedLabel.isHidden }

  /// The speed-limit sign's frame in `view` coordinates, or `nil` while it is hidden — an unknown
  /// limit is never synthesized into a visible-but-blank sign.
  var speedLimitReadoutFrame: CGRect? {
    speedLimitLabel.isHidden ? nil : view.convert(speedLimitLabel.frame, from: speedHUDStack)
  }

  /// The whole speed unit's frame in `view` coordinates.
  var speedUnitFrame: CGRect { speedHUD.frame }

  /// The current-road pill's frame in `view` coordinates while it is shown.
  var currentRoadPillFrame: CGRect? { roadNamePill.isHidden ? nil : roadNamePill.frame }

  /// Whether the pill shows its name whole (scaled down at most to 80%) rather than truncated.
  var currentRoadNameFits: Bool {
    guard let text = roadNameLabel.text, let font = roadNameLabel.font else { return false }
    let width = (text as NSString).size(withAttributes: [.font: font]).width
    return width * roadNameLabel.minimumScaleFactor <= roadNameLabel.bounds.width + 0.5
  }

  /// The attribution's frame in `view` coordinates; it is always shown.
  var attributionFrame: CGRect { attributionLabel.frame }
  var attributionText: String? { attributionLabel.text }

  /// The vehicle's on-screen position in `view` coordinates during guidance.
  var vehicleScreenPoint: CGPoint? {
    guard activeGuidance, let position = renderedPosition ?? latestPosition else { return nil }
    let point = mapView.convert(
      CLLocationCoordinate2D(
        latitude: position.coordinate.latitude, longitude: position.coordinate.longitude),
      toPointTo: mapView)
    return view.convert(point, from: mapView)
  }

  /// The visible map: what CarPlay's live safe area leaves, in `view` coordinates.
  var visibleMapFrame: CGRect { view.safeAreaLayoutGuide.layoutFrame }

  /// Road-label layers currently enlarged for guidance, for the visual harness.
  var enlargedRoadLabelLayerCount: Int { activeGuidance ? roadLabelFontSizes.count : 0 }
  /// Camera and community-report markers drawn: the alerts received from the store, once their
  /// symbol layer is installed in the loaded style.
  var mapAlertMarkerCount: Int {
    guard mapView.style?.layer(withIdentifier: mapAlertLayerIdentifier) != nil else { return 0 }
    return mapAlerts.count
  }

  /// The current-road pill's text while it is shown, for the visual harness.
  var currentRoadNameReadout: String? {
    roadNamePill.isHidden ? nil : roadNameLabel.text
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
    updateGuidanceContentInset()
    guard routeCoordinates.count >= 2 else { return }
    if activeGuidance, !presentsRouteOverview, latestPosition != nil {
      recenter()
    } else {
      fitRoute(animated: false)
    }
  }

  /// During guidance the camera's focal point, where the vehicle sits, is the horizontal centre of
  /// the visible map (what CarPlay's safe area leaves beside the card and the map buttons) and
  /// `puckVerticalFraction` down it, so the vehicle sits in the lower third with the road ahead
  /// above it. The top is measured from the view's own top, not the safe area: the top inset
  /// changes whenever the navigation bar appears, and following it would bounce the camera on
  /// every touch.
  private func updateGuidanceContentInset() {
    guard isViewLoaded else { return }
    let insets = view.safeAreaInsets
    let target: UIEdgeInsets
    if activeGuidance && !presentsRouteOverview {
      let visibleHeight = max(0, view.bounds.height - insets.bottom)
      target = UIEdgeInsets(
        top: (2 * Self.puckVerticalFraction - 1) * visibleHeight,
        left: insets.left,
        bottom: insets.bottom,
        right: insets.right
      )
    } else {
      target = .zero
    }
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
    updateMapDeclutter()
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
    if mapView.showsUserLocation != (requestsUserLocation && !activeGuidance) {
      mapView.showsUserLocation = requestsUserLocation && !activeGuidance
    }
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
    if route != routeGeometry {
      routeGeometry = route
      routePath = NavOSSCarPlayRoutePath(route)
      interpolationSpanIsStale = true
    }
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
    updateSpeedDisplay(
      effectivePosition?.speedMetersPerSecond,
      speeding: overlay.speeding
    )
    updateSpeedLimitDisplay(speedLimitKph)
    updateRoadNameDisplay()
    updateMapDeclutter()
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
    lastTargetAt = nil
    invalidateDisplayLink()
    speedLabel.isHidden = true
    speedLimitLabel.isHidden = true
    updateSpeedHUDVisibility()
    roadNamePill.isHidden = true
    resetCamera()
    presentsRouteOverview = false
    routeId = nil
    alternateRouteCoordinates = []
    routeCoordinates = []
    routeGeometry = []
    routePath = NavOSSCarPlayRoutePath([])
    interpolationSpan = nil
    routeProgress = 0
    guidanceOverlay = NavOSSCarPlayGuidanceOverlay()
    latestDistanceToManeuverMeters = nil
    updateGuidanceContentInset()
    mapView.isScrollEnabled = true
    mapView.showsUserLocation = requestsUserLocation
    for identifier in [
      travelledRouteSourceIdentifier, congestionSourceIdentifier, maneuverArrowSourceIdentifier,
      maneuverArrowHeadSourceIdentifier, routeSourceIdentifier, routeHeadSourceIdentifier,
      alternateRouteSourceIdentifier, positionSourceIdentifier, destinationSourceIdentifier,
      originSourceIdentifier,
    ] {
      (mapView.style?.source(withIdentifier: identifier) as? MLNShapeSource)?.shape = nil
    }
    resetInstalledOverlayShapes()
    updateMapDeclutter()
    recenter()
  }

  func deactivate() {
    routeFitGeneration &+= 1
    invalidateDisplayLink()
    latestPosition = nil
    renderedPosition = nil
    lastRenderedCourseDegrees = nil
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

  /// Forgets what the previous style's sources and layers held; a new style starts empty.
  private func resetInstalledOverlays() {
    resetInstalledOverlayShapes()
    appliedRouteLineGuidance = nil
    appliedMarkerImage = nil
    routeHeadSource = nil
    vehicleLayers = nil
    pointOfInterestLayers = []
    roadLabelLayers = []
    appliedDeclutter = nil
  }

  /// Forgets which shapes the overlay sources hold, so the next install uploads them again.
  private func resetInstalledOverlayShapes() {
    installedRouteTail = nil
    installedAlternateRoute = nil
    installedTravelledRoute = nil
    installedCongestionRuns = nil
    installedManeuverArrow = nil
    installedDestination = nil
    installedOrigin = nil
  }

  func mapView(_ mapView: MLNMapView, didFinishLoading style: MLNStyle) {
    styleLoadWatchdog?.cancel()
    styleLoadWatchdog = nil
    styleLoadRetryCount = 0
    resetInstalledOverlays()
    restyleBasemap(style)
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
    updateMapDeclutter()
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
    resetInstalledOverlays()
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
    resetInstalledOverlays()
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

  /// Points the follow camera at `position`, which the content inset places in the lower third of
  /// the visible map.
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
        cameraHeading, toward: targetHeading, elapsedSeconds: elapsed, timeConstantSeconds: 0.5)
    }
    cameraFrameAt = now
    let camera = MLNMapCamera(
      lookingAtCenter: center,
      acrossDistance: cameraDistance,
      pitch: cameraPitch,
      heading: cameraHeading
    )
    if mapView.userTrackingMode != .none {
      mapView.setUserTrackingMode(.none, animated: false, completionHandler: nil)
    }
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
    interpolationSpanIsStale = true
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
    lastRenderFrameTimestamp = nil
    let link =
      screen?.displayLink(withTarget: self, selector: #selector(renderPositionFrame(_:)))
      ?? CADisplayLink(target: self, selector: #selector(renderPositionFrame(_:)))
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

  @objc private func renderPositionFrame(_ link: CADisplayLink) {
    guard let onRenderFrame else {
      renderPositionFrame()
      return
    }
    let started = CACurrentMediaTime()
    let interval = lastRenderFrameTimestamp.map { link.timestamp - $0 }
    lastRenderFrameTimestamp = link.timestamp
    renderPositionFrame()
    onRenderFrame(interval, CACurrentMediaTime() - started)
  }

  private func renderPositionFrame() {
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
    // The span between the two fixes is resolved once per fix (O(route)); a frame only places the
    // vehicle along it.
    if interpolationSpanIsStale {
      interpolationSpanIsStale = false
      interpolationSpan = navOSSCarPlayPathSpan(
        from: start.coordinate, to: target.coordinate, along: routePath)
    }
    let roadPath = interpolationSpan?.position(at: progress)
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
    defer { updateSpeedHUDVisibility() }
    guard activeGuidance, showsCurrentSpeed, let speedMetersPerSecond else {
      speedLabel.isHidden = true
      return
    }
    let speedKph = Int((speedMetersPerSecond * 3.6).rounded())
    let speeding = speeding == .overLimit
    if speeding != isSpeeding {
      isSpeeding = speeding
      applySpeedColors()
    }
    guard speedKph != displayedSpeedKph || speedLabel.isHidden else { return }
    displayedSpeedKph = speedKph
    let text = NSMutableAttributedString(
      string: "\(speedKph)",
      attributes: [.font: UIFont.monospacedDigitSystemFont(ofSize: 19, weight: .bold)]
    )
    text.append(
      NSAttributedString(
        string: "\nkm/h",
        attributes: [.font: UIFont.systemFont(ofSize: 8, weight: .semibold)]
      )
    )
    speedLabel.attributedText = text
    speedLabel.accessibilityLabel = isSpeeding
      ? "\(speedKph) kilometres per hour, over the limit"
      : "\(speedKph) kilometres per hour"
    speedLabel.isHidden = false
  }

  private func updateSpeedLimitDisplay(_ speedLimitKph: Int?) {
    defer { updateSpeedHUDVisibility() }
    guard activeGuidance, showsSpeedLimit, let speedLimitKph else {
      speedLimitLabel.isHidden = true
      return
    }
    guard speedLimitKph != displayedSpeedLimitKph || speedLimitLabel.isHidden else { return }
    displayedSpeedLimitKph = speedLimitKph
    let text = NSMutableAttributedString(
      string: "MAX\n",
      attributes: [.font: UIFont.systemFont(ofSize: 7, weight: .heavy)]
    )
    text.append(
      NSAttributedString(
        string: "\(speedLimitKph)",
        attributes: [.font: UIFont.monospacedDigitSystemFont(ofSize: 16, weight: .heavy)]
      )
    )
    speedLimitLabel.attributedText = text
    speedLimitLabel.accessibilityLabel = "Speed limit \(speedLimitKph)"
    speedLimitLabel.isHidden = false
  }

  /// The current road, shown only while following: the overview has no single current road.
  private func updateRoadNameDisplay() {
    guard showsRoadName, activeGuidance, !presentsRouteOverview,
      let name = guidanceOverlay.currentRoadName?.trimmingCharacters(in: .whitespacesAndNewlines),
      !name.isEmpty
    else {
      roadNamePill.isHidden = true
      return
    }
    if roadNameLabel.text != name {
      roadNameLabel.text = name
    }
    roadNamePill.isHidden = false
  }

  /// Decorations that depend on follow vs overview.
  private func updateGuidanceDecorations() {
    updateRoadNameDisplay()
    installManeuverArrowIfReady()
  }

  // MARK: Basemap

  /// Restyles the loaded basemap for the car: muted land and water, white or soft-grey roads,
  /// slightly warmer motorways, no extrusions or land-use fills, fewer and larger road names (see
  /// `navOSSCarPlayBasemapRole`). Runs after every style load: hosted, offline, the offline
  /// fallback and appearance changes. A layer the classifier does not recognise is left alone.
  private func restyleBasemap(_ style: MLNStyle) {
    let palette = self.palette
    let halo = NSExpression(forConstantValue: UIColor(rgb: palette.labelHalo))
    pointOfInterestLayers = []
    roadLabelLayers = []
    roadLabelFontSizes = [:]
    roadLabelHaloWidths = [:]
    appliedDeclutter = nil
    for layer in style.layers {
      if layer.identifier.lowercased().contains("poi") {
        pointOfInterestLayers.append(layer)
      }
      let type: NavOSSCarPlayBasemapLayerType =
        switch layer {
        case is MLNBackgroundStyleLayer: .background
        case is MLNFillExtrusionStyleLayer: .fillExtrusion
        case is MLNFillStyleLayer: .fill
        case is MLNLineStyleLayer: .line
        case is MLNSymbolStyleLayer: .symbol
        default: .other
        }
      let role = navOSSCarPlayBasemapRole(
        type: type,
        identifier: layer.identifier,
        sourceLayer: (layer as? MLNVectorStyleLayer)?.sourceLayerIdentifier
      )
      if role == .hidden {
        layer.isVisible = false
        continue
      }
      guard let rgb = palette.color(for: role) else { continue }
      let color = NSExpression(forConstantValue: UIColor(rgb: rgb))
      switch layer {
      case let background as MLNBackgroundStyleLayer:
        background.backgroundColor = color
      case let fill as MLNFillStyleLayer:
        fill.fillColor = color
        fill.fillOutlineColor = color
        fill.fillOpacity = NSExpression(forConstantValue: 1)
      case let line as MLNLineStyleLayer:
        line.lineColor = color
      case let symbol as MLNSymbolStyleLayer:
        symbol.textColor = color
        symbol.textHaloColor = halo
        if role == .roadLabel {
          // Road names repeat less often along a road; guidance also enlarges them.
          symbol.symbolSpacing = NSExpression(forConstantValue: 500)
          roadLabelLayers.append(symbol)
        }
      default:
        break
      }
    }
  }

  /// Hides POIs during guidance (and whenever the driver turned them off) and enlarges road names
  /// during guidance. Works on layers collected at style load, and only when that state changes,
  /// so a fix never walks the whole style.
  private func updateMapDeclutter() {
    guard mapView.style != nil else { return }
    let state = DeclutterState(guidance: activeGuidance, pointsOfInterest: showsPointsOfInterest)
    guard state != appliedDeclutter else { return }
    appliedDeclutter = state
    for layer in pointOfInterestLayers {
      layer.isVisible = state.pointsOfInterest && !state.guidance
    }
    updateRoadLabelLegibility()
  }

  /// Widths for both casings and both lines. Only depends on `activeGuidance`.
  private func applyRouteLineWidths(in style: MLNStyle) {
    guard appliedRouteLineGuidance != activeGuidance else { return }
    appliedRouteLineGuidance = activeGuidance
    let casingWidth = NSExpression(forConstantValue: activeGuidance ? 14 : 8)
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

  private func polylineFeature(_ coordinates: [NavOSSCarPlayCoordinate]) -> MLNPolylineFeature {
    polylineFeature(
      coordinates.map { CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude) })
  }

  /// Creates the heading cone, tail, and head layers together, once, in a fixed order: the cone,
  /// both casings, then both lines. Creating each pair lazily made z-order depend on install
  /// history, and appending casing-then-line per pair left a casing above a line, which painted a
  /// white nick across the route at the shared join. Visibility is driven purely by the source
  /// shapes, which are nil when a part has nothing to draw.
  private func installRouteLayersIfNeeded(
    positionSource: MLNShapeSource,
    tailSource: MLNShapeSource,
    headSource: MLNShapeSource,
    in style: MLNStyle
  ) {
    let palette = self.palette
    func headingCone() -> MLNSymbolStyleLayer {
      // A pre-drawn wedge on the vehicle's own point, rotated by a feature attribute, so a frame
      // updates one point instead of rebuilding a polygon.
      let layer = MLNSymbolStyleLayer(identifier: headingConeLayerIdentifier, source: positionSource)
      layer.iconImageName = NSExpression(forConstantValue: headingConeImageIdentifier)
      layer.predicate = NSPredicate(format: "hasCone == YES")
      layer.iconRotation = NSExpression(forKeyPath: "coneBearing")
      layer.iconRotationAlignment = NSExpression(forConstantValue: "map")
      layer.iconPitchAlignment = NSExpression(forConstantValue: "map")
      layer.iconAllowsOverlap = NSExpression(forConstantValue: true)
      layer.iconIgnoresPlacement = NSExpression(forConstantValue: true)
      return layer
    }
    func casing(_ identifier: String, _ source: MLNShapeSource) -> MLNLineStyleLayer {
      let layer = MLNLineStyleLayer(identifier: identifier, source: source)
      layer.lineCap = NSExpression(forConstantValue: "round")
      layer.lineJoin = NSExpression(forConstantValue: "round")
      layer.lineColor = NSExpression(forConstantValue: UIColor(rgb: palette.routeCasing))
      return layer
    }
    func line(_ identifier: String, _ source: MLNShapeSource) -> MLNLineStyleLayer {
      let layer = MLNLineStyleLayer(identifier: identifier, source: source)
      layer.lineCap = NSExpression(forConstantValue: "round")
      layer.lineJoin = NSExpression(forConstantValue: "round")
      layer.lineColor = NSExpression(forConstantValue: UIColor(rgb: palette.route))
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
    if style.image(forName: headingConeImageIdentifier) == nil {
      style.setImage(headingConeImage(), forName: headingConeImageIdentifier)
    }
    appliedRouteLineGuidance = nil
    add(headingCone(), in: style)
    add(casing(routeCasingLayerIdentifier, tailSource), in: style)
    add(casing(routeHeadCasingLayerIdentifier, headSource), in: style)
    add(line(routeLayerIdentifier, tailSource), in: style)
    add(line(routeHeadLayerIdentifier, headSource), in: style)
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

  /// Installs the static part of the route: everything from the first fixed vertex onward.
  ///
  /// `routeCoordinates[0]` is the moving head and is deliberately excluded, because rebuilding
  /// this source re-tessellates the whole polyline. Splitting the head into its own two-point
  /// source turns the per-frame cost from O(route vertices) into O(1); this source is then only
  /// re-uploaded when its vertices change (a new route, or the vehicle passing a vertex), not on
  /// every fix.
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
      installedRouteTail = nil
      return
    }
    // Sources and layers first, then styling. Styling before the layers exist left the tail at
    // MapLibre's default 1 pt width on the first install after any style load, which is permanent
    // in route preview because `display` runs once there.
    let positionSource = ensureShapeSource(positionSourceIdentifier, in: style)
    let tailSource = ensureShapeSource(routeSourceIdentifier, in: style)
    let headSource = ensureShapeSource(routeHeadSourceIdentifier, in: style)
    installRouteLayersIfNeeded(
      positionSource: positionSource,
      tailSource: tailSource,
      headSource: headSource,
      in: style
    )
    applyRouteLineWidths(in: style)

    // With exactly two coordinates the head already spans the whole remaining route, so the
    // static source would duplicate it and reintroduce the moving vertex it exists to avoid.
    let tail = routeCoordinates.dropFirst()
    let tailKey = RouteTailKey(
      routeId: routeId,
      count: tail.count,
      first: tail.first.map { NavOSSCarPlayCoordinate(latitude: $0.latitude, longitude: $0.longitude) }
    )
    if tailKey != installedRouteTail {
      installedRouteTail = tailKey
      tailSource.shape = tail.count >= 2 ? polylineFeature(Array(tail)) : nil
    }
    installRouteHeadIfReady()
  }

  /// The moving head: a two-point line from the interpolated puck to the first fixed vertex.
  /// This is the only geometry that changes between animation frames, so it does the minimum
  /// possible work: one shape assignment. Layer creation and width styling happen in
  /// `installRouteOverlayIfReady`, which runs on route changes rather than per frame.
  private func installRouteHeadIfReady() {
    guard let style = mapView.style else { return }
    if routeHeadSource == nil {
      routeHeadSource = style.source(withIdentifier: routeHeadSourceIdentifier) as? MLNShapeSource
    }
    guard let source = routeHeadSource else { return }
    // Same distinctness test as `installRouteOverlayIfReady`, so the two entry points cannot
    // disagree about whether there is anything to draw. Without it, remaining geometry that has
    // collapsed to one repeated point at arrival paints a zero-length feature, which with round
    // caps is a casing dot sitting on the puck.
    guard routeCoordinates.count >= 2,
      routeCoordinates[1].latitude != routeCoordinates[0].latitude
        || routeCoordinates[1].longitude != routeCoordinates[0].longitude
    else {
      source.shape = nil
      return
    }
    source.shape = polylineFeature([routeCoordinates[0], routeCoordinates[1]])
  }

  private func installAlternateRouteOverlayIfReady() {
    guard let style = mapView.style else {
      return
    }
    guard alternateRouteCoordinates.count >= 2 else {
      (style.source(withIdentifier: alternateRouteSourceIdentifier) as? MLNShapeSource)?.shape = nil
      installedAlternateRoute = nil
      return
    }
    let source = ensureShapeSource(alternateRouteSourceIdentifier, in: style)
    let key = alternateRouteCoordinates.map {
      NavOSSCarPlayCoordinate(latitude: $0.latitude, longitude: $0.longitude)
    }
    if key != installedAlternateRoute {
      installedAlternateRoute = key
      source.shape = polylineFeature(alternateRouteCoordinates)
    }
    if style.layer(withIdentifier: alternateRouteLayerIdentifier) == nil {
      // Alternates sit under the selected route in a quiet grey-blue, cased so they stay legible.
      let casing = MLNLineStyleLayer(identifier: alternateRouteCasingLayerIdentifier, source: source)
      casing.lineCap = NSExpression(forConstantValue: "round")
      casing.lineJoin = NSExpression(forConstantValue: "round")
      casing.lineColor = NSExpression(forConstantValue: UIColor(rgb: palette.alternateRouteCasing))
      casing.lineWidth = NSExpression(forConstantValue: 8)
      let alternateRoute = MLNLineStyleLayer(identifier: alternateRouteLayerIdentifier, source: source)
      alternateRoute.lineCap = NSExpression(forConstantValue: "round")
      alternateRoute.lineJoin = NSExpression(forConstantValue: "round")
      alternateRoute.lineColor = NSExpression(forConstantValue: UIColor(rgb: palette.alternateRoute))
      alternateRoute.lineWidth = NSExpression(forConstantValue: 5)
      if let below = style.layer(withIdentifier: routeCasingLayerIdentifier) {
        style.insertLayer(casing, below: below)
        style.insertLayer(alternateRoute, below: below)
      } else {
        add(casing, in: style)
        add(alternateRoute, in: style)
      }
    }
  }

  // MARK: Route colours

  private func congestionColor(_ level: NavOSSCarPlayCongestionLevel) -> UIColor {
    switch level {
    case .slow: UIColor(rgb: 0xF5A524)
    case .heavy: UIColor(rgb: 0xE5484D)
    case .stopped: UIColor(rgb: 0x8B1E2D)
    case .free, .unknown: UIColor(rgb: palette.route)
    }
  }

  /// Adds a decoration under the vehicle, so nothing is ever drawn over the puck, or on top while
  /// no vehicle layer exists yet (the vehicle layers are then appended above it).
  private func add(_ layer: MLNStyleLayer, in style: MLNStyle) {
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
  /// rather than disappearing. Static per route: uploaded once per route, not per fix.
  private func installTravelledRouteIfReady() {
    guard let style = mapView.style else { return }
    let source = ensureShapeSource(travelledRouteSourceIdentifier, in: style)
    guard activeGuidance, routeGeometry.count >= 2 else {
      source.shape = nil
      installedTravelledRoute = nil
      return
    }
    if style.layer(withIdentifier: travelledRouteLayerIdentifier) == nil {
      let layer = MLNLineStyleLayer(identifier: travelledRouteLayerIdentifier, source: source)
      layer.lineCap = NSExpression(forConstantValue: "round")
      layer.lineJoin = NSExpression(forConstantValue: "round")
      layer.lineColor = NSExpression(forConstantValue: UIColor(rgb: palette.travelledRoute))
      layer.lineWidth = NSExpression(forConstantValue: 8)
      if let casing = style.layer(withIdentifier: routeCasingLayerIdentifier) {
        style.insertLayer(layer, below: casing)
      } else {
        add(layer, in: style)
      }
    }
    guard installedTravelledRoute != routeGeometry else { return }
    installedTravelledRoute = routeGeometry
    source.shape = polylineFeature(routeGeometry)
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
    guard runs != installedCongestionRuns else { return }
    installedCongestionRuns = runs
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
        default: NSExpression(forConstantValue: UIColor(rgb: palette.route))
      )
      if let head = style.layer(withIdentifier: routeHeadLayerIdentifier) {
        style.insertLayer(layer, above: head)
      } else {
        add(layer, in: style)
      }
    }
    source.shape = MLNShapeCollectionFeature(
      shapes: runs.map { run in
        let feature = polylineFeature(run.coordinates)
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
    let arrow = guidanceOverlay.maneuverArrow
    let visible =
      activeGuidance && !presentsRouteOverview && arrow.count >= 2
      && (latestDistanceToManeuverMeters.map { $0 <= maneuverArrowVisibleMeters } ?? false)
    let key = visible ? arrow : []
    guard key != installedManeuverArrow else { return }
    installedManeuverArrow = key
    let lineSource = ensureShapeSource(maneuverArrowSourceIdentifier, in: style)
    let headSource = ensureShapeSource(maneuverArrowHeadSourceIdentifier, in: style)
    guard visible else {
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
      casing.lineColor = NSExpression(forConstantValue: UIColor(rgb: 0x0E1516, alpha: 0.85))
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
        add(layer, in: style)
      }
    }
    lineSource.shape = polylineFeature(arrow)
    let tip = MLNPointFeature()
    tip.coordinate = CLLocationCoordinate2D(
      latitude: arrow[arrow.count - 1].latitude, longitude: arrow[arrow.count - 1].longitude)
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

  /// Camera and road-report markers from `NavOSSCarPlayMapAlertStore`: the active safety camera
  /// and community reports the server returned (`NavOSSCommunityService`).
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
      add(layer, in: style)
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
  private func updateRoadLabelLegibility() {
    let scale = 1.22
    for symbol in roadLabelLayers {
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

  /// A circle marker for a route end, re-uploaded only when that end moves.
  private func installEndpointOverlay(
    _ coordinate: NavOSSCarPlayCoordinate?,
    installed: inout NavOSSCarPlayCoordinate?,
    sourceIdentifier: String,
    layerIdentifier: String,
    color: UIColor,
    radius: Double
  ) {
    guard let style = mapView.style else { return }
    guard let coordinate else {
      if installed != nil {
        (style.source(withIdentifier: sourceIdentifier) as? MLNShapeSource)?.shape = nil
        installed = nil
      }
      return
    }
    let source = ensureShapeSource(sourceIdentifier, in: style)
    if installed != coordinate {
      installed = coordinate
      let point = MLNPointFeature()
      point.coordinate = CLLocationCoordinate2D(
        latitude: coordinate.latitude, longitude: coordinate.longitude)
      source.shape = point
    }
    if style.layer(withIdentifier: layerIdentifier) == nil {
      let layer = MLNCircleStyleLayer(identifier: layerIdentifier, source: source)
      layer.circleColor = NSExpression(forConstantValue: color)
      layer.circleRadius = NSExpression(forConstantValue: radius)
      layer.circleStrokeColor = NSExpression(forConstantValue: UIColor.white)
      layer.circleStrokeWidth = NSExpression(forConstantValue: 2.5)
      add(layer, in: style)
    }
  }

  /// The destination: a coral dot, distinct from the blue route it ends.
  private func installDestinationOverlayIfReady() {
    installEndpointOverlay(
      latestDestination, installed: &installedDestination,
      sourceIdentifier: destinationSourceIdentifier, layerIdentifier: destinationLayerIdentifier,
      color: UIColor(rgb: 0xE5484D), radius: 7)
  }

  /// The origin in route preview: a green dot.
  private func installOriginOverlayIfReady() {
    installEndpointOverlay(
      latestOrigin, installed: &installedOrigin,
      sourceIdentifier: originSourceIdentifier, layerIdentifier: originLayerIdentifier,
      color: UIColor.systemGreen, radius: 6)
  }

  /// The vehicle, its ground shadow, and its heading cone, all drawn from one point feature.
  ///
  /// This runs every render frame, so after the first install on a style it only builds one point
  /// with its rotation attributes and assigns it; the layers read rotation from the feature, and
  /// marker images and scales are touched only when the marker kind changes.
  private func installPositionOverlayIfReady() {
    guard let style = mapView.style else {
      return
    }
    guard activeGuidance, let position = renderedPosition ?? latestPosition else {
      vehicleLayers?.source.shape = nil
      (style.source(withIdentifier: positionSourceIdentifier) as? MLNShapeSource)?.shape = nil
      return
    }
    let layers = vehicleLayers ?? installVehicleLayers(in: style)
    // Heading fallback chain. Pointing a directional marker due north when the heading is
    // unknown is worse than showing no direction at all, so the terminal case swaps in a
    // non-directional marker instead of inventing a bearing.
    //   1. validated course from the published position (matched route bearing, else GPS course)
    //   2. bearing of the route segment nearest the puck
    //   3. last heading actually rendered this trip
    //   4. none -> neutral, non-directional marker
    let resolvedCourseDegrees =
      validCourseDegrees(position.courseDegrees)
      ?? navOSSRouteBearingDegrees(near: position.coordinate, in: routeGeometry)
      ?? lastRenderedCourseDegrees
    if let resolvedCourseDegrees {
      lastRenderedCourseDegrees = resolvedCourseDegrees
    }
    // The marker keeps its course-based rotation; only the cone prefers the compass, which is the
    // one bearing that still answers "which way is the car pointing" while stopped.
    let coneHeading = navOSSCarPlayConeHeadingDegrees(
      compassHeadingDegrees: position.compassHeadingDegrees,
      fallbackCourseDegrees: resolvedCourseDegrees
    )
    let markerImage =
      resolvedCourseDegrees == nil
      ? neutralImageIdentifier
      : vehicleMarker == .car ? carImageIdentifier : positionImageIdentifier
    if markerImage != appliedMarkerImage {
      appliedMarkerImage = markerImage
      let isCar = markerImage == carImageIdentifier
      layers.position.iconImageName = NSExpression(forConstantValue: markerImage)
      layers.position.iconScale = NSExpression(forConstantValue: isCar ? 0.55 : 0.72)
      layers.shadow.iconScale = NSExpression(forConstantValue: isCar ? 0.72 : 0.62)
    }
    let point = MLNPointFeature()
    point.coordinate = CLLocationCoordinate2D(
      latitude: position.coordinate.latitude,
      longitude: position.coordinate.longitude
    )
    point.attributes = [
      "bearing": resolvedCourseDegrees ?? 0,
      "hasCone": coneHeading != nil,
      "coneBearing": coneHeading ?? 0,
    ]
    layers.source.shape = point
  }

  /// Creates the vehicle's source, images, shadow and marker layers on the loaded style. The
  /// marker and shadow are appended last, and every later decoration is inserted below them.
  private func installVehicleLayers(in style: MLNStyle) -> VehicleLayers {
    let source = ensureShapeSource(positionSourceIdentifier, in: style)
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
    for identifier in [shadowLayerIdentifier, positionLayerIdentifier] {
      if let existing = style.layer(withIdentifier: identifier) {
        style.removeLayer(existing)
      }
    }
    // Ground shadow is its own layer pinned to rotation 0, so the light stays fixed while the
    // vehicle turns. It shares the position source, so it follows the puck for free and is
    // cleared with it.
    let shadow = MLNSymbolStyleLayer(identifier: shadowLayerIdentifier, source: source)
    shadow.iconAllowsOverlap = NSExpression(forConstantValue: true)
    shadow.iconIgnoresPlacement = NSExpression(forConstantValue: true)
    shadow.iconRotationAlignment = NSExpression(forConstantValue: "map")
    shadow.iconPitchAlignment = NSExpression(forConstantValue: "map")
    shadow.iconImageName = NSExpression(forConstantValue: shadowImageIdentifier)
    shadow.iconRotation = NSExpression(forConstantValue: 0)
    style.addLayer(shadow)
    let position = MLNSymbolStyleLayer(identifier: positionLayerIdentifier, source: source)
    position.iconAllowsOverlap = NSExpression(forConstantValue: true)
    position.iconIgnoresPlacement = NSExpression(forConstantValue: true)
    position.iconRotationAlignment = NSExpression(forConstantValue: "map")
    // Keep the marker on the ground plane; without this an implementation default change
    // would billboard it and break the perspective compensation baked into the artwork.
    position.iconPitchAlignment = NSExpression(forConstantValue: "map")
    position.iconRotation = NSExpression(forKeyPath: "bearing")
    style.addLayer(position)
    let layers = VehicleLayers(source: source, shadow: shadow, position: position)
    vehicleLayers = layers
    appliedMarkerImage = nil
    return layers
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

  /// The heading cone: a soft wedge in the route blue, apex at the image centre, pointing up.
  private func headingConeImage() -> UIImage {
    let size = CGSize(width: 128, height: 128)
    let blue = UIColor(rgb: palette.route)
    return UIGraphicsImageRenderer(size: size).image { context in
      let center = CGPoint(x: size.width / 2, y: size.height / 2)
      let wedge = UIBezierPath()
      wedge.move(to: center)
      wedge.addArc(
        withCenter: center, radius: 60, startAngle: -.pi / 2 - .pi / 6,
        endAngle: -.pi / 2 + .pi / 6, clockwise: true)
      wedge.close()
      context.cgContext.saveGState()
      wedge.addClip()
      let colors =
        [blue.withAlphaComponent(0.45).cgColor, blue.withAlphaComponent(0).cgColor] as CFArray
      if let gradient = CGGradient(
        colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1])
      {
        context.cgContext.drawRadialGradient(
          gradient, startCenter: center, startRadius: 0, endCenter: center, endRadius: 60,
          options: [])
      }
      context.cgContext.restoreGState()
    }
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

extension UIColor {
  /// An sRGB colour from `0xRRGGBB`.
  fileprivate convenience init(rgb: UInt32, alpha: CGFloat = 1) {
    self.init(
      red: CGFloat(rgb >> 16 & 0xFF) / 255, green: CGFloat(rgb >> 8 & 0xFF) / 255,
      blue: CGFloat(rgb & 0xFF) / 255, alpha: alpha)
  }
}
