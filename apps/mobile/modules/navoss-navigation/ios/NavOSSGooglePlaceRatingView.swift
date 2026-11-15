import CoreLocation
import ExpoModulesCore
import UIKit

#if NAVOSS_GOOGLE_PLACES
import GooglePlacesSwift
import SwiftUI
#endif

/// Hosts Google's own Place Details component (Places UI Kit, Essentials tier) for the selected
/// place. Google renders, attributes and fetches the content on every open; NavOSS only decides
/// whether the place Google found is the selected one and reports one of these states to React:
/// `loading`, `matched`, `noMatch`, `offline`, `unavailable`. No Google content leaves this view.
final class NavOSSGooglePlaceRatingView: ExpoView {
  let onStateChange = EventDispatcher()

  private var latitude: Double = 0
  private var longitude: Double = 0
  private var name = ""

  #if NAVOSS_GOOGLE_PLACES
  private var hostingController: UIHostingController<GooglePlaceDetailsContent>?
  private var renderedKey: String?
  #endif

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .clear
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
      report("unavailable")
      return
    }
    let key = "\(name)\u{0}\(latitude)\u{0}\(longitude)"
    if renderedKey == key {
      return
    }

    tearDownContent()

    let selectedName = name
    let selectedLatitude = latitude
    let selectedLongitude = longitude
    let controller = UIHostingController(
      rootView: GooglePlaceDetailsContent(
        coordinate: coordinate,
        onResult: { [weak self] result in
          guard let self, self.renderedKey == key else { return }
          let state = Self.state(
            for: result,
            selectedName: selectedName,
            selectedLatitude: selectedLatitude,
            selectedLongitude: selectedLongitude
          )
          if state == "matched" {
            self.hostingController?.view.alpha = 1
            self.hostingController?.view.accessibilityElementsHidden = false
          } else {
            self.detachHostingController()
          }
          self.report(state)
        }
      )
    )
    controller.view.backgroundColor = .clear
    // Hidden until the gate accepts Google's place, so a different business never flashes up.
    controller.view.alpha = 0
    controller.view.accessibilityElementsHidden = true
    controller.view.frame = bounds
    controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    hostingController = controller
    renderedKey = key
    report("loading")
    attachContentIfPossible()
    #else
    report("unavailable")
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
    #endif
  }

  private var coordinate: CLLocationCoordinate2D {
    CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
  }

  private func report(_ state: String) {
    onStateChange(["state": state])
  }

  #if NAVOSS_GOOGLE_PLACES
  private static func state(
    for result: PlaceDetailsResult,
    selectedName: String,
    selectedLatitude: Double,
    selectedLongitude: Double
  ) -> String {
    if let place = result.place {
      guard let displayName = place.displayName else { return "noMatch" }
      return NavOSSGooglePlaceMatch.matches(
        selectedName: selectedName,
        selectedLatitude: selectedLatitude,
        selectedLongitude: selectedLongitude,
        candidateName: displayName,
        candidateLatitude: place.location.latitude,
        candidateLongitude: place.location.longitude
      ) ? "matched" : "noMatch"
    }
    switch result.error {
    case let error as PlacesError:
      switch error {
      case .network:
        return "offline"
      case .keyInvalid, .keyExpired, .usageLimitExceeded, .rateLimitExceeded,
        .deviceRateLimitExceeded, .accessNotConfigured, .incorrectBundleIdentifier:
        return "unavailable"
      case .server, .internal, .location, .invalidRequest:
        return "noMatch"
      @unknown default:
        return "noMatch"
      }
    case let error as URLError where error.code == .notConnectedToInternet
      || error.code == .networkConnectionLost || error.code == .timedOut:
      return "offline"
    default:
      // No place at this coordinate, or nothing Google could say about it.
      return "noMatch"
    }
  }

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

  private func detachHostingController() {
    guard let controller = hostingController else { return }
    controller.willMove(toParent: nil)
    controller.view.removeFromSuperview()
    controller.removeFromParent()
    hostingController = nil
  }

  private func tearDownContent() {
    detachHostingController()
    renderedKey = nil
  }
  #endif
}

#if NAVOSS_GOOGLE_PLACES
/// Every element the Essentials `PlaceDetailsView` offers. Places UI Kit bills per component
/// load, not per element, so the full list costs the same as the earlier media, rating and
/// reviews subset. The Pro `AdvancedPlaceDetailsView` adds only button and review/media filter
/// configuration, which NavOSS does not need.
let navOSSGooglePlaceDetailsContent: Set<PlaceDetailsContent> = [
  .media(),
  .address(),
  .rating(),
  .type(),
  .price(),
  .accessibleEntranceIcon(),
  .openNowStatus(),
  .openingHours(),
  .summary(),
  .website(),
  .phoneNumber(),
  .typeSpecificHighlights(),
  .reviews(),
  .plusCode(),
  .featureList(),
]

private struct GooglePlaceDetailsContent: View {
  @State private var query: PlaceDetailsQuery
  private let onResult: (PlaceDetailsResult) -> Void
  private let configuration = PlaceDetailsConfiguration(
    content: navOSSGooglePlaceDetailsContent,
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
