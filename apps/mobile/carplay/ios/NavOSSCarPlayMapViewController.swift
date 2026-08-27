import MapLibre
internal import NavOSSNavigation
import UIKit

@MainActor
final class NavOSSCarPlayMapViewController: UIViewController,
  @preconcurrency MLNMapViewDelegate
{
  private let calgaryCenter = CLLocationCoordinate2D(latitude: 51.0447, longitude: -114.0719)
  private let destinationLayerIdentifier = "navoss-carplay-destination"
  private let destinationSourceIdentifier = "navoss-carplay-destination-source"
  private let originLayerIdentifier = "navoss-carplay-origin"
  private let originSourceIdentifier = "navoss-carplay-origin-source"
  private let alternateRouteLayerIdentifier = "navoss-carplay-alternate-route"
  private let alternateRouteSourceIdentifier = "navoss-carplay-alternate-route-source"
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
  private var displayLink: CADisplayLink?
  private var interpolationFromPosition: NavOSSCarPlayPosition?
  private var interpolationStartedAt: CFTimeInterval = 0
  private var interpolationDuration: CFTimeInterval = navOSSCarPlayDefaultInterpolationSeconds
  private var lastTargetAt: CFTimeInterval?
  private var latestDestination: NavOSSCarPlayCoordinate?
  private var latestOrigin: NavOSSCarPlayCoordinate?
  private var latestPosition: NavOSSCarPlayPosition?
  private var mapOrientation = NavOSSCarPlayMapOrientation.headingUp
  private var needsIdleLocationRecenter = true
  private var renderedPosition: NavOSSCarPlayPosition?
  private var lastRenderedCourseDegrees: Double?
  private var lastHeadingConeApex: NavOSSCarPlayCoordinate?
  private var lastHeadingConeHeadingDegrees: Double?
  private var navigationViewingDistance = 850.0
  private var presentsRouteOverview = false
  private var guidanceHiddenLayerIdentifiers: Set<String> = []
  private var lastLaidOutMapSize = CGSize.zero
  private var routeFitGeneration: UInt64 = 0
  private var alternateRouteCoordinates: [CLLocationCoordinate2D] = []
  private var routeCoordinates: [CLLocationCoordinate2D] = []
  private var routeGeometry: [NavOSSCarPlayCoordinate] = []
  private var routeId: String?
  private var showsPointsOfInterest = true
  private var styleLoadRetryCount = 0
  private var styleLoadWatchdog: DispatchWorkItem?
  private var styleSlug = "liberty"
  private var vehicleMarker = NavOSSCarPlayVehicleMarker.arrow
  private(set) var mapView: MLNMapView!
  private let speedLabel = UILabel()
  private let speedLimitLabel = UILabel()
  var onStyleLoaded: (() -> Void)?
  var reservesRouteChoiceSheet = true
  private(set) var requestsUserLocation = true

  override func loadView() {
    styleSlug = resolvedStyleSlug()
    let styleURL = URL(string: "https://tiles.openfreemap.org/styles/\(styleSlug)")
    let mapView = MLNMapView(frame: .zero, styleURL: styleURL)
    mapView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    mapView.isPitchEnabled = false
    mapView.isRotateEnabled = false
    mapView.isScrollEnabled = false
    mapView.isZoomEnabled = false
    mapView.compassView.isHidden = true
    mapView.logoView.isHidden = true
    mapView.attributionButton.isHidden = true
    mapView.delegate = self
    mapView.showsUserLocation = requestsUserLocation
    mapView.setCenter(calgaryCenter, zoomLevel: 10.5, animated: false)
    self.mapView = mapView
    scheduleStyleLoadWatchdog()
    let container = UIView(frame: .zero)
    container.addSubview(mapView)
    let attributionLabel = UILabel()
    attributionLabel.backgroundColor = UIColor.secondarySystemBackground.withAlphaComponent(0.78)
    attributionLabel.font = UIFont.systemFont(ofSize: 9, weight: .medium)
    attributionLabel.layer.cornerRadius = 3
    attributionLabel.clipsToBounds = true
    attributionLabel.text = "  © OpenStreetMap contributors  "
    attributionLabel.textColor = .secondaryLabel
    attributionLabel.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(attributionLabel)
    speedLabel.backgroundColor = UIColor.secondarySystemBackground.withAlphaComponent(0.94)
    speedLabel.font = UIFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
    speedLabel.layer.borderColor = UIColor.black.withAlphaComponent(0.65).cgColor
    speedLabel.layer.borderWidth = 1.5
    speedLabel.layer.cornerRadius = 5
    speedLabel.clipsToBounds = true
    speedLabel.numberOfLines = 2
    speedLabel.textAlignment = .center
    speedLabel.textColor = .label
    speedLabel.translatesAutoresizingMaskIntoConstraints = false
    speedLabel.isHidden = true
    container.addSubview(speedLabel)
    speedLimitLabel.backgroundColor = .white
    speedLimitLabel.font = UIFont.monospacedDigitSystemFont(ofSize: 13, weight: .bold)
    speedLimitLabel.layer.borderColor = UIColor.black.cgColor
    speedLimitLabel.layer.borderWidth = 1.5
    speedLimitLabel.layer.cornerRadius = 5
    speedLimitLabel.clipsToBounds = true
    speedLimitLabel.numberOfLines = 2
    speedLimitLabel.textAlignment = .center
    speedLimitLabel.textColor = .black
    speedLimitLabel.translatesAutoresizingMaskIntoConstraints = false
    speedLimitLabel.isHidden = true
    container.addSubview(speedLimitLabel)
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
      speedLimitLabel.trailingAnchor.constraint(
        equalTo: container.safeAreaLayoutGuide.trailingAnchor,
        constant: -8
      ),
      speedLimitLabel.topAnchor.constraint(
        equalTo: container.safeAreaLayoutGuide.topAnchor,
        constant: 8
      ),
      speedLimitLabel.widthAnchor.constraint(equalToConstant: 38),
      speedLimitLabel.heightAnchor.constraint(equalToConstant: 36),
      speedLabel.trailingAnchor.constraint(equalTo: speedLimitLabel.leadingAnchor, constant: -4),
      speedLabel.topAnchor.constraint(equalTo: speedLimitLabel.topAnchor),
      speedLabel.widthAnchor.constraint(equalToConstant: 38),
      speedLabel.heightAnchor.constraint(equalToConstant: 36),
    ])
    view = container
  }

  override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    super.traitCollectionDidChange(previousTraitCollection)
    guard traitCollection.hasDifferentColorAppearance(comparedTo: previousTraitCollection) else {
      return
    }
    guard appearance == .automatic else {
      return
    }
    let nextStyleSlug = resolvedStyleSlug()
    guard nextStyleSlug != styleSlug else {
      return
    }
    styleSlug = nextStyleSlug
    loadStyle(resetRetryCount: true)
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

  func applyAppearance(_ appearance: NavOSSCarPlayAppearance) {
    self.appearance = appearance
    overrideUserInterfaceStyle =
      switch appearance {
      case .automatic: .unspecified
      case .dark: .dark
      case .light: .light
      }
    guard isViewLoaded else {
      return
    }
    let nextStyleSlug = resolvedStyleSlug()
    guard nextStyleSlug != styleSlug else {
      return
    }
    styleSlug = nextStyleSlug
    loadStyle(resetRetryCount: true)
  }

  func setIdleLocationTrackingEnabled(_ enabled: Bool) {
    requestsUserLocation = enabled
    guard isViewLoaded, !activeGuidance else { return }
    mapView.showsUserLocation = enabled
    if enabled {
      needsIdleLocationRecenter = true
      recenter()
    } else {
      needsIdleLocationRecenter = false
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
    guard isViewLoaded else { return }
    recenter()
  }

  private func resolvedStyleSlug() -> String {
    switch appearance {
    case .automatic:
      traitCollection.userInterfaceStyle == .dark ? "dark" : "liberty"
    case .dark:
      "dark"
    case .light:
      "liberty"
    }
  }

  func recenter() {
    presentsRouteOverview = false
    guard let latestPosition else {
      if activeGuidance {
        fitRoute(animated: true)
      } else if !requestsUserLocation {
        mapView.setUserTrackingMode(.none, animated: false, completionHandler: nil)
      } else if let location = mapView.userLocation?.location,
        location.horizontalAccuracy >= 0
      {
        displayIdleLocation(
          NavOSSCarPlayCoordinate(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude
          ),
          animated: true
        )
      } else {
        needsIdleLocationRecenter = true
        let trackingMode: MLNUserTrackingMode =
          mapOrientation == .northUp
          ? .follow
          : .followWithCourse
        mapView.setUserTrackingMode(trackingMode, animated: true, completionHandler: nil)
      }
      return
    }
    follow(latestPosition, duration: 0.35)
  }

  func displayIdleLocation(
    _ coordinate: NavOSSCarPlayCoordinate,
    animated: Bool
  ) {
    guard !activeGuidance, coordinate.latitude.isFinite, coordinate.longitude.isFinite,
      (-90...90).contains(coordinate.latitude), (-180...180).contains(coordinate.longitude)
    else { return }
    needsIdleLocationRecenter = false
    mapView.setUserTrackingMode(.none, animated: false, completionHandler: nil)
    mapView.setCenter(
      CLLocationCoordinate2D(latitude: coordinate.latitude, longitude: coordinate.longitude),
      zoomLevel: 15.5,
      animated: animated
    )
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
    speedLimitKph: Int? = nil
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
    if activeGuidance && !presentsRouteOverview {
      navigationViewingDistance = navOSSCarPlayViewingDistance(distanceToManeuverMeters)
    }
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
    updateSpeedDisplay(effectivePosition?.speedMetersPerSecond, speedLimitKph: speedLimitKph)
    updateSpeedLimitDisplay(speedLimitKph)
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
    activeGuidance = false
    latestOrigin = nil
    latestDestination = nil
    latestPosition = nil
    renderedPosition = nil
    lastRenderedCourseDegrees = nil
    lastHeadingConeApex = nil
    lastHeadingConeHeadingDegrees = nil
    lastTargetAt = nil
    displayLink?.invalidate()
    displayLink = nil
    speedLabel.isHidden = true
    speedLimitLabel.isHidden = true
    navigationViewingDistance = 850
    presentsRouteOverview = false
    routeId = nil
    alternateRouteCoordinates = []
    routeCoordinates = []
    routeGeometry = []
    mapView.showsUserLocation = requestsUserLocation
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
    displayLink?.invalidate()
    displayLink = nil
    latestPosition = nil
    renderedPosition = nil
    lastRenderedCourseDegrees = nil
    lastHeadingConeApex = nil
    lastHeadingConeHeadingDegrees = nil
    lastTargetAt = nil
    mapView.showsUserLocation = false
    mapView.setUserTrackingMode(.none, animated: false, completionHandler: nil)
    mapView.delegate = nil
  }

  func zoom(by delta: Double) {
    if activeGuidance {
      navigationViewingDistance = max(
        250,
        min(5_000, navigationViewingDistance * pow(2, -delta))
      )
      recenter()
    } else {
      mapView.setZoomLevel(max(8, min(18, mapView.zoomLevel + delta)), animated: true)
    }
  }

  func mapView(_ mapView: MLNMapView, didFinishLoading style: MLNStyle) {
    styleLoadWatchdog?.cancel()
    styleLoadWatchdog = nil
    styleLoadRetryCount = 0
    lastHeadingConeApex = nil
    lastHeadingConeHeadingDegrees = nil
    installAlternateRouteOverlayIfReady()
    installRouteOverlayIfReady()
    installOriginOverlayIfReady()
    installDestinationOverlayIfReady()
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
    guard needsIdleLocationRecenter, !activeGuidance, requestsUserLocation,
      let location = userLocation?.location, location.horizontalAccuracy >= 0
    else { return }
    displayIdleLocation(
      NavOSSCarPlayCoordinate(
        latitude: location.coordinate.latitude,
        longitude: location.coordinate.longitude
      ),
      animated: true
    )
  }

  func mapViewDidFailLoadingMap(_ mapView: MLNMapView, withError error: Error) {
    retryStyleLoad()
  }

  private func loadStyle(resetRetryCount: Bool) {
    if resetRetryCount {
      styleLoadRetryCount = 0
    }
    styleLoadWatchdog?.cancel()
    mapView.styleURL = URL(string: "https://tiles.openfreemap.org/styles/\(styleSlug)")
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

  private func follow(_ position: NavOSSCarPlayPosition, duration: TimeInterval) {
    let center = CLLocationCoordinate2D(
      latitude: position.coordinate.latitude,
      longitude: position.coordinate.longitude
    )
    let movementHeading = position.courseDegrees ?? mapView.direction
    let lookAheadCenter = coordinate(
      from: center,
      distanceMeters: navigationViewingDistance * 0.16,
      bearingDegrees: movementHeading
    )
    let camera = MLNMapCamera(
      lookingAtCenter: lookAheadCenter,
      acrossDistance: navigationViewingDistance,
      pitch: 38,
      heading: mapOrientation == .northUp ? 0 : movementHeading
    )
    mapView.setUserTrackingMode(.none, animated: false, completionHandler: nil)
    mapView.setCamera(
      camera,
      withDuration: duration,
      animationTimingFunction: CAMediaTimingFunction(name: .linear)
    )
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
    if displayLink == nil {
      let link = CADisplayLink(target: self, selector: #selector(renderPositionFrame))
      link.preferredFrameRateRange = CAFrameRateRange(
        minimum: 20,
        maximum: 30,
        preferred: 30
      )
      link.add(to: .main, forMode: .common)
      displayLink = link
    }
  }

  @objc private func renderPositionFrame() {
    guard activeGuidance, let target = latestPosition, let start = interpolationFromPosition else {
      displayLink?.invalidate()
      displayLink = nil
      return
    }
    let progress = min(
      1,
      max(0, (CACurrentMediaTime() - interpolationStartedAt) / interpolationDuration)
    )
    renderedPosition = NavOSSCarPlayPosition(
      coordinate: NavOSSCarPlayCoordinate(
        latitude: start.coordinate.latitude
          + (target.coordinate.latitude - start.coordinate.latitude) * progress,
        longitude: start.coordinate.longitude
          + (target.coordinate.longitude - start.coordinate.longitude) * progress
      ),
      courseDegrees: interpolatedCourse(
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
    if !presentsRouteOverview, let renderedPosition {
      follow(renderedPosition, duration: 0)
    }
    if progress >= 1 {
      displayLink?.invalidate()
      displayLink = nil
    }
  }

  private func interpolatedCourse(from: Double?, to: Double?, progress: Double) -> Double? {
    guard let target = to else { return from }
    guard let start = from else { return target }
    let delta = (target - start + 540).truncatingRemainder(dividingBy: 360) - 180
    return (start + delta * progress + 360).truncatingRemainder(dividingBy: 360)
  }

  private func updateSpeedDisplay(
    _ speedMetersPerSecond: Double?,
    speedLimitKph: Int?
  ) {
    guard activeGuidance, let speedMetersPerSecond else {
      speedLabel.isHidden = true
      return
    }
    let speedKph = Int((speedMetersPerSecond * 3.6).rounded())
    let isSpeeding = navOSSCarPlayIsSpeeding(
      speedKph: speedKph,
      speedLimitKph: speedLimitKph
    )
    speedLabel.backgroundColor =
      isSpeeding
      ? UIColor.systemRed.withAlphaComponent(0.88)
      : UIColor.secondarySystemBackground.withAlphaComponent(0.94)
    speedLabel.layer.borderColor =
      isSpeeding
      ? UIColor.systemRed.withAlphaComponent(1).cgColor
      : UIColor.black.withAlphaComponent(0.65).cgColor
    speedLabel.textColor = isSpeeding ? .white : .label
    speedLabel.text = "\(speedKph)\nkm/h"
    speedLabel.isHidden = false
  }

  private func updateSpeedLimitDisplay(_ speedLimitKph: Int?) {
    guard activeGuidance, let speedLimitKph else {
      speedLimitLabel.isHidden = true
      return
    }
    speedLimitLabel.text = "MAX\n\(speedLimitKph)"
    speedLimitLabel.isHidden = false
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
  }

  /// Colours and widths shared by the route line and its moving head, so the two sources render
  /// as one continuous line.
  /// Widths for both casings and both lines. Only depends on `activeGuidance`, so it runs on
  /// route/state changes rather than on the display link.
  private func applyRouteLineWidths(in style: MLNStyle) {
    let casingWidth = NSExpression(forConstantValue: activeGuidance ? 11 : 7)
    let lineWidth = NSExpression(forConstantValue: activeGuidance ? 7 : 4)
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
      layer.lineColor = NSExpression(
        forConstantValue: styleSlug == "dark"
          ? UIColor(red: 0.04, green: 0.08, blue: 0.08, alpha: 1)
          : UIColor.white
      )
      layer.lineOpacity = NSExpression(forConstantValue: 0.96)
      return layer
    }
    func line(_ identifier: String, _ source: MLNShapeSource) -> MLNLineStyleLayer {
      let layer = MLNLineStyleLayer(identifier: identifier, source: source)
      layer.lineCap = NSExpression(forConstantValue: "round")
      layer.lineJoin = NSExpression(forConstantValue: "round")
      layer.lineColor = NSExpression(
        forConstantValue: styleSlug == "dark"
          ? UIColor(red: 0.20, green: 0.78, blue: 0.55, alpha: 1)
          : UIColor(red: 0.11, green: 0.49, blue: 0.31, alpha: 1)
      )
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
      let alternateRoute = MLNLineStyleLayer(
        identifier: alternateRouteLayerIdentifier,
        source: source
      )
      alternateRoute.lineCap = NSExpression(forConstantValue: "round")
      alternateRoute.lineJoin = NSExpression(forConstantValue: "round")
      alternateRoute.lineColor = NSExpression(
        forConstantValue: UIColor(red: 0.51, green: 0.56, blue: 0.56, alpha: 1)
      )
      alternateRoute.lineOpacity = NSExpression(forConstantValue: 0.65)
      alternateRoute.lineWidth = NSExpression(forConstantValue: 4)
      style.addLayer(alternateRoute)
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
