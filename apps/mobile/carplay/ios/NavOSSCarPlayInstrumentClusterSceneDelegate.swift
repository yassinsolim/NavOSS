import CarPlay
internal import NavOSSNavigation
import UIKit

/// Draws the NavOSS map in a vehicle's instrument cluster or head-up display where the car offers
/// one to navigation apps (`CPTemplateApplicationInstrumentClusterScene`, iOS 15.4+, covered by the
/// existing `com.apple.developer.carplay-maps` entitlement).
///
/// The cluster window shows the shared route and vehicle only. Turn-by-turn text, maneuver
/// symbols, lanes, and estimates reach the cluster through the main scene's `CPNavigationSession`
/// metadata, which the car renders itself. Whether a cluster or HUD connects at all is decided by
/// the vehicle; most CarPlay systems have neither.
@objc(NavOSSCarPlayInstrumentClusterSceneDelegate)
@MainActor
final class NavOSSCarPlayInstrumentClusterSceneDelegate: UIResponder,
  @preconcurrency CPTemplateApplicationInstrumentClusterSceneDelegate,
  @preconcurrency CPInstrumentClusterControllerDelegate
{
  private weak var instrumentClusterController: CPInstrumentClusterController?
  private var contentStyle: UIUserInterfaceStyle = .unspecified
  private var mapViewController: NavOSSCarPlayMapViewController?
  private var preferencesObserver: NSObjectProtocol?
  private var stateObserver: NSObjectProtocol?

  func templateApplicationInstrumentClusterScene(
    _ templateApplicationInstrumentClusterScene: CPTemplateApplicationInstrumentClusterScene,
    didConnect instrumentClusterController: CPInstrumentClusterController
  ) {
    self.instrumentClusterController = instrumentClusterController
    contentStyle = templateApplicationInstrumentClusterScene.contentStyle
    instrumentClusterController.delegate = self
    instrumentClusterController.inactiveDescriptionVariants = [
      "Start a trip in NavOSS", "NavOSS",
    ]
  }

  func templateApplicationInstrumentClusterScene(
    _ templateApplicationInstrumentClusterScene: CPTemplateApplicationInstrumentClusterScene,
    didDisconnect instrumentClusterController: CPInstrumentClusterController
  ) {
    tearDown()
    instrumentClusterController.delegate = nil
    self.instrumentClusterController = nil
  }

  func contentStyleDidChange(_ contentStyle: UIUserInterfaceStyle) {
    self.contentStyle = contentStyle
    mapViewController?.applyContentStyle(contentStyle)
  }

  func instrumentClusterControllerDidConnect(_ instrumentClusterWindow: UIWindow) {
    NavOSSNavigationService.shared.setCarPlayConnected(true, scene: "instrument-cluster")
    let mapViewController = NavOSSCarPlayMapViewController()
    mapViewController.reservesRouteChoiceSheet = false
    mapViewController.showsRoadName = false
    mapViewController.showsCurrentSpeed = false
    mapViewController.showsSpeedLimit = speedLimitAllowed
    mapViewController.applyContentStyle(contentStyle)
    applyPreferences(to: mapViewController)
    mapViewController.setIdleLocationTrackingEnabled(true)
    self.mapViewController = mapViewController
    instrumentClusterWindow.rootViewController = mapViewController
    mapViewController.recenter()
    stateObserver = NotificationCenter.default.addObserver(
      forName: .navOSSCarPlayStateDidChange,
      object: NavOSSCarPlayTripStore.shared,
      queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated {
        self?.apply(NavOSSCarPlayTripStore.shared.snapshot())
      }
    }
    preferencesObserver = NotificationCenter.default.addObserver(
      forName: .navOSSCarPlayPreferencesDidChange,
      object: NavOSSCarPlayPreferencesStore.shared,
      queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, let mapViewController = self.mapViewController else { return }
        self.applyPreferences(to: mapViewController)
      }
    }
    apply(NavOSSCarPlayTripStore.shared.snapshot())
  }

  func instrumentClusterControllerDidDisconnectWindow(_ instrumentClusterWindow: UIWindow) {
    tearDown()
    instrumentClusterWindow.rootViewController = nil
  }

  @objc(instrumentClusterControllerDidZoomIn:)
  func instrumentClusterControllerDidZoom(in instrumentClusterController: CPInstrumentClusterController) {
    mapViewController?.zoom(by: 1)
  }

  @objc(instrumentClusterControllerDidZoomOut:)
  func instrumentClusterControllerDidZoomOut(
    _ instrumentClusterController: CPInstrumentClusterController
  ) {
    mapViewController?.zoom(by: -1)
  }

  @objc(instrumentClusterController:didChangeSpeedLimitSetting:)
  func instrumentClusterController(
    _ instrumentClusterController: CPInstrumentClusterController,
    didChangeSpeedLimitSetting speedLimitSetting: CPInstrumentClusterSetting
  ) {
    mapViewController?.showsSpeedLimit = speedLimitAllowed
    apply(NavOSSCarPlayTripStore.shared.snapshot())
  }

  /// The driver can hide speed limits from the cluster in the car's settings; respect that.
  private var speedLimitAllowed: Bool {
    instrumentClusterController?.speedLimitSetting != .disabled
  }

  private func tearDown() {
    guard mapViewController != nil else { return }
    NavOSSNavigationService.shared.setCarPlayConnected(false, scene: "instrument-cluster")
    for observer in [stateObserver, preferencesObserver].compactMap({ $0 }) {
      NotificationCenter.default.removeObserver(observer)
    }
    stateObserver = nil
    preferencesObserver = nil
    mapViewController?.clearRoute()
    mapViewController?.deactivate()
    mapViewController = nil
  }

  private func apply(_ state: NavOSSCarPlayState) {
    guard let mapViewController else { return }
    guard let trip = state.trip else {
      mapViewController.clearRoute()
      return
    }
    let presentation = state.guidance.flatMap {
      navOSSCarPlayGuidancePresentation(trip: trip, guidance: $0)
    }
    mapViewController.display(
      route: trip.geometry,
      routeId: trip.id,
      activeGuidance: state.guidance?.phase == .navigating || state.guidance?.phase == .arrived,
      position: state.position,
      routeProgress: state.routeProgress,
      distanceToManeuverMeters: state.guidance?.distanceToManeuverMeters,
      speedLimitKph: navOSSCarPlaySpeedLimit(
        trip.speedLimitsKph,
        geometry: trip.geometry,
        matchedCoordinate: state.position?.coordinate,
        routeProgress: state.routeProgress
      ),
      overlay: NavOSSCarPlayGuidanceOverlay(
        maneuverArrow: presentation.map {
          navOSSCarPlayManeuverArrow(trip: trip, maneuverStepIndex: $0.primary.stepIndex)
        } ?? [],
        congestion: trip.congestion
      )
    )
  }

  private func applyPreferences(to mapViewController: NavOSSCarPlayMapViewController) {
    let preferences = NavOSSCarPlayPreferencesStore.shared.load()
    mapViewController.applyAppearance(preferences.appearance)
    mapViewController.applyMapOrientation(preferences.mapOrientation)
    mapViewController.applyMapPreferences(
      showsPointsOfInterest: preferences.showsPointsOfInterest,
      vehicleMarker: preferences.vehicleMarker
    )
  }
}
