import Foundation

#if DEBUG && targetEnvironment(simulator)
  /// Simulator-only evidence for restoring a trip after a relaunch, through the real
  /// `NavOSSNavigationService` (which the Swift package tests cannot load). Launched with
  /// `SIMCTL_CHILD_NAVOSS_RESTORE_E2E=<steps>`; does nothing otherwise and is compiled out of
  /// device and Release builds. Output lines start with `NAVOSS_RESTORE_E2E` and carry states,
  /// step indexes and booleans, never coordinates.
  ///
  /// Steps:
  /// - `probe`: in-process checks on private service instances with their own store: what a
  ///   restored trip publishes and what every read returns before and after a fix is matched,
  ///   and a checkpoint held inside its critical section while a clear, or a restart of the
  ///   same trip identifier on new geometry, competes for the lock.
  /// - `seed`: starts the synthetic trip on the shared service, as the phone would.
  /// - `observe`: logs what the shared service shows at launch and on every change, and each
  ///   utterance, for a kill-and-relaunch run driven by `simctl location`.
  enum NavOSSRestoreSimulatorHarness {
    static func runIfRequested() {
      let environment = ProcessInfo.processInfo.environment
      guard let steps = environment["NAVOSS_RESTORE_E2E"], !steps.isEmpty else { return }
      for step in steps.split(separator: ",").map(String.init) {
        switch step {
        case "probe":
          DispatchQueue.global().async { probe() }
        case "seed":
          do {
            try NavOSSNavigationService.shared.startNavigation(syntheticTrip(id: "restore-e2e"))
            log("seed started")
          } catch {
            log("seed failed \(type(of: error))")
          }
        case "observe":
          observe(NavOSSNavigationService.shared)
        default:
          log("unknown step \(step)")
        }
      }
    }

    private static func log(_ message: String) {
      print("NAVOSS_RESTORE_E2E \(message)")
      fflush(stdout)
    }

    // MARK: Synthetic route

    /// The validation harness's start point in Calgary, and a local metre frame around it.
    private static let origin = (latitude: 51.04427, longitude: -114.06309)
    private static let metersPerDegree = Double.pi * 6_371_000 / 180

    static func coordinate(_ x: Double, _ y: Double) -> NavOSSCarPlayCoordinate {
      NavOSSCarPlayCoordinate(
        latitude: origin.latitude + y / metersPerDegree,
        longitude: origin.longitude + x / (metersPerDegree * cos(origin.latitude * .pi / 180))
      )
    }

    private static func line(_ corners: [(Double, Double)]) -> [NavOSSCarPlayCoordinate] {
      var points = [coordinate(corners[0].0, corners[0].1)]
      for (start, end) in zip(corners, corners.dropFirst()) {
        let count = max(1, Int((hypot(end.0 - start.0, end.1 - start.1) / 20).rounded(.up)))
        for index in 1...count {
          let fraction = Double(index) / Double(count)
          points.append(
            coordinate(
              start.0 + (end.0 - start.0) * fraction, start.1 + (end.1 - start.1) * fraction))
        }
      }
      return points
    }

    /// North 800 m, east 900 m, north 900 m: three legs and an arrival.
    static let corners: [(Double, Double)] = [(0, 0), (0, 800), (900, 800), (900, 1_700)]

    static func syntheticTrip(
      id: String, corners: [(Double, Double)] = corners
    ) -> NavOSSCarPlayTrip {
      var steps: [NavOSSCarPlayRouteStep] = []
      for (index, (start, end)) in zip(corners, corners.dropFirst()).enumerated() {
        let length = hypot(end.0 - start.0, end.1 - start.1)
        steps.append(
          NavOSSCarPlayRouteStep(
            distanceMeters: length, durationSeconds: length / 12,
            geometry: line([start, end]),
            instruction: index == 0 ? "Head north" : "Turn \(index == 1 ? "right" : "left")",
            maneuverType: index == 0 ? "depart" : "turn",
            roadName: "Restore Road \(index)"
          ))
      }
      let last = corners[corners.count - 1]
      steps.append(
        NavOSSCarPlayRouteStep(
          distanceMeters: 0, durationSeconds: 0, geometry: line([last, last]),
          instruction: "You have arrived", maneuverType: "arrive", roadName: ""))
      let destination = coordinate(last.0, last.1)
      return NavOSSCarPlayTrip(
        destination: NavOSSCarPlayDestination(
          id: "restore-e2e-destination", label: "Restore test", latitude: destination.latitude,
          longitude: destination.longitude, name: "Restore test"),
        distanceMeters: steps.reduce(0) { $0 + $1.distanceMeters },
        durationSeconds: steps.reduce(0) { $0 + $1.durationSeconds },
        geometry: line(corners), id: id, steps: steps)
    }

    private static func fix(_ x: Double, _ y: Double, course: Double?, speed: Double, at time: Date)
      -> NavigationLocationSample
    {
      let point = coordinate(x, y)
      return NavigationLocationSample(
        coordinate: NavigationCoordinate(latitude: point.latitude, longitude: point.longitude),
        courseDegrees: course, horizontalAccuracyMeters: 5, speedMetersPerSecond: speed,
        timestamp: time.timeIntervalSinceReferenceDate)
    }

    // MARK: Summaries (no coordinates)

    private static func summary(_ state: NavOSSNavigationServiceState) -> String {
      "trip=\(state.trip != nil) acquiring=\(state.isAcquiringPosition) phase=\(state.navigation.phase) "
        + "guidanceStep=\(state.guidance.map { String($0.stepIndex) } ?? "-") "
        + "matched=\(state.navigation.matchedCoordinate != nil) "
        + "road=\(state.roadContext.currentRoadName != nil) "
        + "progress=\(String(format: "%.2f", state.navigation.routeProgress))"
    }

    private static func carPlaySummary() -> String {
      let state = NavOSSCarPlayTripStore.shared.snapshot()
      return "carPlayTrip=\(state.trip != nil) carPlayGuidance=\(state.guidance.map { "\($0.phase.rawValue):\($0.stepIndex)" } ?? "-")"
    }

    private static func storeSummary(_ defaults: UserDefaults = .standard) -> String {
      let key = "org.navoss.mobile.active-navigation-trip.v2"
      var deferred = "-"
      if let data = defaults.data(forKey: key + ".progress"),
        let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      {
        deferred = record["arrivalDeferral"] == nil ? "false" : "true"
      }
      return "storedTrip=\(defaults.data(forKey: key) != nil) "
        + "storedProgress=\(defaults.data(forKey: key + ".progress") != nil) storedDeferred=\(deferred)"
    }

    // MARK: observe

    private static var observer: NSObjectProtocol?

    private static func observe(_ service: NavOSSNavigationService) {
      log("launch \(summary(service.currentState())) \(carPlaySummary()) \(storeSummary())")
      log("live road=\(service.carPlayLiveGuidance().currentRoadName != nil)")
      var last = ""
      observer = NotificationCenter.default.addObserver(
        forName: .navOSSNavigationSnapshotDidChange, object: service, queue: .main
      ) { _ in
        let line = "\(summary(service.currentState())) \(carPlaySummary()) \(storeSummary())"
        guard line != last else { return }
        last = line
        log("change \(line)")
      }
      DispatchQueue.main.async {
        service.speechWillStart = { text in log("speech \(text)") }
      }
    }

    // MARK: probe

    private final class Recorder: @unchecked Sendable {
      private let lock = NSLock()
      private var values: [String] = []
      func append(_ value: String) { lock.withLock { values.append(value) } }
      var all: [String] { lock.withLock { values } }
      func removeAll() { lock.withLock { values.removeAll() } }
    }

    private static func check(_ name: String, _ condition: Bool, _ detail: String = "") {
      log("\(condition ? "PASS" : "FAIL") \(name)\(detail.isEmpty ? "" : " \(detail)")")
    }

    private static func service(_ suite: String) -> (
      NavOSSNavigationService, NavOSSActiveTripStore, UserDefaults, NotificationCenter
    ) {
      let defaults = UserDefaults(suiteName: suite)!
      defaults.removePersistentDomain(forName: suite)
      let store = NavOSSActiveTripStore(defaults: defaults)
      let center = NotificationCenter()
      return (
        NavOSSNavigationService(activeTripStore: store, notificationCenter: center), store,
        defaults, center
      )
    }

    private static func probe() {
      // Each probe service numbers its generations from zero, and the shared CarPlay store
      // ignores a lower generation than it has seen: the probe that checks CarPlay runs first.
      probeRestorePublication()
      probeUnknownCaptureTimeNeedsMovement()
      probeCheckpointRaces()
      log("probe done")
    }

    /// Saved 100 m before the destination, standing still, with a capture time in the future
    /// (the clock was set back) and then missing: stationary fixes biased onto the destination
    /// neither arrive nor drop the trip, through the service, its publication and its store.
    private static func probeUnknownCaptureTimeNeedsMovement() {
      for (label, offset) in [("future", 3_600.0 as Double?), ("missing", nil)] {
        let suite = "NavOSSRestoreE2E.unknown-time.\(label)"
        let (service, store, defaults, _) = service(suite)
        defer { defaults.removePersistentDomain(forName: suite) }
        let trip = syntheticTrip(id: "restore-unknown-time")
        let now = Date()
        store.save(trip)
        store.saveProgress(
          NavigationResumeContext(
            alongMeters: 2_500, highWaterAlongMeters: 2_500, uncertaintyMeters: 5,
            timestamp: offset.map { now.addingTimeInterval($0).timeIntervalSinceReferenceDate },
            speedMetersPerSecond: 0, arrivalDeferral: nil),
          forTripId: trip.id)
        service.resumePersistedNavigation()
        var phases: [String] = []
        for second in 0..<6 {
          _ = try? service.ingest(
            fix(900, 1_700, course: nil, speed: 0, at: now.addingTimeInterval(Double(second))))
          phases.append("\(service.currentState().navigation.phase)")
        }
        var deferred = false
        if case .progress(let progress) = store.loadProgress(for: trip) {
          deferred = progress.isArrivalDeferred
        }
        check(
          "unknown-time-\(label)-no-arrival",
          !phases.contains("arrived") && store.load() != nil && deferred,
          "phases=\(phases) \(storeSummary(defaults))")
        service.clearNavigation()
      }
    }

    /// Saved at 400 m on the first leg; the vehicle is on the last leg when the app comes back.
    private static func probeRestorePublication() {
      let suite = "NavOSSRestoreE2E.publication"
      let (service, store, defaults, center) = service(suite)
      defer { defaults.removePersistentDomain(forName: suite) }
      let trip = syntheticTrip(id: "restore-probe")
      let savedAt = Date().addingTimeInterval(-600)
      store.save(trip)
      store.saveProgress(
        NavigationResumeContext(
          alongMeters: 400, highWaterAlongMeters: 400, uncertaintyMeters: 5,
          timestamp: savedAt.timeIntervalSinceReferenceDate, speedMetersPerSecond: nil,
          arrivalDeferral: nil),
        forTripId: trip.id)
      let notifications = Recorder()
      let spoken = Recorder()
      let token = center.addObserver(
        forName: .navOSSNavigationSnapshotDidChange, object: service, queue: nil
      ) { _ in notifications.append(summary(service.currentState())) }
      defer { center.removeObserver(token) }
      DispatchQueue.main.sync { service.speechWillStart = { spoken.append($0) } }

      service.resumePersistedNavigation()
      var state = service.currentState()
      check(
        "restored-pull-withheld",
        state.trip != nil && state.isAcquiringPosition && state.guidance == nil
          && state.navigation.matchedCoordinate == nil && state.roadContext.currentRoadName == nil,
        summary(state))
      let restoredCarPlay = NavOSSCarPlayTripStore.shared.snapshot()
      check(
        "restored-carplay-acquiring",
        restoredCarPlay.trip?.id == trip.id && restoredCarPlay.guidance == nil,
        carPlaySummary())
      check(
        "restored-callback-withheld",
        notifications.all.count == 1 && notifications.all.allSatisfy { $0.contains("acquiring=true") },
        notifications.all.joined(separator: " | "))
      check("restored-live-road-withheld", service.carPlayLiveGuidance().currentRoadName == nil)

      // A held first fix on the last leg: still nothing guided, pulled or announced.
      let now = Date()
      notifications.removeAll()
      _ = try? service.ingest(fix(900, 1_000, course: 0, speed: 12, at: now))
      state = service.currentState()
      check(
        "held-pull-withheld",
        state.isAcquiringPosition && state.guidance == nil && state.navigation.rawCoordinate != nil,
        summary(state))
      check(
        "held-callback-withheld",
        !notifications.all.isEmpty && notifications.all.allSatisfy { $0.contains("acquiring=true") },
        notifications.all.joined(separator: " | "))
      check(
        "held-carplay-acquiring", NavOSSCarPlayTripStore.shared.snapshot().guidance == nil,
        carPlaySummary())
      DispatchQueue.main.sync {}
      check("held-silent", spoken.all.isEmpty, spoken.all.joined(separator: " | "))

      // The confirming fix: the correct step everywhere, announced once.
      notifications.removeAll()
      _ = try? service.ingest(fix(900, 1_012, course: 0, speed: 12, at: now.addingTimeInterval(1)))
      state = service.currentState()
      check(
        "confirmed-pull-step",
        !state.isAcquiringPosition && state.guidance?.stepIndex == 2, summary(state))
      check(
        "confirmed-callback-step",
        notifications.all.last?.contains("guidanceStep=2") == true,
        notifications.all.joined(separator: " | "))
      check(
        "confirmed-carplay-step",
        NavOSSCarPlayTripStore.shared.snapshot().guidance?.stepIndex == 2, carPlaySummary())
      Thread.sleep(forTimeInterval: 0.5)
      DispatchQueue.main.sync {}
      // The saved step's maneuver is the right turn onto the second leg; it is behind.
      check(
        "confirmed-no-stale-prompt", !spoken.all.contains { $0.contains("right") },
        "spoken=[\(spoken.all.joined(separator: " | "))]")
      service.clearNavigation()
      check("cleared-store", store.load() == nil, storeSummary(defaults))
    }

    /// A checkpoint held inside its critical section, at the store write, while a clear or a
    /// restart of the same trip identifier on new geometry is issued: the competitor waits for
    /// the lock, nothing deadlocks, and the store ends with the competitor's state.
    private static func probeCheckpointRaces() {
      for competitor in ["clear", "same-id-new-geometry"] {
        let suite = "NavOSSRestoreE2E.race.\(competitor)"
        let (service, store, defaults, _) = service(suite)
        defer { defaults.removePersistentDomain(forName: suite) }
        let trip = syntheticTrip(id: "restore-race")
        let replacement = syntheticTrip(
          id: trip.id, corners: [(0, 0), (0, 400), (-600, 400), (-600, 1_400)])
        do {
          try service.startNavigation(trip)
        } catch {
          check("race-\(competitor)-start", false)
          continue
        }
        let inside = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let checkpointDone = DispatchSemaphore(value: 0)
        let competitorDone = DispatchSemaphore(value: 0)
        service.checkpointWillWrite = {
          inside.signal()
          release.wait()
        }
        DispatchQueue.global().async {
          _ = try? service.ingest(fix(0, 300, course: 0, speed: 12, at: Date()))
          checkpointDone.signal()
        }
        guard inside.wait(timeout: .now() + 5) == .success else {
          check("race-\(competitor)-checkpoint-reached", false)
          release.signal()
          continue
        }
        service.checkpointWillWrite = nil
        DispatchQueue.global().async {
          if competitor == "clear" {
            service.clearNavigation()
          } else {
            try? service.startNavigation(replacement)
          }
          competitorDone.signal()
        }
        let waitedForLock = competitorDone.wait(timeout: .now() + 0.5) == .timedOut
        release.signal()
        let finished =
          checkpointDone.wait(timeout: .now() + 5) == .success
          && competitorDone.wait(timeout: .now() + 5) == .success
        check("race-\(competitor)-serialized", waitedForLock)
        check("race-\(competitor)-no-deadlock", finished)
        if competitor == "clear" {
          check(
            "race-clear-final", store.load() == nil && store.loadProgress(for: trip) == .withoutProgress,
            storeSummary(defaults))
        } else {
          let stored = store.load()
          check(
            "race-same-id-final",
            stored?.geometry.count == replacement.geometry.count
              && store.loadProgress(for: replacement) == .withoutProgress,
            storeSummary(defaults))
          // The replacement's own first checkpoint is written as usual.
          _ = try? service.ingest(fix(0, 200, course: 0, speed: 12, at: Date().addingTimeInterval(1)))
          if case .progress(let progress) = store.loadProgress(for: replacement) {
            check("race-same-id-next-checkpoint", abs(progress.alongMeters - 200) < 10)
          } else {
            check("race-same-id-next-checkpoint", false, storeSummary(defaults))
          }
          service.clearNavigation()
        }
      }
    }
  }
#endif
