import MapLibre
import UIKit

@MainActor
final class NavOSSCarPlayMapViewController: UIViewController {
  private let calgaryCenter = CLLocationCoordinate2D(latitude: 51.0447, longitude: -114.0719)
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
    mapView.setCenter(calgaryCenter, zoomLevel: 10.5, animated: false)
    self.mapView = mapView
    view = mapView
  }

  func recenter() {
    mapView.setUserTrackingMode(.followWithCourse, animated: true, completionHandler: nil)
  }

  func zoom(by delta: Double) {
    mapView.setZoomLevel(max(8, min(18, mapView.zoomLevel + delta)), animated: true)
  }
}