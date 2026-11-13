import CarPlay
import MapKit
internal import NavOSSNavigation
import UIKit

@objc(NavOSSCarPlaySceneDelegate)
@MainActor
final class NavOSSCarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate,
  CPInterfaceControllerDelegate, CPMapTemplateDelegate, CPSearchTemplateDelegate
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
    case changeDestination
    case newTrip
  }

  private enum DestinationSearchResult {
    case cancelled
    case results([NavOSSCarPlayDestination], remoteSearchFailed: Bool)
  }

  private enum SettingsCategory {
    case alertOptions
    case community
    case drivingAvatar
    case mapColors
    case mapDisplay
    case mapOrientation
    case rerouting
    case routeOptions
    case speedingWarning
    case volume

    var sectionHeader: String {
      switch self {
      case .alertOptions, .volume: "Sound"
      case .community: "Community"
      case .drivingAvatar: "Vehicle marker"
      case .mapColors: "Map appearance"
      case .mapDisplay: "Map content"
      case .mapOrientation: "Map orientation"
      case .rerouting: "Rerouting"
      case .routeOptions: "Route options"
      case .speedingWarning: "Speeding warning"
      }
    }

    var title: String {
      switch self {
      case .alertOptions: "Alert options"
      case .community: "Community"
      case .drivingAvatar: "Driving avatar"
      case .mapColors: "Map colors"
      case .mapDisplay: "Map display"
      case .mapOrientation: "Map orientation"
      case .rerouting: "Rerouting"
      case .routeOptions: "Route options"
      case .speedingWarning: "Speeding warning"
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
  /// Maneuvers for the trip in `maneuverTripId`, keyed by the step that begins with each one. All
  /// of them are added to the navigation session up front, as CarPlay asks, so the instrument
  /// cluster and Dashboard can show what comes next.
  private var maneuversByStep: [Int: CPManeuver] = [:]
  private var laneGuidanceByStep: [Int: NSObject] = [:]
  private var maneuverTripId: String?
  private var upcomingManeuverSteps: [Int] = []
  private var presentedArrivalTripId: String?
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
  private var searchDebounceTask: Task<Void, Never>?
  private var pendingSearchCompletion: (([CPListItem]) -> Void)?
  private var lastSearchItems: [CPListItem] = []
  private var voiceSearchCoordinator: NavOSSCarPlayVoiceSearchCoordinator?
  private var destinationObserver: NSObjectProtocol?
  private var intentObserver: NSObjectProtocol?
  private var liveGuidanceObservers: [NSObjectProtocol] = []
  private var placesTemplate: CPListTemplate?
  private var stateObserver: NSObjectProtocol?
  private var settingsAudioOnly = false
  private var settingsCategory: SettingsCategory?
  private var settingsTemplate: CPListTemplate?
  private var routeChoicesByIdentifier: [String: NavOSSCarPlayTrip] = [:]
  private var routePreviewLocationLease: UUID?
  private var searchDestinationsByIdentifier: [String: NavOSSCarPlayDestination] = [:]

  /// Returning to NavOSS (from Music, a call, or another CarPlay app) keeps the driver's place:
  /// the template stack, an open route preview, and its choices survive. Only state that changed
  /// while away is refreshed, and a preview that a phone-started trip made stale is dropped.
  func sceneDidBecomeActive(_ scene: UIScene) {
    guard interfaceController != nil, let mapTemplate else { return }
    mapViewController?.setIdleLocationTrackingEnabled(true)
    let state = NavOSSCarPlayTripStore.shared.snapshot()
    switch navOSSCarPlayPreviewResumeAction(
      isPreviewing: isPreviewingRoutes,
      previewReplacesActiveTrip: routePreviewReplacesActiveTrip,
      guidancePhase: state.guidance?.phase
    ) {
    case .discard:
      discardRoutePreview(in: mapTemplate)
    case .keep:
      if routePreviewLocationLease == nil {
        routePreviewLocationLease = NavOSSNavigationService.shared.beginCarPlayRoutePlanning()
      }
    case .none:
      break
    }
    if !isPreviewingRoutes {
      if state.trip != nil {
        apply(state)
      } else {
        mapViewController?.clearRoute()
      }
    }
    placesTemplate?.updateSections(placesTemplateSections())
    performPendingDashboardAction()
    performPendingIntentRequest()
  }

  /// Leaving NavOSS keeps in-flight searches and route requests so their results are waiting on
  /// return, but releases location work that only an idle, visible map needs.
  func sceneWillResignActive(_ scene: UIScene) {
    voiceSearchCoordinator?.cancel()
    if NavOSSCarPlayTripStore.shared.snapshot().trip == nil {
      mapViewController?.setIdleLocationTrackingEnabled(false)
      finishRoutePreviewLocationLease()
      NavOSSNavigationService.shared.finishCarPlayRoutePlanning()
    }
  }

  private func discardRoutePreview(in mapTemplate: CPMapTemplate) {
    routeRequestGeneration &+= 1
    routeTask?.cancel()
    routeTask = nil
    routeChoicesByIdentifier = [:]
    finishRoutePreviewLocationLease()
    isPreviewingRoutes = false
    routePreviewReplacesActiveTrip = false
    destinationSelectionMode = .newTrip
    mapTemplate.hideTripPreviews()
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    guard userActivity.activityType == NavOSSCarPlayDashboardAction.activityType,
      let rawAction = userActivity.userInfo?["action"] as? String,
      let action = NavOSSCarPlayDashboardAction(rawValue: rawAction)
    else { return }
    let identifier =
      (userActivity.userInfo?["identifier"] as? String).flatMap(UUID.init(uuidString:))
      ?? UUID()
    NavOSSCarPlayDashboardActionStore.stage(action, identifier: identifier)
    performPendingDashboardAction()
  }

  /// Takes a destination Siri handed over and shows its routes, or alternatives to it from the
  /// current trip. Guidance never starts without the driver tapping Go.
  private func performPendingIntentRequest() {
    guard interfaceController != nil, let destination = NavOSSCarPlayIntentRequests.take() else {
      return
    }
    if NavOSSCarPlayTripStore.shared.snapshot().guidance?.phase == .navigating {
      destinationSelectionMode = .changeDestination
      returnToMapAndLoadReplacementRoute(to: destination)
    } else {
      destinationSelectionMode = .newTrip
      returnToMapAndLoadRoutes(to: destination)
    }
  }

  private func performPendingDashboardAction() {
    // Readiness is passed in so the queue enforces the ordering; see the queue's `take(isReady:)`.
    guard
      let action = NavOSSCarPlayDashboardActionStore.take(isReady: interfaceController != nil)
    else { return }
    switch action {
    case .go:
      showPlaces()
    case .voice:
      showVoiceSearch()
    }
  }

  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController,
    to window: CPWindow
  ) {
    self.interfaceController = interfaceController
    interfaceController.delegate = self
    voiceSearchCoordinator = NavOSSCarPlayVoiceSearchCoordinator(
      interfaceController: interfaceController,
      onRecognizedQuery: { [weak self] query in
        self?.showVoiceSearchResults(for: query)
      },
      onFailure: { [weak self] title, detail in
        self?.showVoiceSearchRetry(title: title, detail: detail)
      }
    )
    carWindow = window

    let mapViewController = NavOSSCarPlayMapViewController()
    let preferences = preferencesStore.load()
    mapViewController.applyContentStyle(templateApplicationScene.contentStyle)
    mapViewController.applyAppearance(preferences.appearance)
    mapViewController.applyMapPreferences(
      showsPointsOfInterest: preferences.showsPointsOfInterest,
      vehicleMarker: preferences.vehicleMarker
    )
    mapViewController.applyMapOrientation(preferences.mapOrientation)
    NavOSSNavigationService.shared.setAudioMode(preferences.audioMode)
    // Location tracking for this scene must be live before the first `recenter()`, or its
    // one-shot `NavOSSNavigationService.shared.currentCoordinate()` fallback — the only source of
    // a usable position before any live fix arrives — finds nothing and leaves the camera on its
    // hard-coded startup default.
    NavOSSNavigationService.shared.setCarPlayConnected(true, scene: "template")
    self.mapViewController = mapViewController
    window.rootViewController = mapViewController
    mapViewController.anchorsSpeedHUDToViewBounds = true
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
        NavOSSCarPlayIntentRequests.refreshSuggestedPlaces()
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
    liveGuidanceObservers = [
      NotificationCenter.default.addObserver(
        forName: .navOSSNavigationSnapshotDidChange,
        object: NavOSSNavigationService.shared,
        queue: .main
      ) { [weak self] _ in
        MainActor.assumeIsolated {
          guard let self, self.navigationSession != nil else { return }
          self.apply(NavOSSCarPlayTripStore.shared.snapshot())
        }
      },
      NotificationCenter.default.addObserver(
        forName: .navOSSNavigationPreferencesDidChange,
        object: NavOSSNavigationPreferencesStore.shared,
        queue: .main
      ) { [weak self] _ in
        MainActor.assumeIsolated {
          self?.applySharedPreferences()
        }
      },
      // Traffic-sharing state and community preferences shown in Settings ▸ Community.
      NotificationCenter.default.addObserver(
        forName: .navOSSCommunityStateDidChange,
        object: NavOSSCommunityService.shared,
        queue: .main
      ) { [weak self] _ in
        MainActor.assumeIsolated {
          guard let self, self.settingsCategory == .community else { return }
          self.settingsTemplate?.updateSections(self.settingsSections(category: .community))
        }
      },
    ]
    Task { await NavOSSCommunityService.shared.refreshFeatures() }
    intentObserver = NotificationCenter.default.addObserver(
      forName: .navOSSCarPlayIntentDestinationRequested,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated {
        self?.performPendingIntentRequest()
      }
    }
    NavOSSCarPlayTripStore.shared.setConnected(true)
    apply(NavOSSCarPlayTripStore.shared.snapshot())
    performPendingDashboardAction()
    performPendingIntentRequest()
    NavOSSCarPlayIntentRequests.refreshSuggestedPlaces()
  }

  /// The vehicle's suggested map style changed, typically at dusk or when headlights come on.
  func contentStyleDidChange(_ contentStyle: UIUserInterfaceStyle) {
    mapViewController?.applyContentStyle(contentStyle)
  }

  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnect interfaceController: CPInterfaceController,
    from window: CPWindow
  ) {
    voiceSearchCoordinator?.invalidate()
    voiceSearchCoordinator = nil
    interfaceController.delegate = nil
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
    if let intentObserver {
      NotificationCenter.default.removeObserver(intentObserver)
      self.intentObserver = nil
    }
    liveGuidanceObservers.forEach(NotificationCenter.default.removeObserver)
    liveGuidanceObservers = []
    presentedRerouteProposalId = nil
    rerouteProposalAlert = nil
    presentedCameraAlertSequence = nil
    routeRequestGeneration &+= 1
    routeTask?.cancel()
    routeTask = nil
    searchRequestGeneration &+= 1
    searchTask?.cancel()
    searchTask = nil
    finishRoutePreviewLocationLease()
    mapViewController?.clearRoute()
    mapViewController?.deactivate()
    navigationSession?.finishTrip()
    navigationSession = nil
    resetManeuvers()
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
    NavOSSNavigationService.shared.setCarPlayConnected(false, scene: "template")
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
    // Reporting is one tap from the driving map and one more for the type; the Trip list (the
    // navigation bar's Trip button) keeps stops, routes, and End.
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
      finishRoutePreviewLocationLease()
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
      resetManeuvers()
      activeDestinationId = nil
      activeSystemTrip = nil
      activeTripId = nil
      presentedArrivalTripId = nil
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
    let presentation = state.guidance.flatMap {
      navOSSCarPlayGuidancePresentation(trip: trip, guidance: $0)
    }
    let live = NavOSSNavigationService.shared.carPlayLiveGuidance()
    mapViewController?.display(
      route: trip.geometry,
      routeId: trip.id,
      activeGuidance: activeGuidance,
      position: state.position,
      routeProgress: state.routeProgress,
      distanceToManeuverMeters: state.guidance?.distanceToManeuverMeters,
      speedLimitKph: live.speedLimitKph,
      overlay: NavOSSCarPlayGuidanceOverlay(
        maneuverArrow: presentation.map {
          navOSSCarPlayManeuverArrow(trip: trip, maneuverStepIndex: $0.primary.stepIndex)
        } ?? [],
        currentRoadName: live.currentRoadName ?? presentation?.currentRoadName,
        congestion: trip.congestion,
        speeding: live.speedingState
      )
    )

    if activeGuidance
      && (activeDestinationId != trip.destination.id || activeSystemTrip == nil)
    {
      navigationSession?.finishTrip()
      resetManeuvers()
      let systemTrip = makeSystemTrip(trip)
      activeDestinationId = trip.destination.id
      activeSystemTrip = systemTrip
      activeTripId = trip.id
      navigationSession = mapTemplate?.startNavigationSession(for: systemTrip)
    } else if activeGuidance, activeTripId != trip.id {
      // Same destination, new route: the navigation service rerouted from the driver's position.
      // A route the driver chose in CarPlay updates `activeTripId` before it is published, so it
      // never reaches this branch.
      activeTripId = trip.id
      if acceptedRerouteProposal {
        acceptedRerouteProposal = false
      } else {
        showNavigationAlert(
          title: "New route",
          subtitle: "Rerouted from your current position.",
          imageSystemName: "arrow.triangle.branch",
          duration: 4
        )
      }
    }
    if activeGuidance {
      prepareManeuvers(for: trip)
    }

    guard let guidance = state.guidance else {
      updateTripEstimates(
        distanceMeters: trip.distanceMeters,
        durationSeconds: trip.durationSeconds
      )
      return
    }
    updateGuidance(
      guidance,
      trip: trip,
      presentation: presentation,
      currentRoadName: live.currentRoadName ?? presentation?.currentRoadName,
      position: state.position
    )
    presentLiveAlerts(live)
  }

  // MARK: Live alerts

  private var presentedRerouteProposalId: String?
  private var rerouteProposalAlert: CPNavigationAlert?
  private var presentedCameraAlertSequence: Int?
  private var acceptedRerouteProposal = false

  /// Ask-first reroute proposals and safety-camera alerts from the navigation core. Each is shown
  /// once; a proposal the core withdraws is dismissed.
  private func presentLiveAlerts(_ live: NavOSSCarPlayLiveGuidance) {
    guard let mapTemplate, navigationSession != nil else { return }
    if let proposal = live.rerouteProposal {
      if presentedRerouteProposalId != proposal.id {
        presentedRerouteProposalId = proposal.id
        let text = navOSSCarPlayRerouteProposalText(proposal)
        let alert = CPNavigationAlert(
          titleVariants: [text.title],
          subtitleVariants: [text.subtitle],
          image: UIImage(systemName: "arrow.triangle.branch"),
          primaryAction: CPAlertAction(title: "Use new route", style: .default) { [weak self] _ in
            // The driver just chose this route; do not announce it again as a reroute.
            self?.acceptedRerouteProposal = true
            NavOSSNavigationService.shared.acceptRerouteProposal(id: proposal.id)
          },
          secondaryAction: CPAlertAction(title: "Keep mine", style: .cancel) { _ in
            NavOSSNavigationService.shared.declineRerouteProposal(id: proposal.id)
          },
          duration: 0
        )
        rerouteProposalAlert = alert
        presentNavigationAlert(alert, on: mapTemplate)
      }
    } else if presentedRerouteProposalId != nil {
      presentedRerouteProposalId = nil
      if let rerouteProposalAlert, mapTemplate.currentNavigationAlert === rerouteProposalAlert {
        mapTemplate.dismissNavigationAlert(animated: true) { _ in }
      }
      rerouteProposalAlert = nil
    }

    if let camera = live.safetyCameraAlert {
      NavOSSCarPlayMapAlertStore.shared.publish(
        camera.coordinate.map {
          [NavOSSCarPlayMapAlert(id: "camera-\(camera.cameraId)", kind: .redLightAndSpeedCamera, coordinate: $0)]
        } ?? [],
        source: .cameras
      )
      if presentedCameraAlertSequence != camera.sequence, live.rerouteProposal == nil {
        presentedCameraAlertSequence = camera.sequence
        showNavigationAlert(
          title: "Safety camera ahead",
          subtitle: "\(navOSSCarPlayDistanceLabel(camera.distanceAheadMeters)) · \(camera.location)",
          imageSystemName: "camera.fill",
          duration: 6
        )
      }
    } else if presentedCameraAlertSequence != nil {
      presentedCameraAlertSequence = nil
      NavOSSCarPlayMapAlertStore.shared.publish([], source: .cameras)
    }
    presentCommunityAlerts(on: mapTemplate)
  }

  // MARK: Community reports

  private var presentedReportAlertSequence: Int?
  private var presentedStillThereSequence: Int?

  /// A short banner for a report ahead, and "Still there?" once one is passed. The core decides
  /// when (after passing, never near a maneuver); this only presents. A prompt waits while
  /// another alert (reroute proposal, camera) is on screen and is never stacked over one.
  private func presentCommunityAlerts(on mapTemplate: CPMapTemplate) {
    let alerts = NavOSSCommunityService.shared.navigationAlerts()
    if let alert = alerts.reportAlert, presentedReportAlertSequence != alert.sequence,
      mapTemplate.currentNavigationAlert == nil
    {
      presentedReportAlertSequence = alert.sequence
      showNavigationAlert(
        title: navOSSCarPlayCommunityAlertTitle(alert.type),
        subtitle: "\(navOSSCarPlayDistanceLabel(alert.distanceAheadMeters)) · Reported by NavOSS drivers",
        imageSystemName: reportSymbolName(alert.type),
        duration: 6
      )
    }
    guard let prompt = alerts.stillTherePrompt, presentedStillThereSequence != prompt.sequence,
      mapTemplate.currentNavigationAlert == nil
    else {
      return
    }
    presentedStillThereSequence = prompt.sequence
    // Shown once: Present and Not present send a vote; letting it time out is Dismiss and sends
    // nothing. Either way the core will not ask about this report again.
    NavOSSCommunityService.shared.dismissStillThere(reportId: prompt.reportId)
    let vote: (NavOSSCommunityVote) -> Void = { vote in
      guard let coordinate = NavOSSNavigationService.shared.currentCoordinate() else { return }
      Task {
        _ = try? await NavOSSCommunityService.shared.vote(
          reportId: prompt.reportId, vote: vote, observedAt: coordinate)
      }
    }
    let alert = CPNavigationAlert(
      titleVariants: ["\(prompt.type.label) still there?"],
      subtitleVariants: ["Reported by NavOSS drivers"],
      image: UIImage(systemName: reportSymbolName(prompt.type)),
      primaryAction: CPAlertAction(title: "Still there", style: .default) { _ in vote(.present) },
      secondaryAction: CPAlertAction(title: "Not there", style: .cancel) { _ in
        vote(.notPresent)
      },
      duration: 10
    )
    presentNavigationAlert(alert, on: mapTemplate)
  }

  private func communitySection() -> CPListSection {
    let community = NavOSSCommunityService.shared
    let preferences = community.preferences()
    let trafficItem = CPListItem(
      text: selectedTitle("Share traffic speeds", selected: preferences.sharesTrafficSpeeds),
      detailText: preferences.sharesTrafficSpeeds
        ? "Anonymous speeds during guidance, never trip ends"
        : "Off",
      image: UIImage(systemName: "car.2.fill")
    )
    trafficItem.handler = { _, completion in
      completion()
      let store = NavOSSCommunityPreferencesStore.shared
      store.setSharesTrafficSpeeds(!store.load().sharesTrafficSpeeds)
    }
    let announceItem = CPListItem(
      text: selectedTitle("Spoken road reports", selected: preferences.announcesRoadReports),
      detailText: preferences.announcesRoadReports
        ? "Says a short alert for a report ahead"
        : "Visual only",
      image: UIImage(systemName: "speaker.wave.2.fill")
    )
    announceItem.handler = { _, completion in
      completion()
      let store = NavOSSCommunityPreferencesStore.shared
      store.setAnnouncesRoadReports(!store.load().announcesRoadReports)
    }
    return CPListSection(
      items: [trafficItem, announceItem], header: "Community", sectionIndexTitle: nil)
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
    let routeChoiceDetails = navOSSCarPlayRouteChoiceDetails(routes)
    let fastestIndex = navOSSCarPlayFastestRouteIndex(routes) ?? 0
    let routeChoices = routes.enumerated().map { index, route in
      let routeDetail = routeChoiceDetails[index]
      let isFastest = index == fastestIndex
      let alternativeNumber = index < fastestIndex ? index + 1 : index
      let routeName = isFastest ? "Fastest route" : "Alternative \(alternativeNumber)"
      let summary = routeDetail.map { "\(routeName) · \($0)" } ?? routeName
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

  private func resetManeuvers() {
    maneuversByStep = [:]
    laneGuidanceByStep = [:]
    maneuverTripId = nil
    upcomingManeuverSteps = []
  }

  /// Builds every maneuver (and lane guidance, when the route has lanes) for `trip` once, and adds
  /// them to the session in route order.
  private func prepareManeuvers(for trip: NavOSSCarPlayTrip) {
    guard let navigationSession, maneuverTripId != trip.id else { return }
    maneuversByStep = [:]
    laneGuidanceByStep = [:]
    upcomingManeuverSteps = []
    maneuverTripId = trip.id
    var orderedManeuvers: [CPManeuver] = []
    var orderedLaneGuidance: [NSObject] = []
    for stepIndex in trip.steps.indices.dropFirst() {
      guard let info = navOSSCarPlayManeuverInfo(trip: trip, stepIndex: stepIndex) else { continue }
      let maneuver = makeManeuver(info)
      if #available(iOS 18.0, *), let specs = info.lanes {
        let laneGuidance = makeLaneGuidance(specs, instruction: info.instructionVariants[0])
        maneuver.linkedLaneGuidance = laneGuidance
        laneGuidanceByStep[stepIndex] = laneGuidance
        orderedLaneGuidance.append(laneGuidance)
      }
      maneuversByStep[stepIndex] = maneuver
      orderedManeuvers.append(maneuver)
    }
    if #available(iOS 17.4, *) {
      navigationSession.add(orderedManeuvers)
      if let laneGuidance = orderedLaneGuidance as? [CPLaneGuidance], !laneGuidance.isEmpty {
        navigationSession.add(laneGuidance)
      }
    }
  }

  private func makeManeuver(_ info: NavOSSCarPlayManeuverInfo) -> CPManeuver {
    let maneuver = CPManeuver()
    maneuver.instructionVariants = info.instructionVariants
    maneuver.dashboardInstructionVariants = info.instructionVariants
    maneuver.notificationInstructionVariants = info.instructionVariants
    let symbol = NavOSSCarPlayManeuverSymbols.image(
      kind: info.kind,
      angleDegrees: info.turnAngleDegrees
    )
    maneuver.symbolImage = symbol
    maneuver.dashboardSymbolImage = symbol
    maneuver.notificationSymbolImage = symbol
    maneuver.initialTravelEstimates = travelEstimates(
      distanceMeters: info.legDistanceMeters,
      durationSeconds: info.legDurationSeconds
    )
    maneuver.userInfo = info.stepIndex
    if #available(iOS 17.4, *) {
      maneuver.maneuverType = NavOSSCarPlayManeuverSymbols.maneuverType(info.kind)
      maneuver.roadFollowingManeuverVariants = info.roadName.map { [$0] }
      maneuver.trafficSide = .right
      if case .roundabout = info.kind {
        maneuver.junctionType = .roundabout
      } else {
        maneuver.junctionType = .intersection
      }
      if !info.kind.isArrival {
        maneuver.junctionExitAngle = Measurement(value: info.turnAngleDegrees, unit: .degrees)
      }
      if let highwayExitLabel = info.highwayExitLabel {
        maneuver.highwayExitLabel = highwayExitLabel
      }
    }
    return maneuver
  }

  @available(iOS 18.0, *)
  private func makeLaneGuidance(
    _ specs: [NavOSSCarPlayLaneSpec],
    instruction: String
  ) -> CPLaneGuidance {
    let laneGuidance = CPLaneGuidance()
    laneGuidance.lanes = specs.map { spec in
      let angles = spec.angles.map { Measurement(value: $0, unit: UnitAngle.degrees) }
      guard let highlighted = spec.highlightedAngle, spec.status != .notGood else {
        return CPLane(angles: angles)
      }
      return CPLane(
        angles: angles,
        highlightedAngle: Measurement(value: highlighted, unit: UnitAngle.degrees),
        isPreferred: spec.status == .preferred
      )
    }
    laneGuidance.instructionVariants = [instruction]
    return laneGuidance
  }

  private func updateGuidance(
    _ guidance: NavOSSCarPlayGuidance,
    trip: NavOSSCarPlayTrip,
    presentation: NavOSSCarPlayGuidancePresentation?,
    currentRoadName: String?,
    position: NavOSSCarPlayPosition?
  ) {
    guard let navigationSession else {
      return
    }
    updateTripEstimates(
      distanceMeters: guidance.remainingDistanceMeters,
      durationSeconds: guidance.remainingDurationSeconds
    )

    if guidance.phase == .arrived {
      presentArrival(for: trip, session: navigationSession)
      return
    }

    guard let presentation, let primary = maneuversByStep[presentation.primary.stepIndex] else {
      return
    }
    let steps = [presentation.primary.stepIndex] + (presentation.then.map { [$0.stepIndex] } ?? [])
    if steps != upcomingManeuverSteps {
      upcomingManeuverSteps = steps
      navigationSession.upcomingManeuvers = steps.compactMap { maneuversByStep[$0] }
    }
    navigationSession.updateEstimates(
      travelEstimates(
        distanceMeters: guidance.distanceToManeuverMeters,
        durationSeconds: guidance.durationToManeuverSeconds
      ),
      for: primary
    )
    if #available(iOS 17.4, *) {
      navigationSession.currentRoadNameVariants = currentRoadName.map { [$0] } ?? []
      let phase = navOSSCarPlayManeuverPhase(
        distanceToManeuverMeters: guidance.distanceToManeuverMeters,
        speedMetersPerSecond: position?.speedMetersPerSecond
      )
      navigationSession.maneuverState =
        switch phase {
        case .continuing: .continue
        case .initial: .initial
        case .prepare: .prepare
        case .execute: .execute
        }
      // Lanes matter only on the approach; showing them for a turn kilometres away is noise.
      let showsLanes = phase == .prepare || phase == .execute
      let laneGuidance =
        showsLanes ? laneGuidanceByStep[presentation.primary.stepIndex] as? CPLaneGuidance : nil
      if navigationSession.currentLaneGuidance !== laneGuidance {
        navigationSession.currentLaneGuidance = laneGuidance
      }
    }
  }

  /// Arrival keeps the trip on screen, paused with an arrival card, and offers Done. The trip ends
  /// when the driver taps Done, End, or the phone ends it.
  private func presentArrival(for trip: NavOSSCarPlayTrip, session: CPNavigationSession) {
    guard presentedArrivalTripId != trip.id else { return }
    presentedArrivalTripId = trip.id
    upcomingManeuverSteps = []
    session.pauseTrip(for: .arrived, description: trip.destination.name)
    guard let mapTemplate else { return }
    let alert = CPNavigationAlert(
      titleVariants: ["You've arrived", "Arrived"],
      subtitleVariants: [trip.destination.name],
      image: UIImage(systemName: "flag.checkered"),
      primaryAction: CPAlertAction(title: "Done", style: .default) { [weak self] _ in
        self?.endNavigation()
      },
      secondaryAction: CPAlertAction(title: "Keep map", style: .cancel) { _ in },
      duration: 0
    )
    presentNavigationAlert(alert, on: mapTemplate)
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
    guard let interfaceController, prepareDestinationSearch(selectionMode: selectionMode) else {
      return
    }
    let searchTemplate = CPSearchTemplate()
    searchTemplate.delegate = self
    interfaceController.pushTemplate(searchTemplate, animated: true, completion: nil)
  }

  private func showVoiceSearch(
    selectionMode: DestinationSelectionMode = .newTrip
  ) {
    guard interfaceController != nil, let voiceSearchCoordinator else {
      return
    }
    guard prepareDestinationSearch(selectionMode: selectionMode) else {
      return
    }
    voiceSearchCoordinator.start()
  }

  private func prepareDestinationSearch(selectionMode: DestinationSelectionMode) -> Bool {
    let state = NavOSSCarPlayTripStore.shared.snapshot()
    guard state.guidance?.phase != .navigating || selectionMode != .newTrip else {
      showNavigationAlert(
        title: "Navigation in progress",
        subtitle: "End the current trip before searching for another destination."
      )
      return false
    }
    destinationSelectionMode = selectionMode
    return true
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
        (.rerouting, "arrow.triangle.branch"),
        (.speedingWarning, "gauge.with.dots.needle.67percent"),
        (.community, "person.2.fill"),
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
        // From the driving map's sound button, one tap picks the mode and returns to the map.
        if self.settingsAudioOnly, let template = self.settingsTemplate,
          self.interfaceController?.topTemplate === template
        {
          self.interfaceController?.popToRootTemplate(animated: true, completion: nil)
        }
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
      sections.append(contentsOf: navigationPreferenceSections())
      sections.append(communitySection())
    }
    return sections
  }

  /// Rerouting and speeding settings live in the navigation core's preference store, shared with
  /// the phone; CarPlay only edits them.
  private func navigationPreferenceSections() -> [CPListSection] {
    let store = NavOSSNavigationPreferencesStore.shared
    let preferences = store.load()
    let rerouteItems = NavOSSRerouteMode.allCases.map { mode in
      let detail: String =
        switch mode {
        case .adaptive: "Switch to a new route automatically when you leave yours"
        case .askFirst: "Show the time and distance change; you choose"
        case .keepRoute: "Guide you back onto your chosen route"
        }
      let item = CPListItem(
        text: selectedTitle(mode.label, selected: preferences.rerouteMode == mode),
        detailText: detail,
        image: UIImage(systemName: mode == .keepRoute ? "lock.fill" : "arrow.triangle.branch")
      )
      item.handler = { _, completion in
        completion()
        store.setRerouteMode(mode)
      }
      return item
    }
    let toleranceItems = [0, 5, 10].map { tolerance in
      let item = CPListItem(
        text: selectedTitle(
          tolerance == 0 ? "At the limit" : "\(tolerance) km/h over",
          selected: preferences.speedingToleranceKph == tolerance
        ),
        detailText: "Speed turns red here when the posted limit is known",
        image: UIImage(systemName: "gauge.with.dots.needle.67percent")
      )
      item.handler = { _, completion in
        completion()
        let current = store.load()
        store.setSpeedingWarning(toleranceKph: tolerance, audible: current.speedingAudibleWarning)
      }
      return item
    }
    let audibleItem = CPListItem(
      text: selectedTitle("Spoken reminder", selected: preferences.speedingAudibleWarning),
      detailText: preferences.speedingAudibleWarning
        ? "Says the limit once when speeding starts"
        : "Visual only",
      image: UIImage(systemName: "speaker.wave.2.fill")
    )
    audibleItem.handler = { _, completion in
      completion()
      let current = store.load()
      store.setSpeedingWarning(
        toleranceKph: current.speedingToleranceKph,
        audible: !current.speedingAudibleWarning
      )
    }
    return [
      CPListSection(items: rerouteItems, header: "Rerouting", sectionIndexTitle: nil),
      CPListSection(
        items: toleranceItems + [audibleItem], header: "Speeding warning", sectionIndexTitle: nil),
    ]
  }

  /// Two taps from the driving map: Report, then the type. The grid never blocks guidance, and
  /// saving returns straight to the map with a short confirmation.
  private func showReports() {
    guard let interfaceController else {
      return
    }
    let buttons = NavOSSCarPlayReportType.allCases.map { type in
      CPGridButton(
        titleVariants: [type.label],
        image: carPlayImage(reportSymbolName(type))
      ) { [weak self] _ in
        self?.saveReport(type)
      }
    }
    let template = CPGridTemplate(title: "Report", gridButtons: buttons)
    interfaceController.pushTemplate(template, animated: true, completion: nil)
  }

  private func reportSymbolName(_ type: NavOSSCarPlayReportType) -> String {
    switch type {
    case .collision: "car.side.rear.and.collision.and.car.side.front"
    case .construction: "cone.fill"
    case .objectOnRoad: "shippingbox.fill"
    case .pothole: "exclamationmark.triangle.fill"
    case .roadClosure: "xmark.octagon.fill"
    case .roadHazard: "exclamationmark.triangle"
    case .slowTraffic: "car.2.fill"
    case .stalledVehicle: "car.fill"
    }
  }
  /// Submits to NavOSS community reports when the server has them live and this device can
  /// attest; otherwise keeps the private local draft as before.
  private func saveReport(_ type: NavOSSCarPlayReportType) {
    guard let coordinate = NavOSSNavigationService.shared.currentCoordinate() else {
      interfaceController?.popToRootTemplate(animated: true) { [weak self] _, _ in
        self?.showNavigationAlert(
          title: "Location unavailable",
          subtitle: "Wait for a GPS position, then try again."
        )
      }
      return
    }
    let heading = NavOSSCarPlayTripStore.shared.snapshot().position?.courseDegrees
      .map { Int($0.rounded()) % 360 }
    interfaceController?.popToRootTemplate(animated: true, completion: nil)
    Task { @MainActor [weak self] in
      let community = NavOSSCommunityService.shared
      let live = await community.refreshFeatures()
      let canWrite = await community.availability().canWrite
      guard live, canWrite else {
        self?.saveLocalDraft(type, coordinate: coordinate)
        return
      }
      do {
        _ = try await community.submitReport(type: type, coordinate: coordinate, heading: heading)
        self?.showNavigationAlert(
          title: "\(type.label) reported",
          subtitle: "Sent to NavOSS. Nearby drivers may see it once it is checked.",
          imageSystemName: "checkmark.circle.fill",
          duration: 3
        )
      } catch let failure as NavOSSCommunityFailure {
        self?.showNavigationAlert(
          title: "Report not sent",
          subtitle: navOSSCarPlayCommunityFailureText(failure)
        )
      } catch {
        self?.showNavigationAlert(title: "Report not sent", subtitle: "Try again in a moment.")
      }
    }
  }

  private func saveLocalDraft(_ type: NavOSSCarPlayReportType, coordinate: NavOSSCarPlayCoordinate) {
    guard reportStore.record(type, coordinate: coordinate) != nil else {
      showNavigationAlert(title: "Report not saved", subtitle: "Try again in a moment.")
      return
    }
    showNavigationAlert(
      title: "\(type.label) saved",
      subtitle: "Kept privately on this iPhone. Not shared with other drivers.",
      imageSystemName: "checkmark.circle.fill",
      duration: 3
    )
  }

  private func showPlaces() {
    guard let interfaceController else {
      return
    }
    let hasActiveTrip = NavOSSCarPlayTripStore.shared.snapshot().trip != nil
    destinationSelectionMode = .newTrip
    if !hasActiveTrip {
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

  /// The idle search screen: saved places first, then the most-used nearby categories. Typing and
  /// voice are one tap away in the navigation bar, and every other category is under Categories.
  private func showSearchHub() {
    guard let interfaceController else { return }
    let catalog = NavOSSCarPlayDestinationStore.shared.snapshot()
    func shortcut(
      _ title: String,
      _ symbol: String,
      destination: NavOSSCarPlayDestination?
    ) -> CPGridButton {
      CPGridButton(titleVariants: [title], image: carPlayImage(symbol)) { [weak self] _ in
        guard let self else { return }
        if let destination {
          self.selectDestination(destination)
        } else {
          self.showDestinationList(title: title, destinations: [], emptyDetail: "Set \(title) on your iPhone. Until then, search for it here.")
        }
      }
    }
    func category(_ label: String, _ titleVariants: [String], _ symbol: String) -> CPGridButton {
      CPGridButton(titleVariants: titleVariants, image: carPlayImage(symbol)) { [weak self] _ in
        self?.showSearchCategory(label: label)
      }
    }
    let buttons = [
      shortcut("Home", "house.fill", destination: catalog.home),
      shortcut("Work", "briefcase.fill", destination: catalog.work),
      CPGridButton(
        titleVariants: ["Recents"],
        image: carPlayImage("clock.arrow.circlepath")
      ) { [weak self] _ in
        self?.showDestinationList(
          title: "Recents",
          destinations: NavOSSCarPlayDestinationStore.shared.snapshot().recents,
          emptyDetail: "Places you navigate to appear here."
        )
      },
      CPGridButton(
        titleVariants: ["Saved"],
        image: carPlayImage("star.fill")
      ) { [weak self] _ in
        self?.showDestinationList(
          title: "Saved",
          destinations: NavOSSCarPlayDestinationStore.shared.snapshot().favorites,
          emptyDetail: "Save places on your iPhone to see them here."
        )
      },
      category("Gas", ["Gas", "Gas stations"], "fuelpump.fill"),
      category("Coffee", ["Coffee"], "cup.and.saucer.fill"),
      category("Restaurants", ["Food", "Restaurants"], "fork.knife"),
      category("Parking", ["Parking"], "parkingsign.circle.fill"),
    ]
    let template = CPGridTemplate(title: "Search", gridButtons: buttons)
    template.leadingNavigationBarButtons = [
      CPBarButton(title: "Categories") { [weak self] _ in
        self?.showAllCategories()
      }
    ]
    template.trailingNavigationBarButtons = [
      CPBarButton(image: carPlayImage("keyboard")) { [weak self] _ in
        self?.showSearch()
      },
      CPBarButton(image: carPlayImage("mic.fill")) { [weak self] _ in
        self?.showVoiceSearch()
      },
    ]
    interfaceController.pushTemplate(template, animated: true, completion: nil)
  }

  private func showAllCategories() {
    guard let interfaceController else { return }
    let sections = searchCategoryGroups.map { header, categories in
      CPListSection(
        items: categories.map { category in
          let item = CPListItem(
            text: category.label,
            detailText: nil,
            image: UIImage(systemName: category.systemImageName)
          )
          item.accessoryType = .disclosureIndicator
          item.handler = { [weak self] _, completion in
            completion()
            self?.showCategoryResults(category)
          }
          return item
        },
        header: header,
        sectionIndexTitle: nil
      )
    }
    interfaceController.pushTemplate(
      CPListTemplate(title: "Categories", sections: sections),
      animated: true,
      completion: nil
    )
  }
  private func showDestinationList(
    title: String,
    destinations: [NavOSSCarPlayDestination],
    emptyDetail: String
  ) {
    guard let interfaceController else { return }
    let template = CPListTemplate(title: title, sections: [])
    if destinations.isEmpty {
      template.emptyViewTitleVariants = ["Nothing here yet"]
      template.emptyViewSubtitleVariants = [emptyDetail]
      // An empty list is never a dead end: searching is one tap away.
      let searchItem = CPListItem(
        text: "Search for a place",
        detailText: "Type or say a destination",
        image: UIImage(systemName: "magnifyingglass")
      )
      searchItem.handler = { [weak self] _, completion in
        completion()
        self?.showSearch(selectionMode: self?.destinationSelectionMode ?? .newTrip)
      }
      template.updateSections([CPListSection(items: [searchItem])])
    } else {
      let origin = mapViewController?.currentLocationCoordinate()
        ?? NavOSSNavigationService.shared.currentCoordinate()
      template.updateSections([
        CPListSection(
          items: uniqueDestinations(destinations, limit: 12).map {
            destinationItem($0, distanceFrom: origin)
          }
        )
      ])
    }
    interfaceController.pushTemplate(template, animated: true, completion: nil)
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

  /// Shows the results list immediately in a searching state, so the driver sees progress the
  /// moment the voice sheet closes, then fills it in place.
  private func showVoiceSearchResults(for query: String) {
    guard
      let interfaceController,
      prepareDestinationSearch(selectionMode: destinationSelectionMode)
    else {
      return
    }
    let template = makeLoadingList(title: "“\(query)”", loadingSubtitle: "Searching for places")
    interfaceController.pushTemplate(template, animated: true, completion: nil)
    startDestinationSearch(query: query) { [weak self, weak template] result in
      guard let self, let template else {
        return
      }
      switch result {
      case .cancelled:
        return
      case let .results(matches, remoteSearchFailed):
        guard !matches.isEmpty else {
          self.showListFailure(
            template,
            title: remoteSearchFailed ? "Search unavailable" : "No places found",
            subtitle: remoteSearchFailed
              ? "Check your connection, then try again."
              : "Try a more specific place or address.",
            retry: { [weak self] in self?.showVoiceSearch(selectionMode: self?.destinationSelectionMode ?? .newTrip) },
            retryTitle: "Try voice search again"
          )
          return
        }
        let origin = self.mapViewController?.currentLocationCoordinate()
          ?? NavOSSNavigationService.shared.currentCoordinate()
        var sections = [
          CPListSection(items: matches.map { self.destinationItem($0, distanceFrom: origin) })
        ]
        if remoteSearchFailed {
          sections.insert(
            CPListSection(
              items: [self.messageItem("Showing saved places only. Online search is unavailable.")]
            ),
            at: 0
          )
        }
        template.updateSections(sections)
      }
    }
  }

  /// A list that shows a searching message until its sections arrive.
  private func makeLoadingList(title: String, loadingSubtitle: String) -> CPListTemplate {
    let template = CPListTemplate(title: title, sections: [])
    template.emptyViewTitleVariants = ["Searching…"]
    template.emptyViewSubtitleVariants = [loadingSubtitle]
    return template
  }

  /// Replaces a list's contents with a failure message and a way forward.
  private func showListFailure(
    _ template: CPListTemplate,
    title: String,
    subtitle: String,
    retry: @escaping () -> Void,
    retryTitle: String = "Try again"
  ) {
    template.emptyViewTitleVariants = [title]
    template.emptyViewSubtitleVariants = [subtitle]
    let retryItem = CPListItem(
      text: retryTitle,
      detailText: nil,
      image: UIImage(systemName: "arrow.clockwise")
    )
    retryItem.handler = { [weak self, weak template] _, completion in
      completion()
      guard let self, let template, let interfaceController = self.interfaceController,
        interfaceController.topTemplate === template
      else { return }
      interfaceController.popTemplate(animated: true) { _, _ in
        MainActor.assumeIsolated { retry() }
      }
    }
    template.updateSections([
      CPListSection(items: [messageItem(title), retryItem])
    ])
  }

  private func messageItem(_ text: String) -> CPListItem {
    let item = CPListItem(text: text, detailText: nil)
    item.isEnabled = false
    return item
  }
  /// Voice search failed (permission, no on-device recognizer, no audio, nothing heard). Offer the
  /// retry plus the routes that do not need the microphone, so the driver is never stuck.
  private func showVoiceSearchRetry(title: String, detail: String) {
    guard let interfaceController else {
      return
    }
    let retry = CPListItem(
      text: "Try voice search again",
      detailText: nil,
      image: UIImage(systemName: "mic.fill")
    )
    let type = CPListItem(
      text: "Type a destination",
      detailText: nil,
      image: UIImage(systemName: "keyboard")
    )
    let saved = CPListItem(
      text: "Home, Work, and recents",
      detailText: nil,
      image: UIImage(systemName: "star.fill")
    )
    let retryTemplate = CPListTemplate(
      title: title,
      sections: [
        CPListSection(items: [messageItem(detail)]),
        CPListSection(items: [retry, type, saved]),
      ]
    )
    let selectionMode = destinationSelectionMode
    retry.handler = { [weak self, weak retryTemplate] _, completion in
      completion()
      guard
        let self,
        let retryTemplate,
        let interfaceController = self.interfaceController,
        interfaceController.topTemplate === retryTemplate
      else {
        return
      }
      interfaceController.popTemplate(animated: true) { [weak self] success, _ in
        guard success else {
          return
        }
        MainActor.assumeIsolated {
          self?.showVoiceSearch(selectionMode: selectionMode)
        }
      }
    }
    type.handler = { [weak self] _, completion in
      completion()
      self?.showSearch(selectionMode: selectionMode)
    }
    saved.handler = { [weak self] _, completion in
      completion()
      guard let self, let interfaceController = self.interfaceController else { return }
      self.destinationSelectionMode = selectionMode
      let template = CPListTemplate(
        title: "Places",
        sections: self.destinationSearchSections()
      )
      interfaceController.pushTemplate(template, animated: true, completion: nil)
    }
    interfaceController.pushTemplate(retryTemplate, animated: true, completion: nil)
  }
  private func startDestinationSearch(
    query: String,
    completion: @escaping (DestinationSearchResult) -> Void
  ) {
    searchRequestGeneration &+= 1
    let requestGeneration = searchRequestGeneration
    searchTask?.cancel()
    searchTask = Task { [weak self] in
      guard let self else {
        completion(.cancelled)
        return
      }
      let localMatches = NavOSSCarPlayDestinationStore.shared.snapshot().searchableDestinations
        .filter { destination in
          destination.name.localizedCaseInsensitiveContains(query)
            || destination.label.localizedCaseInsensitiveContains(query)
        }
      do {
        let proximity = self.mapViewController?.currentLocationCoordinate()
          ?? NavOSSNavigationService.shared.currentCoordinate()
        let client = try NavOSSNavigationAPIClient()
        let remoteMatches = try await client.search(
          query: query,
          proximity: proximity
        )
        guard !Task.isCancelled, requestGeneration == self.searchRequestGeneration else {
          completion(.cancelled)
          return
        }
        let matches = self.uniqueDestinations(localMatches + remoteMatches)
        self.searchTask = nil
        self.searchDestinationsByIdentifier = Dictionary(
          uniqueKeysWithValues: matches.map { ($0.id, $0) }
        )
        completion(.results(matches, remoteSearchFailed: false))
      } catch {
        guard !Task.isCancelled, requestGeneration == self.searchRequestGeneration else {
          completion(.cancelled)
          return
        }
        let matches = self.uniqueDestinations(localMatches)
        self.searchTask = nil
        self.searchDestinationsByIdentifier = Dictionary(
          uniqueKeysWithValues: matches.map { ($0.id, $0) }
        )
        completion(.results(matches, remoteSearchFailed: true))
      }
    }
  }

  private func placesTemplateSections() -> [CPListSection] {
    switch destinationSelectionMode {
    case .addStop, .changeDestination:
      return destinationSearchSections()
    case .newTrip:
      return destinationSections()
    }
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
      let changeDestinationItem = CPListItem(
        text: "Change destination",
        detailText: "Choose a new destination from here",
        image: UIImage(systemName: "arrow.triangle.2.circlepath")
      )
      changeDestinationItem.handler = { [weak self] _, completion in
        completion()
        self?.showChangeDestinationPicker()
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
      let stopsItem = CPListItem(
        text: "Stops",
        detailText: remainingWaypoints.isEmpty
          ? "No stops on this trip"
          : remainingWaypoints.count == 1 ? "1 stop" : "\(remainingWaypoints.count) stops",
        image: UIImage(systemName: "mappin.and.ellipse")
      )
      stopsItem.accessoryType = .disclosureIndicator
      stopsItem.isEnabled = !remainingWaypoints.isEmpty
      stopsItem.handler = { [weak self] _, completion in
        completion()
        self?.showStops()
      }
      let reportItem = CPListItem(
        text: "Report road condition",
        detailText: "Saved privately on this iPhone",
        image: UIImage(systemName: "exclamationmark.bubble.fill")
      )
      reportItem.handler = { [weak self] _, completion in
        completion()
        self?.showReports()
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
          items: [addStopItem, stopsItem, changeDestinationItem, routesItem, reportItem, endItem],
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
        subtitle: "Remove a stop before adding another."
      )
      return
    }
    destinationSelectionMode = .addStop
    let template = CPListTemplate(title: "Add stop", sections: destinationSearchSections())
    template.trailingNavigationBarButtons = [makeEndNavigationBarButton()]
    placesTemplate = template
    interfaceController.pushTemplate(template, animated: true, completion: nil)
  }

  private func showChangeDestinationPicker() {
    guard let interfaceController else {
      return
    }
    let state = NavOSSCarPlayTripStore.shared.snapshot()
    guard state.trip != nil, state.guidance?.phase == .navigating else {
      showNavigationAlert(title: "Trip unavailable", subtitle: "Start navigation and try again.")
      return
    }
    destinationSelectionMode = .changeDestination
    let template = CPListTemplate(
      title: "Change destination",
      sections: destinationSearchSections()
    )
    template.trailingNavigationBarButtons = [makeEndNavigationBarButton()]
    placesTemplate = template
    interfaceController.pushTemplate(template, animated: true, completion: nil)
  }

  /// Remaining stops in route order. Choosing one offers Remove or Move earlier; either shows the
  /// recalculated routes before anything changes, like Add stop.
  private func showStops() {
    guard let interfaceController, let trip = NavOSSCarPlayTripStore.shared.snapshot().trip else {
      return
    }
    let state = NavOSSCarPlayTripStore.shared.snapshot()
    let stops = navOSSRemainingWaypoints(in: trip, after: state.routeProgress)
    let template = CPListTemplate(title: "Stops", sections: [])
    template.emptyViewTitleVariants = ["No stops"]
    template.emptyViewSubtitleVariants = ["Add a stop from the Trip screen."]
    let items = stops.enumerated().map { index, stop in
      let item = CPListItem(
        text: "\(index + 1). \(stop.name)",
        detailText: stop.label.isEmpty ? nil : stop.label,
        image: UIImage(systemName: "\(min(index + 1, 50)).circle.fill")
      )
      item.handler = { [weak self] _, completion in
        completion()
        self?.showStopActions(stops: stops, index: index)
      }
      return item
    }
    let destination = CPListItem(
      text: trip.destination.name,
      detailText: "Destination",
      image: UIImage(systemName: "flag.checkered")
    )
    destination.isEnabled = false
    template.updateSections(
      items.isEmpty ? [] : [CPListSection(items: items + [destination])]
    )
    template.trailingNavigationBarButtons = [makeEndNavigationBarButton()]
    interfaceController.pushTemplate(template, animated: true, completion: nil)
  }

  private func showStopActions(stops: [NavOSSCarPlayDestination], index: Int) {
    guard let interfaceController, stops.indices.contains(index) else { return }
    var actions = [
      CPAlertAction(title: "Remove stop", style: .destructive) { [weak self] _ in
        self?.interfaceController?.dismissTemplate(animated: true, completion: nil)
        guard let updated = navOSSCarPlayWaypoints(stops, removingAt: index) else { return }
        self?.returnToMapAndLoadEditedStops(updated, summary: "Without \(stops[index].name)")
      }
    ]
    if index > 0 {
      actions.append(
        CPAlertAction(title: "Move earlier", style: .default) { [weak self] _ in
          self?.interfaceController?.dismissTemplate(animated: true, completion: nil)
          guard let updated = navOSSCarPlayWaypoints(stops, movingEarlierAt: index) else { return }
          self?.returnToMapAndLoadEditedStops(updated, summary: "\(stops[index].name) first")
        }
      )
    }
    actions.append(
      CPAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
        self?.interfaceController?.dismissTemplate(animated: true, completion: nil)
      }
    )
    interfaceController.presentTemplate(
      CPAlertTemplate(titleVariants: [stops[index].name], actions: actions),
      animated: true,
      completion: nil
    )
  }

  private func returnToMapAndLoadEditedStops(
    _ waypoints: [NavOSSCarPlayDestination],
    summary: String
  ) {
    guard let interfaceController else { return }
    interfaceController.popToRootTemplate(animated: true) { [weak self] _, _ in
      MainActor.assumeIsolated {
        self?.loadEditedStopRoute(waypoints: waypoints, summary: summary)
      }
    }
  }

  private func loadEditedStopRoute(waypoints: [NavOSSCarPlayDestination], summary: String) {
    let state = NavOSSCarPlayTripStore.shared.snapshot()
    guard let trip = state.trip, state.guidance?.phase == .navigating else {
      showNavigationAlert(title: "Trip unavailable", subtitle: "Start navigation and try again.")
      return
    }
    loadReplacementRoutes(
      destination: trip.destination,
      preferences: trip.preferences,
      waypoints: waypoints,
      progressTitle: summary,
      progressSubtitle: "Finding routes with your stops…",
      failureTitle: "Stops unavailable",
      failureSubtitle: "No route with these stops was found."
    )
  }

  /// Nearby results for a category, nearest first, each with its distance. The list appears at
  /// once in a searching state and fills in place; an empty or failed search keeps a way forward.
  private func showCategoryResults(_ category: SearchCategory) {
    guard let interfaceController else { return }
    let template = makeLoadingList(title: category.label, loadingSubtitle: "Finding places nearby")
    interfaceController.pushTemplate(template, animated: true, completion: nil)
    searchRequestGeneration &+= 1
    let requestGeneration = searchRequestGeneration
    searchTask?.cancel()
    searchTask = Task { [weak self, weak template] in
      guard let self else { return }
      let retry: () -> Void = { [weak self] in self?.showCategoryResults(category) }
      let proximity: NavOSSCarPlayCoordinate?
      if let currentLocation = self.mapViewController?.currentLocationCoordinate() {
        proximity = currentLocation
      } else {
        proximity = await NavOSSNavigationService.shared.awaitCurrentRouteOrigin(
          timeoutSeconds: 2
        )?.coordinate
      }
      guard !Task.isCancelled, requestGeneration == self.searchRequestGeneration,
        let template
      else { return }
      guard let proximity else {
        self.searchTask = nil
        self.showListFailure(
          template,
          title: "Location unavailable",
          subtitle: "Nearby search needs your current location.",
          retry: retry
        )
        return
      }
      do {
        let client = try NavOSSNavigationAPIClient()
        let matches = try await client.search(
          query: category.query,
          proximity: proximity,
          category: category.category
        )
        guard !Task.isCancelled, requestGeneration == self.searchRequestGeneration else { return }
        self.searchTask = nil
        let ordered = navOSSCarPlayDestinationsOrderedByDistance(matches, from: proximity)
        self.searchDestinationsByIdentifier = Dictionary(
          ordered.map { ($0.id, $0) },
          uniquingKeysWith: { first, _ in first }
        )
        guard !ordered.isEmpty else {
          template.emptyViewTitleVariants = ["No \(category.label.lowercased()) nearby"]
          template.emptyViewSubtitleVariants = ["Try another category or search by name."]
          template.updateSections([])
          return
        }
        template.updateSections([
          CPListSection(items: ordered.map { self.destinationItem($0, distanceFrom: proximity) })
        ])
      } catch {
        guard !Task.isCancelled, requestGeneration == self.searchRequestGeneration else { return }
        self.searchTask = nil
        self.showListFailure(
          template,
          title: "Search unavailable",
          subtitle: "Check your connection, then try again.",
          retry: retry
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
      // CarPlay limits the map to four controls. Trip actions live behind the navigation bar's
      // Trip button, which CarPlay reveals on any touch.
      mapTemplate?.mapButtons = [
        endNavigationMapButton, overviewMapButton, muteGuidanceMapButton, reportMapButton,
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
    finishRoutePreviewLocationLease()
    routeChoicesByIdentifier = [:]
    searchDestinationsByIdentifier = [:]
    isPreviewingRoutes = false
    routePreviewReplacesActiveTrip = false
    destinationSelectionMode = .newTrip
    mapTemplate?.dismissNavigationAlert(animated: false) { _ in }
    mapTemplate?.hideTripPreviews()
    navigationSession?.cancelTrip()
    navigationSession = nil
    resetManeuvers()
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
    prefix: String? = nil,
    distanceFrom origin: NavOSSCarPlayCoordinate? = nil
  ) -> CPListItem {
    let title = prefix.map { "\($0) · \(destination.name)" } ?? destination.name
    let distance = origin.map {
      navOSSCarPlayDistanceLabel(navOSSCarPlayDistanceMeters(from: $0, to: destination))
    }
    let detail = [distance, destination.label.isEmpty ? nil : destination.label]
      .compactMap { $0 }
      .joined(separator: " · ")
    let item = CPListItem(text: title, detailText: detail.isEmpty ? nil : detail)
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
    case .changeDestination:
      returnToMapAndLoadReplacementRoute(to: destination)
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

  private func returnToMapAndLoadReplacementRoute(to destination: NavOSSCarPlayDestination) {
    guard let interfaceController else { return }
    interfaceController.popToRootTemplate(animated: true) { [weak self] _, error in
      guard error == nil else { return }
      self?.loadReplacementRoute(to: destination)
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
        subtitle: "Remove a stop before adding another."
      )
      return
    }
    loadReplacementRoutes(
      destination: trip.destination,
      preferences: trip.preferences,
      waypoints: [stop] + remainingWaypoints.filter { $0.id != stop.id },
      progressTitle: stop.name,
      progressSubtitle: "Finding routes with this stop…",
      failureTitle: "Stop unavailable",
      failureSubtitle: "No route through this stop was found."
    )
  }

  /// Calculates alternatives from the current position for a change to the active trip and shows
  /// them as a preview. The current trip keeps guiding until the driver taps Go; Cancel keeps it.
  private func loadReplacementRoutes(
    destination: NavOSSCarPlayDestination,
    preferences: NavOSSRoutePreferences,
    waypoints: [NavOSSCarPlayDestination],
    progressTitle: String,
    progressSubtitle: String,
    failureTitle: String,
    failureSubtitle: String
  ) {
    routeRequestGeneration &+= 1
    let requestGeneration = routeRequestGeneration
    routeTask?.cancel()
    showNavigationAlert(title: progressTitle, subtitle: progressSubtitle)
    routeTask = Task { [weak self] in
      do {
        guard let origin = await NavOSSNavigationService.shared.awaitCurrentRouteOrigin()
        else {
          guard !Task.isCancelled, let self,
            requestGeneration == self.routeRequestGeneration
          else { return }
          self.routeTask = nil
          self.showNavigationAlert(
            title: "Current location unavailable",
            subtitle: "Check Location access on your iPhone, then try again."
          )
          return
        }
        let client = try NavOSSNavigationAPIClient()
        let routes = try await client.routes(
          origin: origin.coordinate,
          originHeadingDegrees: origin.headingDegrees,
          originHorizontalAccuracyMeters: origin.horizontalAccuracyMeters,
          destination: destination,
          preferences: preferences,
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
        self.showNavigationAlert(title: failureTitle, subtitle: failureSubtitle)
      }
    }
  }
  private func loadReplacementRoute(to destination: NavOSSCarPlayDestination) {
    let state = NavOSSCarPlayTripStore.shared.snapshot()
    guard let trip = state.trip, state.guidance?.phase == .navigating else {
      showNavigationAlert(title: "Trip unavailable", subtitle: "Start navigation and try again.")
      return
    }
    guard destination.id != trip.destination.id else {
      showNavigationAlert(title: "Already your destination", subtitle: "Choose a different place.")
      return
    }
    loadReplacementRoutes(
      destination: destination,
      preferences: trip.preferences,
      waypoints: navOSSRemainingWaypoints(in: trip, after: state.routeProgress)
        .filter { $0.id != destination.id },
      progressTitle: destination.name,
      progressSubtitle: "Finding routes to this destination…",
      failureTitle: "Destination unavailable",
      failureSubtitle: "No route to this destination was found."
    )
  }
  private func loadActiveRouteAlternatives() {
    let state = NavOSSCarPlayTripStore.shared.snapshot()
    guard let trip = state.trip, state.guidance?.phase == .navigating else {
      showNavigationAlert(title: "Trip unavailable", subtitle: "Start navigation and try again.")
      return
    }
    loadReplacementRoutes(
      destination: trip.destination,
      preferences: trip.preferences,
      waypoints: navOSSRemainingWaypoints(in: trip, after: state.routeProgress),
      progressTitle: "Alternate routes",
      progressSubtitle: "Finding routes from here…",
      failureTitle: "Routes unavailable",
      failureSubtitle: "No alternate route was found."
    )
  }
  private func returnToMapAndLoadActiveRouteAlternatives() {
    guard let interfaceController else { return }
    interfaceController.popToRootTemplate(animated: true) { [weak self] _, error in
      guard error == nil else { return }
      self?.loadActiveRouteAlternatives()
    }
  }

  /// Shows a transient banner over the map. CarPlay presents one navigation alert at a time and
  /// ignores a new one while another is visible, so a newer message replaces the older one instead
  /// of being dropped.
  private func showNavigationAlert(
    title: String,
    subtitle: String,
    imageSystemName: String? = nil,
    duration: TimeInterval = 4
  ) {
    guard let mapTemplate else {
      return
    }
    let alert = CPNavigationAlert(
      titleVariants: [title],
      subtitleVariants: [subtitle],
      image: imageSystemName.flatMap { UIImage(systemName: $0) },
      primaryAction: CPAlertAction(title: "OK", style: .default) { _ in },
      secondaryAction: nil,
      duration: duration
    )
    presentNavigationAlert(alert, on: mapTemplate)
  }

  private func presentNavigationAlert(_ alert: CPNavigationAlert, on mapTemplate: CPMapTemplate) {
    guard mapTemplate.currentNavigationAlert != nil else {
      mapTemplate.present(navigationAlert: alert, animated: true)
      return
    }
    mapTemplate.dismissNavigationAlert(animated: false) { [weak mapTemplate] _ in
      MainActor.assumeIsolated {
        mapTemplate?.present(navigationAlert: alert, animated: true)
      }
    }
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
    finishRoutePreviewLocationLease()
    routeChoicesByIdentifier = [:]
    isPreviewingRoutes = false
    mapTemplate?.hideTripPreviews()
    mapViewController?.clearRoute()
    showNavigationAlert(title: destination.name, subtitle: "Finding routes…")
    let routePreferences = preferencesStore.load().routePreferences
    routeTask = Task { [weak self] in
      do {
        guard let origin = await NavOSSNavigationService.shared.awaitCurrentRouteOrigin()
        else {
          guard !Task.isCancelled, let self,
            requestGeneration == self.routeRequestGeneration
          else { return }
          self.routeTask = nil
          self.showNavigationAlert(
            title: "Current location unavailable",
            subtitle: "Check Location access on your iPhone, then try again."
          )
          return
        }
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
    finishRoutePreviewLocationLease()
    routePreviewLocationLease = NavOSSNavigationService.shared.beginCarPlayRoutePlanning()
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
      self.mapTemplate?.showRouteChoicesPreview(
        for: systemTrip,
        textConfiguration: CPTripPreviewTextConfiguration(
          startButtonTitle: replacingActiveTrip ? "Use route" : "Go",
          additionalRoutesButtonTitle: "Routes",
          overviewButtonTitle: "Overview"
        )
      )
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
      finishRoutePreviewLocationLease()
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
    let previousManeuvers = (maneuversByStep, laneGuidanceByStep, maneuverTripId, upcomingManeuverSteps)
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
        resetManeuvers()
      }
      try NavOSSNavigationService.shared.startNavigation(route)
      finishRoutePreviewLocationLease()
      if replacesActiveTrip {
        previousNavigationSession?.cancelTrip()
      }
      navigationSession = mapTemplate.startNavigationSession(for: trip)
      resetManeuvers()
      presentedArrivalTripId = nil
      routeChoicesByIdentifier = [:]
      apply(NavOSSCarPlayTripStore.shared.snapshot())
    } catch {
      finishRoutePreviewLocationLease()
      activeDestinationId = previousActiveDestinationId
      activeSystemTrip = previousActiveSystemTrip
      activeTripId = previousActiveTripId
      (maneuversByStep, laneGuidanceByStep, maneuverTripId, upcomingManeuverSteps) =
        previousManeuvers
      navigationSession = previousNavigationSession
      mapTemplate.hideTripPreviews()
      apply(NavOSSCarPlayTripStore.shared.snapshot())
      showNavigationAlert(title: "Navigation unavailable", subtitle: "Try another route.")
    }
  }

  private func finishRoutePreviewLocationLease() {
    guard let routePreviewLocationLease else { return }
    self.routePreviewLocationLease = nil
    NavOSSNavigationService.shared.finishCarPlayRoutePlanning(routePreviewLocationLease)
  }

  func templateWillDisappear(_ template: CPTemplate, animated: Bool) {
    voiceSearchCoordinator?.templateWillDisappear(template)
  }

  func templateDidDisappear(_ template: CPTemplate, animated: Bool) {
    voiceSearchCoordinator?.templateDidDisappear(template)
  }

  /// Typed search waits for a short pause in typing before asking the API, so each keystroke does
  /// not cost a request. A superseded keystroke is answered with the last results instead of an
  /// empty list, which kept the list from flashing blank while typing.
  func searchTemplate(
    _ searchTemplate: CPSearchTemplate,
    updatedSearchText searchText: String,
    completionHandler: @escaping ([CPListItem]) -> Void
  ) {
    pendingSearchCompletion?(lastSearchItems)
    pendingSearchCompletion = nil
    searchDebounceTask?.cancel()
    let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard query.count >= 2 else {
      searchRequestGeneration &+= 1
      searchTask?.cancel()
      searchTask = nil
      searchDestinationsByIdentifier = [:]
      lastSearchItems = []
      completionHandler([])
      return
    }
    pendingSearchCompletion = completionHandler
    searchDebounceTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 280_000_000)
      guard !Task.isCancelled, let self else { return }
      self.startDestinationSearch(query: query) { [weak self] result in
        guard let self, let completion = self.pendingSearchCompletion else { return }
        self.pendingSearchCompletion = nil
        switch result {
        case .cancelled:
          completion(self.lastSearchItems)
        case let .results(matches, remoteSearchFailed):
          let origin = self.mapViewController?.currentLocationCoordinate()
            ?? NavOSSNavigationService.shared.currentCoordinate()
          var items = matches.map { self.destinationItem($0, distanceFrom: origin) }
          if items.isEmpty {
            items = [
              self.messageItem(
                remoteSearchFailed
                  ? "Search unavailable. Check your connection."
                  : "No places found. Try a more specific name or address."
              )
            ]
          }
          self.lastSearchItems = items
          completion(items)
        }
      }
    }
  }

  /// The keyboard's Search key shows the full result list for the typed text.
  func searchTemplateSearchButtonPressed(_ searchTemplate: CPSearchTemplate) {
    let items = lastSearchItems.filter { $0.userInfo is String }
    guard let interfaceController, !items.isEmpty else { return }
    interfaceController.pushTemplate(
      CPListTemplate(title: "Results", sections: [CPListSection(items: items)]),
      animated: true,
      completion: nil
    )
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
