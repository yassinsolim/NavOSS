import MapLibre
internal import NavOSSNavigation
import UIKit

@MainActor
final class NavOSSCarPlayMapViewController: UIViewController,
  @preconcurrency MLNMapViewDelegate
{
  private let calgaryCenter = CLLocationCoordinate2D(latitude: 51.0447, longitude: -114.0719)
  private let positionLayerIdentifier = "navoss-carplay-position"
  private let positionSourceIdentifier = "navoss-carplay-position-source"
  private let routeCasingLayerIdentifier = "navoss-carplay-route-casing"
  private let routeLayerIdentifier = "navoss-carplay-route"
  private let routeSourceIdentifier = "navoss-carplay-route-source"
  private var activeGuidance = false
  private var latestPosition: NavOSSCarPlayPosition?
  private var navigationViewingDistance = 850.0
  private var routeCoordinates: [CLLocationCoordinate2D] = []
  private var routeId: String?
  private(set) var mapView: MLNMapView!

  override func loadView() {
    let styleURL = URL(string: "https://tiles.openfreemap.org/styles/liberty")
    let mapView = MLNMapView(frame: .zero, styleURL: styleURL)
    mapView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    mapView.isPitchEnabled = false
    mapView.isRotateEnabled = false
    mapView.isScrollEnabled = false
    mapView.isZoomEnabled = false
    mapView.logoView.isHidden = true
    mapView.delegate = self
    mapView.showsUserLocation = true
    mapView.setCenter(calgaryCenter, zoomLevel: 10.5, animated: false)
    self.mapView = mapView
    view = mapView
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
    position: NavOSSCarPlayPosition? = nil
  ) {
    self.activeGuidance = activeGuidance
    latestPosition = position
    mapView.showsUserLocation = !activeGuidance
    if self.routeId != routeId {
      self.routeId = routeId
      routeCoordinates = route.map {
        CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude)
      }
      installRouteOverlayIfReady()
    }
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
    latestPosition = nil
    navigationViewingDistance = 850
    routeId = nil
    routeCoordinates = []
    mapView.showsUserLocation = true
    if let source = mapView.style?.source(withIdentifier: routeSourceIdentifier)
      as? MLNShapeSource
    {
      source.shape = nil
    }
    if let source = mapView.style?.source(withIdentifier: positionSourceIdentifier)
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
    installRouteOverlayIfReady()
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
    let camera = MLNMapCamera(
      lookingAtCenter: center,
      acrossDistance: navigationViewingDistance,
      pitch: 38,
      heading: position.courseDegrees ?? mapView.direction
    )
    mapView.setUserTrackingMode(.none, animated: false, completionHandler: nil)
    mapView.setCamera(
      camera,
      withDuration: duration,
      animationTimingFunction: CAMediaTimingFunction(name: .linear)
    )
  }

  private func installRouteOverlayIfReady() {
    guard routeCoordinates.count >= 2, let style = mapView.style else {
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

  private func installPositionOverlayIfReady() {
    guard activeGuidance, let latestPosition, let style = mapView.style else {
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

    if style.layer(withIdentifier: positionLayerIdentifier) == nil {
      let position = MLNCircleStyleLayer(identifier: positionLayerIdentifier, source: source)
      position.circleColor = NSExpression(
        forConstantValue: UIColor(red: 0.11, green: 0.49, blue: 0.31, alpha: 1)
      )
      position.circleRadius = NSExpression(forConstantValue: 10)
      position.circleStrokeColor = NSExpression(forConstantValue: UIColor.white)
      position.circleStrokeWidth = NSExpression(forConstantValue: 3)
      style.addLayer(position)
    }
  }
}
