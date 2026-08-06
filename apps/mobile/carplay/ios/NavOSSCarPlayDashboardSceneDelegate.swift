import CarPlay
internal import NavOSSNavigation
import UIKit

enum NavOSSCarPlayDashboardAction: String {
  static let activityType = "org.navoss.mobile.carplay-dashboard-action"

  case go
  case voice
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
    dashboardWindow = window
    let mapViewController = NavOSSCarPlayMapViewController()
    mapViewController.reservesRouteChoiceSheet = false
    mapViewController.setIdleLocationTrackingEnabled(false)
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
        let activity = NSUserActivity(activityType: NavOSSCarPlayDashboardAction.activityType)
        activity.userInfo = ["action": action.rawValue]
        let mainSession = UIApplication.shared.openSessions.first {
          $0.role == .carTemplateApplication
        }
        UIApplication.shared.requestSceneSessionActivation(
          mainSession,
          userActivity: activity,
          options: nil,
          errorHandler: nil
        )
      }
    )
  }
}
