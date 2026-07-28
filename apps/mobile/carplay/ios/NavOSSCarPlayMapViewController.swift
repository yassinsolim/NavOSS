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
  private let alternateRouteLayerIdentifier = "navoss-carplay-alternate-route"
  private let alternateRouteSourceIdentifier = "navoss-carplay-alternate-route-source"
  private let positionImageIdentifier = "navoss-carplay-vehicle-arrow"
  private let positionLayerIdentifier = "navoss-carplay-position"
  private let positionSourceIdentifier = "navoss-carplay-position-source"
  private let routeCasingLayerIdentifier = "navoss-carplay-route-casing"
  private let routeLayerIdentifier = "navoss-carplay-route"
  private let routeSourceIdentifier = "navoss-carplay-route-source"
  private var activeGuidance = false
  private var latestDestination: NavOSSCarPlayCoordinate?
  private var latestPosition: NavOSSCarPlayPosition?
  private var navigationViewingDistance = 850.0
  private var alternateRouteCoordinates: [CLLocationCoordinate2D] = []
  private var routeCoordinates: [CLLocationCoordinate2D] = []
  private var routeId: String?
  private var styleSlug = "liberty"
  private(set) var mapView: MLNMapView!
  var onStyleLoaded: (() -> Void)?
  var requestsUserLocation = true

  override func loadView() {
    styleSlug = traitCollection.userInterfaceStyle == .dark ? "dark" : "liberty"
    let styleURL = URL(string: "https://tiles.openfreemap.org/styles/\(styleSlug)")
    let mapView = MLNMapView(frame: .zero, styleURL: styleURL)
    mapView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    mapView.isPitchEnabled = false
    mapView.isRotateEnabled = false
    mapView.isScrollEnabled = false
    mapView.isZoomEnabled = false
    mapView.logoView.isHidden = true
    mapView.delegate = self
    mapView.showsUserLocation = requestsUserLocation
    mapView.setCenter(calgaryCenter, zoomLevel: 10.5, animated: false)
    self.mapView = mapView
    view = mapView
  }

  override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    super.traitCollectionDidChange(previousTraitCollection)
    guard traitCollection.hasDifferentColorAppearance(comparedTo: previousTraitCollection) else {
      return
    }
    let nextStyleSlug = traitCollection.userInterfaceStyle == .dark ? "dark" : "liberty"
    guard nextStyleSlug != styleSlug else {
      return
    }
    styleSlug = nextStyleSlug
    mapView.styleURL = URL(string: "https://tiles.openfreemap.org/styles/\(nextStyleSlug)")
  }

  func recenter() {
    guard let latestPosition else {
      if activeGuidance {
        fitRoute(animated: true)
      } else {
        mapView.setUserTrackingMode(.followWithCourse, animated: true, completionHandler: nil)
      }
      return
    }
    follow(latestPosition, duration: 0.35)
  }

  func display(
    route: [NavOSSCarPlayCoordinate],
    routeId: String,
    activeGuidance: Bool,
    position: NavOSSCarPlayPosition? = nil,
    routeProgress: Double = 0,
    alternateRoute: [NavOSSCarPlayCoordinate]? = nil
  ) {
    self.activeGuidance = activeGuidance
    latestDestination = route.last
    latestPosition = position
    mapView.showsUserLocation = requestsUserLocation && !activeGuidance
    self.routeId = routeId
    let displayedRoute =
      activeGuidance
      ? navOSSRemainingRouteGeometry(
        route,
        routeProgress: routeProgress,
        matchedCoordinate: position?.courseDegrees == nil ? nil : position?.coordinate
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
    installDestinationOverlayIfReady()
    installPositionOverlayIfReady()
    if activeGuidance, let position {
      follow(position, duration: 0.35)
    } else if activeGuidance {
      fitRoute(animated: true)
    } else if !activeGuidance {
      fitRoute(animated: true)
    }
  }

  func clearRoute() {
    activeGuidance = false
    latestDestination = nil
    latestPosition = nil
    navigationViewingDistance = 850
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
    recenter()
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
    installAlternateRouteOverlayIfReady()
    installRouteOverlayIfReady()
    installDestinationOverlayIfReady()
    installPositionOverlayIfReady()
    if activeGuidance {
      if latestPosition != nil {
        recenter()
      } else {
        fitRoute(animated: false)
      }
    } else {
      fitRoute(animated: false)
    }
    onStyleLoaded?()
  }

  private func fitRoute(animated: Bool) {
    guard routeCoordinates.count >= 2 else {
      return
    }
    routeCoordinates.withUnsafeBufferPointer { coordinates in
      guard let baseAddress = coordinates.baseAddress else {
        return
      }
      mapView.setVisibleCoordinates(
        baseAddress,
        count: UInt(coordinates.count),
        edgePadding: UIEdgeInsets(top: 56, left: 48, bottom: 96, right: 48),
        animated: animated
      )
    }
  }

  private func follow(_ position: NavOSSCarPlayPosition, duration: TimeInterval) {
    let center = CLLocationCoordinate2D(
      latitude: position.coordinate.latitude,
      longitude: position.coordinate.longitude
    )
    let heading = position.courseDegrees ?? mapView.direction
    let lookAheadCenter = coordinate(
      from: center,
      distanceMeters: navigationViewingDistance * 0.16,
      bearingDegrees: heading
    )
    let camera = MLNMapCamera(
      lookingAtCenter: lookAheadCenter,
      acrossDistance: navigationViewingDistance,
      pitch: 38,
      heading: heading
    )
    mapView.setUserTrackingMode(.none, animated: false, completionHandler: nil)
    mapView.setCamera(
      camera,
      withDuration: duration,
      animationTimingFunction: CAMediaTimingFunction(name: .linear)
    )
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
      casing.lineColor = NSExpression(forConstantValue: UIColor.white)
      casing.lineOpacity = NSExpression(forConstantValue: 0.96)
      casing.lineWidth = NSExpression(forConstantValue: 11)
      style.addLayer(casing)
    }
    if style.layer(withIdentifier: routeLayerIdentifier) == nil {
      let route = MLNLineStyleLayer(identifier: routeLayerIdentifier, source: source)
      route.lineCap = NSExpression(forConstantValue: "round")
      route.lineJoin = NSExpression(forConstantValue: "round")
      route.lineColor = NSExpression(
        forConstantValue: UIColor(red: 0.11, green: 0.49, blue: 0.31, alpha: 1))
      route.lineWidth = NSExpression(forConstantValue: 7)
      style.addLayer(route)
    }
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
        forConstantValue: UIColor(red: 0.93, green: 0.33, blue: 0.26, alpha: 1)
      )
      destinationLayer.circleRadius = NSExpression(forConstantValue: 8)
      destinationLayer.circleStrokeColor = NSExpression(forConstantValue: UIColor.white)
      destinationLayer.circleStrokeWidth = NSExpression(forConstantValue: 3)
      style.addLayer(destinationLayer)
    }
  }

  private func installPositionOverlayIfReady() {
    guard let style = mapView.style else {
      return
    }
    guard activeGuidance, let latestPosition else {
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

    let position: MLNSymbolStyleLayer
    if let existingLayer = style.layer(withIdentifier: positionLayerIdentifier)
      as? MLNSymbolStyleLayer
    {
      position = existingLayer
    } else {
      position = MLNSymbolStyleLayer(identifier: positionLayerIdentifier, source: source)
      position.iconImageName = NSExpression(forConstantValue: positionImageIdentifier)
      position.iconScale = NSExpression(forConstantValue: 0.72)
      position.iconAllowsOverlap = NSExpression(forConstantValue: true)
      position.iconIgnoresPlacement = NSExpression(forConstantValue: true)
      position.iconRotationAlignment = NSExpression(forConstantValue: "map")
      style.addLayer(position)
    }
    let mapRelativeCourse =
      latestPosition.courseDegrees.map {
        (($0 - mapView.direction).truncatingRemainder(dividingBy: 360) + 360)
          .truncatingRemainder(dividingBy: 360)
      } ?? 0
    position.iconRotation = NSExpression(forConstantValue: mapRelativeCourse)
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
