import CoreLocation
import ExpoModulesCore
import UIKit

#if NAVOSS_GOOGLE_PLACES
import GooglePlacesSwift
import SwiftUI
#endif

final class NavOSSGooglePlaceRatingView: ExpoView {
  private var latitude: Double = 0
  private var longitude: Double = 0
  private var name = ""

  #if NAVOSS_GOOGLE_PLACES
  private var hostingController: UIHostingController<GooglePlaceDetailsContent>?
  private var renderedCoordinate: CLLocationCoordinate2D?
  private let stateLabel = UILabel()
  #endif

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
    #if NAVOSS_GOOGLE_PLACES
    stateLabel.font = .preferredFont(forTextStyle: .subheadline)
    stateLabel.textColor = .secondaryLabel
    stateLabel.adjustsFontForContentSizeCategory = true
    #endif
  }

  func setLatitude(_ value: Double) {
    latitude = value
  }

  func setLongitude(_ value: Double) {
    longitude = value
  }

  func setName(_ value: String) {
    name = value
  }

  func updateContent() {
    #if NAVOSS_GOOGLE_PLACES
    guard
      NavOSSGooglePlacesConfiguration.isAvailable,
      CLLocationCoordinate2DIsValid(coordinate)
    else {
      tearDownContent()
      return
    }
    if let renderedCoordinate,
      renderedCoordinate.latitude == coordinate.latitude,
      renderedCoordinate.longitude == coordinate.longitude {
      return
    }

    tearDownContent()

    let controller = UIHostingController(
      rootView: GooglePlaceDetailsContent(
        coordinate: coordinate,
        onResult: { [weak self] result in
          guard let self else { return }
          if self.matchesSelectedPlace(result) {
            self.hostingController?.view.alpha = 1
            self.stateLabel.removeFromSuperview()
          } else {
            self.showUnavailableState()
            self.detachHostingController()
          }
        }
      )
    )
    controller.view.backgroundColor = .clear
    controller.view.alpha = 0
    controller.view.frame = bounds
    controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    hostingController = controller
    renderedCoordinate = coordinate
    showLoadingState()
    attachContentIfPossible()
    #endif
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    #if NAVOSS_GOOGLE_PLACES
    if window == nil {
      tearDownContent()
    } else {
      attachContentIfPossible()
    }
    #endif
  }

  override func removeFromSuperview() {
    #if NAVOSS_GOOGLE_PLACES
    tearDownContent()
    #endif
    super.removeFromSuperview()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    #if NAVOSS_GOOGLE_PLACES
    hostingController?.view.frame = bounds
    stateLabel.frame = bounds
    #endif
  }

  private var coordinate: CLLocationCoordinate2D {
    CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
  }

  #if NAVOSS_GOOGLE_PLACES
  private func attachContentIfPossible() {
    guard
      window != nil,
      let controller = hostingController,
      controller.parent == nil,
      let parentController = nearestViewController()
    else {
      return
    }
    parentController.addChild(controller)
    addSubview(controller.view)
    controller.didMove(toParent: parentController)
    controller.view.frame = bounds
  }

  private func nearestViewController() -> UIViewController? {
    var responder: UIResponder? = self
    while let currentResponder = responder {
      if let viewController = currentResponder as? UIViewController {
        return viewController
      }
      responder = currentResponder.next
    }
    return nil
  }

  private func matchesSelectedPlace(_ result: PlaceDetailsResult) -> Bool {
    guard
      let place = result.place,
      let displayName = place.displayName,
      namesMatch(displayName, name)
    else {
      return false
    }
    let selectedLocation = CLLocation(latitude: latitude, longitude: longitude)
    let googleLocation = CLLocation(
      latitude: place.location.latitude,
      longitude: place.location.longitude
    )
    return selectedLocation.distance(from: googleLocation) <= 200
  }

  private func namesMatch(_ left: String, _ right: String) -> Bool {
    func normalize(_ value: String) -> String {
      let normalizedCharacters = value
        .folding(
          options: [.caseInsensitive, .diacriticInsensitive],
          locale: Locale(identifier: "en_CA")
        )
        .unicodeScalars
        .map { CharacterSet.alphanumerics.contains($0) ? Character($0) : " " }
      return String(normalizedCharacters)
        .split(separator: " ")
        .joined(separator: " ")
    }
    let normalizedLeft = normalize(left)
    let normalizedRight = normalize(right)
    guard !normalizedLeft.isEmpty, !normalizedRight.isEmpty else { return false }
    return normalizedLeft == normalizedRight
      || (min(normalizedLeft.count, normalizedRight.count) >= 5
        && (normalizedLeft.contains(normalizedRight) || normalizedRight.contains(normalizedLeft)))
  }

  private func showLoadingState() {
    stateLabel.text = "Loading Google photos and reviews"
    stateLabel.frame = bounds
    if stateLabel.superview == nil {
      addSubview(stateLabel)
    }
  }

  private func showUnavailableState() {
    stateLabel.text = "Google place details unavailable"
    stateLabel.frame = bounds
    if stateLabel.superview == nil {
      addSubview(stateLabel)
    }
  }

  private func detachHostingController() {
    guard let controller = hostingController else { return }
    controller.willMove(toParent: nil)
    controller.view.removeFromSuperview()
    controller.removeFromParent()
    hostingController = nil
  }

  private func tearDownContent() {
    detachHostingController()
    renderedCoordinate = nil
    stateLabel.removeFromSuperview()
  }
  #endif
}

#if NAVOSS_GOOGLE_PLACES
private struct GooglePlaceDetailsContent: View {
  @State private var query: PlaceDetailsQuery
  private let onResult: (PlaceDetailsResult) -> Void
  private let configuration = PlaceDetailsConfiguration(
    content: [.media(), .rating(), .reviews()],
    theme: PlacesMaterialTheme()
  )

  init(
    coordinate: CLLocationCoordinate2D,
    onResult: @escaping (PlaceDetailsResult) -> Void
  ) {
    _query = State(initialValue: PlaceDetailsQuery(identifier: .coordinate(coordinate)))
    self.onResult = onResult
  }

  var body: some View {
    GooglePlacesSwift.PlaceDetailsView(
      query: $query,
      configuration: configuration,
      placeDetailsCallback: onResult
    )
  }
}
#endif
