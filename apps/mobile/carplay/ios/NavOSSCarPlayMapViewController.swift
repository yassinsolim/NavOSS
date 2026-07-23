import MapLibre
internal import NavOSSNavigation
import UIKit

@MainActor
final class NavOSSCarPlayMapViewController: UIViewController,
  @preconcurrency MLNMapViewDelegate
{
  private let calgaryCenter = CLLocationCoordinate2D(latitude: 51.0447, longitude: -114.0719)
  private let routeCasingLayerIdentifier = "navoss-carplay-route-casing"
  private let routeLayerIdentifier = "navoss-carplay-route"
  private let routeSourceIdentifier = "navoss-carplay-route-source"
  private var activeGuidance = false
  private var routeCoordinates: [CLLocationCoordinate2D] = []
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
    mapView.setUserTrackingMode(.followWithCourse, animated: true, completionHandler: nil)
  }

  func display(route: [NavOSSCarPlayCoordinate], activeGuidance: Bool) {
    self.activeGuidance = activeGuidance
    routeCoordinates = route.map {
      CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude)
    }
    installRouteOverlayIfReady()
    if activeGuidance {
      recenter()
    } else {
      fitRoute(animated: true)
    }
  }

  func clearRoute() {
    activeGuidance = false
    routeCoordinates = []
    if let source = mapView.style?.source(withIdentifier: routeSourceIdentifier)
      as? MLNShapeSource
    {
      source.shape = nil
    }
  }

  func zoom(by delta: Double) {
    mapView.setZoomLevel(max(8, min(18, mapView.zoomLevel + delta)), animated: true)
  }

  func mapView(_ mapView: MLNMapView, didFinishLoading style: MLNStyle) {
    installRouteOverlayIfReady()
    if activeGuidance {
      recenter()
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
}
