import CarPlay
import MapKit
internal import NavOSSNavigation
import UIKit

@objc(NavOSSCarPlaySceneDelegate)
@MainActor
final class NavOSSCarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate,
  CPMapTemplateDelegate, CPSearchTemplateDelegate
{
  private weak var carWindow: CPWindow?
  private weak var interfaceController: CPInterfaceController?
  private var activeManeuver: CPManeuver?
  private var activeManeuverKey: String?
  private var activeSystemTrip: CPTrip?
  private var activeTripId: String?
  private var mapTemplate: CPMapTemplate?
  private var mapViewController: NavOSSCarPlayMapViewController?
  private var navigationSession: CPNavigationSession?
  private var stateObserver: NSObjectProtocol?

  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController,
    to window: CPWindow
  ) {
    self.interfaceController = interfaceController
    carWindow = window

    let mapViewController = NavOSSCarPlayMapViewController()
    self.mapViewController = mapViewController
    window.rootViewController = mapViewController

    let mapTemplate = makeMapTemplate()
    self.mapTemplate = mapTemplate
    interfaceController.setRootTemplate(mapTemplate, animated: false, completion: nil)
    stateObserver = NotificationCenter.default.addObserver(
      forName: .navOSSCarPlayStateDidChange,
      object: NavOSSCarPlayTripStore.shared,
      queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated {
        self?.apply(NavOSSCarPlayTripStore.shared.snapshot())
      }
    }
    NavOSSCarPlayTripStore.shared.setConnected(true)
    apply(NavOSSCarPlayTripStore.shared.snapshot())
  }

  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnect interfaceController: CPInterfaceController,
    from window: CPWindow
  ) {
    if let stateObserver {
      NotificationCenter.default.removeObserver(stateObserver)
      self.stateObserver = nil
    }
    navigationSession?.finishTrip()
    navigationSession = nil
    activeManeuver = nil
    activeManeuverKey = nil
    activeSystemTrip = nil
    activeTripId = nil
    NavOSSCarPlayTripStore.shared.setConnected(false)
    self.interfaceController = nil
    carWindow = nil
    mapTemplate = nil
    mapViewController = nil
  }

  private func makeMapTemplate() -> CPMapTemplate {
    let template = CPMapTemplate()
    template.mapDelegate = self
    template.guidanceBackgroundColor = UIColor(red: 0.08, green: 0.38, blue: 0.24, alpha: 1)
    template.automaticallyHidesNavigationBar = true
    template.hidesButtonsWithNavigationBar = false

    let placesButton = CPBarButton(type: .text) { [weak self] _ in
      self?.showPlaces()
    }
    placesButton.title = "Places"
    template.leadingNavigationBarButtons = [placesButton]

    let recenterButton = CPMapButton { [weak self] _ in
      self?.mapViewController?.recenter()
    }
    recenterButton.image = UIImage(systemName: "location.fill")
    let zoomInButton = CPMapButton { [weak self] _ in
      self?.mapViewController?.zoom(by: 1)
    }
    zoomInButton.image = UIImage(systemName: "plus.magnifyingglass")
    let zoomOutButton = CPMapButton { [weak self] _ in
      self?.mapViewController?.zoom(by: -1)
    }
    zoomOutButton.image = UIImage(systemName: "minus.magnifyingglass")
    template.mapButtons = [recenterButton, zoomInButton, zoomOutButton]
    return template
  }

  private func apply(_ state: NavOSSCarPlayState) {
    guard let trip = state.trip else {
      navigationSession?.cancelTrip()
      navigationSession = nil
      activeManeuver = nil
      activeManeuverKey = nil
      activeSystemTrip = nil
      activeTripId = nil
      mapViewController?.clearRoute()
      return
    }

    let activeGuidance = state.guidance?.phase == .navigating || state.guidance?.phase == .arrived
    mapViewController?.display(route: trip.geometry, activeGuidance: activeGuidance)

    if activeTripId != trip.id || activeSystemTrip == nil {
      navigationSession?.finishTrip()
      activeManeuver = nil
      activeManeuverKey = nil
      let systemTrip = makeSystemTrip(trip)
      activeSystemTrip = systemTrip
      activeTripId = trip.id
      navigationSession = mapTemplate?.startNavigationSession(for: systemTrip)
    }

    guard let guidance = state.guidance else {
      updateTripEstimates(
        distanceMeters: trip.distanceMeters,
        durationSeconds: trip.durationSeconds
      )
      return
    }
    updateGuidance(guidance)
  }

  private func makeSystemTrip(_ trip: NavOSSCarPlayTrip) -> CPTrip {
    let originCoordinate = trip.geometry.first ?? NavOSSCarPlayCoordinate(
      latitude: trip.destination.latitude,
      longitude: trip.destination.longitude
    )
    let origin = MKMapItem(
      placemark: MKPlacemark(
        coordinate: CLLocationCoordinate2D(
          latitude: originCoordinate.latitude,
          longitude: originCoordinate.longitude
        )
      )
    )
    origin.name = "Current location"
    let destination = MKMapItem(
      placemark: MKPlacemark(
        coordinate: CLLocationCoordinate2D(
          latitude: trip.destination.latitude,
          longitude: trip.destination.longitude
        )
      )
    )
    destination.name = trip.destination.name
    let routeChoice = CPRouteChoice(
      summaryVariants: [trip.steps.first(where: { !$0.roadName.isEmpty })?.roadName ?? "Fastest route"],
      additionalInformationVariants: [
        "\(formatDuration(trip.durationSeconds)) · \(formatDistance(trip.distanceMeters))"
      ],
      selectionSummaryVariants: [trip.destination.name]
    )
    routeChoice.userInfo = trip.id
    let systemTrip = CPTrip(origin: origin, destination: destination, routeChoices: [routeChoice])
    if #available(iOS 17.4, *) {
      systemTrip.destinationNameVariants = [trip.destination.name]
    }
    systemTrip.userInfo = trip.id
    return systemTrip
  }

  private func updateGuidance(_ guidance: NavOSSCarPlayGuidance) {
    guard let navigationSession else {
      return
    }
    updateTripEstimates(
      distanceMeters: guidance.remainingDistanceMeters,
      durationSeconds: guidance.remainingDurationSeconds
    )

    if guidance.phase == .arrived {
      navigationSession.pauseTrip(for: .arrived, description: "You've arrived")
      return
    }

    let maneuverKey = [
      String(guidance.stepIndex),
      guidance.instruction,
      guidance.maneuverType,
      guidance.roadName
    ].joined(separator: "|")
    let maneuver: CPManeuver
    if let activeManeuver, activeManeuverKey == maneuverKey {
      maneuver = activeManeuver
    } else {
      maneuver = CPManeuver()
      maneuver.instructionVariants = [guidance.instruction]
      maneuver.dashboardInstructionVariants = [guidance.instruction]
      maneuver.notificationInstructionVariants = [guidance.instruction]
      maneuver.symbolImage = UIImage(systemName: maneuverSymbolName(guidance.maneuverType))
      if #available(iOS 17.4, *) {
        maneuver.maneuverType = maneuverType(guidance.maneuverType, guidance.instruction)
        maneuver.roadFollowingManeuverVariants = guidance.roadName.isEmpty
          ? nil
          : [guidance.roadName]
        navigationSession.add([maneuver])
      }
      activeManeuver = maneuver
      activeManeuverKey = maneuverKey
    }
    let maneuverEstimates = travelEstimates(
      distanceMeters: guidance.distanceToManeuverMeters,
      durationSeconds: guidance.durationToManeuverSeconds
    )
    maneuver.initialTravelEstimates = maneuverEstimates
    if #available(iOS 17.4, *) {
      navigationSession.currentRoadNameVariants = guidance.roadName.isEmpty
        ? []
        : [guidance.roadName]
      navigationSession.maneuverState = guidance.distanceToManeuverMeters < 60
        ? .execute
        : guidance.distanceToManeuverMeters < 500
          ? .prepare
          : .initial
    }
    navigationSession.upcomingManeuvers = [maneuver]
    navigationSession.updateEstimates(maneuverEstimates, for: maneuver)
  }

  private func updateTripEstimates(distanceMeters: Double, durationSeconds: Double) {
    guard let activeSystemTrip else {
      return
    }
    mapTemplate?.update(
      travelEstimates(distanceMeters: distanceMeters, durationSeconds: durationSeconds),
      for: activeSystemTrip,
      with: .default
    )
  }

  private func travelEstimates(
    distanceMeters: Double,
    durationSeconds: Double
  ) -> CPTravelEstimates {
    CPTravelEstimates(
      distanceRemaining: Measurement(value: max(0, distanceMeters), unit: UnitLength.meters),
      timeRemaining: max(0, durationSeconds)
    )
  }

  private func maneuverSymbolName(_ maneuverType: String) -> String {
    let normalized = maneuverType.lowercased()
    if normalized.contains("left") { return "arrow.turn.up.left" }
    if normalized.contains("right") { return "arrow.turn.up.right" }
    if normalized.contains("roundabout") { return "arrow.triangle.2.circlepath" }
    if normalized.contains("uturn") || normalized.contains("u-turn") { return "arrow.uturn.up" }
    if normalized.contains("arrive") || normalized.contains("destination") { return "flag.checkered" }
    return "arrow.up"
  }

  @available(iOS 17.4, *)
  private func maneuverType(_ maneuverType: String, _ instruction: String) -> CPManeuverType {
    let normalized = "\(maneuverType) \(instruction)".lowercased()
    if normalized.contains("u-turn") || normalized.contains("uturn") { return .uTurn }
    if normalized.contains("roundabout") { return .enterRoundabout }
    if normalized.contains("keep left") { return .keepLeft }
    if normalized.contains("keep right") { return .keepRight }
    if normalized.contains("left") { return .leftTurn }
    if normalized.contains("right") { return .rightTurn }
    if normalized.contains("arrive") || normalized.contains("destination") {
      return .arriveAtDestination
    }
    return .straightAhead
  }

  private func formatDuration(_ seconds: Double) -> String {
    let minutes = max(1, Int((seconds / 60).rounded()))
    return "\(minutes) min"
  }

  private func formatDistance(_ meters: Double) -> String {
    meters < 1_000
      ? "\(max(10, Int((meters / 10).rounded()) * 10)) m"
      : String(format: "%.1f km", meters / 1_000)
  }

  private func showPlaces() {
    guard let interfaceController else {
      return
    }

    let catalog = NavOSSCarPlayDestinationStore.shared.snapshot()
    var sections: [CPListSection] = []
    let shortcuts = [
      catalog.home.map { destinationItem($0, prefix: "Home") },
      catalog.work.map { destinationItem($0, prefix: "Work") },
    ].compactMap { $0 }
    if !shortcuts.isEmpty {
      sections.append(CPListSection(items: shortcuts, header: "Shortcuts", sectionIndexTitle: nil))
    }
    if !catalog.recents.isEmpty {
      sections.append(
        CPListSection(
          items: catalog.recents.prefix(6).map { destinationItem($0) },
          header: "Recent",
          sectionIndexTitle: nil
        )
      )
    }
    if !catalog.favorites.isEmpty {
      sections.append(
        CPListSection(
          items: catalog.favorites.prefix(6).map { destinationItem($0) },
          header: "Favorites",
          sectionIndexTitle: nil
        )
      )
    }

    let searchItem = CPListItem(text: "Search Calgary", detailText: "Places and addresses")
    searchItem.handler = { [weak self] _, completion in
      completion()
      let searchTemplate = CPSearchTemplate()
      searchTemplate.delegate = self
      self?.interfaceController?.pushTemplate(searchTemplate, animated: true, completion: nil)
    }
    sections.insert(CPListSection(items: [searchItem]), at: 0)

    let listTemplate = CPListTemplate(title: "Choose a destination", sections: sections)
    interfaceController.pushTemplate(listTemplate, animated: true, completion: nil)
  }

  private func destinationItem(
    _ destination: NavOSSCarPlayDestination,
    prefix: String? = nil
  ) -> CPListItem {
    let title = prefix.map { "\($0) · \(destination.name)" } ?? destination.name
    let item = CPListItem(text: title, detailText: destination.label)
    item.handler = { [weak self] _, completion in
      completion()
      self?.showRoutingUnavailableAlert(destination: destination)
    }
    return item
  }

  private func showRoutingUnavailableAlert(destination: NavOSSCarPlayDestination) {
    guard let mapTemplate else {
      return
    }
    let alert = CPNavigationAlert(
      titleVariants: [destination.name],
      subtitleVariants: ["CarPlay route loading will be enabled after native routing is connected."],
      image: nil,
      primaryAction: CPAlertAction(title: "OK", style: .default) { _ in },
      secondaryAction: nil,
      duration: 4
    )
    mapTemplate.present(navigationAlert: alert, animated: true)
  }

  func mapTemplateDidCancelNavigation(_ mapTemplate: CPMapTemplate) {
    navigationSession?.cancelTrip()
    navigationSession = nil
    activeManeuver = nil
    activeManeuverKey = nil
    activeSystemTrip = nil
    activeTripId = nil
    NavOSSCarPlayTripStore.shared.endTripFromCarPlay()
  }

  func mapTemplate(
    _ mapTemplate: CPMapTemplate,
    startedTrip trip: CPTrip,
    using routeChoice: CPRouteChoice
  ) {
    navigationSession = mapTemplate.startNavigationSession(for: trip)
    apply(NavOSSCarPlayTripStore.shared.snapshot())
  }

  func searchTemplate(
    _ searchTemplate: CPSearchTemplate,
    updatedSearchText searchText: String,
    completionHandler: @escaping ([CPListItem]) -> Void
  ) {
    let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard query.count >= 2 else {
      completionHandler([])
      return
    }
    let matches = NavOSSCarPlayDestinationStore.shared.snapshot().searchableDestinations
      .filter { destination in
        destination.name.localizedCaseInsensitiveContains(query) ||
          destination.label.localizedCaseInsensitiveContains(query)
      }
      .prefix(8)
      .map { destinationItem($0) }
    completionHandler(Array(matches))
  }

  func searchTemplate(
    _ searchTemplate: CPSearchTemplate,
    selectedResult item: CPListItem,
    completionHandler: @escaping () -> Void
  ) {
    interfaceController?.popToRootTemplate(animated: true, completion: nil)
    completionHandler()
  }
}
