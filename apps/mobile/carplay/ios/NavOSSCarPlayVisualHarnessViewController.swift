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
    // Offline scenarios draw the installed offline region's local style (needs a region
    // installed on the simulator; see docs/architecture/offline.md).
    mapViewController.forcesOfflineStyle = scenario.hasPrefix("offline-")

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
    case "preview", "offline-preview":
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
      // The night run stands in for the core's over-limit verdict (68 km/h in a 50 zone).
      renderGuidance(
        trip: trip, guidance: guidance, position: position, progress: 0.29, speedLimitKph: 50,
        speeding: night ? .overLimit : .withinLimit)
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
    case "real-calgary-exit", "real-calgary-exit-night", "real-vancouver-exit",
      "real-vancouver-lanes-night":
      // Ready is signalled below only when the recording decoded and rendered.
      guard renderRecordedRouteScenario() else { return }
    case "maneuver-symbols":
      showManeuverSymbols()
      return
    case "search-hub", "search-results", "preview-alternatives", "guidance-lanes-then",
      "guidance-roundabout", "reroute-proposal", "arrival", "end", "dashboard":
      renderFlowScenario()
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
    speedLimitKph: Int?,
    speeding: NavOSSSpeedingState = .unknown
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
        congestion: trip.congestion,
        speeding: speeding
      )
    )
  }

  // MARK: Recorded routes
  //
  // Real `/v2/routes` responses recorded from the NavOSS API with the public development Valhalla
  // (apps/mobile/test/fixtures/routes-v2, read from the host through NAVOSS_ROUTE_FIXTURES_DIR).
  // The lanes, exit numbers, signposts and posted limits shown are the router's; the harness only
  // chooses where along the recorded route the vehicle is.

  private func renderRecordedRouteScenario() -> Bool {
    let (fixture, maneuverIndex, metersBefore): (String, Int, Double) =
      switch scenario {
      case "real-calgary-exit", "real-calgary-exit-night": ("calgary-deerfoot-glenmore.v2", 1, 450)
      case "real-vancouver-exit": ("vancouver-bc91-highway99.v2", 1, 450)
      default: ("vancouver-bc91-highway99.v2", 3, 160)
      }
    guard
      let directory = ProcessInfo.processInfo.environment["NAVOSS_ROUTE_FIXTURES_DIR"],
      let data = try? Data(
        contentsOf: URL(fileURLWithPath: directory).appendingPathComponent("\(fixture).json")),
      let document = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let response = document["response"],
      let body = try? JSONSerialization.data(withJSONObject: response),
      let request = document["request"] as? [String: Any],
      let target = request["destination"] as? [String: Double],
      let latitude = target["latitude"], let longitude = target["longitude"],
      let trip = try? navOSSTripsFromRoutesV2Response(
        body,
        destination: NavOSSCarPlayDestination(
          id: fixture, label: "Recorded route", latitude: latitude, longitude: longitude,
          name: "Recorded destination")
      ).first,
      trip.steps.indices.contains(maneuverIndex), maneuverIndex > 0
    else {
      print("NAVOSS_CARPLAY_VISUAL_FAILED \(scenario): recorded route unavailable")
      return false
    }
    useCarPlayFrame(CGSize(width: 800, height: 480), guidanceCardInset: 300)
    let drivenIndex = maneuverIndex - 1
    let driven = trip.steps[drivenIndex]
    let toManeuver = min(metersBefore, driven.distanceMeters * 0.9)
    // Walk back from the maneuver along the driven step's geometry.
    var remainingBack = toManeuver
    var position = driven.geometry[driven.geometry.count - 1]
    var course = 0.0
    for index in stride(from: driven.geometry.count - 1, to: 0, by: -1) {
      let end = CLLocation(
        latitude: driven.geometry[index].latitude, longitude: driven.geometry[index].longitude)
      let start = CLLocation(
        latitude: driven.geometry[index - 1].latitude,
        longitude: driven.geometry[index - 1].longitude)
      let length = start.distance(from: end)
      course = start.bearing(to: end)
      if length >= remainingBack, length > 0 {
        let fraction = 1 - remainingBack / length
        position = NavOSSCarPlayCoordinate(
          latitude: start.coordinate.latitude
            + (end.coordinate.latitude - start.coordinate.latitude) * fraction,
          longitude: start.coordinate.longitude
            + (end.coordinate.longitude - start.coordinate.longitude) * fraction)
        break
      }
      remainingBack -= length
      position = driven.geometry[index - 1]
    }
    let travelled =
      trip.steps[..<drivenIndex].reduce(0) { $0 + $1.distanceMeters } + driven.distanceMeters
      - toManeuver
    let remaining = max(0, trip.distanceMeters - travelled)
    let maneuver = trip.steps[maneuverIndex]
    let guidance = NavOSSCarPlayGuidance(
      distanceToManeuverMeters: toManeuver, durationToManeuverSeconds: toManeuver / 22,
      instruction: maneuver.instruction, maneuverType: maneuver.maneuverType, phase: .navigating,
      remainingDistanceMeters: remaining, remainingDurationSeconds: remaining / 18,
      roadName: maneuver.roadName, stepIndex: drivenIndex)
    // The recorded posted limit on the segment nearest the vehicle, if it is known.
    let here = CLLocation(latitude: position.latitude, longitude: position.longitude)
    let nearestSegment = trip.geometry.indices.dropLast().min { left, right in
      here.distance(
        from: CLLocation(
          latitude: trip.geometry[left].latitude, longitude: trip.geometry[left].longitude))
        < here.distance(
          from: CLLocation(
            latitude: trip.geometry[right].latitude, longitude: trip.geometry[right].longitude))
    }
    let limit = nearestSegment.flatMap { index in
      trip.speedLimitsKph.flatMap { $0.indices.contains(index) && $0[index] > 0 ? $0[index] : nil }
    }
    renderGuidance(
      trip: trip, guidance: guidance,
      position: NavOSSCarPlayPosition(
        coordinate: position, courseDegrees: course, speedMetersPerSecond: 22),
      progress: trip.distanceMeters > 0 ? travelled / trip.distanceMeters : 0,
      speedLimitKph: limit, speeding: limit == nil ? .unknown : .withinLimit)
    showMockCard(trip: trip, guidance: guidance)
    return true
  }

  // MARK: Flow scenarios
  //
  // CarPlay draws its own templates (lists, grids, the turn card, alerts), and the simulator cannot
  // host them on Xcode 27.2. These scenarios render the map exactly as production does and lay a
  // clearly labelled mock over it whose *content* comes from the same production functions
  // (presentation, ordering, symbols, lanes, alert text). The mock's look is an approximation.

  private func renderFlowScenario() {
    let frame = CGSize(width: 800, height: 480)
    switch scenario {
    case "search-hub":
      useCarPlayFrame(frame, guidanceCardInset: 0)
      mapViewController.displayIdleLocation(
        NavOSSCarPlayCoordinate(latitude: 51.04470, longitude: -114.07190), animated: false)
      showMockGrid(
        title: "Search",
        bar: ["Categories", "⌨︎", "🎙"],
        buttons: [
          ("house.fill", "Home"), ("briefcase.fill", "Work"),
          ("clock.arrow.circlepath", "Recents"), ("star.fill", "Saved"),
          ("fuelpump.fill", "Gas"), ("cup.and.saucer.fill", "Coffee"),
          ("fork.knife", "Food"), ("parkingsign.circle.fill", "Parking"),
        ])
    case "search-results":
      useCarPlayFrame(frame, guidanceCardInset: 0)
      mapViewController.displayIdleLocation(Self.here, animated: false)
      // Harness fixture places, in provider order; production ordering and labels reorder them.
      let ordered = navOSSCarPlayDestinationsOrderedByDistance(Self.fixtureCafes, from: Self.here)
      showMockList(
        title: "Coffee",
        rows: ordered.map { place in
          (
            nil, place.name,
            "\(navOSSCarPlayDistanceLabel(navOSSCarPlayDistanceMeters(from: Self.here, to: place))) · \(place.label)"
          )
        })
    case "preview-alternatives":
      useCarPlayFrame(frame, guidanceCardInset: 0)
      let trip = Self.turnTrip
      let alternate = trip.geometry.enumerated().map { index, coordinate in
        NavOSSCarPlayCoordinate(
          latitude: coordinate.latitude - (index == 1 || index == 2 ? 0.0030 : 0),
          longitude: coordinate.longitude)
      }
      mapViewController.display(
        route: trip.geometry, routeId: trip.id, activeGuidance: false, alternateRoute: alternate)
      showMockList(
        title: trip.destination.name,
        rows: [
          ("checkmark.circle.fill", "Fastest route · via 9 Avenue SW", "3 min · 1.6 km"),
          (nil, "Alternative 1 · 400 m longer", "4 min · 2.0 km"),
        ],
        footer: "Go",
        width: 300)
    case "guidance-lanes-then":
      useCarPlayFrame(frame, guidanceCardInset: 300)
      let trip = Self.lanesThenTrip
      let guidance = Self.guidance(stepIndex: 0, toManeuver: 140, remaining: 900)
      renderGuidance(
        trip: trip, guidance: guidance,
        position: NavOSSCarPlayPosition(
          coordinate: NavOSSCarPlayCoordinate(latitude: 51.04470, longitude: -114.06700),
          courseDegrees: 90, speedMetersPerSecond: 11),
        progress: 0.33, speedLimitKph: 50, speeding: .withinLimit)
      showMockCard(trip: trip, guidance: guidance)
    case "guidance-roundabout":
      useCarPlayFrame(frame, guidanceCardInset: 300)
      let trip = Self.roundaboutTrip
      let guidance = Self.guidance(stepIndex: 0, toManeuver: 90, remaining: 700)
      renderGuidance(
        trip: trip, guidance: guidance,
        position: NavOSSCarPlayPosition(
          coordinate: NavOSSCarPlayCoordinate(latitude: 51.04640, longitude: -114.07000),
          courseDegrees: 0, speedMetersPerSecond: 9),
        progress: 0.4, speedLimitKph: 40, speeding: .withinLimit)
      showMockCard(trip: trip, guidance: guidance)
    case "reroute-proposal":
      useCarPlayFrame(frame, guidanceCardInset: 300)
      let trip = Self.turnTrip
      let guidance = Self.guidance(stepIndex: 0, toManeuver: 400, remaining: 1_300)
      renderGuidance(
        trip: trip, guidance: guidance,
        position: NavOSSCarPlayPosition(
          coordinate: NavOSSCarPlayCoordinate(latitude: 51.04470, longitude: -114.07200),
          courseDegrees: 90, speedMetersPerSecond: 12),
        progress: 0.15, speedLimitKph: 50, speeding: .withinLimit)
      showMockCard(trip: trip, guidance: guidance)
      // Harness fixture proposal; the text comes from the production formatter.
      let text = navOSSCarPlayRerouteProposalText(
        .init(id: "fixture", durationDeltaSeconds: 180, distanceDeltaMeters: 650))
      showMockAlert(title: text.title, subtitle: text.subtitle, actions: ["Use new route", "Keep mine"])
    case "arrival":
      useCarPlayFrame(frame, guidanceCardInset: 300)
      let trip = Self.turnTrip
      let end = trip.geometry[trip.geometry.count - 1]
      mapViewController.display(
        route: trip.geometry, routeId: trip.id, activeGuidance: true,
        position: NavOSSCarPlayPosition(coordinate: end, courseDegrees: 0, speedMetersPerSecond: 0),
        routeProgress: 1, distanceToManeuverMeters: 0)
      showMockAlert(
        title: "You've arrived", subtitle: trip.destination.name, actions: ["Done", "Keep map"])
    case "end":
      useCarPlayFrame(frame, guidanceCardInset: 0)
      let trip = Self.turnTrip
      renderGuidance(
        trip: trip, guidance: Self.guidance(stepIndex: 0, toManeuver: 300, remaining: 1_200),
        position: NavOSSCarPlayPosition(
          coordinate: NavOSSCarPlayCoordinate(latitude: 51.04470, longitude: -114.07000),
          courseDegrees: 90, speedMetersPerSecond: 12),
        progress: 0.2, speedLimitKph: 50)
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
        self?.mapViewController.clearRoute()
        self?.mapViewController.displayIdleLocation(Self.here, animated: false)
      }
    case "dashboard":
      // Dashboard tile proportions with the production Dashboard options.
      useCarPlayFrame(CGSize(width: 440, height: 480), guidanceCardInset: 0)
      mapViewController.showsRoadName = false
      mapViewController.anchorsSpeedHUDToViewBounds = false
      let trip = Self.turnTrip
      renderGuidance(
        trip: trip, guidance: Self.guidance(stepIndex: 0, toManeuver: 180, remaining: 980),
        position: NavOSSCarPlayPosition(
          coordinate: NavOSSCarPlayCoordinate(latitude: 51.04470, longitude: -114.06750),
          courseDegrees: 90, speedMetersPerSecond: 12),
        progress: 0.29, speedLimitKph: 50, speeding: .withinLimit)
      showMockDashboardButtons()
    default:
      break
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in self?.markReady() }
  }

  private static let here = NavOSSCarPlayCoordinate(latitude: 51.04470, longitude: -114.07190)

  private static func fixtureCafe(_ name: String, _ latitude: Double, _ longitude: Double)
    -> NavOSSCarPlayDestination
  {
    NavOSSCarPlayDestination(
      category: "cafe", id: "fixture-\(name)", label: "Cafe · harness fixture",
      latitude: latitude, longitude: longitude, name: name)
  }

  private static let fixtureCafes: [NavOSSCarPlayDestination] = [
    fixtureCafe("Harness Cafe North", 51.0560, -114.0720),
    fixtureCafe("Harness Cafe Close", 51.0452, -114.0712),
    fixtureCafe("Harness Cafe East", 51.0447, -114.0600),
    fixtureCafe("Harness Cafe Mid", 51.0480, -114.0750),
  ]

  private static func guidance(stepIndex: Int, toManeuver: Double, remaining: Double)
    -> NavOSSCarPlayGuidance
  {
    NavOSSCarPlayGuidance(
      distanceToManeuverMeters: toManeuver, durationToManeuverSeconds: toManeuver / 12,
      instruction: "", maneuverType: "turn", phase: .navigating,
      remainingDistanceMeters: remaining, remainingDurationSeconds: remaining / 12, roadName: "",
      stepIndex: stepIndex)
  }

  /// Harness fixture: a left turn with lanes, then a right turn 180 m later.
  private static var lanesThenTrip: NavOSSCarPlayTrip {
    let a = NavOSSCarPlayCoordinate(latitude: 51.04470, longitude: -114.07200)
    let b = NavOSSCarPlayCoordinate(latitude: 51.04470, longitude: -114.06500)
    let c = NavOSSCarPlayCoordinate(latitude: 51.04632, longitude: -114.06500)
    let d = NavOSSCarPlayCoordinate(latitude: 51.04632, longitude: -114.05900)
    return NavOSSCarPlayTrip(
      destination: NavOSSCarPlayDestination(
        id: "fixture-lanes", label: "Harness fixture", latitude: d.latitude,
        longitude: d.longitude, name: "Fixture destination"),
      distanceMeters: 1_100, durationSeconds: 120, geometry: [a, b, c, d], id: "visual-lanes",
      steps: [
        NavOSSCarPlayRouteStep(
          distanceMeters: 490, durationSeconds: 45, geometry: [a, b],
          instruction: "Drive east on 9 Avenue SW.", maneuverType: "depart",
          roadName: "9 Avenue SW"),
        NavOSSCarPlayRouteStep(
          distanceMeters: 180, durationSeconds: 20, geometry: [b, c],
          instruction: "Turn left onto Centre Street.", maneuverType: "turn",
          roadName: "Centre Street",
          lanes: [
            NavOSSCarPlayLane(indications: [.left], isValid: true, isPreferred: true),
            NavOSSCarPlayLane(indications: [.left, .straight], isValid: true),
            NavOSSCarPlayLane(indications: [.straight], isValid: false),
            NavOSSCarPlayLane(indications: [.straight, .right], isValid: false),
          ]),
        NavOSSCarPlayRouteStep(
          distanceMeters: 420, durationSeconds: 50, geometry: [c, d],
          instruction: "Turn right onto 7 Avenue SE.", maneuverType: "turn",
          roadName: "7 Avenue SE"),
        NavOSSCarPlayRouteStep(
          distanceMeters: 0, durationSeconds: 0, geometry: [d, d],
          instruction: "You have arrived.", maneuverType: "arrive", roadName: "7 Avenue SE"),
      ])
  }

  /// Harness fixture: north into a roundabout, second exit continuing north.
  private static var roundaboutTrip: NavOSSCarPlayTrip {
    let center = (latitude: 51.04750, longitude: -114.07000)
    let r = 0.00025
    let lonR = r / cos(center.latitude * .pi / 180)
    func ring(_ degrees: Double) -> NavOSSCarPlayCoordinate {
      let radians = degrees * .pi / 180
      return NavOSSCarPlayCoordinate(
        latitude: center.latitude + r * cos(radians), longitude: center.longitude + lonR * sin(radians))
    }
    let start = NavOSSCarPlayCoordinate(latitude: 51.04550, longitude: -114.07000)
    let entry = ring(180)
    let circulation = [entry, ring(135), ring(90), ring(45), ring(0)]
    let north = NavOSSCarPlayCoordinate(latitude: 51.04950, longitude: -114.07000)
    return NavOSSCarPlayTrip(
      destination: NavOSSCarPlayDestination(
        id: "fixture-roundabout", label: "Harness fixture", latitude: north.latitude,
        longitude: north.longitude, name: "Fixture destination"),
      distanceMeters: 480, durationSeconds: 60,
      geometry: [start] + circulation + [north], id: "visual-roundabout",
      steps: [
        NavOSSCarPlayRouteStep(
          distanceMeters: 190, durationSeconds: 20, geometry: [start, entry],
          instruction: "Drive north on 1 Street SW.", maneuverType: "depart",
          roadName: "1 Street SW"),
        NavOSSCarPlayRouteStep(
          distanceMeters: 70, durationSeconds: 15, geometry: circulation,
          instruction: "Enter the roundabout and take the 2nd exit onto 1 Street SW.",
          maneuverType: "roundabout", roadName: "1 Street SW"),
        NavOSSCarPlayRouteStep(
          distanceMeters: 220, durationSeconds: 25, geometry: [circulation[4], north],
          instruction: "Exit the roundabout onto 1 Street SW.", maneuverType: "exit roundabout",
          roadName: "1 Street SW"),
        NavOSSCarPlayRouteStep(
          distanceMeters: 0, durationSeconds: 0, geometry: [north, north],
          instruction: "You have arrived.", maneuverType: "arrive", roadName: "1 Street SW"),
      ])
  }

  // MARK: Mock CarPlay chrome (harness only)

  private var mockHost: UIView { mapViewController.view }

  private func mockLabel(_ text: String, size: CGFloat, weight: UIFont.Weight, color: UIColor = .white)
    -> UILabel
  {
    let label = UILabel()
    label.text = text
    label.font = .systemFont(ofSize: size, weight: weight)
    label.textColor = color
    label.numberOfLines = 2
    return label
  }

  private func addMockBadge(to view: UIView) {
    let badge = mockLabel("HARNESS MOCK · CarPlay draws the real template", size: 9, weight: .bold, color: .black)
    badge.backgroundColor = UIColor(red: 0.97, green: 0.79, blue: 0.28, alpha: 1)
    badge.textAlignment = .center
    badge.frame = CGRect(x: view.bounds.width - 250, y: view.bounds.height - 16, width: 250, height: 16)
    view.addSubview(badge)
  }

  private func mockPanel(width: CGFloat? = nil) -> UIView {
    let bounds = mockHost.bounds
    let panel = UIView(frame: CGRect(x: 0, y: 0, width: width ?? bounds.width, height: bounds.height))
    panel.backgroundColor = UIColor(white: 0.08, alpha: width == nil ? 0.96 : 0.92)
    mockHost.addSubview(panel)
    return panel
  }

  private func showMockGrid(title: String, bar: [String], buttons: [(String, String)]) {
    let panel = mockPanel()
    let heading = mockLabel(title, size: 18, weight: .bold)
    heading.frame = CGRect(x: 0, y: 10, width: panel.bounds.width, height: 26)
    heading.textAlignment = .center
    panel.addSubview(heading)
    let barLabel = mockLabel(bar.joined(separator: "    "), size: 14, weight: .semibold,
      color: UIColor(red: 0.24, green: 0.84, blue: 0.71, alpha: 1))
    barLabel.frame = CGRect(x: 16, y: 10, width: panel.bounds.width - 32, height: 26)
    barLabel.textAlignment = .right
    panel.addSubview(barLabel)
    let columns = 4
    let cell = CGSize(width: (panel.bounds.width - 40) / CGFloat(columns), height: 180)
    for (index, button) in buttons.enumerated() {
      let x = 20 + CGFloat(index % columns) * cell.width
      let y = 70 + CGFloat(index / columns) * cell.height
      let icon = UIImageView(image: UIImage(systemName: button.0))
      icon.tintColor = .white
      icon.contentMode = .scaleAspectFit
      icon.frame = CGRect(x: x + cell.width / 2 - 30, y: y, width: 60, height: 60)
      panel.addSubview(icon)
      let label = mockLabel(button.1, size: 15, weight: .semibold)
      label.textAlignment = .center
      label.frame = CGRect(x: x, y: y + 72, width: cell.width, height: 22)
      panel.addSubview(label)
    }
    addMockBadge(to: panel)
  }

  private func showMockList(
    title: String,
    rows: [(String?, String, String)],
    footer: String? = nil,
    width: CGFloat? = nil
  ) {
    let panel = mockPanel(width: width)
    let heading = mockLabel(title, size: 18, weight: .bold)
    heading.frame = CGRect(x: 16, y: 10, width: panel.bounds.width - 32, height: 26)
    panel.addSubview(heading)
    for (index, row) in rows.enumerated() {
      let y = 50 + CGFloat(index) * 64
      let text = mockLabel(row.1, size: 16, weight: .semibold)
      text.frame = CGRect(x: row.0 == nil ? 16 : 52, y: y, width: panel.bounds.width - 70, height: 22)
      panel.addSubview(text)
      let detail = mockLabel(row.2, size: 13, weight: .regular, color: UIColor(white: 0.7, alpha: 1))
      detail.frame = CGRect(x: text.frame.minX, y: y + 24, width: text.frame.width, height: 18)
      panel.addSubview(detail)
      if let symbol = row.0 {
        let icon = UIImageView(image: UIImage(systemName: symbol))
        icon.tintColor = UIColor(red: 0.24, green: 0.84, blue: 0.71, alpha: 1)
        icon.frame = CGRect(x: 16, y: y + 6, width: 26, height: 26)
        panel.addSubview(icon)
      }
      let divider = UIView(frame: CGRect(x: 16, y: y + 54, width: panel.bounds.width - 32, height: 1))
      divider.backgroundColor = UIColor(white: 1, alpha: 0.12)
      panel.addSubview(divider)
    }
    if let footer {
      let go = mockLabel(footer, size: 18, weight: .bold)
      go.textAlignment = .center
      go.backgroundColor = UIColor(red: 0.06, green: 0.56, blue: 0.50, alpha: 1)
      go.layer.cornerRadius = 10
      go.clipsToBounds = true
      go.frame = CGRect(x: 16, y: panel.bounds.height - 70, width: panel.bounds.width - 32, height: 44)
      panel.addSubview(go)
    }
    addMockBadge(to: panel)
  }

  /// The turn card from the production presentation: symbol, distance, instruction, lanes, then.
  private func showMockCard(trip: NavOSSCarPlayTrip, guidance: NavOSSCarPlayGuidance) {
    guard let presentation = navOSSCarPlayGuidancePresentation(trip: trip, guidance: guidance) else {
      return
    }
    let card = UIView(frame: CGRect(x: 10, y: 10, width: 280, height: 0))
    card.backgroundColor = UIColor(red: 0.08, green: 0.38, blue: 0.24, alpha: 1)
    card.layer.cornerRadius = 12
    card.clipsToBounds = true
    mockHost.addSubview(card)
    let primary = presentation.primary
    let symbol = UIImageView(
      image: NavOSSCarPlayManeuverSymbols.image(kind: primary.kind, angleDegrees: primary.turnAngleDegrees))
    symbol.tintColor = .white
    symbol.contentMode = .scaleAspectFit
    symbol.frame = CGRect(x: 12, y: 12, width: 56, height: 56)
    card.addSubview(symbol)
    let distance = mockLabel(
      navOSSCarPlayDistanceLabel(guidance.distanceToManeuverMeters), size: 24, weight: .bold)
    distance.frame = CGRect(x: 80, y: 12, width: 190, height: 30)
    card.addSubview(distance)
    let instruction = mockLabel(primary.instructionVariants[0], size: 15, weight: .semibold)
    instruction.frame = CGRect(x: 80, y: 42, width: 190, height: 40)
    card.addSubview(instruction)
    var y: CGFloat = 92
    if let lanes = primary.lanes {
      let laneWidth: CGFloat = 40
      for (index, lane) in lanes.enumerated() {
        let laneView = UIView(frame: CGRect(x: 12 + CGFloat(index) * (laneWidth + 6), y: y, width: laneWidth, height: 44))
        laneView.backgroundColor = UIColor(white: 0, alpha: 0.25)
        laneView.layer.cornerRadius = 6
        for angle in lane.angles + (lane.highlightedAngle.map { [$0] } ?? []) {
          let arrow = UIImageView(
            image: NavOSSCarPlayManeuverSymbols.image(kind: .straight, angleDegrees: angle))
          arrow.tintColor = angle == lane.highlightedAngle
            ? .white : UIColor(white: 1, alpha: lane.status == .notGood ? 0.25 : 0.45)
          arrow.frame = CGRect(x: 4, y: 4, width: 32, height: 36)
          laneView.addSubview(arrow)
        }
        card.addSubview(laneView)
      }
      y += 52
    }
    if let then = presentation.then {
      let thenRow = UIView(frame: CGRect(x: 0, y: y, width: 280, height: 40))
      thenRow.backgroundColor = UIColor(white: 0, alpha: 0.25)
      let label = mockLabel("Then", size: 14, weight: .semibold)
      label.frame = CGRect(x: 12, y: 10, width: 50, height: 20)
      thenRow.addSubview(label)
      let thenSymbol = UIImageView(
        image: NavOSSCarPlayManeuverSymbols.image(kind: then.kind, angleDegrees: then.turnAngleDegrees))
      thenSymbol.tintColor = .white
      thenSymbol.frame = CGRect(x: 60, y: 6, width: 28, height: 28)
      thenRow.addSubview(thenSymbol)
      card.addSubview(thenRow)
      y += 40
    }
    let road = mockLabel(
      "Now on \(presentation.currentRoadName ?? "an unnamed road")", size: 12, weight: .regular,
      color: UIColor(white: 1, alpha: 0.8))
    road.frame = CGRect(x: 12, y: y + 6, width: 260, height: 18)
    card.addSubview(road)
    card.frame.size.height = y + 30
    addMockBadge(to: mockHost)
  }

  private func showMockAlert(title: String, subtitle: String, actions: [String]) {
    let host = mockHost
    let alert = UIView(frame: CGRect(x: host.bounds.width / 2 - 170, y: 20, width: 340, height: 120))
    alert.backgroundColor = UIColor(white: 0.12, alpha: 0.97)
    alert.layer.cornerRadius = 14
    host.addSubview(alert)
    let heading = mockLabel(title, size: 17, weight: .bold)
    heading.textAlignment = .center
    heading.frame = CGRect(x: 10, y: 12, width: 320, height: 22)
    alert.addSubview(heading)
    let detail = mockLabel(subtitle, size: 14, weight: .regular, color: UIColor(white: 0.8, alpha: 1))
    detail.textAlignment = .center
    detail.frame = CGRect(x: 10, y: 36, width: 320, height: 20)
    alert.addSubview(detail)
    let width = (320 - CGFloat(actions.count - 1) * 8) / CGFloat(actions.count)
    for (index, action) in actions.enumerated() {
      let button = mockLabel(action, size: 15, weight: .semibold)
      button.textAlignment = .center
      button.backgroundColor = index == 0
        ? UIColor(red: 0.06, green: 0.56, blue: 0.50, alpha: 1) : UIColor(white: 0.3, alpha: 1)
      button.layer.cornerRadius = 8
      button.clipsToBounds = true
      button.frame = CGRect(x: 10 + CGFloat(index) * (width + 8), y: 70, width: width, height: 38)
      alert.addSubview(button)
    }
    addMockBadge(to: host)
  }

  private func showMockDashboardButtons() {
    let host = mockHost
    for (index, item) in [("arrow.triangle.turn.up.right.diamond.fill", "Go"), ("mic.fill", "Voice")]
      .enumerated()
    {
      let button = mockLabel("  \(item.1)", size: 15, weight: .semibold)
      button.backgroundColor = UIColor(white: 0.12, alpha: 0.92)
      button.layer.cornerRadius = 10
      button.clipsToBounds = true
      button.frame = CGRect(x: 12 + CGFloat(index) * 110, y: host.bounds.height - 56, width: 100, height: 40)
      host.addSubview(button)
    }
    addMockBadge(to: host)
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
