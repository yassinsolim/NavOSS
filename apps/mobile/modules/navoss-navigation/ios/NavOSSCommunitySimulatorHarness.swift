import Foundation

#if DEBUG && targetEnvironment(simulator)
  /// Simulator-only end-to-end driver for the native community client against a local API
  /// (`COMMUNITY_ATTESTATION_MODE=allow-development`). Launched with
  /// `SIMCTL_CHILD_NAVOSS_COMMUNITY_E2E=<steps>`; does nothing otherwise and is compiled out of
  /// device and Release builds. It goes through the same `NavOSSCommunityService` the phone and
  /// CarPlay use. Output lines start with `NAVOSS_COMMUNITY_E2E` and carry ids and statuses,
  /// never coordinates.
  enum NavOSSCommunitySimulatorHarness {
    static func runIfRequested() {
      let environment = ProcessInfo.processInfo.environment
      guard let steps = environment["NAVOSS_COMMUNITY_E2E"], !steps.isEmpty else { return }
      Task.detached {
        await run(steps: steps.split(separator: ",").map(String.init), environment: environment)
      }
    }

    private static func log(_ message: String) {
      print("NAVOSS_COMMUNITY_E2E \(message)")
      fflush(stdout)
    }

    private static func coordinate(_ environment: [String: String], _ prefix: String)
      -> NavOSSCarPlayCoordinate?
    {
      guard let latitude = environment["\(prefix)_LAT"].flatMap(Double.init),
        let longitude = environment["\(prefix)_LON"].flatMap(Double.init)
      else { return nil }
      return NavOSSCarPlayCoordinate(latitude: latitude, longitude: longitude)
    }

    private static func describe(_ error: Error) -> String {
      (error as? NavOSSCommunityFailure).map { "\($0)" } ?? "\(type(of: error))"
    }

    private static func run(steps: [String], environment: [String: String]) async {
      let community = NavOSSCommunityService.shared
      let here = coordinate(environment, "NAVOSS_E2E") ?? NavOSSCarPlayCoordinate(
        latitude: 51.0447, longitude: -114.0719)
      for step in steps {
        switch step {
        case "state":
          let live = await community.refreshFeatures(force: true)
          let availability = await community.availability()
          log(
            "state reportsLive=\(live) canWrite=\(availability.canWrite) hasIdentity=\(availability.hasIdentity) traffic=\(availability.trafficSharing)"
          )
        case "submit":
          let type = environment["NAVOSS_E2E_TYPE"].flatMap(NavOSSCarPlayReportType.init(rawValue:))
            ?? .construction
          do {
            let submission = try await community.submitReport(type: type, coordinate: here, heading: 90)
            log("submit ok reportId=\(submission.reportId) merged=\(submission.merged)")
          } catch {
            log("submit failed \(describe(error))")
          }
        case "fetch":
          let bounds = NavOSSCommunityBounds(
            east: here.longitude + 0.05, north: here.latitude + 0.05,
            south: here.latitude - 0.05, west: here.longitude - 0.05)
          do {
            let reports = try await community.fetchReports(in: bounds)
            let summary = reports.map { "\($0.id):\($0.type.rawValue):\($0.state.rawValue)" }
            log("fetch ok count=\(reports.count) reports=\(summary.joined(separator: ";"))")
            log("carplay-markers=\(NavOSSCarPlayMapAlertStore.shared.snapshot().filter { !$0.isCamera }.count)")
          } catch {
            log("fetch failed \(describe(error))")
          }
        case "vote":
          guard let reportId = environment["NAVOSS_E2E_VOTE_ID"] else {
            log("vote skipped no id")
            continue
          }
          let value = environment["NAVOSS_E2E_VOTE"].flatMap(NavOSSCommunityVote.init(rawValue:))
            ?? .present
          do {
            let active = try await community.vote(reportId: reportId, vote: value, observedAt: here)
            log("vote ok reportId=\(reportId) vote=\(value.rawValue) active=\(active)")
          } catch {
            log("vote failed \(describe(error))")
          }
        case "withdraw":
          guard let reportId = environment["NAVOSS_E2E_WITHDRAW_ID"] else { continue }
          do {
            try await community.withdraw(reportId: reportId)
            log("withdraw ok reportId=\(reportId)")
          } catch {
            log("withdraw failed \(describe(error))")
          }
        case "reset":
          do {
            try await community.resetIdentity()
            let availability = await community.availability()
            log("reset ok hasIdentity=\(availability.hasIdentity)")
          } catch {
            log("reset failed \(describe(error))")
          }
        case "share-traffic":
          NavOSSCommunityPreferencesStore.shared.setSharesTrafficSpeeds(true)
          log("share-traffic on")
        case "navigate":
          await navigate(environment: environment, origin: here)
        case "watch":
          // Reports traffic-sharing state until the trip ends.
          let seconds = environment["NAVOSS_E2E_WATCH_SECONDS"].flatMap(Double.init) ?? 900
          let deadline = Date().addingTimeInterval(seconds)
          while Date() < deadline {
            try? await Task.sleep(nanoseconds: 30_000_000_000)
            let availability = await community.availability()
            let counts = await community.trafficOutcomeCounts()
            let alerts = community.navigationAlerts()
            let phase = NavOSSNavigationService.shared.currentState().navigation.phase
            log(
              "watch phase=\(phase) traffic=\(availability.trafficSharing) uploads=\(counts.sorted { $0.key < $1.key }) reportAlert=\(alerts.reportAlert?.reportId ?? "-") stillThere=\(alerts.stillTherePrompt?.reportId ?? "-")"
            )
          }
        default:
          log("unknown step \(step)")
        }
      }
      log("done")
    }

    /// Starts real turn-by-turn navigation on a route from the API; the driver script then
    /// moves the simulator along it with `simctl location`.
    private static func navigate(environment: [String: String], origin: NavOSSCarPlayCoordinate) async {
      guard let destination = coordinate(environment, "NAVOSS_E2E_DEST") else {
        log("navigate skipped no destination")
        return
      }
      do {
        let client = try NavOSSNavigationAPIClient()
        let trips = try await client.routes(
          origin: origin,
          destination: NavOSSCarPlayDestination(
            category: nil, id: "e2e-destination", label: "E2E destination",
            latitude: destination.latitude, longitude: destination.longitude, name: "E2E destination"),
          preferences: NavOSSRoutePreferences(),
          alternatives: 0
        )
        guard let trip = trips.first else {
          log("navigate failed no route")
          return
        }
        try NavOSSNavigationService.shared.startNavigation(trip)
        log("navigate ok distanceMeters=\(Int(trip.distanceMeters)) points=\(trip.geometry.count)")
      } catch {
        log("navigate failed \(type(of: error))")
      }
    }
  }
#endif
