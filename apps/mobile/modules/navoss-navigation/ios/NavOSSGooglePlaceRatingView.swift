import CoreLocation
import ExpoModulesCore
import UIKit

#if NAVOSS_GOOGLE_PLACES
import GooglePlacesSwift
import SwiftUI
#endif

/// Hosts Google's own Places UI Kit components (Essentials tier) for the selected place. React
/// moves `phase` forward only after it holds a NavOSS grant for the next component load:
///
/// - `nearest`: Place Details queried by the selected coordinate. Google reports the place it chose
///   with no name, so the panel is shown only if that place is within
///   `NavOSSGooglePlaceMatch.maximumDistanceMeters`.
/// - `search`: after the driver asks to find the place, Place Search lists Google's results for the
///   selected name near the coordinate; the driver's pick is reported as `picked`.
/// - `picked`: Place Details for the place the driver picked, shown without a distance check.
///
/// States reported to React: `loading`, `matched`, `noMatch`, `searchReady`, `searchEmpty`,
/// `picked`, `offline`, `unavailable`. No Google content leaves this view; the picked place ID is
/// held in memory only.
final class NavOSSGooglePlaceRatingView: ExpoView {
  let onStateChange = EventDispatcher()

  private var latitude: Double = 0
  private var longitude: Double = 0
  private var name = ""
  private var phase = "idle"

  #if NAVOSS_GOOGLE_PLACES
  private var hostingController: UIHostingController<AnyView>?
  private var renderedKey: String?
  private var pickedPlaceID: String?
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

  func setPhase(_ value: String) {
    phase = value
  }

  func updateContent() {
    #if NAVOSS_GOOGLE_PLACES
    guard NavOSSGooglePlacesConfiguration.isAvailable, CLLocationCoordinate2DIsValid(coordinate)
    else {
      tearDownContent()
      report("unavailable")
      return
    }
    let place = "\(name)\u{0}\(latitude)\u{0}\(longitude)"
    if renderedKey?.hasPrefix(place) == false {
      pickedPlaceID = nil
    }
    let key = "\(place)\u{0}\(phase)"
    guard renderedKey != key else { return }
    detachHostingController()
    renderedKey = key
    switch phase {
    case "nearest":
      show(details(identifier: .coordinate(coordinate), checkDistance: true, key: key))
      report("loading")
    case "search":
      show(search(key: key))
      report("loading")
    case "picked":
      guard let placeID = pickedPlaceID else {
        report("noMatch")
        return
      }
      show(details(identifier: .placeID(placeID), checkDistance: false, key: key))
      report("loading")
    default:
      return
    }
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
  private func details(identifier: PlaceIdentifier, checkDistance: Bool, key: String) -> AnyView {
    let selectedLatitude = latitude
    let selectedLongitude = longitude
    return AnyView(
      GooglePlaceDetailsContent(
        identifier: identifier,
        onResult: { [weak self] result in
          guard let self, self.renderedKey == key else { return }
          let state: String
          if let place = result.place {
            state =
              !checkDistance
                || NavOSSGooglePlaceMatch.isNearby(
                  selectedLatitude: selectedLatitude,
                  selectedLongitude: selectedLongitude,
                  candidateLatitude: place.location.latitude,
                  candidateLongitude: place.location.longitude
                ) ? "matched" : "noMatch"
          } else {
            state = Self.state(for: result.error)
          }
          if state == "matched" {
            self.reveal()
          } else {
            self.detachHostingController()
          }
          self.report(state)
        }
      )
    )
  }

  private func search(key: String) -> AnyView {
    AnyView(
      GooglePlaceSearchContent(
        name: name,
        coordinate: coordinate,
        onLoad: { [weak self] places in
          guard let self, self.renderedKey == key else { return }
          if places.isEmpty {
            self.detachHostingController()
            self.report("searchEmpty")
          } else {
            self.reveal()
            self.report("searchReady")
          }
        },
        onError: { [weak self] error in
          guard let self, self.renderedKey == key else { return }
          self.detachHostingController()
          self.report(Self.state(for: error))
        },
        onSelect: { [weak self] place in
          guard let self, self.renderedKey == key, let placeID = place.placeID else { return }
          self.pickedPlaceID = placeID
          self.report("picked")
        }
      )
    )
  }

  private static func state(for error: (any Error)?) -> String {
    switch error {
    case let error as PlacesError:
      switch error {
      case .network:
        return "offline"
      // A rejected key surfaces as `.server("Authentication failed…")` (seen with a placeholder
      // key on the simulator), so server and internal failures are "temporarily unavailable".
      case .keyInvalid, .keyExpired, .usageLimitExceeded, .rateLimitExceeded,
        .deviceRateLimitExceeded, .accessNotConfigured, .incorrectBundleIdentifier, .server,
        .internal:
        return "unavailable"
      case .location, .invalidRequest:
        return "noMatch"
      @unknown default:
        return "noMatch"
      }
    case let error as URLError where error.code == .notConnectedToInternet
      || error.code == .networkConnectionLost || error.code == .timedOut:
      return "offline"
    default:
      return "noMatch"
    }
  }

  private func show(_ view: AnyView) {
    let controller = UIHostingController(rootView: view)
    controller.view.backgroundColor = .clear
    // Hidden until Google's content is confirmed for this place.
    controller.view.alpha = 0
    controller.view.accessibilityElementsHidden = true
    controller.view.frame = bounds
    controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    hostingController = controller
    attachContentIfPossible()
  }

  private func reveal() {
    hostingController?.view.alpha = 1
    hostingController?.view.accessibilityElementsHidden = false
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
    pickedPlaceID = nil
  }
  #endif
}

#if NAVOSS_GOOGLE_PLACES
/// Every element the Essentials `PlaceDetailsView` offers. Places UI Kit bills per component
/// load, not per element. Google's place name is always shown in the panel's header, so the driver
/// can see which listing Google chose.
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

  init(identifier: PlaceIdentifier, onResult: @escaping (PlaceDetailsResult) -> Void) {
    _query = State(initialValue: PlaceDetailsQuery(identifier: identifier))
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

/// Google's Place Search component listing results for the selected name near its coordinate,
/// shown only after the driver asks for it. Selecting a result reports Google's place ID.
private struct GooglePlaceSearchContent: View {
  /// How far around the selected point Google's results are biased.
  static let biasRadiusMeters: CLLocationDistance = 500

  @State private var request: PlaceSearchViewRequest
  private let onLoad: ([Place]) -> Void
  private let onError: (PlacesError) -> Void
  private let onSelect: (Place) -> Void
  private let configuration = PlaceSearchConfiguration(
    content: [.address(), .rating(), .type(), .openNowStatus()],
    theme: PlacesMaterialTheme(),
    selectable: true
  )

  init(
    name: String,
    coordinate: CLLocationCoordinate2D,
    onLoad: @escaping ([Place]) -> Void,
    onError: @escaping (PlacesError) -> Void,
    onSelect: @escaping (Place) -> Void
  ) {
    _request = State(
      initialValue: .searchByText(
        SearchByTextRequest(
          textQuery: name,
          placeProperties: [.all],
          locationBias: CircularCoordinateRegion(center: coordinate, radius: Self.biasRadiusMeters),
          maxResultCount: 5,
          isOpenNow: false,
          rankPreference: .distance
        )
      )
    )
    self.onLoad = onLoad
    self.onError = onError
    self.onSelect = onSelect
  }

  var body: some View {
    GooglePlacesSwift.PlaceSearchView(request: $request, configuration: configuration)
      .onLoad(onLoad)
      .onRequestError(onError)
      .onPlaceSelected(onSelect)
  }
}
#endif
