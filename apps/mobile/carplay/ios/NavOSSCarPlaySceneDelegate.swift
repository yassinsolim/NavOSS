import CarPlay
import MapKit
internal import NavOSSNavigation
import UIKit

@objc(NavOSSCarPlaySceneDelegate)
@MainActor
final class NavOSSCarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate,
  CPMapTemplateDelegate, CPSearchTemplateDelegate
{
  private struct SearchCategory {
    let category: String?
    let label: String
    let query: String
    let systemImageName: String
  }

  private enum RoutePreferenceOption: CaseIterable {
    case ferries
    case highways
    case tolls
    case unpaved

    var label: String {
      switch self {
      case .ferries: "Avoid ferries"
      case .highways: "Avoid highways"
      case .tolls: "Avoid tolls"
      case .unpaved: "Avoid unpaved roads"
      }
    }

    var systemImageName: String {
      switch self {
      case .ferries: "ferry.fill"
      case .highways: "road.lanes"
      case .tolls: "dollarsign.circle.fill"
      case .unpaved: "mountain.2.fill"
      }
    }

    func isEnabled(in preferences: NavOSSRoutePreferences) -> Bool {
      switch self {
      case .ferries: preferences.avoidFerries
      case .highways: preferences.avoidHighways
      case .tolls: preferences.avoidTolls
      case .unpaved: preferences.avoidUnpaved
      }
    }

    func toggled(in preferences: NavOSSRoutePreferences) -> NavOSSRoutePreferences {
      NavOSSRoutePreferences(
        avoidFerries: self == .ferries ? !preferences.avoidFerries : preferences.avoidFerries,
        avoidHighways: self == .highways ? !preferences.avoidHighways : preferences.avoidHighways,
        avoidTolls: self == .tolls ? !preferences.avoidTolls : preferences.avoidTolls,
        avoidUnpaved: self == .unpaved ? !preferences.avoidUnpaved : preferences.avoidUnpaved
      )
    }
  }

  private enum DestinationSelectionMode {
    case addStop
    case newTrip
  }

  private enum SettingsCategory {
    case alertOptions
    case drivingAvatar
    case mapColors
    case mapDisplay
    case mapOrientation
    case routeOptions
    case volume

    var sectionHeader: String {
      switch self {
      case .alertOptions, .volume: "Sound"
      case .drivingAvatar: "Vehicle marker"
      case .mapColors: "Map appearance"
      case .mapDisplay: "Map content"
      case .mapOrientation: "Map orientation"
      case .routeOptions: "Route options"
      }
    }

    var title: String {
      switch self {
      case .alertOptions: "Alert options"
      case .drivingAvatar: "Driving avatar"
      case .mapColors: "Map colors"
      case .mapDisplay: "Map display"
      case .mapOrientation: "Map orientation"
      case .routeOptions: "Route options"
      case .volume: "Volume"
      }
    }
  }

  private let searchCategoryGroups: [(String, [SearchCategory])] = [
    (
      "Food & Drink",
      [
        SearchCategory(
          category: "restaurant", label: "Restaurants", query: "restaurant",
          systemImageName: "fork.knife"),
        SearchCategory(
          category: "cafe", label: "Coffee", query: "cafe", systemImageName: "cup.and.saucer.fill"),
        SearchCategory(category: "bar", label: "Bars", query: "bar", systemImageName: "wineglass"),
      ]
    ),
    (
      "Everyday",
      [
        SearchCategory(
          category: "fuel", label: "Gas", query: "fuel", systemImageName: "fuelpump.fill"),
        SearchCategory(
          category: "grocery", label: "Groceries", query: "supermarket",
          systemImageName: "cart.fill"),
        SearchCategory(
          category: "parking", label: "Parking", query: "parking",
          systemImageName: "parkingsign.circle.fill"),
        SearchCategory(
          category: "pharmacy", label: "Pharmacies", query: "pharmacy",
          systemImageName: "pills.fill"),
      ]
    ),
    (
      "Explore",
      [
        SearchCategory(
          category: "park", label: "Parks", query: "park", systemImageName: "tree.fill"),
        SearchCategory(
          category: "shopping-centre", label: "Shopping", query: "shopping centre",
          systemImageName: "bag.fill"),
        SearchCategory(
          category: "hotel", label: "Hotels", query: "hotel", systemImageName: "bed.double.fill"),
        SearchCategory(
          category: "attraction", label: "Attractions", query: "attraction",
          systemImageName: "ticket.fill"),
      ]
    ),
    (
      "Services",
      [
        SearchCategory(
          category: "healthcare", label: "Hospitals and clinics", query: "hospital clinic",
          systemImageName: "cross.case.fill"),
        SearchCategory(
          category: "charging-station", label: "Charging stations", query: "charging station",
          systemImageName: "bolt.car.fill"),
        SearchCategory(
          category: "car-repair", label: "Car repair", query: "car repair",
          systemImageName: "wrench.and.screwdriver.fill"),
        SearchCategory(
          category: "car-wash", label: "Car wash", query: "car wash", systemImageName: "drop.fill"),
      ]
    ),
  ]

  private weak var carWindow: CPWindow?
  private weak var interfaceController: CPInterfaceController?
  private var activeManeuver: CPManeuver?
  private var activeManeuverKey: String?
  private var activeDestinationId: String?
  private var activeSystemTrip: CPTrip?
  private var activeTripId: String?
  private var activeTripControlsVisible = false
  private var destinationSelectionMode = DestinationSelectionMode.newTrip
  private var endNavigationMapButton: CPMapButton?
  private var idleMapButtons: [CPMapButton] = []
  private var isPreviewingRoutes = false
  private var mapTemplate: CPMapTemplate?
  private var mapViewController: NavOSSCarPlayMapViewController?
  private var muteGuidanceMapButton: CPMapButton?
  private var navigationSession: CPNavigationSession?
  private var overviewMapButton: CPMapButton?
  private let preferencesStore = NavOSSCarPlayPreferencesStore.shared
  private var preferencesObserver: NSObjectProtocol?
  private var reportMapButton: CPMapButton?
  private var routePreviewReplacesActiveTrip = false
  private var rootActionShowsTrip = false
  private let reportStore = NavOSSCarPlayReportStore.shared
  private var routeRequestGeneration: UInt64 = 0
  private var routeTask: Task<Void, Never>?
  private var searchRequestGeneration: UInt64 = 0
  private var searchTask: Task<Void, Never>?
  private var destinationObserver: NSObjectProtocol?
  private var placesTemplate: CPListTemplate?
  private var stateObserver: NSObjectProtocol?
  private var settingsAudioOnly = false
  private var settingsCategory: SettingsCategory?
  private var settingsTemplate: CPListTemplate?
  private var routeChoicesByIdentifier: [String: NavOSSCarPlayTrip] = [:]
  private var searchDestinationsByIdentifier: [String: NavOSSCarPlayDestination] = [:]

  func sceneDidBecomeActive(_ scene: UIScene) {
    guard let interfaceController, let mapTemplate else { return }
    searchRequestGeneration &+= 1
    searchTask?.cancel()
    searchTask = nil
    searchDestinationsByIdentifier = [:]
    destinationSelectionMode = .newTrip
    routeRequestGeneration &+= 1
    routeTask?.cancel()
    routeTask = nil
    routeChoicesByIdentifier = [:]
    let discardedPreview = isPreviewingRoutes
    isPreviewingRoutes = false
    routePreviewReplacesActiveTrip = false
    if discardedPreview {
      mapTemplate.hideTripPreviews()
    }
    placesTemplate = nil
    settingsCategory = nil
    settingsTemplate = nil
    if interfaceController.topTemplate !== mapTemplate {
      interfaceController.popToRootTemplate(animated: false, completion: nil)
    }
    let state = NavOSSCarPlayTripStore.shared.snapshot()
    if state.trip != nil {
      apply(state)
    } else {
      mapViewController?.clearRoute()
      mapViewController?.recenter()
    }
  }

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
    mapViewController.applyMapPreferences(
      showsPointsOfInterest: preferences.showsPointsOfInterest,
      vehicleMarker: preferences.vehicleMarker
    )
    mapViewController.applyMapOrientation(preferences.mapOrientation)
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
        self?.placesTemplate?.updateSections(self?.placesTemplateSections() ?? [])
      }
    }
    preferencesObserver = NotificationCenter.default.addObserver(
      forName: .navOSSCarPlayPreferencesDidChange,
      object: preferencesStore,
      queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated {
        self?.applySharedPreferences()
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
    if let preferencesObserver {
      NotificationCenter.default.removeObserver(preferencesObserver)
      self.preferencesObserver = nil
    }
    routeRequestGeneration &+= 1
    routeTask?.cancel()
    routeTask = nil
    searchRequestGeneration &+= 1
    searchTask?.cancel()
    searchTask = nil
    mapViewController?.clearRoute()
    navigationSession?.finishTrip()
    navigationSession = nil
    activeManeuver = nil
    activeManeuverKey = nil
    activeDestinationId = nil
    activeSystemTrip = nil
    activeTripId = nil
    activeTripControlsVisible = false
    destinationSelectionMode = .newTrip
    isPreviewingRoutes = false
    endNavigationMapButton = nil
    idleMapButtons = []
    muteGuidanceMapButton = nil
    overviewMapButton = nil
    reportMapButton = nil
    rootActionShowsTrip = false
    routePreviewReplacesActiveTrip = false
    routeChoicesByIdentifier = [:]
    searchDestinationsByIdentifier = [:]
    placesTemplate = nil
    settingsCategory = nil
    settingsTemplate = nil
    NavOSSCarPlayTripStore.shared.setConnected(false)
    NavOSSNavigationService.shared.setCarPlayConnected(false)
    self.interfaceController = nil
    carWindow = nil
    mapTemplate = nil
    mapViewController = nil
  }

  private func applySharedPreferences() {
    let preferences = preferencesStore.load()
    NavOSSNavigationService.shared.setAudioMode(preferences.audioMode)
    muteGuidanceMapButton?.image = audioModeImage(preferences.audioMode)
    mapViewController?.applyAppearance(preferences.appearance)
    mapViewController?.applyMapOrientation(preferences.mapOrientation)
    mapViewController?.applyMapPreferences(
      showsPointsOfInterest: preferences.showsPointsOfInterest,
      vehicleMarker: preferences.vehicleMarker
    )
    if settingsAudioOnly {
      settingsTemplate?.updateSections(settingsSections(audioOnly: true))
    } else if let settingsCategory {
      settingsTemplate?.updateSections(settingsSections(category: settingsCategory))
    }
  }

  private func makeMapTemplate() -> CPMapTemplate {
    let template = CPMapTemplate()
    template.mapDelegate = self
    template.guidanceBackgroundColor = UIColor(red: 0.08, green: 0.38, blue: 0.24, alpha: 1)
    template.automaticallyHidesNavigationBar = false
    template.hidesButtonsWithNavigationBar = false

    template.leadingNavigationBarButtons = [makeRootActionButton(title: "Search")]

    let recenterButton = CPMapButton { [weak self] _ in
      self?.mapViewController?.recenter()
    }
    recenterButton.image = UIImage(systemName: "location.fill")
    let searchButton = CPMapButton { [weak self] _ in
      self?.showPlaces()
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
      routeRequestGeneration &+= 1
      routeTask?.cancel()
      routeTask = nil
      routeChoicesByIdentifier = [:]
      destinationSelectionMode = .newTrip
      routePreviewReplacesActiveTrip = false
      if isPreviewingRoutes {
        mapTemplate?.hideTripPreviews()
      }
      updateRootAction(hasActiveTrip: false)
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

    if isPreviewingRoutes, routePreviewReplacesActiveTrip,
      state.guidance?.phase == .navigating
    {
      return
    }

    updateRootAction(hasActiveTrip: true)
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
      distanceToManeuverMeters: state.guidance?.distanceToManeuverMeters,
      speedLimitKph: navOSSCarPlaySpeedLimit(
        trip.speedLimitsKph,
        geometry: trip.geometry,
        matchedCoordinate: state.position?.coordinate,
        routeProgress: state.routeProgress
      )
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
    makeSystemTrip([trip])
  }

  private func makeSystemTrip(_ routes: [NavOSSCarPlayTrip]) -> CPTrip {
    precondition(!routes.isEmpty)
    let trip = routes[0]
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
    let routeChoices = routes.enumerated().map { index, route in
      let roadName = route.steps.first(where: { !$0.roadName.isEmpty })?.roadName
      let routeName = index == 0 ? "Fastest route" : "Alternative \(index)"
      let summary = roadName.map { "\(routeName) via \($0)" } ?? routeName
      let duration = formatDuration(route.durationSeconds)
      let distance = formatDistance(route.distanceMeters)
      let estimates = "\(duration) · \(distance)"
      let routeChoice = CPRouteChoice(
        summaryVariants: [summary, routeName],
        additionalInformationVariants: [estimates],
        selectionSummaryVariants: ["\(summary) · \(estimates)", estimates]
      )
      routeChoice.userInfo = route.id
      return routeChoice
    }
    let systemTrip = CPTrip(origin: origin, destination: destination, routeChoices: routeChoices)
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

  private func makeRootActionButton(title: String) -> CPBarButton {
    CPBarButton(title: title) { [weak self] _ in
      self?.showPlaces()
    }
  }

  private func carPlayImage(_ systemName: String) -> UIImage {
    UIImage(systemName: systemName) ?? UIImage()
  }

  private func updateRootAction(hasActiveTrip: Bool) {
    guard rootActionShowsTrip != hasActiveTrip else { return }
    rootActionShowsTrip = hasActiveTrip
    mapTemplate?.leadingNavigationBarButtons = [
      makeRootActionButton(title: hasActiveTrip ? "Trip" : "Search")
    ]
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

  private func appearanceImage(_ appearance: NavOSSCarPlayAppearance) -> UIImage? {
    switch appearance {
    case .automatic:
      UIImage(systemName: "circle.lefthalf.filled")
    case .dark:
      UIImage(systemName: "moon.fill")
    case .light:
      UIImage(systemName: "sun.max.fill")
    }
  }

  private func vehicleMarkerImage(_ marker: NavOSSCarPlayVehicleMarker) -> UIImage? {
    UIImage(systemName: marker == .car ? "car.fill" : "location.north.fill")
  }

  private func mapOrientationImage(_ orientation: NavOSSCarPlayMapOrientation) -> UIImage? {
    UIImage(systemName: orientation == .northUp ? "safari.fill" : "location.north.fill")
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

  private func showSearch(
    selectionMode: DestinationSelectionMode = .newTrip
  ) {
    guard let interfaceController else {
      return
    }
    let state = NavOSSCarPlayTripStore.shared.snapshot()
    guard state.guidance?.phase != .navigating || selectionMode == .addStop else {
      showNavigationAlert(
        title: "Navigation in progress",
        subtitle: "End the current trip before searching for another destination."
      )
      return
    }
    destinationSelectionMode = selectionMode
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
    settingsCategory = nil
    if !audioOnly {
      let buttons: [(SettingsCategory, String)] = [
        (.routeOptions, "slider.horizontal.3"),
        (.alertOptions, "exclamationmark.triangle.fill"),
        (.mapColors, "circle.lefthalf.filled"),
        (.mapOrientation, "safari.fill"),
        (.mapDisplay, "map.fill"),
        (.volume, "speaker.wave.2.fill"),
        (.drivingAvatar, "car.fill"),
      ]
      let template = CPGridTemplate(
        title: "Settings",
        gridButtons: buttons.map { category, systemImageName in
          CPGridButton(
            titleVariants: [category.title],
            image: carPlayImage(systemImageName)
          ) { [weak self] _ in
            self?.showSettingsCategory(category)
          }
        }
      )
      settingsTemplate = nil
      interfaceController.pushTemplate(template, animated: true, completion: nil)
      return
    }
    let template = CPListTemplate(
      title: "Guidance sound",
      sections: settingsSections(audioOnly: true)
    )
    settingsTemplate = template
    interfaceController.pushTemplate(template, animated: true, completion: nil)
  }

  private func showSettingsCategory(_ category: SettingsCategory) {
    guard let interfaceController else { return }
    settingsAudioOnly = false
    settingsCategory = category
    let template = CPListTemplate(
      title: category.title,
      sections: settingsSections(category: category)
    )
    settingsTemplate = template
    interfaceController.pushTemplate(template, animated: true, completion: nil)
  }

  private func settingsSections(category: SettingsCategory) -> [CPListSection] {
    settingsSections(audioOnly: false).filter { $0.header == category.sectionHeader }
  }

  private func settingsSections(audioOnly: Bool) -> [CPListSection] {
    let preferences = preferencesStore.load()
    let audioItems = NavOSSCarPlayAudioMode.allCases.map { mode in
      let item = CPListItem(
        text: selectedTitle(mode.label, selected: preferences.audioMode == mode),
        detailText: audioModeDetail(mode),
        image: audioModeImage(mode)
      )
      item.handler = { [weak self] _, completion in
        completion()
        guard let self else {
          return
        }
        self.preferencesStore.setAudioMode(mode)
      }
      return item
    }
    var sections = [
      CPListSection(items: audioItems, header: "Sound", sectionIndexTitle: nil)
    ]
    if !audioOnly {
      let orientationItems = NavOSSCarPlayMapOrientation.allCases.map { orientation in
        let item = CPListItem(
          text: selectedTitle(
            orientation.label,
            selected: preferences.mapOrientation == orientation
          ),
          detailText: orientation == .northUp
            ? "Keep north at the top"
            : "Rotate the map with travel direction",
          image: mapOrientationImage(orientation)
        )
        item.handler = { [weak self] _, completion in
          completion()
          guard let self else { return }
          self.preferencesStore.setMapOrientation(orientation)
        }
        return item
      }
      let routePreferenceItems = RoutePreferenceOption.allCases.map { option in
        let enabled = option.isEnabled(in: preferences.routePreferences)
        let item = CPListItem(
          text: selectedTitle(option.label, selected: enabled),
          detailText: enabled ? "Avoided when possible" : "Allowed",
          image: UIImage(systemName: option.systemImageName)
        )
        item.handler = { [weak self] _, completion in
          completion()
          guard let self else { return }
          let updated = option.toggled(in: self.preferencesStore.load().routePreferences)
          self.preferencesStore.setRoutePreferences(updated)
        }
        return item
      }
      let appearanceItems = NavOSSCarPlayAppearance.allCases.map { appearance in
        let item = CPListItem(
          text: selectedTitle(
            appearance.label,
            selected: preferences.appearance == appearance
          ),
          detailText: nil,
          image: appearanceImage(appearance)
        )
        item.handler = { [weak self] _, completion in
          completion()
          guard let self else {
            return
          }
          self.preferencesStore.setAppearance(appearance)
        }
        return item
      }
      sections.insert(
        CPListSection(items: appearanceItems, header: "Map appearance", sectionIndexTitle: nil),
        at: 0
      )
      sections.insert(
        CPListSection(
          items: routePreferenceItems,
          header: "Route options",
          sectionIndexTitle: nil
        ),
        at: 1
      )
      sections.insert(
        CPListSection(items: orientationItems, header: "Map orientation", sectionIndexTitle: nil),
        at: 1
      )
      let markerItems = NavOSSCarPlayVehicleMarker.allCases.map { marker in
        let item = CPListItem(
          text: selectedTitle(marker.label, selected: preferences.vehicleMarker == marker),
          detailText: marker == .car
            ? "Show a car on the route"
            : "Show the NavOSS direction arrow",
          image: vehicleMarkerImage(marker)
        )
        item.handler = { [weak self] _, completion in
          completion()
          guard let self else { return }
          self.preferencesStore.setVehicleMarker(marker)
        }
        return item
      }
      let poiItem = CPListItem(
        text: selectedTitle(
          "Show points of interest",
          selected: preferences.showsPointsOfInterest
        ),
        detailText: preferences.showsPointsOfInterest
          ? "Visible on the map"
          : "Hidden from the map",
        image: UIImage(systemName: "mappin.and.ellipse")
      )
      poiItem.handler = { [weak self] _, completion in
        completion()
        guard let self else { return }
        self.preferencesStore.setShowsPointsOfInterest(!preferences.showsPointsOfInterest)
      }
      sections.append(
        CPListSection(items: markerItems, header: "Vehicle marker", sectionIndexTitle: nil)
      )
      sections.append(
        CPListSection(items: [poiItem], header: "Map content", sectionIndexTitle: nil)
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
    destinationSelectionMode = .newTrip
    if !hasActiveTrip {
      NavOSSNavigationService.shared.prepareForCarPlayRoutePlanning()
      showSearchHub()
      return
    }

    let listTemplate = CPListTemplate(
      title: hasActiveTrip ? "Current trip" : "Search",
      sections: destinationSections()
    )
    listTemplate.trailingNavigationBarButtons =
      hasActiveTrip
      ? [makeEndNavigationBarButton()]
      : []
    placesTemplate = listTemplate
    interfaceController.pushTemplate(listTemplate, animated: true, completion: nil)
  }

  private func showSearchHub() {
    guard let interfaceController else { return }
    let catalog = NavOSSCarPlayDestinationStore.shared.snapshot()
    let recentButton = CPGridButton(
      titleVariants: ["Recent searches", "Recents"],
      image: carPlayImage("clock.arrow.circlepath")
    ) { [weak self] _ in
      self?.showDestinationList(title: "Recent searches", destinations: catalog.recents)
    }
    let homeButton = CPGridButton(
      titleVariants: ["Home"],
      image: carPlayImage("house.fill")
    ) { [weak self] _ in
      guard let self else { return }
      if let home = catalog.home {
        self.selectDestination(home)
      } else {
        self.showDestinationList(title: "Home", destinations: [])
      }
    }
    let workButton = CPGridButton(
      titleVariants: ["Work"],
      image: carPlayImage("briefcase.fill")
    ) { [weak self] _ in
      guard let self else { return }
      if let work = catalog.work {
        self.selectDestination(work)
      } else {
        self.showDestinationList(title: "Work", destinations: [])
      }
    }
    let savedButton = CPGridButton(
      titleVariants: ["Saved places", "Saved"],
      image: carPlayImage("bookmark.fill")
    ) { [weak self] _ in
      self?.showDestinationList(title: "Saved places", destinations: catalog.favorites)
    }
    let gasButton = CPGridButton(
      titleVariants: ["Gas stations", "Gas"],
      image: carPlayImage("fuelpump.fill")
    ) { [weak self] _ in
      self?.showSearchCategory(label: "Gas")
    }
    let restaurantButton = CPGridButton(
      titleVariants: ["Restaurants", "Food"],
      image: carPlayImage("fork.knife")
    ) { [weak self] _ in
      self?.showSearchCategory(label: "Restaurants")
    }
    let template = CPGridTemplate(
      title: "Search",
      gridButtons: [recentButton, homeButton, workButton, savedButton, gasButton, restaurantButton]
    )
    template.trailingNavigationBarButtons = [
      CPBarButton(image: carPlayImage("keyboard")) { [weak self] _ in
        self?.showSearch()
      },
      CPBarButton(image: carPlayImage("mic.fill")) { [weak self] _ in
        self?.showSearch()
      },
    ]
    interfaceController.pushTemplate(template, animated: true, completion: nil)
  }

  private func showDestinationList(
    title: String,
    destinations: [NavOSSCarPlayDestination]
  ) {
    guard let interfaceController else { return }
    let items: [CPListItem]
    if destinations.isEmpty {
      let emptyItem = CPListItem(
        text: "No places yet",
        detailText: "Add or save this place on your phone"
      )
      emptyItem.isEnabled = false
      items = [emptyItem]
    } else {
      items = uniqueDestinations(destinations).map { destinationItem($0) }
    }
    interfaceController.pushTemplate(
      CPListTemplate(title: title, sections: [CPListSection(items: items)]),
      animated: true,
      completion: nil
    )
  }

  private func showSearchCategory(label: String) {
    guard
      let category =
        searchCategoryGroups
        .flatMap(\.1)
        .first(where: { $0.label == label })
    else { return }
    showCategoryResults(category)
  }

  private func placesTemplateSections() -> [CPListSection] {
    destinationSelectionMode == .addStop
      ? destinationSearchSections()
      : destinationSections()
  }

  private func destinationSections() -> [CPListSection] {
    if let trip = NavOSSCarPlayTripStore.shared.snapshot().trip {
      let state = NavOSSCarPlayTripStore.shared.snapshot()
      let remainingWaypoints = navOSSRemainingWaypoints(in: trip, after: state.routeProgress)
      let addStopItem = CPListItem(
        text: "Add stop",
        detailText: remainingWaypoints.count >= 8
          ? "Eight remaining stops is the limit"
          : "Search places along this trip",
        image: UIImage(systemName: "plus.circle.fill")
      )
      addStopItem.isEnabled = remainingWaypoints.count < 8
      addStopItem.handler = { [weak self] _, completion in
        completion()
        self?.showAddStopPicker()
      }
      let routesItem = CPListItem(
        text: "View routes",
        detailText: "Compare alternatives from here",
        image: UIImage(systemName: "arrow.triangle.branch")
      )
      routesItem.handler = { [weak self] _, completion in
        completion()
        self?.returnToMapAndLoadActiveRouteAlternatives()
      }
      let endItem = CPListItem(
        text: "End navigation",
        detailText: "Stop guidance to \(trip.destination.name)"
      )
      endItem.handler = { [weak self] _, completion in
        completion()
        self?.endNavigation()
      }
      return [
        CPListSection(
          items: [addStopItem, routesItem, endItem],
          header: "Current trip",
          sectionIndexTitle: nil
        )
      ]
    }

    return destinationSearchSections()
  }

  private func destinationSearchSections() -> [CPListSection] {
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

    let searchItem = CPListItem(text: "Type a destination", detailText: "Places and addresses")
    searchItem.handler = { [weak self] _, completion in
      completion()
      guard let self else { return }
      self.showSearch(selectionMode: self.destinationSelectionMode)
    }
    sections.insert(CPListSection(items: [searchItem]), at: 0)
    for (header, categories) in searchCategoryGroups.reversed() {
      let items = categories.map { category in
        let item = CPListItem(
          text: category.label,
          detailText: "Nearby",
          image: UIImage(systemName: category.systemImageName)
        )
        item.accessoryType = .disclosureIndicator
        item.handler = { [weak self] _, completion in
          completion()
          self?.showCategoryResults(category)
        }
        return item
      }
      sections.insert(
        CPListSection(items: items, header: header, sectionIndexTitle: nil),
        at: 1
      )
    }
    return sections
  }

  private func showAddStopPicker() {
    guard let interfaceController, let trip = NavOSSCarPlayTripStore.shared.snapshot().trip else {
      return
    }
    let state = NavOSSCarPlayTripStore.shared.snapshot()
    guard navOSSRemainingWaypoints(in: trip, after: state.routeProgress).count < 8 else {
      showNavigationAlert(
        title: "Stop limit reached",
        subtitle: "Remove a stop on the phone before adding another."
      )
      return
    }
    destinationSelectionMode = .addStop
    let template = CPListTemplate(title: "Add stop", sections: destinationSearchSections())
    template.trailingNavigationBarButtons = [makeEndNavigationBarButton()]
    placesTemplate = template
    interfaceController.pushTemplate(template, animated: true, completion: nil)
  }

  private func showCategoryResults(_ category: SearchCategory) {
    guard let interfaceController else { return }
    showNavigationAlert(title: category.label, subtitle: "Finding nearby places…")
    searchRequestGeneration &+= 1
    let requestGeneration = searchRequestGeneration
    searchTask?.cancel()
    searchTask = Task { [weak self] in
      do {
        let client = try NavOSSNavigationAPIClient()
        let matches = try await client.search(
          query: category.query,
          proximity: NavOSSNavigationService.shared.currentCoordinate(),
          category: category.category
        )
        guard !Task.isCancelled, let self,
          requestGeneration == self.searchRequestGeneration
        else { return }
        self.searchTask = nil
        self.searchDestinationsByIdentifier = Dictionary(
          uniqueKeysWithValues: matches.map { ($0.id, $0) }
        )
        _ = await self.mapTemplate?.dismissNavigationAlert(animated: true)
        let template = CPListTemplate(
          title: category.label,
          sections: [CPListSection(items: matches.map { self.destinationItem($0) })]
        )
        interfaceController.pushTemplate(template, animated: true, completion: nil)
      } catch {
        guard !Task.isCancelled, let self,
          requestGeneration == self.searchRequestGeneration
        else { return }
        self.searchTask = nil
        self.showNavigationAlert(
          title: "Search unavailable",
          subtitle: "Check your connection and try again."
        )
      }
    }
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
      muteGuidanceMapButton.image = audioModeImage(preferencesStore.load().audioMode)
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
      placesTemplate.updateSections(placesTemplateSections())
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
    routePreviewReplacesActiveTrip = false
    destinationSelectionMode = .newTrip
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
    if let interfaceController, interfaceController.topTemplate !== mapTemplate {
      interfaceController.popToRootTemplate(animated: true, completion: nil)
    }
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
      self?.selectDestination(destination)
    }
    return item
  }

  private func selectDestination(_ destination: NavOSSCarPlayDestination) {
    switch destinationSelectionMode {
    case .addStop:
      returnToMapAndLoadStopRoute(adding: destination)
    case .newTrip:
      returnToMapAndLoadRoutes(to: destination)
    }
  }

  private func uniqueDestinations(
    _ destinations: [NavOSSCarPlayDestination],
    limit: Int = 8
  ) -> [NavOSSCarPlayDestination] {
    var seen: Set<String> = []
    return destinations.filter { seen.insert($0.id).inserted }.prefix(limit).map { $0 }
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

  private func returnToMapAndLoadStopRoute(adding stop: NavOSSCarPlayDestination) {
    guard let interfaceController else { return }
    interfaceController.popToRootTemplate(animated: true) { [weak self] _, error in
      guard error == nil else { return }
      self?.loadStopRoute(adding: stop)
    }
  }

  private func loadStopRoute(adding stop: NavOSSCarPlayDestination) {
    let state = NavOSSCarPlayTripStore.shared.snapshot()
    guard let trip = state.trip, state.guidance?.phase == .navigating else {
      showNavigationAlert(title: "Trip unavailable", subtitle: "Start navigation and try again.")
      return
    }
    guard stop.id != trip.destination.id else {
      showNavigationAlert(title: "Already on this trip", subtitle: "Choose a different stop.")
      return
    }
    let remainingWaypoints = navOSSRemainingWaypoints(in: trip, after: state.routeProgress)
    guard remainingWaypoints.count < 8 else {
      showNavigationAlert(
        title: "Stop limit reached",
        subtitle: "Remove a stop on the phone before adding another."
      )
      return
    }
    guard let origin = NavOSSNavigationService.shared.currentRouteOrigin() else {
      showNavigationAlert(
        title: "Current location unavailable",
        subtitle: "Wait for a GPS position, then try again."
      )
      return
    }
    let waypoints = [stop] + remainingWaypoints.filter { $0.id != stop.id }
    routeRequestGeneration &+= 1
    let requestGeneration = routeRequestGeneration
    routeTask?.cancel()
    showNavigationAlert(title: stop.name, subtitle: "Finding routes with this stop…")
    routeTask = Task { [weak self] in
      do {
        let client = try NavOSSNavigationAPIClient()
        let routes = try await client.routes(
          origin: origin.coordinate,
          originHeadingDegrees: origin.headingDegrees,
          originHorizontalAccuracyMeters: origin.horizontalAccuracyMeters,
          destination: trip.destination,
          preferences: trip.preferences,
          alternatives: 2,
          waypoints: waypoints
        )
        guard !Task.isCancelled, let self,
          requestGeneration == self.routeRequestGeneration
        else { return }
        self.routeTask = nil
        _ = await self.mapTemplate?.dismissNavigationAlert(animated: true)
        guard !Task.isCancelled,
          requestGeneration == self.routeRequestGeneration
        else { return }
        self.showRoutePreviews(routes, replacingActiveTrip: true)
      } catch {
        guard !Task.isCancelled, let self,
          requestGeneration == self.routeRequestGeneration
        else { return }
        self.routeTask = nil
        self.showNavigationAlert(
          title: "Stop unavailable",
          subtitle: "No route through this stop was found."
        )
      }
    }
  }

  private func loadActiveRouteAlternatives() {
    let state = NavOSSCarPlayTripStore.shared.snapshot()
    guard let trip = state.trip, state.guidance?.phase == .navigating else {
      showNavigationAlert(title: "Trip unavailable", subtitle: "Start navigation and try again.")
      return
    }
    guard let origin = NavOSSNavigationService.shared.currentRouteOrigin() else {
      showNavigationAlert(
        title: "Current location unavailable",
        subtitle: "Wait for a GPS position, then try again."
      )
      return
    }
    routeRequestGeneration &+= 1
    let requestGeneration = routeRequestGeneration
    routeTask?.cancel()
    showNavigationAlert(title: "Alternate routes", subtitle: "Finding routes from here…")
    routeTask = Task { [weak self] in
      do {
        let client = try NavOSSNavigationAPIClient()
        let routes = try await client.routes(
          origin: origin.coordinate,
          originHeadingDegrees: origin.headingDegrees,
          originHorizontalAccuracyMeters: origin.horizontalAccuracyMeters,
          destination: trip.destination,
          preferences: trip.preferences,
          alternatives: 2,
          waypoints: navOSSRemainingWaypoints(in: trip, after: state.routeProgress)
        )
        guard !Task.isCancelled, let self,
          requestGeneration == self.routeRequestGeneration
        else { return }
        self.routeTask = nil
        _ = await self.mapTemplate?.dismissNavigationAlert(animated: true)
        guard !Task.isCancelled,
          requestGeneration == self.routeRequestGeneration
        else { return }
        self.showRoutePreviews(routes, replacingActiveTrip: true)
      } catch {
        guard !Task.isCancelled, let self,
          requestGeneration == self.routeRequestGeneration
        else { return }
        self.routeTask = nil
        self.showNavigationAlert(
          title: "Routes unavailable",
          subtitle: "No alternate route was found."
        )
      }
    }
  }

  private func returnToMapAndLoadActiveRouteAlternatives() {
    guard let interfaceController else { return }
    interfaceController.popToRootTemplate(animated: true) { [weak self] _, error in
      guard error == nil else { return }
      self?.loadActiveRouteAlternatives()
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
    guard let origin = NavOSSNavigationService.shared.currentRouteOrigin() else {
      showNavigationAlert(
        title: "Current location unavailable",
        subtitle: "Wait for a GPS position, then try again."
      )
      return
    }
    showNavigationAlert(title: destination.name, subtitle: "Finding routes…")
    let routePreferences = preferencesStore.load().routePreferences
    routeTask = Task { [weak self] in
      do {
        let client = try NavOSSNavigationAPIClient()
        let routes = try await client.routes(
          origin: origin.coordinate,
          originHeadingDegrees: origin.headingDegrees,
          originHorizontalAccuracyMeters: origin.horizontalAccuracyMeters,
          destination: destination,
          preferences: routePreferences,
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

  private func showRoutePreviews(
    _ routes: [NavOSSCarPlayTrip],
    replacingActiveTrip: Bool = false
  ) {
    guard mapTemplate != nil, !routes.isEmpty else {
      return
    }
    guard
      replacingActiveTrip
        || NavOSSCarPlayTripStore.shared.snapshot().guidance?.phase != .navigating
    else { return }
    routeChoicesByIdentifier = Dictionary(uniqueKeysWithValues: routes.map { ($0.id, $0) })
    isPreviewingRoutes = true
    routePreviewReplacesActiveTrip = replacingActiveTrip
    let systemTrip = makeSystemTrip(routes)
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
      guard let self else { return }
      self.mapTemplate?.showRouteChoicesPreview(for: systemTrip, textConfiguration: nil)
      if let firstRoute = routes.first {
        self.mapViewController?.display(
          route: firstRoute.geometry,
          routeId: firstRoute.id,
          activeGuidance: false,
          alternateRoute: routes.dropFirst().first?.geometry
        )
      }
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
    let alternateRoute = trip.routeChoices.lazy.compactMap { choice -> NavOSSCarPlayTrip? in
      guard let choiceIdentifier = choice.userInfo as? String,
        choiceIdentifier != route.id
      else { return nil }
      return self.routeChoicesByIdentifier[choiceIdentifier]
    }.first
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
      routePreviewReplacesActiveTrip = false
      destinationSelectionMode = .newTrip
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
    let previousNavigationSession = navigationSession
    let previousActiveDestinationId = activeDestinationId
    let previousActiveSystemTrip = activeSystemTrip
    let previousActiveTripId = activeTripId
    let previousActiveManeuver = activeManeuver
    let previousActiveManeuverKey = activeManeuverKey
    do {
      let replacesActiveTrip = routePreviewReplacesActiveTrip
      routeRequestGeneration &+= 1
      routeTask?.cancel()
      routeTask = nil
      activeDestinationId = route.destination.id
      activeSystemTrip = trip
      activeTripId = route.id
      isPreviewingRoutes = false
      routePreviewReplacesActiveTrip = false
      destinationSelectionMode = .newTrip
      if replacesActiveTrip {
        navigationSession = nil
        activeManeuver = nil
        activeManeuverKey = nil
      }
      try NavOSSNavigationService.shared.startNavigation(route)
      if replacesActiveTrip {
        previousNavigationSession?.cancelTrip()
      }
      navigationSession = mapTemplate.startNavigationSession(for: trip)
      activeManeuver = nil
      activeManeuverKey = nil
      routeChoicesByIdentifier = [:]
      apply(NavOSSCarPlayTripStore.shared.snapshot())
    } catch {
      activeDestinationId = previousActiveDestinationId
      activeSystemTrip = previousActiveSystemTrip
      activeTripId = previousActiveTripId
      activeManeuver = previousActiveManeuver
      activeManeuverKey = previousActiveManeuverKey
      navigationSession = previousNavigationSession
      mapTemplate.hideTripPreviews()
      apply(NavOSSCarPlayTripStore.shared.snapshot())
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
        let matches = self?.uniqueDestinations(localMatches + remoteMatches) ?? []
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
    selectDestination(destination)
  }
}
