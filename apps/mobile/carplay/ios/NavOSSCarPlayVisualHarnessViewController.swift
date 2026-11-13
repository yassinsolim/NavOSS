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
        let margin = NavOSSCarPlayMapViewController.hudMargin
        let speedWidth = NavOSSCarPlayMapViewController.speedBadgeSize.width
        let limitSize = NavOSSCarPlayMapViewController.speedLimitBadgeSize
        let gap = NavOSSCarPlayMapViewController.hudGap
        let expectedTop = margin
        // The round speed badge is centred on the taller limit sign.
        let expectedSpeedTop = margin + (limitSize.height - NavOSSCarPlayMapViewController.speedBadgeSize.height) / 2
        let beforeChrome = self.mapViewController.speedReadoutFrame
        let limitBeforeChrome = self.mapViewController.speedLimitReadoutFrame
        let expectedSpeedLeftWithLimit = hudFrame.width - margin - limitSize.width - gap - speedWidth
        let expectedLimitLeft = hudFrame.width - margin - limitSize.width
        guard self.mapViewController.speedReadoutIsVisible,
          abs(beforeChrome.origin.y - expectedSpeedTop) < 0.5,
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
        let resizedExpectedSpeedLeft =
          resizedBounds.width - margin - limitSize.width - gap - speedWidth
        guard abs(resizedReadout.minX - resizedExpectedSpeedLeft) < 0.5,
          abs(resizedReadout.minY - expectedSpeedTop) < 0.5
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
        let expectedSpeedLeftAlone = resizedBounds.width - margin - speedWidth
        guard self.mapViewController.speedReadoutIsVisible,
          self.mapViewController.speedLimitReadoutFrame == nil,
          abs(speedWithoutLimit.origin.x - expectedSpeedLeftAlone) < 0.5,
          abs(speedWithoutLimit.origin.y - expectedSpeedTop) < 0.5
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
          abs(limitRestored.origin.x - (resizedBounds.width - margin - limitSize.width)) < 0.5,
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
    case "guidance-maneuver", "guidance-night":
      // A CarPlay-sized 800 × 480 frame with the guidance card's safe-area inset, approaching a
      // left turn: maneuver arrow, current-road pill, speed and limit badges. The night variant
      // runs the dark style and is over the limit, so the speed badge turns red.
      let night = scenario == "guidance-night"
      useCarPlayFrame(CGSize(width: 800, height: 480), guidanceCardInset: 300)
      mapViewController.applyMapPreferences(showsPointsOfInterest: true, vehicleMarker: .arrow)
      let trip = Self.turnTrip
      let position = NavOSSCarPlayPosition(
        coordinate: NavOSSCarPlayCoordinate(latitude: 51.04470, longitude: -114.06750),
        courseDegrees: 90,
        speedMetersPerSecond: night ? 19 : 12
      )
      let guidance = NavOSSCarPlayGuidance(
        distanceToManeuverMeters: 180, durationToManeuverSeconds: 15, instruction: "",
        maneuverType: "turn", phase: .navigating, remainingDistanceMeters: 980,
        remainingDurationSeconds: 110, roadName: "", stepIndex: 0)
      // 450 m along the 1,560 m fixture, 200 m before the turn.
      renderGuidance(trip: trip, guidance: guidance, position: position, progress: 0.29, speedLimitKph: 50)
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in
        guard let self else { return }
        guard self.mapViewController.currentRoadNameReadout == "9 Avenue SW" else {
          assertionFailure(
            "Current road pill missing: \(String(describing: self.mapViewController.currentRoadNameReadout))"
          )
          return
        }
        guard self.mapViewController.enlargedRoadLabelLayerCount > 0 else {
          assertionFailure("Road labels were not enlarged for guidance")
          return
        }
        self.markReady()
      }
      return
    case "guidance-annotations":
      // Exercises the optional inputs with harness-only fixture data: per-segment congestion on
      // the route and camera/report markers. Production publishes neither until real sources exist.
      useCarPlayFrame(CGSize(width: 800, height: 480), guidanceCardInset: 300)
      let trip = Self.turnTrip(congestion: [.slow, .heavy, .stopped, .free])
      NavOSSCarPlayMapAlertStore.shared.publish([
        NavOSSCarPlayMapAlert(
          id: "fixture-camera", kind: .redLightAndSpeedCamera,
          coordinate: NavOSSCarPlayCoordinate(latitude: 51.04470, longitude: -114.06560)),
        NavOSSCarPlayMapAlert(
          id: "fixture-report", kind: .report(.construction),
          coordinate: NavOSSCarPlayCoordinate(latitude: 51.04560, longitude: -114.06400)),
      ])
      let guidance = NavOSSCarPlayGuidance(
        distanceToManeuverMeters: 1_400, durationToManeuverSeconds: 120, instruction: "",
        maneuverType: "turn", phase: .navigating, remainingDistanceMeters: 2_000,
        remainingDurationSeconds: 200, roadName: "", stepIndex: 0)
      renderGuidance(
        trip: trip, guidance: guidance,
        position: NavOSSCarPlayPosition(
          coordinate: NavOSSCarPlayCoordinate(latitude: 51.04470, longitude: -114.07150),
          courseDegrees: 90, speedMetersPerSecond: 14),
        progress: 0.1, speedLimitKph: nil)
      _ = mapViewController.toggleRouteOverview()
      // The fixture alerts stay published: the app process ends after this scenario's capture.
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in
        self?.markReady()
      }
      return
    case "maneuver-symbols":
      showManeuverSymbols()
      return
    case "simulated-drive":
      // Not part of the pixel gate: drives the fixture trip at 1 Hz, like real GPS fixes, so the
      // eased camera, the turn, and arrival can be watched or recorded with `simctl io`.
      useCarPlayFrame(CGSize(width: 800, height: 480), guidanceCardInset: 300)
      startSimulatedDrive()
      return
    default:
      assertionFailure("Unknown CarPlay visual scenario: \(scenario)")
    }

    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
      self?.markReady()
    }
  }

  /// Lays the map out at a CarPlay display size, scaled to fit the phone, with the left inset the
  /// guidance card takes on a real head unit.
  private func useCarPlayFrame(_ size: CGSize, guidanceCardInset: CGFloat) {
    mapViewController.view.autoresizingMask = []
    mapViewController.view.bounds = CGRect(origin: .zero, size: size)
    let scale = min(view.bounds.width / size.width, view.bounds.height / size.height)
    mapViewController.view.transform = CGAffineTransform(scaleX: scale, y: scale)
    mapViewController.view.center = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
    mapViewController.additionalSafeAreaInsets = UIEdgeInsets(
      top: 0, left: guidanceCardInset, bottom: 0, right: 0)
    mapViewController.anchorsSpeedHUDToViewBounds = true
  }

  /// Renders guidance through the same presentation path the CarPlay scenes use.
  private func renderGuidance(
    trip: NavOSSCarPlayTrip,
    guidance: NavOSSCarPlayGuidance,
    position: NavOSSCarPlayPosition,
    progress: Double,
    speedLimitKph: Int?
  ) {
    let presentation = navOSSCarPlayGuidancePresentation(trip: trip, guidance: guidance)
    mapViewController.display(
      route: trip.geometry,
      routeId: trip.id,
      activeGuidance: true,
      position: position,
      routeProgress: progress,
      distanceToManeuverMeters: guidance.distanceToManeuverMeters,
      speedLimitKph: speedLimitKph,
      overlay: NavOSSCarPlayGuidanceOverlay(
        maneuverArrow: presentation.map {
          navOSSCarPlayManeuverArrow(trip: trip, maneuverStepIndex: $0.primary.stepIndex)
        } ?? [],
        currentRoadName: presentation?.currentRoadName,
        congestion: trip.congestion
      )
    )
  }

  private var driveTimer: Timer?

  private func startSimulatedDrive() {
    let trip = Self.turnTrip
    let geometry = trip.geometry
    var cumulative = [0.0]
    for index in 1..<geometry.count {
      let a = CLLocation(latitude: geometry[index - 1].latitude, longitude: geometry[index - 1].longitude)
      let b = CLLocation(latitude: geometry[index].latitude, longitude: geometry[index].longitude)
      cumulative.append(cumulative[index - 1] + b.distance(from: a))
    }
    let total = cumulative[cumulative.count - 1]
    let firstLeg = trip.steps[0].distanceMeters
    var travelled = 0.0
    let speed = 16.0
    markReady()
    driveTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] timer in
      MainActor.assumeIsolated {
        guard let self else { return timer.invalidate() }
        travelled = min(total, travelled + speed)
        var segment = 0
        while segment < geometry.count - 2, cumulative[segment + 1] < travelled { segment += 1 }
        let start = geometry[segment]
        let end = geometry[segment + 1]
        let fraction = (travelled - cumulative[segment]) / max(1, cumulative[segment + 1] - cumulative[segment])
        let coordinate = NavOSSCarPlayCoordinate(
          latitude: start.latitude + (end.latitude - start.latitude) * fraction,
          longitude: start.longitude + (end.longitude - start.longitude) * fraction)
        let course = CLLocation(latitude: start.latitude, longitude: start.longitude)
          .bearing(to: CLLocation(latitude: end.latitude, longitude: end.longitude))
        let onFirstLeg = travelled < firstLeg
        let guidance = NavOSSCarPlayGuidance(
          distanceToManeuverMeters: onFirstLeg ? firstLeg - travelled : total - travelled,
          durationToManeuverSeconds: (onFirstLeg ? firstLeg - travelled : total - travelled) / speed,
          instruction: "", maneuverType: "turn",
          phase: travelled >= total ? .arrived : .navigating,
          remainingDistanceMeters: total - travelled,
          remainingDurationSeconds: (total - travelled) / speed, roadName: "",
          stepIndex: onFirstLeg ? 0 : 1)
        self.renderGuidance(
          trip: trip, guidance: guidance,
          position: NavOSSCarPlayPosition(
            coordinate: coordinate, courseDegrees: course, speedMetersPerSecond: speed),
          progress: travelled / total,
          speedLimitKph: 50)
        print("NAVOSS_CARPLAY_DRIVE \(Int(travelled)) / \(Int(total))")
        fflush(stdout)
        if travelled >= total { timer.invalidate() }
      }
    }
  }

  /// Every turn-card symbol the renderer draws, on the guidance-card green, for visual review.
  private func showManeuverSymbols() {
    let samples: [(NavOSSCarPlayManeuverKind, Double, String)] = [
      (.straight, 0, "Straight"), (.slightRight, 35, "Slight right"), (.right, 90, "Right"),
      (.sharpRight, 140, "Sharp right"), (.slightLeft, -35, "Slight left"), (.left, -90, "Left"),
      (.sharpLeft, -140, "Sharp left"), (.uTurn, -180, "U-turn"), (.keepRight, 25, "Keep right"),
      (.offRampRight, 40, "Exit right"), (.roundabout(exit: 1), 90, "Exit 1"),
      (.roundabout(exit: 2), 0, "Exit 2"), (.roundabout(exit: 3), -90, "Exit 3"),
      (.roundabout(exit: nil), -150, "Exit 4"), (.depart, 0, "Start"), (.arrive, 0, "Arrive"),
    ]
    // The board covers the lower part only, so the frame keeps real map pixels above it.
    let board = UIView(
      frame: CGRect(x: 0, y: view.bounds.height - 660, width: view.bounds.width, height: 660))
    board.backgroundColor = UIColor(red: 0.06, green: 0.35, blue: 0.30, alpha: 1)
    let columns = 4
    let cell = CGSize(width: view.bounds.width / CGFloat(columns), height: 150)
    for (index, sample) in samples.enumerated() {
      let origin = CGPoint(
        x: CGFloat(index % columns) * cell.width,
        y: 30 + CGFloat(index / columns) * cell.height
      )
      let imageView = UIImageView(
        image: NavOSSCarPlayManeuverSymbols.image(kind: sample.0, angleDegrees: sample.1))
      imageView.tintColor = .white
      imageView.contentMode = .scaleAspectFit
      imageView.frame = CGRect(x: origin.x + (cell.width - 80) / 2, y: origin.y, width: 80, height: 80)
      board.addSubview(imageView)
      let label = UILabel(
        frame: CGRect(x: origin.x, y: origin.y + 88, width: cell.width, height: 24))
      label.text = sample.2
      label.textAlignment = .center
      label.textColor = .white
      label.font = .systemFont(ofSize: 15, weight: .semibold)
      board.addSubview(label)
    }
    view.addSubview(board)
    DispatchQueue.main.async { [weak self] in self?.markReady() }
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

  /// Harness fixture: east along one avenue, a left turn, then north to the destination.
  private static func turnTrip(congestion: [NavOSSCarPlayCongestionLevel]? = nil) -> NavOSSCarPlayTrip {
    let start = NavOSSCarPlayCoordinate(latitude: 51.04470, longitude: -114.07400)
    let middle = NavOSSCarPlayCoordinate(latitude: 51.04470, longitude: -114.06900)
    let corner = NavOSSCarPlayCoordinate(latitude: 51.04470, longitude: -114.06500)
    let north = NavOSSCarPlayCoordinate(latitude: 51.04920, longitude: -114.06500)
    let end = NavOSSCarPlayCoordinate(latitude: 51.05300, longitude: -114.06500)
    return NavOSSCarPlayTrip(
      destination: NavOSSCarPlayDestination(
        id: "fixture-destination", label: "Harness fixture", latitude: end.latitude,
        longitude: end.longitude, name: "Fixture destination"),
      distanceMeters: 1_560,
      durationSeconds: 180,
      geometry: [start, middle, corner, north, end],
      id: "visual-turn-trip",
      steps: [
        NavOSSCarPlayRouteStep(
          distanceMeters: 650, durationSeconds: 60, geometry: [start, middle, corner],
          instruction: "Drive east on 9 Avenue SW.", maneuverType: "depart",
          roadName: "9 Avenue SW"),
        NavOSSCarPlayRouteStep(
          distanceMeters: 920, durationSeconds: 120, geometry: [corner, north, end],
          instruction: "Turn left onto Centre Street.", maneuverType: "turn",
          roadName: "Centre Street"),
        NavOSSCarPlayRouteStep(
          distanceMeters: 0, durationSeconds: 0, geometry: [end, end],
          instruction: "You have arrived.", maneuverType: "arrive", roadName: "Centre Street"),
      ],
      congestion: congestion
    )
  }

  private static var turnTrip: NavOSSCarPlayTrip { turnTrip() }

  private static let shortRoute = [
    NavOSSCarPlayCoordinate(latitude: 51.04470, longitude: -114.07190),
    NavOSSCarPlayCoordinate(latitude: 51.04620, longitude: -114.06880),
    NavOSSCarPlayCoordinate(latitude: 51.04800, longitude: -114.06520),
  ]
}
#endif

#if targetEnvironment(simulator)
extension CLLocation {
  fileprivate func bearing(to other: CLLocation) -> Double {
    let lat1 = coordinate.latitude * .pi / 180
    let lat2 = other.coordinate.latitude * .pi / 180
    let deltaLongitude = (other.coordinate.longitude - coordinate.longitude) * .pi / 180
    let degrees = atan2(
      sin(deltaLongitude) * cos(lat2),
      cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(deltaLongitude)
    ) * 180 / .pi
    return degrees >= 0 ? degrees : degrees + 360
  }
}
#endif
