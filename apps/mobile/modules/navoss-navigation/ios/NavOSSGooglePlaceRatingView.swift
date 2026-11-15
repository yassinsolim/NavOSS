import CoreLocation
import ExpoModulesCore
import UIKit

#if NAVOSS_GOOGLE_PLACES
import GooglePlacesSwift
import SwiftUI
#endif

/// Hosts Google's own Place Details component (Places UI Kit, Essentials tier) for the selected
/// place, in two steps:
///
/// 1. Resolve: a Places text search for the selected name, restricted to a box of
///    `NavOSSGooglePlaceMatch.maximumDistanceMeters` around the selected coordinate, asking for the
///    place ID only (the free Text Search Essentials IDs Only SKU). No result means Google does not
///    list this place: `noMatch`, and no NavOSS grant is spent.
/// 2. Load: once React has taken a NavOSS grant (`loadDetails`), Google's component loads that
///    place ID live; it is shown only if Google's place lies within the same distance.
///
/// States reported to React: `resolving`, `resolved`, `loading`, `matched`, `noMatch`, `offline`,
/// `unavailable`. No Google content leaves this view; the place ID is held in memory only.
final class NavOSSGooglePlaceRatingView: ExpoView {
  let onStateChange = EventDispatcher()

  private var latitude: Double = 0
  private var longitude: Double = 0
  private var name = ""
  private var loadDetails = false

  #if NAVOSS_GOOGLE_PLACES
  private var hostingController: UIHostingController<GooglePlaceDetailsContent>?
  private var renderedKey: String?
  private var resolvedPlaceID: String?
  private var resolveTask: Task<Void, Never>?
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

  func setLoadDetails(_ value: Bool) {
    loadDetails = value
  }

  func updateContent() {
    #if NAVOSS_GOOGLE_PLACES
    let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard
      NavOSSGooglePlacesConfiguration.isAvailable,
      !trimmedName.isEmpty,
      let bounds = NavOSSGooglePlaceMatch.searchBounds(latitude: latitude, longitude: longitude)
    else {
      tearDownContent()
      report("unavailable")
      return
    }
    let key = "\(trimmedName)\u{0}\(latitude)\u{0}\(longitude)"
    if renderedKey != key {
      tearDownContent()
      renderedKey = key
      report("resolving")
      resolveTask = Task { @MainActor [weak self] in
        let state = await Self.resolvePlaceID(name: trimmedName, bounds: bounds)
        guard let self, !Task.isCancelled, self.renderedKey == key else { return }
        switch state {
        case let .resolved(placeID):
          self.resolvedPlaceID = placeID
          self.report("resolved")
          self.loadDetailsIfReady()
        case let .failed(reported):
          self.report(reported)
        }
      }
      return
    }
    loadDetailsIfReady()
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

  private func report(_ state: String) {
    onStateChange(["state": state])
  }

  #if NAVOSS_GOOGLE_PLACES
  private enum ResolveState {
    case resolved(String)
    case failed(String)
  }

  /// Exactly the place ID: the field list that bills as Text Search Essentials (IDs Only). Any
  /// other property moves every search to a paid SKU, so the request is checked before it is sent.
  static let placeIDSearchProperties: [PlaceProperty] = [.placeID]

  @MainActor
  private static func resolvePlaceID(
    name: String,
    bounds: NavOSSGooglePlaceMatch.Bounds
  ) async -> ResolveState {
    guard
      let restriction = RectangularCoordinateRegion(
        northEast: CLLocationCoordinate2D(latitude: bounds.north, longitude: bounds.east),
        southWest: CLLocationCoordinate2D(latitude: bounds.south, longitude: bounds.west)
      )
    else {
      return .failed("noMatch")
    }
    let request = SearchByTextRequest(
      textQuery: name,
      placeProperties: placeIDSearchProperties,
      locationRestriction: restriction,
      maxResultCount: 1,
      isOpenNow: false,
      rankPreference: .relevance
    )
    precondition(
      request.placeProperties == [.placeID],
      "The Google place search must request the place ID only (Text Search Essentials IDs Only)."
    )
    switch await PlacesClient.shared.responseForSearchByText(with: request) {
    case let .success(response):
      guard let placeID = response.places?.first?.placeID, !placeID.isEmpty else {
        return .failed("noMatch")
      }
      return .resolved(placeID)
    case let .failure(error):
      return .failed(state(for: error))
    }
  }

  private func loadDetailsIfReady() {
    guard loadDetails, hostingController == nil, let placeID = resolvedPlaceID, let key = renderedKey
    else {
      return
    }
    let selectedLatitude = latitude
    let selectedLongitude = longitude
    let controller = UIHostingController(
      rootView: GooglePlaceDetailsContent(
        placeID: placeID,
        onResult: { [weak self] result in
          guard let self, self.renderedKey == key else { return }
          let state = Self.state(
            for: result,
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
    // Hidden until Google's place is confirmed near the selection.
    controller.view.alpha = 0
    controller.view.accessibilityElementsHidden = true
    controller.view.frame = bounds
    controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    hostingController = controller
    report("loading")
    attachContentIfPossible()
  }

  private static func state(
    for result: PlaceDetailsResult,
    selectedLatitude: Double,
    selectedLongitude: Double
  ) -> String {
    if let place = result.place {
      return NavOSSGooglePlaceMatch.isNearby(
        selectedLatitude: selectedLatitude,
        selectedLongitude: selectedLongitude,
        candidateLatitude: place.location.latitude,
        candidateLongitude: place.location.longitude
      ) ? "matched" : "noMatch"
    }
    switch result.error {
    case let error as PlacesError:
      return state(for: error)
    case let error as URLError where error.code == .notConnectedToInternet
      || error.code == .networkConnectionLost || error.code == .timedOut:
      return "offline"
    default:
      return "noMatch"
    }
  }

  private static func state(for error: PlacesError) -> String {
    switch error {
    case .network:
      return "offline"
    // A rejected key surfaces as `.server("Authentication failed…")` (seen with a placeholder key
    // on the simulator), so server and internal failures are "temporarily unavailable".
    case .keyInvalid, .keyExpired, .usageLimitExceeded, .rateLimitExceeded,
      .deviceRateLimitExceeded, .accessNotConfigured, .incorrectBundleIdentifier, .server,
      .internal:
      return "unavailable"
    case .location, .invalidRequest:
      return "noMatch"
    @unknown default:
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
    resolveTask?.cancel()
    resolveTask = nil
    detachHostingController()
    resolvedPlaceID = nil
    renderedKey = nil
  }
  #endif
}

#if NAVOSS_GOOGLE_PLACES
/// Every element the Essentials `PlaceDetailsView` offers. Places UI Kit bills per component
/// load, not per element, so the full list costs the same as any subset. The Pro
/// `AdvancedPlaceDetailsView` adds only button and review/media filter configuration, which
/// NavOSS does not need.
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

  init(placeID: String, onResult: @escaping (PlaceDetailsResult) -> Void) {
    _query = State(initialValue: PlaceDetailsQuery(identifier: .placeID(placeID)))
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
