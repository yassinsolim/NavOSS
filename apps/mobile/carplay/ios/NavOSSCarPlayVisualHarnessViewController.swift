import CoreLocation
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
    case "idle-live-location":
      // Exercises the real NavOSSCarPlayLocationManager -> MLNMapView path: with the simulator
      // location set far from the Calgary startup center, the puck and camera must move there.
      mapViewController.setIdleLocationTrackingEnabled(true)
      waitForAudioCondition(
        "idle map follows live location", until: Date().addingTimeInterval(30),
        condition: { [weak self] in
          guard let mapView = self?.mapViewController.mapView,
            let fix = mapView.userLocation?.location,
            CLLocationCoordinate2DIsValid(fix.coordinate)
          else { return false }
          let center = mapView.centerCoordinate
          let centerLocation = CLLocation(latitude: center.latitude, longitude: center.longitude)
          return fix.distance(from: centerLocation) < 500
            && centerLocation.distance(
              from: CLLocation(latitude: 51.0447, longitude: -114.0719)) > 100_000
        }
      ) { [weak self] in
        self?.markReady()
      }
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
      // Pins the map to a landscape, wide-display region and sets the same
      // `anchorsSpeedHUDToViewBounds` option the main CarPlay scene uses in production, then
      // exercises every way the speed/speed-limit readouts can move: transient chrome
      // (`additionalSafeAreaInsets`) revealed and hidden, a real content resize, and the
      // speed limit going from known -> unknown -> known again through the real display()
      // path. Asserts the readouts sit at the true content-relative margins throughout —
      // including that speed slides flush to the trailing margin (no blank badge-width slot)
      // while the limit is unknown, and returns to its slot beside the limit once restored.
      // A regression crashes the harness instead of silently emitting a stale screenshot.
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
        let margin = 8.0
        let badgeWidth = 38.0
        let gap = 4.0
        let expectedTop = margin
        let beforeChrome = self.mapViewController.speedReadoutFrame
        let limitBeforeChrome = self.mapViewController.speedLimitReadoutFrame
        let expectedSpeedLeftWithLimit = hudFrame.width - margin - badgeWidth - gap - badgeWidth
        let expectedLimitLeft = hudFrame.width - margin - badgeWidth
        guard self.mapViewController.speedReadoutIsVisible,
          abs(beforeChrome.origin.y - expectedTop) < 0.5,
          abs(beforeChrome.origin.x - expectedSpeedLeftWithLimit) < 0.5,
          let limitBeforeChrome,
          abs(limitBeforeChrome.origin.y - expectedTop) < 0.5,
          abs(limitBeforeChrome.origin.x - expectedLimitLeft) < 0.5
        else {
          assertionFailure(
            "CarPlay speed/limit readouts are not at the content top-right margin: "
              + "speed=\(beforeChrome) limit=\(String(describing: limitBeforeChrome)) "
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
        let resizedExpectedSpeedLeft = resizedBounds.width - margin - badgeWidth - gap - badgeWidth
        guard abs(resizedReadout.minX - resizedExpectedSpeedLeft) < 0.5,
          abs(resizedReadout.minY - expectedTop) < 0.5
        else {
          assertionFailure("CarPlay speed readout did not follow a real content resize")
          return
        }
        // Drop the speed limit through the real display() path (no synthesized frame): the
        // speed badge must slide flush to the trailing margin instead of leaving the limit
        // badge's old badgeWidth+gap slot empty.
        self.mapViewController.display(
          route: Self.wideRoute,
          routeId: "visual-hud-wide-chrome",
          activeGuidance: true,
          position: NavOSSCarPlayPosition(
            coordinate: Self.wideRoute[2], courseDegrees: 70, speedMetersPerSecond: 24
          ),
          routeProgress: 0.35,
          speedLimitKph: nil
        )
        self.view.layoutIfNeeded()
        let speedWithoutLimit = self.mapViewController.speedReadoutFrame
        let expectedSpeedLeftAlone = resizedBounds.width - margin - badgeWidth
        guard self.mapViewController.speedReadoutIsVisible,
          self.mapViewController.speedLimitReadoutFrame == nil,
          abs(speedWithoutLimit.origin.x - expectedSpeedLeftAlone) < 0.5,
          abs(speedWithoutLimit.origin.y - expectedTop) < 0.5
        else {
          assertionFailure(
            "CarPlay speed readout left a blank slot instead of taking the trailing margin "
              + "once the speed limit was hidden: speed=\(speedWithoutLimit) "
              + "limit=\(String(describing: self.mapViewController.speedLimitReadoutFrame))"
          )
          return
        }
        // Restore the limit through the real display() path and confirm the speed badge
        // slides back to its original slot without changing the visible ordering (speed
        // left, limit right, no overlap).
        self.mapViewController.display(
          route: Self.wideRoute,
          routeId: "visual-hud-wide-chrome",
          activeGuidance: true,
          position: NavOSSCarPlayPosition(
            coordinate: Self.wideRoute[2], courseDegrees: 70, speedMetersPerSecond: 24
          ),
          routeProgress: 0.35,
          speedLimitKph: 80
        )
        self.view.layoutIfNeeded()
        let speedRestored = self.mapViewController.speedReadoutFrame
        let limitRestored = self.mapViewController.speedLimitReadoutFrame
        guard self.mapViewController.speedReadoutIsVisible, let limitRestored,
          abs(speedRestored.origin.x - resizedExpectedSpeedLeft) < 0.5,
          abs(limitRestored.origin.x - (resizedBounds.width - margin - badgeWidth)) < 0.5,
          speedRestored.maxX < limitRestored.minX
        else {
          assertionFailure(
            "CarPlay speed/limit readouts did not restore correctly: "
              + "speed=\(speedRestored) limit=\(String(describing: limitRestored))"
          )
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