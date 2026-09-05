import CarPlay
internal import NavOSSNavigation
import UIKit

/// Main-actor holder for the Dashboard shortcut queue.
///
/// The queueing rules live in `NavOSSCarPlayDashboardActionQueue` inside the navigation core, where
/// they are covered by tests; this only owns the shared instance the scenes talk to.
@MainActor
enum NavOSSCarPlayDashboardActionStore {
  private static var queue = NavOSSCarPlayDashboardActionQueue()

  @discardableResult
  static func stage(
    _ action: NavOSSCarPlayDashboardAction,
    identifier: UUID = UUID()
  ) -> UUID {
    queue.stage(action, identifier: identifier)
    return identifier
  }

  static func take(isReady: Bool) -> NavOSSCarPlayDashboardAction? {
    queue.take(isReady: isReady)
  }

  static func clear(_ identifier: UUID) {
    queue.clear(identifier)
  }
}

@objc(NavOSSCarPlayDashboardSceneDelegate)
@MainActor
final class NavOSSCarPlayDashboardSceneDelegate: UIResponder,
  @preconcurrency CPTemplateApplicationDashboardSceneDelegate
{
  private weak var dashboardWindow: UIWindow?
  private var mapViewController: NavOSSCarPlayMapViewController?
  private var preferencesObserver: NSObjectProtocol?
  private var stateObserver: NSObjectProtocol?

  func templateApplicationDashboardScene(
    _ templateApplicationDashboardScene: CPTemplateApplicationDashboardScene,
    didConnect dashboardController: CPDashboardController,
    to window: UIWindow
  ) {
    // A Dashboard-only connection is the common case of plugging in and never opening NavOSS on
    // the head-unit screen. It is just as much a live map in a vehicle as the template scene, so
    // it must hold location too.
    NavOSSNavigationService.shared.setCarPlayConnected(true, scene: "dashboard")
    dashboardWindow = window
    let mapViewController = NavOSSCarPlayMapViewController()
    mapViewController.reservesRouteChoiceSheet = false
    mapViewController.setIdleLocationTrackingEnabled(true)
    applyPreferences(to: mapViewController)
    self.mapViewController = mapViewController
    window.rootViewController = mapViewController
    mapViewController.recenter()

    dashboardController.shortcutButtons = [
      dashboardButton(
        title: "Go",
        systemImageName: "arrow.triangle.turn.up.right.diamond.fill",
        action: .go
      ),
      dashboardButton(title: "Voice", systemImageName: "mic.fill", action: .voice),
    ]

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

  func templateApplicationDashboardScene(
    _ templateApplicationDashboardScene: CPTemplateApplicationDashboardScene,
    didDisconnect dashboardController: CPDashboardController,
    from window: UIWindow
  ) {
    NavOSSNavigationService.shared.setCarPlayConnected(false, scene: "dashboard")
    if let stateObserver {
      NotificationCenter.default.removeObserver(stateObserver)
      self.stateObserver = nil
    }
    if let preferencesObserver {
      NotificationCenter.default.removeObserver(preferencesObserver)
      self.preferencesObserver = nil
    }
    mapViewController?.clearRoute()
    mapViewController?.deactivate()
    window.rootViewController = nil
    dashboardWindow = nil
    mapViewController = nil
  }

  private func apply(_ state: NavOSSCarPlayState) {
    guard let mapViewController else { return }
    guard let trip = state.trip else {
      mapViewController.clearRoute()
      mapViewController.recenter()
      return
    }
    let activeGuidance = state.guidance?.phase == .navigating || state.guidance?.phase == .arrived
    mapViewController.display(
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

  private func dashboardButton(
    title: String,
    systemImageName: String,
    action: NavOSSCarPlayDashboardAction
  ) -> CPDashboardButton {
    CPDashboardButton(
      titleVariants: [title],
      subtitleVariants: [],
      image: UIImage(systemName: systemImageName) ?? UIImage(),
      handler: { _ in
        let actionIdentifier = NavOSSCarPlayDashboardActionStore.stage(action)
        let activity = NSUserActivity(activityType: NavOSSCarPlayDashboardAction.activityType)
        activity.userInfo = [
          "action": action.rawValue,
          "identifier": actionIdentifier.uuidString,
        ]
        let clearPendingAction: (Error) -> Void = { _ in
          Task { @MainActor in
            NavOSSCarPlayDashboardActionStore.clear(actionIdentifier)
          }
        }
        if #available(iOS 17.0, *) {
          var request = UISceneSessionActivationRequest(role: .carTemplateApplication)
          request.userActivity = activity
          UIApplication.shared.activateSceneSession(
            for: request,
            errorHandler: clearPendingAction
          )
        } else {
          let mainSession = UIApplication.shared.openSessions.first {
            $0.role == .carTemplateApplication
          }
          UIApplication.shared.requestSceneSessionActivation(
            mainSession,
            userActivity: activity,
            options: nil,
            errorHandler: clearPendingAction
          )
        }
      }
    )
  }
}
