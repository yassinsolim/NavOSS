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
  private var activeDestinationId: String?
  private var activeSystemTrip: CPTrip?
  private var activeTripId: String?
  private var activeTripControlsVisible = false
  private var endNavigationMapButton: CPMapButton?
  private var idleMapButtons: [CPMapButton] = []
  private var isPreviewingRoutes = false
  private var mapTemplate: CPMapTemplate?
  private var mapViewController: NavOSSCarPlayMapViewController?
  private var muteGuidanceMapButton: CPMapButton?
  private var navigationSession: CPNavigationSession?
  private var overviewMapButton: CPMapButton?
  private let preferencesStore = NavOSSCarPlayPreferencesStore.shared
  private var reportMapButton: CPMapButton?
  private let reportStore = NavOSSCarPlayReportStore.shared
  private var routeRequestGeneration: UInt64 = 0
  private var routeTask: Task<Void, Never>?
  private var searchRequestGeneration: UInt64 = 0
  private var searchTask: Task<Void, Never>?
  private var destinationObserver: NSObjectProtocol?
  private var placesTemplate: CPListTemplate?
  private var stateObserver: NSObjectProtocol?
  private var settingsAudioOnly = false
  private var settingsTemplate: CPListTemplate?
  private var routeChoicesByIdentifier: [String: NavOSSCarPlayTrip] = [:]
  private var searchDestinationsByIdentifier: [String: NavOSSCarPlayDestination] = [:]

  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController,
    to window: CPWindow
  ) {
    self.interfaceController = interfaceController
    carWindow = window

    let mapViewController = NavOSSCarPlayMapViewController()
    let preferences = preferencesStore.load()
    mapViewController.applyAppearance(preferences.appearance)
    NavOSSNavigationService.shared.setAudioMode(preferences.audioMode)
    self.mapViewController = mapViewController
    window.rootViewController = mapViewController
    mapViewController.recenter()

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
    destinationObserver = NotificationCenter.default.addObserver(
      forName: .navOSSCarPlayDestinationCatalogDidChange,
      object: NavOSSCarPlayDestinationStore.shared,
      queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated {
        self?.placesTemplate?.updateSections(self?.destinationSections() ?? [])
      }
    }
    NavOSSCarPlayTripStore.shared.setConnected(true)
    NavOSSNavigationService.shared.setCarPlayConnected(true)
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
    if let destinationObserver {
      NotificationCenter.default.removeObserver(destinationObserver)
      self.destinationObserver = nil
    }
    routeRequestGeneration &+= 1
    routeTask?.cancel()
    routeTask = nil
    searchRequestGeneration &+= 1
    searchTask?.cancel()
    searchTask = nil
    navigationSession?.finishTrip()
    navigationSession = nil
    activeManeuver = nil
    activeManeuverKey = nil
    activeDestinationId = nil
    activeSystemTrip = nil
    activeTripId = nil
    activeTripControlsVisible = false
    endNavigationMapButton = nil
    idleMapButtons = []
    muteGuidanceMapButton = nil
    overviewMapButton = nil
    reportMapButton = nil
    routeChoicesByIdentifier = [:]
    searchDestinationsByIdentifier = [:]
    placesTemplate = nil
    settingsTemplate = nil
    NavOSSCarPlayTripStore.shared.setConnected(false)
    NavOSSNavigationService.shared.setCarPlayConnected(false)
    self.interfaceController = nil
    carWindow = nil
    mapTemplate = nil
    mapViewController = nil
  }

  private func makeMapTemplate() -> CPMapTemplate {
    let template = CPMapTemplate()
    template.mapDelegate = self
    template.guidanceBackgroundColor = UIColor(red: 0.08, green: 0.38, blue: 0.24, alpha: 1)
    template.automaticallyHidesNavigationBar = false
    template.hidesButtonsWithNavigationBar = false

    let placesButton = CPBarButton(title: "Places") { [weak self] _ in
      self?.showPlaces()
    }
    template.leadingNavigationBarButtons = [placesButton]

    let recenterButton = CPMapButton { [weak self] _ in
      self?.mapViewController?.recenter()
    }
    recenterButton.image = UIImage(systemName: "location.fill")
    let searchButton = CPMapButton { [weak self] _ in
      self?.showSearch()
    }
    searchButton.image = UIImage(systemName: "magnifyingglass")
    let settingsButton = CPMapButton { [weak self] _ in
      self?.showSettings(audioOnly: false)
    }
    settingsButton.image = UIImage(systemName: "gearshape.fill")
    let endNavigationButton = CPMapButton { [weak self] _ in
      self?.endNavigation()
    }
    endNavigationButton.image = UIImage(systemName: "xmark.circle.fill")
    let overviewButton = CPMapButton { [weak self] button in
      guard let self else {
        return
      }
      let overviewVisible = self.mapViewController?.toggleRouteOverview() ?? false
      button.image = UIImage(systemName: overviewVisible ? "location.fill" : "map")
    }
    overviewButton.image = UIImage(systemName: "map")
    let muteGuidanceButton = CPMapButton { [weak self] _ in
      self?.showSettings(audioOnly: true)
    }
    muteGuidanceButton.image = audioModeImage(preferencesStore.load().audioMode)
    let reportButton = CPMapButton { [weak self] _ in
      self?.showReports()
    }
    reportButton.image = UIImage(systemName: "exclamationmark.bubble.fill")
    endNavigationMapButton = endNavigationButton
    overviewMapButton = overviewButton
    muteGuidanceMapButton = muteGuidanceButton
    reportMapButton = reportButton
    idleMapButtons = [searchButton, recenterButton, settingsButton]
    template.mapButtons = idleMapButtons
    return template
  }

  private func apply(_ state: NavOSSCarPlayState) {
    guard let trip = state.trip else {
      updateActiveTripControls(visible: false)
      navigationSession?.cancelTrip()
      navigationSession = nil
      activeManeuver = nil
      activeManeuverKey = nil
      activeDestinationId = nil
      activeSystemTrip = nil
      activeTripId = nil
      isPreviewingRoutes = false
      mapTemplate?.automaticallyHidesNavigationBar = false
      mapTemplate?.trailingNavigationBarButtons = []
      mapViewController?.clearRoute()
      return
    }

    updateActiveTripControls(visible: true)
    let activeGuidance = state.guidance?.phase == .navigating || state.guidance?.phase == .arrived
    mapTemplate?.automaticallyHidesNavigationBar = activeGuidance
    configureRouteAttribution(source: trip.source)
    mapViewController?.display(
      route: trip.geometry,
      routeId: trip.id,
      activeGuidance: activeGuidance,
      position: state.position,
      routeProgress: state.routeProgress,
      distanceToManeuverMeters: state.guidance?.distanceToManeuverMeters
    )

    if activeGuidance
      && (activeDestinationId != trip.destination.id || activeSystemTrip == nil)
    {
      navigationSession?.finishTrip()
      activeManeuver = nil
      activeManeuverKey = nil
      let systemTrip = makeSystemTrip(trip)
      activeDestinationId = trip.destination.id
      activeSystemTrip = systemTrip
      activeTripId = trip.id
      navigationSession = mapTemplate?.startNavigationSession(for: systemTrip)
    } else if activeGuidance {
      activeTripId = trip.id
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
    let originCoordinate =
      trip.geometry.first
      ?? NavOSSCarPlayCoordinate(
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
      summaryVariants: [
        trip.steps.first(where: { !$0.roadName.isEmpty })?.roadName ?? "Fastest route"
      ],
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

  private func configureRouteAttribution(source: String?) {
    let mapboxTraffic = source == "mapbox-traffic"
    mapTemplate?.trailingNavigationBarButtons =
      mapboxTraffic
      ? [CPBarButton(title: "Traffic: Mapbox") { _ in }]
      : []
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
      navigationSession.finishTrip()
      self.navigationSession = nil
      activeManeuver = nil
      activeManeuverKey = nil
      return
    }

    let maneuverKey = [
      String(guidance.stepIndex),
      guidance.instruction,
      guidance.maneuverType,
      guidance.roadName,
    ].joined(separator: "|")
    let maneuver: CPManeuver
    let maneuverChanged: Bool
    if let activeManeuver, activeManeuverKey == maneuverKey {
      maneuver = activeManeuver
      maneuverChanged = false
    } else {
      maneuver = CPManeuver()
      maneuver.instructionVariants = [guidance.instruction]
      maneuver.dashboardInstructionVariants = [guidance.instruction]
      maneuver.notificationInstructionVariants = [guidance.instruction]
      maneuver.symbolImage = UIImage(systemName: maneuverSymbolName(guidance.maneuverType))
      if #available(iOS 17.4, *) {
        maneuver.maneuverType = maneuverType(guidance.maneuverType, guidance.instruction)
        maneuver.roadFollowingManeuverVariants =
          guidance.roadName.isEmpty
          ? nil
          : [guidance.roadName]
        navigationSession.add([maneuver])
      }
      activeManeuver = maneuver
      activeManeuverKey = maneuverKey
      maneuverChanged = true
    }
    let maneuverEstimates = travelEstimates(
      distanceMeters: guidance.distanceToManeuverMeters,
      durationSeconds: guidance.durationToManeuverSeconds
    )
    if maneuverChanged {
      maneuver.initialTravelEstimates = maneuverEstimates
    }
    if #available(iOS 17.4, *) {
      navigationSession.currentRoadNameVariants =
        guidance.roadName.isEmpty
        ? []
        : [guidance.roadName]
      navigationSession.maneuverState =
        guidance.distanceToManeuverMeters < 60
        ? .execute
        : guidance.distanceToManeuverMeters < 500
          ? .prepare
          : .initial
    }
    if maneuverChanged {
      navigationSession.upcomingManeuvers = [maneuver]
    }
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
      distanceRemaining: navOSSCarPlayDistanceMeasurement(distanceMeters),
      timeRemaining: max(0, durationSeconds)
    )
  }

  private func maneuverSymbolName(_ maneuverType: String) -> String {
    let normalized = maneuverType.lowercased()
    if normalized.contains("left") { return "arrow.turn.up.left" }
    if normalized.contains("right") { return "arrow.turn.up.right" }
    if normalized.contains("roundabout") { return "arrow.triangle.2.circlepath" }
    if normalized.contains("uturn") || normalized.contains("u-turn") { return "arrow.uturn.up" }
    if normalized.contains("arrive") || normalized.contains("destination") {
      return "flag.checkered"
    }
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

  private func audioModeImage(_ mode: NavOSSCarPlayAudioMode) -> UIImage? {
    switch mode {
    case .alertsOnly:
      UIImage(systemName: "bell.fill")
    case .allGuidance:
      UIImage(systemName: "speaker.wave.2.fill")
    case .muted:
      UIImage(systemName: "speaker.slash.fill")
    }
  }

  private func audioModeDetail(_ mode: NavOSSCarPlayAudioMode) -> String {
    switch mode {
    case .alertsOnly:
      return "Camera alerts without turn-by-turn speech"
    case .allGuidance:
      return "Maneuvers and camera alerts"
    case .muted:
      return "No spoken guidance or camera alerts"
    }
  }

  private func selectedTitle(_ title: String, selected: Bool) -> String {
    selected ? "Selected · \(title)" : title
  }

  private func showSearch() {
    guard let interfaceController else {
      return
    }
    let state = NavOSSCarPlayTripStore.shared.snapshot()
    guard state.guidance?.phase != .navigating else {
      showNavigationAlert(
        title: "Navigation in progress",
        subtitle: "End the current trip before searching for another destination."
      )
      return
    }
    NavOSSNavigationService.shared.prepareForCarPlayRoutePlanning()
    let searchTemplate = CPSearchTemplate()
    searchTemplate.delegate = self
    interfaceController.pushTemplate(searchTemplate, animated: true, completion: nil)
  }

  private func showSettings(audioOnly: Bool) {
    guard let interfaceController else {
      return
    }
    settingsAudioOnly = audioOnly
    let template = CPListTemplate(
      title: audioOnly ? "Guidance sound" : "Settings",
      sections: settingsSections(audioOnly: audioOnly)
    )
    settingsTemplate = template
    interfaceController.pushTemplate(template, animated: true, completion: nil)
  }

  private func settingsSections(audioOnly: Bool) -> [CPListSection] {
    let preferences = preferencesStore.load()
    let audioItems = NavOSSCarPlayAudioMode.allCases.map { mode in
      let item = CPListItem(
        text: selectedTitle(mode.label, selected: preferences.audioMode == mode),
        detailText: audioModeDetail(mode)
      )
      item.handler = { [weak self] _, completion in
        completion()
        guard let self else {
          return
        }
        self.preferencesStore.setAudioMode(mode)
        NavOSSNavigationService.shared.setAudioMode(mode)
        self.muteGuidanceMapButton?.image = self.audioModeImage(mode)
        self.settingsTemplate?.updateSections(
          self.settingsSections(audioOnly: self.settingsAudioOnly)
        )
      }
      return item
    }
    var sections = [
      CPListSection(items: audioItems, header: "Sound", sectionIndexTitle: nil)
    ]
    if !audioOnly {
      let appearanceItems = NavOSSCarPlayAppearance.allCases.map { appearance in
        let item = CPListItem(
          text: selectedTitle(
            appearance.label,
            selected: preferences.appearance == appearance
          ),
          detailText: nil
        )
        item.handler = { [weak self] _, completion in
          completion()
          guard let self else {
            return
          }
          self.preferencesStore.setAppearance(appearance)
          self.mapViewController?.applyAppearance(appearance)
          self.settingsTemplate?.updateSections(self.settingsSections(audioOnly: false))
        }
        return item
      }
      sections.insert(
        CPListSection(items: appearanceItems, header: "Map appearance", sectionIndexTitle: nil),
        at: 0
      )
    }
    return sections
  }

  private func showReports() {
    guard let interfaceController else {
      return
    }
    let items = NavOSSCarPlayReportType.allCases.map { type in
      let item = CPListItem(text: type.label, detailText: nil)
      item.handler = { [weak self] _, completion in
        completion()
        self?.saveReport(type)
      }
      return item
    }
    let template = CPListTemplate(
      title: "Report road condition",
      sections: [
        CPListSection(
          items: items,
          header: "Private testing · expires in 2 hours",
          sectionIndexTitle: nil
        )
      ]
    )
    interfaceController.pushTemplate(template, animated: true, completion: nil)
  }

  private func saveReport(_ type: NavOSSCarPlayReportType) {
    guard let coordinate = NavOSSNavigationService.shared.currentCoordinate() else {
      showNavigationAlert(
        title: "Location unavailable",
        subtitle: "Wait for a GPS position, then try again."
      )
      return
    }
    guard reportStore.record(type, coordinate: coordinate) != nil else {
      showNavigationAlert(title: "Report not saved", subtitle: "Try again in a moment.")
      return
    }
    interfaceController?.popToRootTemplate(animated: true) { [weak self] _, _ in
      self?.showNavigationAlert(
        title: "Saved for testing",
        subtitle: "This private draft is not shown to other drivers."
      )
    }
  }

  private func showPlaces() {
    guard let interfaceController else {
      return
    }
    let hasActiveTrip = NavOSSCarPlayTripStore.shared.snapshot().trip != nil
    if !hasActiveTrip {
      NavOSSNavigationService.shared.prepareForCarPlayRoutePlanning()
    }

    let listTemplate = CPListTemplate(
      title: hasActiveTrip ? "Current trip" : "Choose a destination",
      sections: destinationSections()
    )
    listTemplate.trailingNavigationBarButtons =
      hasActiveTrip
      ? [makeEndNavigationBarButton()]
      : []
    placesTemplate = listTemplate
    interfaceController.pushTemplate(listTemplate, animated: true, completion: nil)
  }

  private func destinationSections() -> [CPListSection] {
    if let trip = NavOSSCarPlayTripStore.shared.snapshot().trip {
      let endItem = CPListItem(
        text: "End navigation",
        detailText: "Stop guidance to \(trip.destination.name)"
      )
      endItem.handler = { [weak self] _, completion in
        completion()
        self?.endNavigation()
      }
      return [
        CPListSection(items: [endItem], header: "Current trip", sectionIndexTitle: nil)
      ]
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
      self?.showSearch()
    }
    sections.insert(CPListSection(items: [searchItem]), at: 0)
    return sections
  }

  private func makeEndNavigationBarButton() -> CPBarButton {
    let button = CPBarButton(title: "End") { [weak self] _ in
      self?.endNavigation()
    }
    button.buttonStyle = .rounded
    return button
  }

  private func updateActiveTripControls(visible: Bool) {
    guard activeTripControlsVisible != visible else {
      return
    }
    activeTripControlsVisible = visible
    let controlState = NavOSSCarPlayControlState(
      hasActiveTrip: visible,
      searchVisible: interfaceController?.topTemplate is CPSearchTemplate
    )
    if controlState.drivingControlsVisible, let endNavigationMapButton,
      let overviewMapButton, let muteGuidanceMapButton, let reportMapButton
    {
      overviewMapButton.image = UIImage(systemName: "map")
      muteGuidanceMapButton.image = audioModeImage(
        NavOSSNavigationService.shared.audioMode()
      )
      mapTemplate?.mapButtons = [
        endNavigationMapButton, overviewMapButton, muteGuidanceMapButton,
        reportMapButton,
      ]
      if controlState.returnToRootFromSearch {
        interfaceController?.popToRootTemplate(animated: true, completion: nil)
      }
    } else {
      mapTemplate?.mapButtons = idleMapButtons
    }
    if let placesTemplate {
      placesTemplate.trailingNavigationBarButtons =
        visible
        ? [makeEndNavigationBarButton()]
        : []
      placesTemplate.updateSections(destinationSections())
    }
  }

  private func endNavigation() {
    guard NavOSSCarPlayTripStore.shared.snapshot().trip != nil || navigationSession != nil else {
      return
    }
    routeRequestGeneration &+= 1
    routeTask?.cancel()
    routeTask = nil
    searchRequestGeneration &+= 1
    searchTask?.cancel()
    searchTask = nil
    routeChoicesByIdentifier = [:]
    searchDestinationsByIdentifier = [:]
    isPreviewingRoutes = false
    mapTemplate?.dismissNavigationAlert(animated: false) { _ in }
    mapTemplate?.hideTripPreviews()
    navigationSession?.cancelTrip()
    navigationSession = nil
    activeManeuver = nil
    activeManeuverKey = nil
    activeDestinationId = nil
    activeSystemTrip = nil
    activeTripId = nil
    placesTemplate = nil
    configureRouteAttribution(source: nil)
    mapViewController?.clearRoute()
    interfaceController?.popToRootTemplate(animated: true, completion: nil)
    NavOSSNavigationService.shared.endNavigationFromCarPlay()
  }

  private func destinationItem(
    _ destination: NavOSSCarPlayDestination,
    prefix: String? = nil
  ) -> CPListItem {
    let title = prefix.map { "\($0) · \(destination.name)" } ?? destination.name
    let item = CPListItem(text: title, detailText: destination.label)
    item.userInfo = destination.id
    item.handler = { [weak self] _, completion in
      completion()
      self?.returnToMapAndLoadRoutes(to: destination)
    }
    return item
  }

  private func returnToMapAndLoadRoutes(to destination: NavOSSCarPlayDestination) {
    guard let interfaceController else {
      return
    }
    interfaceController.popToRootTemplate(animated: true) { [weak self] _, error in
      guard error == nil else {
        return
      }
      self?.loadRoutes(to: destination)
    }
  }

  private func showNavigationAlert(title: String, subtitle: String) {
    guard let mapTemplate else {
      return
    }
    let alert = CPNavigationAlert(
      titleVariants: [title],
      subtitleVariants: [subtitle],
      image: nil,
      primaryAction: CPAlertAction(title: "OK", style: .default) { _ in },
      secondaryAction: nil,
      duration: 4
    )
    mapTemplate.present(navigationAlert: alert, animated: true)
  }

  private func loadRoutes(to destination: NavOSSCarPlayDestination) {
    let state = NavOSSCarPlayTripStore.shared.snapshot()
    if state.guidance?.phase == .navigating {
      showNavigationAlert(
        title: "Navigation in progress",
        subtitle: "End the current trip before choosing another destination."
      )
      return
    }
    routeRequestGeneration &+= 1
    let requestGeneration = routeRequestGeneration
    routeTask?.cancel()
    routeTask = nil
    routeChoicesByIdentifier = [:]
    isPreviewingRoutes = false
    mapTemplate?.hideTripPreviews()
    mapViewController?.clearRoute()
    NavOSSNavigationService.shared.prepareForCarPlayRoutePlanning()
    guard let origin = NavOSSNavigationService.shared.currentCoordinate() else {
      showNavigationAlert(
        title: "Current location unavailable",
        subtitle: "Wait for a GPS position, then try again."
      )
      return
    }
    showNavigationAlert(title: destination.name, subtitle: "Finding routes…")
    routeTask = Task { [weak self] in
      do {
        let client = try NavOSSNavigationAPIClient()
        let routes = try await client.routes(
          origin: origin,
          destination: destination,
          preferences: NavOSSRoutePreferences(),
          alternatives: 2
        )
        guard !Task.isCancelled, let self,
          requestGeneration == self.routeRequestGeneration
        else {
          return
        }
        self.routeTask = nil
        _ = await self.mapTemplate?.dismissNavigationAlert(animated: true)
        guard !Task.isCancelled,
          requestGeneration == self.routeRequestGeneration
        else {
          return
        }
        self.showRoutePreviews(routes)
      } catch {
        guard !Task.isCancelled, let self,
          requestGeneration == self.routeRequestGeneration
        else {
          return
        }
        self.routeTask = nil
        self.showNavigationAlert(
          title: "Route unavailable",
          subtitle: "Check your connection and try again."
        )
      }
    }
  }

  private func showRoutePreviews(_ routes: [NavOSSCarPlayTrip]) {
    guard mapTemplate != nil, !routes.isEmpty,
      NavOSSCarPlayTripStore.shared.snapshot().guidance?.phase != .navigating
    else {
      return
    }
    routeChoicesByIdentifier = Dictionary(uniqueKeysWithValues: routes.map { ($0.id, $0) })
    isPreviewingRoutes = true
    let systemTrips = routes.map(makeSystemTrip)
    if let firstRoute = routes.first {
      configureRouteAttribution(source: firstRoute.source)
      mapViewController?.display(
        route: firstRoute.geometry,
        routeId: firstRoute.id,
        activeGuidance: false,
        alternateRoute: routes.dropFirst().first?.geometry
      )
    }
    interfaceController?.popToRootTemplate(animated: true) { [weak self] _, _ in
      self?.mapTemplate?.showTripPreviews(systemTrips, textConfiguration: nil)
    }
  }

  func mapTemplate(
    _ mapTemplate: CPMapTemplate,
    selectedPreviewFor trip: CPTrip,
    using routeChoice: CPRouteChoice
  ) {
    guard let identifier = routeChoice.userInfo as? String,
      let route = routeChoicesByIdentifier[identifier]
    else {
      return
    }
    configureRouteAttribution(source: route.source)
    let alternateRoute = routeChoicesByIdentifier.values.first { $0.id != route.id }
    mapViewController?.display(
      route: route.geometry,
      routeId: route.id,
      activeGuidance: false,
      alternateRoute: alternateRoute?.geometry
    )
  }

  func mapTemplateDidCancelNavigation(_ mapTemplate: CPMapTemplate) {
    if isPreviewingRoutes {
      routeRequestGeneration &+= 1
      routeTask?.cancel()
      routeTask = nil
      routeChoicesByIdentifier = [:]
      isPreviewingRoutes = false
      mapTemplate.hideTripPreviews()
      let state = NavOSSCarPlayTripStore.shared.snapshot()
      if state.guidance?.phase == .navigating || state.guidance?.phase == .arrived {
        apply(state)
      } else {
        configureRouteAttribution(source: nil)
        mapViewController?.clearRoute()
      }
      return
    }
    endNavigation()
  }

  func mapTemplate(
    _ mapTemplate: CPMapTemplate,
    startedTrip trip: CPTrip,
    using routeChoice: CPRouteChoice
  ) {
    guard let identifier = routeChoice.userInfo as? String,
      let route = routeChoicesByIdentifier[identifier]
    else {
      return
    }
    do {
      routeRequestGeneration &+= 1
      routeTask?.cancel()
      routeTask = nil
      activeDestinationId = route.destination.id
      activeSystemTrip = trip
      activeTripId = route.id
      isPreviewingRoutes = false
      try NavOSSNavigationService.shared.startNavigation(route)
      navigationSession = mapTemplate.startNavigationSession(for: trip)
      routeChoicesByIdentifier = [:]
      apply(NavOSSCarPlayTripStore.shared.snapshot())
    } catch {
      activeDestinationId = nil
      activeSystemTrip = nil
      activeTripId = nil
      navigationSession = nil
      showNavigationAlert(title: "Navigation unavailable", subtitle: "Try another route.")
    }
  }

  func searchTemplate(
    _ searchTemplate: CPSearchTemplate,
    updatedSearchText searchText: String,
    completionHandler: @escaping ([CPListItem]) -> Void
  ) {
    let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    searchRequestGeneration &+= 1
    let requestGeneration = searchRequestGeneration
    searchTask?.cancel()
    guard query.count >= 2 else {
      searchTask = nil
      searchDestinationsByIdentifier = [:]
      completionHandler([])
      return
    }
    searchTask = Task { [weak self] in
      let localMatches = NavOSSCarPlayDestinationStore.shared.snapshot().searchableDestinations
        .filter { destination in
          destination.name.localizedCaseInsensitiveContains(query)
            || destination.label.localizedCaseInsensitiveContains(query)
        }
      do {
        let client = try NavOSSNavigationAPIClient()
        let remoteMatches = try await client.search(
          query: query,
          proximity: NavOSSNavigationService.shared.currentCoordinate()
        )
        let matches = Array(
          (localMatches + remoteMatches).reduce(into: [String: NavOSSCarPlayDestination]()) {
            $0[$1.id] = $1
          }.values.prefix(8))
        guard !Task.isCancelled, let self,
          requestGeneration == self.searchRequestGeneration
        else {
          completionHandler([])
          return
        }
        self.searchTask = nil
        self.searchDestinationsByIdentifier = Dictionary(
          uniqueKeysWithValues: matches.map { ($0.id, $0) }
        )
        completionHandler(matches.map { self.destinationItem($0) })
      } catch {
        let matches = Array(localMatches.prefix(8))
        guard !Task.isCancelled, let self,
          requestGeneration == self.searchRequestGeneration
        else {
          completionHandler([])
          return
        }
        self.searchTask = nil
        self.searchDestinationsByIdentifier = Dictionary(
          uniqueKeysWithValues: matches.map { ($0.id, $0) }
        )
        completionHandler(matches.map { self.destinationItem($0) })
      }
    }
  }

  func searchTemplate(
    _ searchTemplate: CPSearchTemplate,
    selectedResult item: CPListItem,
    completionHandler: @escaping () -> Void
  ) {
    guard let identifier = item.userInfo as? String,
      let destination = searchDestinationsByIdentifier[identifier]
    else {
      completionHandler()
      return
    }
    completionHandler()
    returnToMapAndLoadRoutes(to: destination)
  }
}
