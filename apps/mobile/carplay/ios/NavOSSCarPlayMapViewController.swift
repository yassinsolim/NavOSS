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
  private let carImageIdentifier = "navoss-carplay-vehicle-car"
  private let positionImageIdentifier = "navoss-carplay-vehicle-arrow"
  private let positionLayerIdentifier = "navoss-carplay-position"
  private let positionSourceIdentifier = "navoss-carplay-position-source"
  private let routeCasingLayerIdentifier = "navoss-carplay-route-casing"
  private let routeLayerIdentifier = "navoss-carplay-route"
  private let routeSourceIdentifier = "navoss-carplay-route-source"
  private var activeGuidance = false
  private var appearance = NavOSSCarPlayAppearance.automatic
  private var displayLink: CADisplayLink?
  private var interpolationFromPosition: NavOSSCarPlayPosition?
  private var interpolationStartedAt: CFTimeInterval = 0
  private let interpolationDuration: CFTimeInterval = 0.9
  private var latestDestination: NavOSSCarPlayCoordinate?
  private var latestOrigin: NavOSSCarPlayCoordinate?
  private var latestPosition: NavOSSCarPlayPosition?
  private var mapOrientation = NavOSSCarPlayMapOrientation.headingUp
  private var needsIdleLocationRecenter = true
  private var renderedPosition: NavOSSCarPlayPosition?
  private var navigationViewingDistance = 850.0
  private var presentsRouteOverview = false
  private var guidanceHiddenLayerIdentifiers: Set<String> = []
  private var lastLaidOutMapSize = CGSize.zero
  private var routeFitGeneration: UInt64 = 0
  private var alternateRouteCoordinates: [CLLocationCoordinate2D] = []
  private var routeCoordinates: [CLLocationCoordinate2D] = []
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
    displayLink?.invalidate()
    displayLink = nil
    speedLabel.isHidden = true
    speedLimitLabel.isHidden = true
    navigationViewingDistance = 850
    presentsRouteOverview = false
    routeId = nil
    alternateRouteCoordinates = []
    routeCoordinates = []
    mapView.showsUserLocation = requestsUserLocation
    if let source = mapView.style?.source(withIdentifier: routeSourceIdentifier)
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
    interpolationStartedAt = CACurrentMediaTime()
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
      speedMetersPerSecond: target.speedMetersPerSecond
    )
    if let renderedPosition, routeCoordinates.count >= 2 {
      routeCoordinates[0] = CLLocationCoordinate2D(
        latitude: renderedPosition.coordinate.latitude,
        longitude: renderedPosition.coordinate.longitude
      )
      installRouteOverlayIfReady()
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
      return
    }
    let polyline = routeCoordinates.withUnsafeMutableBufferPointer { coordinates in
      MLNPolylineFeature(coordinates: coordinates.baseAddress!, count: UInt(coordinates.count))
    }
    let source: MLNShapeSource
    if let existingSource = style.source(withIdentifier: routeSourceIdentifier)
      as? MLNShapeSource
    {
      source = existingSource
      source.shape = polyline
    } else {
      source = MLNShapeSource(identifier: routeSourceIdentifier, shape: polyline, options: nil)
      style.addSource(source)
    }

    if style.layer(withIdentifier: routeCasingLayerIdentifier) == nil {
      let casing = MLNLineStyleLayer(identifier: routeCasingLayerIdentifier, source: source)
      casing.lineCap = NSExpression(forConstantValue: "round")
      casing.lineJoin = NSExpression(forConstantValue: "round")
      casing.lineColor = NSExpression(
        forConstantValue: styleSlug == "dark"
          ? UIColor(red: 0.04, green: 0.08, blue: 0.08, alpha: 1)
          : UIColor.white
      )
      casing.lineOpacity = NSExpression(forConstantValue: 0.96)
      style.addLayer(casing)
    }
    if style.layer(withIdentifier: routeLayerIdentifier) == nil {
      let route = MLNLineStyleLayer(identifier: routeLayerIdentifier, source: source)
      route.lineCap = NSExpression(forConstantValue: "round")
      route.lineJoin = NSExpression(forConstantValue: "round")
      route.lineColor = NSExpression(
        forConstantValue: styleSlug == "dark"
          ? UIColor(red: 0.20, green: 0.78, blue: 0.55, alpha: 1)
          : UIColor(red: 0.11, green: 0.49, blue: 0.31, alpha: 1)
      )
      style.addLayer(route)
    }
    (style.layer(withIdentifier: routeCasingLayerIdentifier) as? MLNLineStyleLayer)?.lineWidth =
      NSExpression(forConstantValue: activeGuidance ? 11 : 7)
    (style.layer(withIdentifier: routeLayerIdentifier) as? MLNLineStyleLayer)?.lineWidth =
      NSExpression(forConstantValue: activeGuidance ? 7 : 4)
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
      style.addLayer(position)
    }
    position.iconImageName = NSExpression(
      forConstantValue: vehicleMarker == .car ? carImageIdentifier : positionImageIdentifier
    )
    position.iconScale = NSExpression(forConstantValue: vehicleMarker == .car ? 0.82 : 0.72)
    position.iconRotation = NSExpression(forConstantValue: latestPosition.courseDegrees ?? 0)
    bringPositionLayerToFront(position, in: style)
  }

  private func bringPositionLayerToFront(
    _ positionLayer: MLNSymbolStyleLayer,
    in style: MLNStyle
  ) {
    guard style.layers.last?.identifier != positionLayerIdentifier else { return }
    style.removeLayer(positionLayer)
    style.addLayer(positionLayer)
  }

  private func carMarkerImage() -> UIImage {
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: 64, height: 64))
    return renderer.image { context in
      let graphics = context.cgContext
      graphics.saveGState()
      graphics.setShadow(offset: CGSize(width: 0, height: 4), blur: 5, color: UIColor.black.cgColor)
      UIColor.black.withAlphaComponent(0.28).setFill()
      UIBezierPath(ovalIn: CGRect(x: 16, y: 47, width: 32, height: 10)).fill()
      graphics.restoreGState()

      UIColor(red: 0.04, green: 0.11, blue: 0.16, alpha: 0.9).setFill()
      UIBezierPath(roundedRect: CGRect(x: 12, y: 17, width: 8, height: 29), cornerRadius: 4).fill()
      UIBezierPath(roundedRect: CGRect(x: 44, y: 17, width: 8, height: 29), cornerRadius: 4).fill()

      let body = UIBezierPath(
        roundedRect: CGRect(x: 17, y: 5, width: 30, height: 51),
        cornerRadius: 12
      )
      graphics.saveGState()
      body.addClip()
      let colors =
        [
          UIColor(red: 0.45, green: 0.93, blue: 0.98, alpha: 1).cgColor,
          UIColor(red: 0.03, green: 0.48, blue: 0.65, alpha: 1).cgColor,
          UIColor(red: 0.01, green: 0.19, blue: 0.31, alpha: 1).cgColor,
        ] as CFArray
      let locations: [CGFloat] = [0, 0.48, 1]
      if let gradient = CGGradient(
        colorsSpace: CGColorSpaceCreateDeviceRGB(),
        colors: colors,
        locations: locations
      ) {
        graphics.drawLinearGradient(
          gradient,
          start: CGPoint(x: 18, y: 5),
          end: CGPoint(x: 46, y: 56),
          options: []
        )
      }
      graphics.restoreGState()

      UIColor.white.withAlphaComponent(0.24).setStroke()
      body.lineWidth = 1.5
      body.stroke()

      let windshield = UIBezierPath()
      windshield.move(to: CGPoint(x: 23, y: 18))
      windshield.addLine(to: CGPoint(x: 41, y: 18))
      windshield.addLine(to: CGPoint(x: 38, y: 31))
      windshield.addLine(to: CGPoint(x: 26, y: 31))
      windshield.close()
      UIColor(red: 0.03, green: 0.12, blue: 0.2, alpha: 0.92).setFill()
      windshield.fill()
      UIColor.white.withAlphaComponent(0.28).setStroke()
      windshield.lineWidth = 1
      windshield.stroke()

      UIColor(red: 0.04, green: 0.14, blue: 0.22, alpha: 0.9).setFill()
      UIBezierPath(roundedRect: CGRect(x: 24, y: 36, width: 16, height: 10), cornerRadius: 4).fill()
      UIColor.white.withAlphaComponent(0.7).setFill()
      UIBezierPath(roundedRect: CGRect(x: 21, y: 8, width: 6, height: 3), cornerRadius: 1.5).fill()
      UIBezierPath(roundedRect: CGRect(x: 37, y: 8, width: 6, height: 3), cornerRadius: 1.5).fill()
      UIColor.red.withAlphaComponent(0.88).setFill()
      UIBezierPath(roundedRect: CGRect(x: 21, y: 50, width: 6, height: 3), cornerRadius: 1.5).fill()
      UIBezierPath(roundedRect: CGRect(x: 37, y: 50, width: 6, height: 3), cornerRadius: 1.5).fill()
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
