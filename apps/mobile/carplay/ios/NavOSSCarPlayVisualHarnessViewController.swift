import MapLibre
internal import NavOSSNavigation
import UIKit

#if targetEnvironment(simulator)
@MainActor
final class NavOSSCarPlayVisualHarnessViewController: UIViewController {
  private let mapViewController = NavOSSCarPlayMapViewController()
  private let scenario: String

  init(scenario: String) {
    self.scenario = scenario
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    let darkAppearance = ProcessInfo.processInfo.environment[
      "NAVOSS_CARPLAY_VISUAL_APPEARANCE"
    ] == "dark"
    mapViewController.applyAppearance(darkAppearance ? .dark : .light)

    mapViewController.setIdleLocationTrackingEnabled(false)
    addChild(mapViewController)
    mapViewController.view.frame = view.bounds
    mapViewController.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(mapViewController.view)
    mapViewController.didMove(toParent: self)

    mapViewController.onStyleLoaded = { [weak self] in
      self?.renderScenario()
    }
  }

  private func renderScenario() {
    let route = Self.route
    let alternateRoute = route.enumerated().map { index, coordinate in
      NavOSSCarPlayCoordinate(
        latitude: coordinate.latitude + (index > 2 && index < 8 ? 0.0022 : 0),
        longitude: coordinate.longitude - (index > 2 && index < 8 ? 0.0018 : 0)
      )
    }

    switch scenario {
    case "audio-release":
      runAudioReleaseScenario()
      return
    case "idle-location":
      mapViewController.displayIdleLocation(
        NavOSSCarPlayCoordinate(latitude: 51.04470, longitude: -114.07190),
        animated: false
      )
    case "preview":
      mapViewController.display(
        route: route,
        routeId: "visual-preview",
        activeGuidance: false,
        alternateRoute: alternateRoute
      )
    case "preview-short":
      mapViewController.display(
        route: Self.shortRoute,
        routeId: "visual-preview-short",
        activeGuidance: false
      )
    case "preview-resize":
      mapViewController.view.autoresizingMask = []
      mapViewController.view.frame = CGRect(
        x: 0,
        y: 0,
        width: view.bounds.width * 0.55,
        height: view.bounds.height
      )
      mapViewController.display(
        route: Self.wideRoute,
        routeId: "visual-preview-resize",
        activeGuidance: false
      )
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
        guard let self else { return }
        self.mapViewController.view.frame = self.view.bounds
        self.mapViewController.view.setNeedsLayout()
        self.mapViewController.view.layoutIfNeeded()
      }
    case "progress-05":
      mapViewController.display(
        route: route,
        routeId: "visual-guidance",
        activeGuidance: true,
        position: NavOSSCarPlayPosition(
          coordinate: route[1],
          courseDegrees: 24,
          speedMetersPerSecond: 15
        ),
        routeProgress: 0.05,
        speedLimitKph: 50
      )
    case "guidance-position-fallback":
      mapViewController.display(
        route: route,
        routeId: "visual-guidance-fallback",
        activeGuidance: false
      )
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
        self?.mapViewController.display(
          route: route,
          routeId: "visual-guidance-fallback",
          activeGuidance: true
        )
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.65) { [weak self] in
        self?.mapViewController.display(
          route: route,
          routeId: "visual-guidance-fallback",
          activeGuidance: true
        )
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { [weak self] in
        self?.markReady()
      }
      return
    case "progress-60":
      mapViewController.applyMapPreferences(showsPointsOfInterest: true, vehicleMarker: .car)
      mapViewController.display(
        route: route,
        routeId: "visual-guidance",
        activeGuidance: true,
        position: NavOSSCarPlayPosition(
          coordinate: route[7],
          courseDegrees: 50,
          speedMetersPerSecond: 24
        ),
        routeProgress: 0.60,
        speedLimitKph: 80
      )
    case "overview":
      mapViewController.display(
        route: route,
        routeId: "visual-guidance",
        activeGuidance: true,
        position: NavOSSCarPlayPosition(coordinate: route[5], courseDegrees: 42),
        routeProgress: 0.40,
        distanceToManeuverMeters: 1_200
      )
      _ = mapViewController.toggleRouteOverview()
    case "clear":
      mapViewController.display(
        route: route,
        routeId: "visual-clear",
        activeGuidance: false,
        alternateRoute: alternateRoute
      )
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
        self?.mapViewController.clearRoute()
        self?.markReady()
      }
      return
    case "hud-wide-chrome":
      // Pins the map to a landscape, full-width region (simulating a wide CarPlay display)
      // and sets the same `anchorsSpeedHUDToViewBounds` option the main CarPlay scene uses in
      // production, then grows `additionalSafeAreaInsets` to simulate CarPlay revealing the
      // Trips/back affordance at the top-left when the driver touches the map. Asserts the
      // speed readout both sits at the content's true top-right margin and is unaffected by
      // the inset change — a correctly anchored readout never moves; a regression here
      // crashes the harness instead of silently emitting a stale screenshot.
      let hudFrame = CGRect(
        x: 0,
        y: 0,
        width: 1024,
        height: 360
      )
      mapViewController.view.autoresizingMask = []
      mapViewController.view.bounds = hudFrame
      let scale = min(view.bounds.width / hudFrame.width, view.bounds.height / hudFrame.height)
      mapViewController.view.transform = CGAffineTransform(scaleX: scale, y: scale)
      mapViewController.view.center = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
      mapViewController.anchorsSpeedHUDToViewBounds = true
      mapViewController.applyMapPreferences(showsPointsOfInterest: true, vehicleMarker: .car)
      mapViewController.display(
        route: Self.wideRoute,
        routeId: "visual-hud-wide-chrome",
        activeGuidance: true,
        position: NavOSSCarPlayPosition(
          coordinate: Self.wideRoute[2],
          courseDegrees: 70,
          speedMetersPerSecond: 24
        ),
        routeProgress: 0.35,
        speedLimitKph: 80
      )
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
        guard let self else { return }
        self.view.layoutIfNeeded()
        let beforeChrome = self.mapViewController.speedReadoutFrame
        let expectedReadoutWidth = 38.0
        let expectedMargin = 8.0
        let expectedTop = expectedMargin
        let expectedLeft = hudFrame.width - expectedMargin - expectedReadoutWidth
        guard abs(beforeChrome.origin.y - expectedTop) < 0.5,
          abs(beforeChrome.origin.x - expectedLeft) < 0.5
        else {
          assertionFailure(
            "CarPlay speed readout is not at the content top-right margin: "
              + "frame=\(beforeChrome) expectedOrigin=(\(expectedLeft), \(expectedTop)) "
              + "content=\(hudFrame)"
          )
          return
        }
        self.mapViewController.additionalSafeAreaInsets = UIEdgeInsets(
          top: 44,
          left: 180,
          bottom: 0,
          right: 96
        )
        self.view.setNeedsLayout()
        self.view.layoutIfNeeded()
        let afterChrome = self.mapViewController.speedReadoutFrame
        guard beforeChrome == afterChrome else {
          assertionFailure(
            "CarPlay speed readout drifted when transient chrome insets changed: "
              + "before=\(beforeChrome) after=\(afterChrome)"
          )
          return
        }
        self.mapViewController.additionalSafeAreaInsets = .zero
        self.view.layoutIfNeeded()
        guard self.mapViewController.speedReadoutFrame == beforeChrome else {
          assertionFailure("CarPlay speed readout drifted when transient chrome was hidden")
          return
        }
        let resizedBounds = CGRect(x: 0, y: 0, width: 1280, height: 360)
        self.mapViewController.view.bounds = resizedBounds
        let resizedScale = min(
          self.view.bounds.width / resizedBounds.width,
          self.view.bounds.height / resizedBounds.height
        )
        self.mapViewController.view.transform = CGAffineTransform(
          scaleX: resizedScale, y: resizedScale
        )
        self.view.layoutIfNeeded()
        let resizedReadout = self.mapViewController.speedReadoutFrame
        guard
          abs(resizedReadout.minX - (resizedBounds.width - expectedMargin - expectedReadoutWidth))
            < 0.5,
          abs(resizedReadout.minY - expectedTop) < 0.5
        else {
          assertionFailure("CarPlay speed readout did not follow a real content resize")
          return
        }
        self.markReady()
      }
      return
    default:
      assertionFailure("Unknown CarPlay visual scenario: \(scenario)")
    }

    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
      self?.markReady()
    }
  }

  private func runAudioReleaseScenario() {
    let service = NavOSSNavigationService.shared
    let previousMode = service.audioMode()
    service.setAudioMode(.allGuidance)
    service.announceSafetyCamera()
    waitForAudioCondition(
      "guidance activation", until: Date().addingTimeInterval(10),
      condition: {
        service.audioSessionTestState.needsRelease && service.audioSessionTestState.isSpeaking
      }
    ) { [weak self] in
      guard let self else { return }
      let lease = service.beginCarPlayVoiceInput()
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
        guard let self else { return }
        let held = service.audioSessionTestState
        guard held.hasVoiceInput && held.needsRelease else {
          assertionFailure("Speech cancellation released an active voice-input lease")
          return
        }
        service.finishCarPlayVoiceInput(lease)
        self.waitForAudioCondition(
          "voice-input release", until: Date().addingTimeInterval(10),
          condition: {
            let state = service.audioSessionTestState
            return !state.needsRelease && !state.hasVoiceInput && !state.isSpeaking
          }
        ) { [weak self] in
          guard let self else { return }
          service.announceSafetyCamera()
          self.waitForAudioCondition(
            "second guidance activation", until: Date().addingTimeInterval(10),
            condition: {
              service.audioSessionTestState.needsRelease && service.audioSessionTestState.isSpeaking
            }
          ) { [weak self] in
            self?.waitForAudioCondition(
              "natural speech completion release", until: Date().addingTimeInterval(15),
              condition: {
                let state = service.audioSessionTestState
                return !state.needsRelease && !state.isSpeaking && !state.hasVoiceInput
              }
            ) { [weak self] in
              service.setAudioMode(previousMode)
              self?.markReady()
            }
          }
        }
      }
    }
  }

  private func waitForAudioCondition(
    _ stage: String,
    until deadline: Date,
    condition: @escaping () -> Bool,
    completion: @escaping () -> Void
  ) {
    if condition() {
      completion()
    } else if Date() >= deadline {
      assertionFailure("Audio lifecycle scenario timed out: \(stage)")
    } else {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
        self?.waitForAudioCondition(
          stage, until: deadline, condition: condition, completion: completion)
      }
    }
  }

  private func markReady() {
    view.accessibilityLabel = "CarPlay visual \(scenario) ready"
    view.isAccessibilityElement = true
    // The validator redirects this to a file, where stdout is block buffered, so a few bytes would
    // otherwise sit unwritten until the process exits.
    print("NAVOSS_CARPLAY_VISUAL_READY \(scenario)")
    fflush(stdout)
  }

  private static let route = [
    NavOSSCarPlayCoordinate(latitude: 51.04470, longitude: -114.07190),
    NavOSSCarPlayCoordinate(latitude: 51.04910, longitude: -114.06930),
    NavOSSCarPlayCoordinate(latitude: 51.05440, longitude: -114.06410),
    NavOSSCarPlayCoordinate(latitude: 51.06020, longitude: -114.05720),
    NavOSSCarPlayCoordinate(latitude: 51.06670, longitude: -114.05010),
    NavOSSCarPlayCoordinate(latitude: 51.07390, longitude: -114.04430),
    NavOSSCarPlayCoordinate(latitude: 51.08120, longitude: -114.03840),
    NavOSSCarPlayCoordinate(latitude: 51.08900, longitude: -114.03090),
    NavOSSCarPlayCoordinate(latitude: 51.09730, longitude: -114.02210),
    NavOSSCarPlayCoordinate(latitude: 51.10610, longitude: -114.01220),
    NavOSSCarPlayCoordinate(latitude: 51.11390, longitude: -114.00220),
  ]

  private static let wideRoute = [
    NavOSSCarPlayCoordinate(latitude: 51.04390, longitude: -114.15400),
    NavOSSCarPlayCoordinate(latitude: 51.04640, longitude: -114.13200),
    NavOSSCarPlayCoordinate(latitude: 51.04480, longitude: -114.10700),
    NavOSSCarPlayCoordinate(latitude: 51.04720, longitude: -114.08100),
    NavOSSCarPlayCoordinate(latitude: 51.04510, longitude: -114.05400),
    NavOSSCarPlayCoordinate(latitude: 51.04800, longitude: -114.02700),
  ]

  private static let shortRoute = [
    NavOSSCarPlayCoordinate(latitude: 51.04470, longitude: -114.07190),
    NavOSSCarPlayCoordinate(latitude: 51.04620, longitude: -114.06880),
    NavOSSCarPlayCoordinate(latitude: 51.04800, longitude: -114.06520),
  ]
}
#endif