import Foundation
import XCTest

@testable import NavOSSNavigationCore

/// Restoring a trip after the app was killed or the phone restarted, through `NavigationEngine`
/// on the recorded Calgary drive: Deerfoot Trail to Glenmore Trail
/// (`apps/mobile/test/fixtures/routes-v2/calgary-deerfoot-glenmore.v2.json`) and its recorded
/// fixes (`Fixtures/calgary-deerfoot-glenmore.trace.json`, the Android replay's trace), one a
/// second. The drive leaves the route at fix 176 for a detour up to 180 m from it, rejoins at fix
/// 213 and arrives at fix 362. The exit 248 maneuver is about 60 m after fix 128.
///
/// A "process" is one run of the app: an engine over the phone's storage. Killing it lets any
/// reroute in flight fail, as the process's death would, so nothing of it reaches the store
/// afterwards. A restore is a new process on the same storage, later on the same clock.
///
/// The rules (situation, outcome, reason):
/// - Restored, first usable fix on the route: continues from the checkpoint.
/// - Restored, off the route: an ordinary off-route trip under the driver's reroute mode, after
///   the same number of fixes as a departure mid-trip; never ended.
/// - Saved before its first match: starts as it was started; the pre-match rules decide.
/// - Expired (12 hours): ended, `restored-trip-expired`.
/// - Further from the route than any drive since the checkpoint: ended, `restored-trip-too-far`.
/// - Off the route beside the destination: ended, `restored-trip-arrived`.
/// - Unreadable, or cannot be started: removed, `restored-trip-unavailable`.
/// - No fix, or only poor fixes: restored and visible, nothing ended or asked for.
///
/// Reasons are compared as strings so the defect tests also build against the code they fixed.
final class NavigationTripRestoreEngineTests: XCTestCase {
  // MARK: The recorded drive

  private static let routeFixture = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .appendingPathComponent("../../../../test/fixtures/routes-v2/calgary-deerfoot-glenmore.v2.json")
  private static let destination = NavOSSCarPlayDestination(
    id: "replay-destination", label: "Replay destination", latitude: 50.9881,
    longitude: -114.094978, name: "Replay destination")
  private static let tripKey = "org.navoss.mobile.active-navigation-trip.v2"
  private static let progressKey = tripKey + ".progress"
  private static let twelveHours: TimeInterval = 12 * 60 * 60

  private static func calgaryTrip() throws -> NavOSSCarPlayTrip {
    let document = try JSONSerialization.jsonObject(with: Data(contentsOf: routeFixture))
      as? [String: Any]
    let response = try JSONSerialization.data(withJSONObject: try XCTUnwrap(document?["response"]))
    return try XCTUnwrap(
      try navOSSTripsFromRoutesV2Response(response, destination: destination).first)
  }

  private static func calgaryFixes() throws -> [NavigationLocationSample] {
    let url = try XCTUnwrap(
      Bundle.module.url(
        forResource: "calgary-deerfoot-glenmore.trace", withExtension: "json",
        subdirectory: "Fixtures"))
    let object = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
    return try XCTUnwrap(object?["fixes"] as? [[String: Any]]).map { fix in
      NavigationLocationSample(
        coordinate: NavigationCoordinate(
          latitude: try XCTUnwrap(fix["latitude"] as? Double),
          longitude: try XCTUnwrap(fix["longitude"] as? Double)),
        courseDegrees: fix["courseDegrees"] as? Double,
        horizontalAccuracyMeters: fix["horizontalAccuracyMeters"] as? Double,
        speedMetersPerSecond: fix["speedMetersPerSecond"] as? Double,
        timestamp: try XCTUnwrap(fix["timestampMs"] as? Double) / 1_000 - 978_307_200)
    }
  }

  private var trip: NavOSSCarPlayTrip!
  private var fixes: [NavigationLocationSample]!

  override func setUpWithError() throws {
    trip = try Self.calgaryTrip()
    fixes = try Self.calgaryFixes()
  }

  /// Fix `index` moved `meters` to the right of its course (a side road, a parking lot).
  private func beside(_ index: Int, meters: Double, accuracy: Double = 5) -> NavigationLocationSample {
    let fix = fixes[index]
    let right = ((fix.courseDegrees ?? 0) + 90) * .pi / 180
    return NavigationLocationSample(
      coordinate: offsetCoordinate(
        fix.coordinate, east: meters * sin(right), north: meters * cos(right)),
      courseDegrees: fix.courseDegrees, horizontalAccuracyMeters: accuracy,
      speedMetersPerSecond: fix.speedMetersPerSecond, timestamp: fix.timestamp)
  }

  /// `sample` captured at `time` instead.
  private static func at(_ time: TimeInterval, _ sample: NavigationLocationSample)
    -> NavigationLocationSample
  {
    NavigationLocationSample(
      coordinate: sample.coordinate, courseDegrees: sample.courseDegrees,
      horizontalAccuracyMeters: sample.horizontalAccuracyMeters,
      speedMetersPerSecond: sample.speedMetersPerSecond, timestamp: time)
  }

  private static func carPlay(_ coordinate: NavigationCoordinate) -> NavOSSCarPlayCoordinate {
    NavOSSCarPlayCoordinate(latitude: coordinate.latitude, longitude: coordinate.longitude)
  }

  private static func length(_ points: [NavigationCoordinate]) -> Double {
    zip(points, points.dropFirst()).reduce(0) { $0 + navigationDistanceMeters(from: $1.0, to: $1.1) }
  }

  /// A replacement route from `origin`, as the server would answer: along the recorded detour
  /// when the vehicle is on it (then Glenmore Trail from fix 213), otherwise to the nearest
  /// point of the route and on along it.
  private static func replacement(
    from origin: NavOSSCarPlayCoordinate, of trip: NavOSSCarPlayTrip,
    fixes: [NavigationLocationSample], id: String
  ) -> NavOSSCarPlayTrip {
    let start = NavigationCoordinate(latitude: origin.latitude, longitude: origin.longitude)
    let route = trip.geometry.map {
      NavigationCoordinate(latitude: $0.latitude, longitude: $0.longitude)
    }
    let detour = fixes[176...212].map(\.coordinate)
    var lead = [start]
    var rejoin = start
    if let index = detour.indices.first(where: {
      navigationDistanceMeters(from: detour[$0], to: start) < 40
    }) {
      lead += detour[(index + 1)...]
      rejoin = fixes[213].coordinate
    }
    let nearest = route.indices.min {
      navigationDistanceMeters(from: route[$0], to: rejoin)
        < navigationDistanceMeters(from: route[$1], to: rejoin)
    }!
    let tail = Array(route[min(nearest + 1, route.count - 2)...])
    let first = lead + [tail[0]]
    let last = tail[tail.count - 1]
    let steps = [
      NavOSSCarPlayRouteStep(
        distanceMeters: length(first), durationSeconds: length(first) / 20,
        geometry: first.map(carPlay), instruction: "Head back to the route",
        maneuverType: "depart", roadName: "Detour"),
      NavOSSCarPlayRouteStep(
        distanceMeters: length(tail), durationSeconds: length(tail) / 20,
        geometry: tail.map(carPlay), instruction: "Continue on the route",
        maneuverType: "turn", roadName: "Glenmore Trail"),
      NavOSSCarPlayRouteStep(
        distanceMeters: 0, durationSeconds: 0, geometry: [carPlay(last), carPlay(last)],
        instruction: "You have arrived", maneuverType: "arrive", roadName: ""),
    ]
    let geometry = first + tail.dropFirst()
    return NavOSSCarPlayTrip(
      destination: trip.destination,
      distanceMeters: length(geometry), durationSeconds: length(geometry) / 20,
      geometry: geometry.map(carPlay), id: id, steps: steps)
  }

  // MARK: The phone and its processes

  /// What outlives a process: the storage and the clock.
  private final class Phone {
    let clock: EngineTestClock
    let storage: EngineTripStoreFixture

    init(time: TimeInterval) {
      clock = EngineTestClock(time)
      storage = EngineTripStoreFixture(clock: clock)
    }

    var defaults: UserDefaults { storage.defaults }
    var tripData: Data? { defaults.data(forKey: NavigationTripRestoreEngineTests.tripKey) }
  }

  /// One run of the app.
  private final class AppProcess {
    let phone: Phone
    let host = RecordingEngineHost()
    let network: ScriptedEngineNetwork
    let engine: NavigationEngine
    let session = NavigationSession()
    let companion: RecordingEngineCompanion
    /// Reroutes the engine started, counted as each fix returns.
    private(set) var requests = 0
    /// Fixes fed so far, and the fix count at each request.
    private(set) var fed = 0
    private(set) var requestedAtFix: [Int] = []
    private var lastRequest: Task<Void, Never>?
    /// Whether a reroute in flight is answered before the next fix.
    var answersReroutes = true

    init(
      _ phone: Phone, mode: NavOSSRerouteMode,
      answer: @escaping (ScriptedEngineNetwork.Request) throws -> [NavOSSCarPlayTrip]
    ) {
      self.phone = phone
      network = ScriptedEngineNetwork(answer: answer)
      companion = RecordingEngineCompanion(host: host)
      engine = NavigationEngine(
        tripStore: NavOSSActiveTripStore(defaults: phone.defaults, clock: { [clock = phone.clock] in clock.now }),
        audioMode: .allGuidance, preferences: NavOSSNavigationPreferences(rerouteMode: mode),
        network: network, session: session, clock: { [clock = phone.clock] in clock.now })
      engine.host = host
      engine.companion = companion
      host.tripPause = { [unowned engine] in engine.lock.withLock { engine.tripPauseLocked } }
    }

    var state: NavOSSNavigationServiceState { engine.currentState() }
    var endReason: String? { state.tripEndReason?.rawValue }

    func start(_ trip: NavOSSCarPlayTrip) throws {
      try engine.startNavigation(trip)
      engine.completePendingSafetyCameraFetch()
    }

    func restore() {
      engine.resumePersistedNavigation()
      engine.completePendingSafetyCameraFetch()
    }

    @discardableResult
    func fix(_ sample: NavigationLocationSample) throws -> NavigationEngineFixOutcome {
      phone.clock.time = try XCTUnwrap(sample.timestamp)
      let outcome = try engine.ingest(sample)
      fed += 1
      if let request = engine.pendingRerouteTask, request != lastRequest {
        requests += 1
        requestedAtFix.append(fed)
        lastRequest = request
      }
      if answersReroutes {
        engine.completePendingReroute(through: network)
      }
      return outcome
    }

    func fix(_ samples: some Sequence<NavigationLocationSample>) throws {
      for sample in samples where state.trip != nil {
        try fix(sample)
      }
    }

    /// The process dies: a request in flight never comes back.
    func kill() {
      network.answer = { _ in throw URLError(.cancelled) }
      engine.completePendingReroute(through: network)
    }
  }

  private func process(_ phone: Phone, mode: NavOSSRerouteMode = .adaptive, network: Bool = true)
    -> AppProcess
  {
    var made = 0
    return AppProcess(phone, mode: mode) { [trip = trip!, fixes = fixes!] request in
      guard network else { throw URLError(.notConnectedToInternet) }
      made += 1
      return [Self.replacement(from: request.origin, of: trip, fixes: fixes, id: "replacement-\(made)")]
    }
  }

  /// A phone whose trip was started a second before the first recorded fix.
  private func phone() -> Phone {
    Phone(time: fixes[0].timestamp! - 1)
  }

  /// Drives the recorded trip through fix `last` in one process and kills it. With `answering`
  /// false its reroute requests never come back (no network, or killed while waiting).
  private func driveThenKill(
    _ phone: Phone, through last: Int, mode: NavOSSRerouteMode = .adaptive,
    answering: Bool = true
  ) throws -> AppProcess {
    let first = process(phone, mode: mode)
    first.answersReroutes = answering
    try first.start(trip)
    try first.fix(fixes[0...last])
    first.kill()
    return first
  }

  /// A new process on `phone` at `time`, restoring what the store holds.
  private func relaunch(
    _ phone: Phone, at time: TimeInterval, mode: NavOSSRerouteMode = .adaptive,
    network: Bool = true
  ) -> AppProcess {
    phone.clock.time = time
    let restored = process(phone, mode: mode, network: network)
    restored.restore()
    return restored
  }

  private func assertRestoredAndAcquiring(
    _ process: AppProcess, _ label: String, file: StaticString = #filePath, line: UInt = #line
  ) {
    XCTAssertNotNil(process.state.trip, "\(label): the trip is gone", file: file, line: line)
    XCTAssertNil(process.endReason, label, file: file, line: line)
    XCTAssertNotNil(process.phone.tripData, "\(label): the store lost the trip", file: file, line: line)
  }

  // MARK: On the route

  /// Killed on a straight, just before a maneuver, near the destination, and with a replacement
  /// route installed; reopened 1 or 20 seconds later on the route. The trip carries on from its
  /// checkpoint with nothing asked for, to the end of the drive.
  func testARestoredTripOnItsRouteContinuesFromItsCheckpoint() throws {
    for (killAfter, label) in [
      (50, "straight"), (127, "before exit 248"), (195, "after a reroute"), (340, "near the end"),
    ] {
      for delay in [1, 20] where killAfter + delay < fixes.count {
        let name = "\(label), \(delay) s"
        let phone = phone()
        let first = try driveThenKill(phone, through: killAfter)
        let routeId = try XCTUnwrap(first.state.trip?.id)
        if killAfter == 195 {
          XCTAssertEqual(first.state.rerouteCount, 1, "\(name): the detour's replacement")
        }
        let restored = relaunch(phone, at: fixes[killAfter + delay].timestamp! - 0.5)
        XCTAssertEqual(restored.state.trip?.id, routeId, name)
        XCTAssertTrue(restored.state.isAcquiringPosition, "\(name): withheld until matched")
        var guidedAt: Int?
        var requestsOnTheRoute = 0
        for index in (killAfter + delay)..<fixes.count where restored.state.trip != nil {
          try restored.fix(fixes[index])
          if guidedAt == nil, !restored.state.isAcquiringPosition {
            guidedAt = index - killAfter - delay + 1
            XCTAssertNotNil(restored.state.guidance, name)
          }
          // Killed before the recorded detour (fix 176), the drive is rerouted there like any.
          if index < 176 || killAfter >= 176 {
            requestsOnTheRoute = restored.requests
          }
        }
        XCTAssertLessThanOrEqual(try XCTUnwrap(guidedAt, "\(name): never guided"), 2, name)
        XCTAssertEqual(requestsOnTheRoute, 0, "\(name): nothing asked for on the route")
        XCTAssertNil(restored.endReason, name)
        XCTAssertEqual(restored.state.navigation.phase, .arrived, "\(name): drove to the end")
      }
    }
  }

  // MARK: Off the route (defect 1)

  /// The recorded reproduction: killed after fix 180, 96 m into the detour, reopened 1, 5 or 20
  /// seconds later 108 to 152 m from the route. It was ended ("Trip ended"). It is rerouted
  /// after the same number of fixes as the uninterrupted drive's departure, under each mode.
  func testARestoredTripOffItsRouteIsReroutedNotEnded() throws {
    // The uninterrupted drive: the first departure fix and the fix that asks for a route.
    let reference = process(phone())
    try reference.start(trip)
    var firstDeparture: Int?
    for index in 0...200 where reference.requests == 0 {
      try reference.fix(fixes[index])
      if firstDeparture == nil, (reference.state.navigation.distanceFromRouteMeters ?? 0) > 40 {
        firstDeparture = reference.fed
      }
    }
    let departureFixes = try XCTUnwrap(reference.requestedAtFix.first)
      - XCTUnwrap(firstDeparture)

    for mode in [NavOSSRerouteMode.adaptive, .askFirst, .keepRoute] {
      for delay in [1, 5, 20] {
        let name = "\(mode), \(delay) s"
        let phone = phone()
        let killed = try driveThenKill(phone, through: 180, mode: mode, answering: false)
        XCTAssertGreaterThanOrEqual(killed.requests, 1, "\(name): left the route before the kill")
        let restored = relaunch(phone, at: fixes[180 + delay].timestamp! - 0.5, mode: mode)
        restored.answersReroutes = false
        // Fixes 1 and 2 count towards leaving, as mid-trip: the trip stays, acquiring.
        for index in (180 + delay)...(182 + delay) where restored.requests == 0 {
          let distance = try XCTUnwrap(
            Self.distanceFromRoute(fixes[index].coordinate, of: trip))
          XCTAssertGreaterThan(distance, 69, name)
          try restored.fix(fixes[index])
          assertRestoredAndAcquiring(restored, "\(name), fix \(index)")
        }
        XCTAssertEqual(restored.requests, 1, "\(name): one reroute")
        XCTAssertEqual(restored.requestedAtFix.first.map { $0 - 1 }, departureFixes, name)
        XCTAssertFalse(restored.state.isAcquiringPosition, "\(name): published, off route")
        XCTAssertTrue(restored.state.navigation.isOffRoute, name)
        XCTAssertEqual(restored.state.routeStatus, .rerouting, name)
        XCTAssertTrue(restored.engine.completePendingReroute(through: restored.network), name)
        let request = try XCTUnwrap(restored.network.requests.first)
        switch mode {
        case .adaptive:
          XCTAssertEqual(restored.state.rerouteCount, 1, "\(name): installed")
          XCTAssertEqual(restored.state.trip?.id, "replacement-1", name)
        case .askFirst:
          XCTAssertNotNil(restored.state.rerouteProposal, "\(name): proposed")
          XCTAssertEqual(restored.state.rerouteCount, 0, "\(name): not installed unasked")
        case .keepRoute:
          XCTAssertEqual(request.waypointIds, ["navoss-route-rejoin"], "\(name): back to the route")
          XCTAssertEqual(restored.state.rerouteCount, 1, name)
        }
        XCTAssertNil(restored.endReason, name)
      }
    }
  }

  /// Killed on the route, reopened on a road beside it (100 m to the right): an ordinary
  /// departure, rerouted after three fixes, never ended.
  func testARestoredTripReopenedBesideItsRouteIsRerouted() throws {
    for (killAfter, delay) in [(50, 1), (50, 20), (127, 1), (127, 20)] {
      let name = "fix \(killAfter), \(delay) s"
      let phone = phone()
      _ = try driveThenKill(phone, through: killAfter)
      let first = killAfter + delay
      let restored = relaunch(phone, at: fixes[first].timestamp! - 0.5)
      for index in first..<(first + 3) {
        try restored.fix(beside(index, meters: 100))
      }
      XCTAssertEqual(restored.requestedAtFix, [3], name)
      XCTAssertEqual(restored.state.rerouteCount, 1, "\(name): installed")
      XCTAssertNil(restored.endReason, name)
    }
  }

  // MARK: Saved before its first match (defect 2)

  /// The driver tapped Start in a parking lot 100 m behind where the route starts, stood there
  /// 30 seconds, and the app was killed. Reopened in the same spot 1 or 20 seconds later the
  /// trip is there, ten more minutes parked ask for nothing, and driving onto the road guides.
  func testATripSavedBeforeItsFirstMatchRestoresAsItWasStarted() throws {
    for mode in [NavOSSRerouteMode.adaptive, .askFirst, .keepRoute] {
      for delay in [1.0, 20] {
        let name = "\(mode), \(delay) s"
        let phone = phone()
        let first = process(phone, mode: mode)
        try first.start(trip)
        try parkThenDrive(first, parkedSeconds: 30, drive: false)
        let asStarted = first.state
        XCTAssertFalse(asStarted.isAcquiringPosition)
        first.kill()

        // Shown as it was before the kill: the chosen route with its first maneuver ahead, not
        // withheld as a trip finding its place.
        let restored = relaunch(phone, at: phone.clock.time + delay, mode: mode)
        XCTAssertEqual(restored.state.trip?.id, trip.id, name)
        XCTAssertFalse(restored.state.isAcquiringPosition, "\(name): as it was started")
        XCTAssertEqual(restored.state.guidance?.stepIndex, asStarted.guidance?.stepIndex, name)
        XCTAssertNotNil(restored.state.guidance, name)
        XCTAssertEqual(
          restored.host.events.filter { if case .publication = $0 { true } else { false } }.count,
          1, "\(name): published like a start")
        try parkThenDrive(restored, parkedSeconds: 600, drive: true)
        XCTAssertEqual(restored.requests, 0, "\(name): never rerouted")
        XCTAssertNil(restored.endReason, name)
        XCTAssertFalse(restored.state.isAcquiringPosition, name)
        XCTAssertNotNil(restored.state.navigation.matchedCoordinate, "\(name): matched")
        XCTAssertNotNil(restored.state.guidance, "\(name): guided")
      }
    }
  }

  /// 100 m behind the start of the route, against its first heading.
  private var parkingLot: NavigationCoordinate {
    let course = 25.0 * .pi / 180
    return offsetCoordinate(
      fixes[0].coordinate, east: 100 * sin(course), north: 100 * cos(course))
  }

  /// Parked: a fix every two seconds, half a metre apart, no speed or course. Then (`drive`)
  /// straight to the road at 5 m/s and 60 seconds along the recorded drive.
  private func parkThenDrive(_ process: AppProcess, parkedSeconds: Int, drive: Bool) throws {
    let parked = parkingLot
    for index in 0..<(parkedSeconds / 2) {
      let jitter = index.isMultiple(of: 2) ? 0.0 : 0.5
      try process.fix(
        NavigationLocationSample(
          coordinate: offsetCoordinate(parked, east: 0, north: jitter),
          horizontalAccuracyMeters: 5, timestamp: process.phone.clock.time + 2))
      assertRestoredAndAcquiring(process, "parked at \(index * 2) s")
    }
    guard drive else { return }
    let road = fixes[0].coordinate
    for step in 1...20 {
      let fraction = Double(step) / 20
      try process.fix(
        NavigationLocationSample(
          coordinate: NavigationCoordinate(
            latitude: parked.latitude + (road.latitude - parked.latitude) * fraction,
            longitude: parked.longitude + (road.longitude - parked.longitude) * fraction),
          courseDegrees: 205, horizontalAccuracyMeters: 5, speedMetersPerSecond: 5,
          timestamp: process.phone.clock.time + 1))
    }
    for fix in fixes[1...60] {
      try process.fix(Self.at(process.phone.clock.time + 1, fix))
    }
  }

  // MARK: Ending a restored trip

  /// Twelve hours count from the later of the route's save and its last checkpoint. Reopened
  /// 12 hours after Start but under 12 hours after the last checkpoint (a long drive still
  /// moving), the trip is restored; 12 hours after the last checkpoint it ends, and the phone
  /// says so.
  func testASavedTripExpiresTwelveHoursAfterItsLastCheckpoint() throws {
    let startedAt = fixes[0].timestamp! - 1
    for expired in [false, true] {
      let phone = phone()
      _ = try driveThenKill(phone, through: 50)
      guard case .progress(let checkpoint) = phone.storage.store.loadProgress(for: trip),
        let capturedAt = checkpoint.timestamp
      else {
        return XCTFail("no checkpoint at the kill")
      }
      XCTAssertGreaterThan(capturedAt, startedAt + 30)
      let restored = relaunch(
        phone, at: expired ? capturedAt + Self.twelveHours : startedAt + Self.twelveHours + 10)
      if expired {
        XCTAssertNil(restored.state.trip)
        XCTAssertEqual(restored.endReason, "restored-trip-expired")
        XCTAssertNil(phone.tripData)
        XCTAssertNil(phone.defaults.data(forKey: Self.progressKey))
        XCTAssertEqual(restored.host.events.map(\.label), ["stateDidChange"])
      } else {
        assertRestoredAndAcquiring(restored, "under twelve hours since the checkpoint")
      }
    }
  }

  /// The clock was set back an hour before the relaunch: no elapsed time is negative evidence.
  /// The trip is not expired; its first fix, 20 km away and "before" the checkpoint, gives no
  /// elapsed time, so the too-far bound cannot be applied and the trip is treated as any
  /// off-route restore: kept and rerouted after three fixes.
  func testARestoredTripAfterTheClockWasSetBackIsKeptAndRerouted() throws {
    let phone = phone()
    _ = try driveThenKill(phone, through: 50)
    let setBack = fixes[0].timestamp! - 3_600
    let restored = relaunch(phone, at: setBack)
    assertRestoredAndAcquiring(restored, "clock set back")
    for second in 1...3 {
      try restored.fix(
        NavigationLocationSample(
          coordinate: offsetCoordinate(fixes[50].coordinate, east: 20_000, north: 0),
          horizontalAccuracyMeters: 5, timestamp: setBack + Double(second)))
    }
    XCTAssertNil(restored.endReason)
    XCTAssertEqual(restored.requests, 1, "rerouted from where it is")
  }

  /// The first accurate fix 20 km from the route, 20 seconds after the kill: no car can have
  /// got there since the checkpoint (45 m/s for at most 35 s). Ended. Ten minutes later it can
  /// (27 km), so the trip is kept and rerouted from there.
  func testARestoredTripFurtherFromItsRouteThanAnyDriveEnds() throws {
    for (delay, ends) in [(20.0, true), (600, false)] {
      let phone = phone()
      _ = try driveThenKill(phone, through: 50)
      let time = fixes[50].timestamp! + delay
      let restored = relaunch(phone, at: time - 0.5)
      let far = NavigationLocationSample(
        coordinate: offsetCoordinate(fixes[50].coordinate, east: 20_000, north: 0),
        horizontalAccuracyMeters: 5, timestamp: time)
      if ends {
        try restored.fix(far)
        XCTAssertEqual(restored.endReason, "restored-trip-too-far")
        XCTAssertNil(restored.state.trip)
        XCTAssertNil(phone.tripData)
        XCTAssertEqual(restored.requests, 0)
      } else {
        for second in 0..<3 {
          try restored.fix(Self.at(time + Double(second), far))
        }
        XCTAssertEqual(restored.requests, 1, "rerouted from where it is")
        XCTAssertNil(restored.endReason)
      }
    }
  }

  /// Killed near the end (the last checkpoint within 500 m of it) and reopened off the route
  /// 100 m beside its last stretch, within 250 m of the destination (the car park): the trip had
  /// got there. Ended, not routed back. 400 m beside it, it had not: rerouted.
  func testARestoredTripOffItsRouteBesideItsDestinationEndsAsArrived() throws {
    for (killAfter, delay, meters, arrived) in [
      (357, 1, 100.0, true), (352, 6, 100, true), (352, 6, 400, false),
    ] {
      let name = "fix \(killAfter) + \(delay) s, \(meters) m"
      let phone = phone()
      _ = try driveThenKill(phone, through: killAfter)
      let first = killAfter + delay
      let restored = relaunch(phone, at: fixes[first].timestamp! - 0.5)
      if arrived {
        try restored.fix(beside(first, meters: meters))
        XCTAssertNil(restored.state.trip, name)
        XCTAssertEqual(restored.endReason, "restored-trip-arrived", name)
        XCTAssertNil(phone.tripData, name)
      } else {
        for second in 0..<3 {
          var fix = beside(first, meters: meters)
          fix = Self.at(fix.timestamp! + Double(second), fix)
          try restored.fix(fix)
        }
        XCTAssertEqual(restored.requests, 1, name)
        XCTAssertNil(restored.endReason, name)
      }
    }
  }

  /// A saved trip that decodes but cannot be started again (here, a route of one point): it
  /// was removed without a word. Now the phone is told.
  func testARestoredTripThatCannotStartIsClearedWithAReason() throws {
    let phone = phone()
    var stored = try XCTUnwrap(
      JSONSerialization.jsonObject(with: try JSONEncoder().encode(Self.StoredTrip(
        expiresAt: Date(timeIntervalSinceReferenceDate: phone.clock.time + 3_600), trip: trip)))
        as? [String: Any])
    var record = try XCTUnwrap(stored["trip"] as? [String: Any])
    record["geometry"] = [try XCTUnwrap((record["geometry"] as? [Any])?.first)]
    stored["trip"] = record
    phone.defaults.set(try JSONSerialization.data(withJSONObject: stored), forKey: Self.tripKey)
    let restored = relaunch(phone, at: phone.clock.time)
    XCTAssertNil(restored.state.trip)
    XCTAssertEqual(restored.endReason, "restored-trip-unavailable")
    XCTAssertNil(phone.tripData)
    XCTAssertTrue(restored.host.events.contains(.stateDidChange))
  }

  /// A saved trip that cannot be decoded (damaged, or a shape this build does not read).
  func testASavedTripThatCannotBeReadIsClearedWithAReason() throws {
    let phone = phone()
    phone.defaults.set(Data("not a trip".utf8), forKey: Self.tripKey)
    phone.defaults.set(Data("{}".utf8), forKey: Self.progressKey)
    let restored = relaunch(phone, at: phone.clock.time)
    XCTAssertNil(restored.state.trip)
    XCTAssertEqual(restored.endReason, "restored-trip-unavailable")
    XCTAssertNil(phone.tripData)
    XCTAssertNil(phone.defaults.data(forKey: Self.progressKey))
    XCTAssertTrue(restored.host.events.contains(.stateDidChange))
    // A new trip starts without the reason.
    try restored.start(trip)
    XCTAssertNil(restored.endReason)
  }

  /// `NavOSSActiveTripStore`'s record, to write one the store will read.
  private struct StoredTrip: Codable {
    let expiresAt: Date
    let trip: NavOSSCarPlayTrip
  }

  // MARK: Pending, poor or no fixes

  /// Reopened beside the route, with fixes of 80 m accuracy at first: the trip stays restored
  /// and acquiring, nothing is ended or asked for. The first accurate fix asks for a route.
  func testARestoredTripWaitsForAnAccurateFixBeforeAnything() throws {
    let phone = phone()
    _ = try driveThenKill(phone, through: 50)
    let restored = relaunch(phone, at: fixes[55].timestamp! - 0.5)
    XCTAssertTrue(restored.state.isAcquiringPosition, "visible before any fix")
    for index in 55..<61 {
      try restored.fix(beside(index, meters: 150, accuracy: 80))
      assertRestoredAndAcquiring(restored, "poor fix \(index)")
      XCTAssertTrue(restored.state.isAcquiringPosition)
    }
    XCTAssertEqual(restored.requests, 0, "no request without an accurate fix")
    // Nor from a change of reroute mode meanwhile.
    restored.engine.setNavigationPreferences(NavOSSNavigationPreferences(rerouteMode: .keepRoute))
    XCTAssertNil(restored.engine.pendingRerouteTask, "no request from a preference change")
    try restored.fix(beside(61, meters: 150))
    XCTAssertEqual(restored.requestedAtFix, [7], "the first accurate fix asks")
    XCTAssertNil(restored.endReason)
  }

  /// Location permission lost (or no fix at all) after the relaunch: ten minutes of the clock
  /// and the trip is still there, acquiring, with nothing asked for.
  func testARestoredTripWithoutFixesStaysRestored() throws {
    let phone = phone()
    _ = try driveThenKill(phone, through: 50)
    let restored = relaunch(phone, at: fixes[51].timestamp!)
    for _ in 0..<600 {
      phone.clock.advance(1)
      restored.engine.clockTick()
    }
    assertRestoredAndAcquiring(restored, "after ten minutes")
    XCTAssertTrue(restored.state.isAcquiringPosition)
    XCTAssertNil(restored.engine.pendingRerouteTask)
  }

  /// No network: the reroute fails, the trip stays (off route, reroute failed) and asks again
  /// after the existing backoff, and installs once the network is back.
  func testARestoredTripOffItsRouteWithoutNetworkStaysAndRetries() throws {
    let phone = phone()
    _ = try driveThenKill(phone, through: 180, answering: false)
    let restored = relaunch(phone, at: fixes[181].timestamp! - 0.5, network: false)
    try restored.fix(fixes[181...183])
    XCTAssertEqual(restored.requests, 1)
    XCTAssertEqual(restored.state.routeStatus, .rerouteFailed)
    XCTAssertNotNil(restored.state.trip)
    try restored.fix(fixes[184...192])
    XCTAssertEqual(restored.requests, 1, "not before ten seconds")
    restored.network.answer = { [trip = trip!, fixes = fixes!] request in
      [Self.replacement(from: request.origin, of: trip, fixes: fixes, id: "back-online")]
    }
    try restored.fix(fixes[193...194])
    XCTAssertEqual(restored.requests, 2, "asked again after the backoff")
    XCTAssertEqual(restored.state.trip?.id, "back-online")
    XCTAssertNil(restored.endReason)
  }

  // MARK: Ask-first and a second restore

  /// Killed with an ask-first proposal on screen. Reopened, the proposal is asked again (it was
  /// not saved), nothing is installed unasked, and accepting installs it.
  func testAPendingProposalIsAskedAgainAfterARestore() throws {
    let phone = phone()
    let killed = try driveThenKill(phone, through: 182, mode: .askFirst)
    XCTAssertNotNil(killed.state.rerouteProposal, "pending at the kill")
    let restored = relaunch(phone, at: fixes[183].timestamp! - 0.5, mode: .askFirst)
    XCTAssertNil(restored.state.rerouteProposal)
    try restored.fix(fixes[183...185])
    let proposal = try XCTUnwrap(restored.state.rerouteProposal, "asked again")
    XCTAssertEqual(restored.state.rerouteCount, 0)
    XCTAssertTrue(restored.engine.acceptRerouteProposal(id: proposal.id))
    XCTAssertEqual(restored.state.rerouteCount, 1)
    try restored.fix(fixes[186...230])
    XCTAssertFalse(restored.state.navigation.isOffRoute, "on the replacement")
    XCTAssertNil(restored.endReason)
  }

  /// Restore called twice (two launch paths, or two processes' worth): the trip starts once and
  /// one reroute is asked for; a restore during the trip changes nothing.
  func testRestoringTwiceStartsTheTripOnceAndAsksOnce() throws {
    let phone = phone()
    _ = try driveThenKill(phone, through: 180, answering: false)
    let restored = relaunch(phone, at: fixes[181].timestamp! - 0.5)
    restored.answersReroutes = false
    try restored.fix(fixes[181...183])
    XCTAssertEqual(restored.requests, 1)
    restored.restore()
    try restored.fix(fixes[184...186])
    XCTAssertEqual(
      restored.host.events.filter { $0 == .companion("didStart(restored)") }.count, 1)
    XCTAssertEqual(restored.requests, 1, "no second request")
    XCTAssertTrue(restored.engine.completePendingReroute(through: restored.network))
    XCTAssertEqual(restored.network.requests.count, 1)
    restored.restore()
    XCTAssertEqual(restored.state.trip?.id, "replacement-1")
    XCTAssertEqual(restored.state.rerouteCount, 1)
  }

  // MARK: What an off-route restore presents

  /// Killed 60 m before exit 248 and reopened on a road 100 m beside the route. Until the trip
  /// is matched again it presents what a departure presents (the trip, off route, rerouting, a
  /// failed reroute, a proposal, End) and never the checkpoint's maneuver, distance, lanes,
  /// road or estimate: not in a published update (CarPlay), not in any read (the phone).
  func testARestoredTripOffItsRouteShowsNoGuidanceFromItsCheckpoint() throws {
    for (mode, network, answers, label) in [
      (NavOSSRerouteMode.adaptive, false, true, "adaptive, no network"),
      (.adaptive, true, true, "adaptive"),
      (.askFirst, true, true, "ask-first, proposal pending"),
      (.keepRoute, true, false, "keep-route, request pending"),
    ] {
      let phone = phone()
      let killed = try driveThenKill(phone, through: 127)
      XCTAssertNotNil(killed.state.guidance, "\(label): guided before the kill")
      let restored = relaunch(
        phone, at: fixes[128].timestamp! - 0.5, mode: mode, network: network)
      restored.answersReroutes = answers
      func assertNoCheckpointGuidance(_ what: String) {
        let state = restored.state
        XCTAssertNil(state.guidance, "\(label), \(what)")
        XCTAssertNil(state.roadContext.currentRoadName, "\(label), \(what)")
        XCTAssertNil(state.roadContext.speedLimitKph, "\(label), \(what)")
        XCTAssertNil(
          restored.engine.lock.withLock { restored.engine.currentUpdateLocked().guidance },
          "\(label), \(what)")
        XCTAssertTrue(
          restored.host.publishedGuidance.allSatisfy { $0 == nil }, "\(label), \(what): published")
      }
      for index in 128..<136 where restored.state.rerouteCount == 0 {
        try restored.fix(beside(index, meters: 100))
        // Until a replacement is installed (a new route, guided from its start).
        if restored.state.rerouteCount == 0 {
          assertNoCheckpointGuidance("fix \(index)")
        }
      }
      XCTAssertEqual(restored.requests, 1, label)
      XCTAssertNil(restored.endReason, label)
      switch label {
      case "adaptive, no network":
        XCTAssertEqual(restored.state.routeStatus, .rerouteFailed)
        XCTAssertTrue(restored.state.navigation.isOffRoute)
      case "adaptive":
        // The replacement is a new route: guided from it.
        XCTAssertEqual(restored.state.rerouteCount, 1)
        XCTAssertNotNil(restored.state.guidance)
      case "ask-first, proposal pending":
        XCTAssertNotNil(restored.state.rerouteProposal)
        XCTAssertEqual(restored.state.routeStatus, .tracking)
      default:
        XCTAssertEqual(restored.state.routeStatus, .rerouting)
        // Back on the route the matched position brings guidance back.
        try restored.fix(fixes[150...160])
        XCTAssertFalse(restored.state.navigation.isOffRoute, label)
        XCTAssertNotNil(restored.state.guidance, "\(label): guided again")
      }
    }
  }

  /// Review finding: restored progress lets a poor fix match within its accuracy, so a matched
  /// coordinate is no proof the trip is back on its route. Restored beside a parallel road 60 m
  /// away: an 80 m fix (matched, withheld), then accurate fixes on that road. Nothing from the
  /// checkpoint is presented at any point, in every mode, and the trip departs as any other.
  func testAPoorFixMatchedAfterARestoreBringsNoCheckpointGuidanceBack() throws {
    for (mode, network, answers, label) in [
      (NavOSSRerouteMode.adaptive, false, true, "adaptive, no network"),
      (.askFirst, true, true, "ask-first, proposal pending"),
      (.keepRoute, true, false, "keep-route, request pending"),
    ] {
      let phone = phone()
      _ = try driveThenKill(phone, through: 127)
      let restored = relaunch(
        phone, at: fixes[128].timestamp! - 0.5, mode: mode, network: network)
      restored.answersReroutes = answers
      try restored.fix(beside(128, meters: 60, accuracy: 80))
      for index in 129..<136 {
        try restored.fix(beside(index, meters: 60))
      }
      XCTAssertNil(restored.endReason, label)
      XCTAssertTrue(restored.state.navigation.isOffRoute, label)
      XCTAssertEqual(restored.requests, 1, label)
      XCTAssertNil(restored.state.guidance, label)
      XCTAssertNil(
        restored.engine.lock.withLock { restored.engine.currentUpdateLocked().guidance }, label)
      XCTAssertTrue(
        restored.host.publishedGuidance.allSatisfy { $0 == nil }, "\(label): published")
    }
  }

  /// Review finding: only the matcher's own verdict on a fix releases checkpoint guidance. After
  /// an 80 m fix matched near the checkpoint, an accurate fix 100 m behind it travelling the
  /// wrong way is rejected (a departure sample, not yet off route); its snapshot still carries
  /// the earlier match with the new position and accuracy. Nothing from the checkpoint is shown
  /// or spoken for it. Accurate fixes the matcher accepts then bring guidance back.
  func testOnlyAnAccurateFixTheMatcherAcceptsReleasesCheckpointGuidance() throws {
    let phone = phone()
    _ = try driveThenKill(phone, through: 127)
    let restored = relaunch(phone, at: fixes[128].timestamp! - 0.5)
    func assertWithheld(_ what: String) {
      XCTAssertNil(restored.state.guidance, what)
      XCTAssertNil(restored.state.roadContext.currentRoadName, what)
      XCTAssertTrue(restored.host.publishedGuidance.allSatisfy { $0 == nil }, what)
      XCTAssertFalse(
        restored.host.spoken.contains { $0.kind == .maneuver }, "\(what): \(restored.host.spoken)")
      XCTAssertNotNil(restored.state.tripPause, what)
    }
    try restored.fix(beside(128, meters: 0, accuracy: 80))
    assertWithheld("poor match")
    let behind = fixes[124]
    let backward = NavigationLocationSample(
      coordinate: behind.coordinate,
      courseDegrees: ((behind.courseDegrees ?? 0) + 180).truncatingRemainder(dividingBy: 360),
      horizontalAccuracyMeters: 5, speedMetersPerSecond: behind.speedMetersPerSecond,
      timestamp: fixes[128].timestamp! + 0.5)
    try restored.fix(backward)
    // The case under review: rejected, not off route, an earlier match kept, this fix's accuracy.
    let snapshot = restored.engine.lock.withLock { restored.session.currentUpdate().snapshot }
    XCTAssertFalse(restored.session.acceptedLatestFix)
    XCTAssertFalse(snapshot.isOffRoute)
    XCTAssertNotNil(snapshot.matchedCoordinate)
    XCTAssertEqual(snapshot.horizontalAccuracyMeters, 5)
    assertWithheld("rejected accurate fix")
    // Accepted accurate fixes: guided again from the matched position.
    for index in 140...150 where restored.state.guidance == nil {
      try restored.fix(fixes[index])
      if restored.state.guidance == nil {
        assertWithheld("fix \(index)")
      } else {
        XCTAssertTrue(restored.session.acceptedLatestFix, "released by fix \(index)")
      }
    }
    XCTAssertNotNil(restored.state.guidance, "guided again")
    XCTAssertNil(restored.state.tripPause)
    XCTAssertNotNil(restored.host.publishedGuidance.last ?? nil)
    XCTAssertEqual(restored.requests, 0)
  }

  /// A poor fix matched near the checkpoint, then an accurate fix the matcher accepts: guidance
  /// comes back with that fix, not with the poor one.
  func testAPoorMatchThenAnAcceptedAccurateFixReleasesCheckpointGuidance() throws {
    let phone = phone()
    _ = try driveThenKill(phone, through: 127)
    let restored = relaunch(phone, at: fixes[128].timestamp! - 0.5)
    try restored.fix(beside(128, meters: 0, accuracy: 80))
    XCTAssertNil(restored.state.guidance)
    XCTAssertEqual(restored.state.tripPause, .locating)
    try restored.fix(fixes[129])
    XCTAssertTrue(restored.session.acceptedLatestFix)
    XCTAssertNotNil(restored.state.guidance)
    XCTAssertNil(restored.state.tripPause)
    XCTAssertNotNil(restored.host.publishedGuidance.last ?? nil)
  }

  /// Review finding: the reason a trip has no maneuver changes with the reroute status, not
  /// only with fixes. "Finding a new route" was stored; GPS stops; the request fails: the state
  /// and what the host is told at that change say "off route" (proceed to the route).
  func testWhyATripHasNoManeuverFollowsTheRerouteStatusWithoutFixes() throws {
    let phone = phone()
    _ = try driveThenKill(phone, through: 127)
    let restored = relaunch(phone, at: fixes[128].timestamp! - 0.5, network: false)
    restored.answersReroutes = false
    for index in 128..<136 where restored.requests == 0 {
      try restored.fix(beside(index, meters: 100))
    }
    XCTAssertEqual(restored.requests, 1)
    XCTAssertEqual(restored.state.routeStatus, .rerouting)
    XCTAssertEqual(restored.state.tripPause, .rerouting)
    XCTAssertEqual(restored.host.tripPausesAtStateChange.last, .some(.rerouting))
    // No further fix: the request fails.
    restored.engine.completePendingReroute(through: restored.network)
    XCTAssertEqual(restored.state.routeStatus, .rerouteFailed)
    XCTAssertEqual(restored.state.tripPause, .proceedToRoute)
    XCTAssertEqual(restored.host.tripPausesAtStateChange.last, .some(.proceedToRoute))
    // CarPlay's store, as the iOS service feeds it on that change.
    let store = NavOSSCarPlayTripStore(notificationCenter: NotificationCenter())
    let trip = try XCTUnwrap(restored.state.trip)
    store.publishNavigationState(
      trip: trip, guidance: nil, tripPause: .rerouting, generation: 1, sequence: 1)
    store.publishTripPause(restored.state.tripPause, forTripId: trip.id)
    XCTAssertEqual(store.snapshot().tripPause, .proceedToRoute)
    store.publishTripPause(.rerouting, forTripId: "another trip")
    XCTAssertEqual(store.snapshot().tripPause, .proceedToRoute)
  }

  /// "A trip is active" and "there is a maneuver to show" are two facts: CarPlay runs its
  /// session, follows the vehicle and presents proposals for a restored trip without guidance,
  /// with the reason in place of the maneuver. Finding its place: locating. Off its route:
  /// rerouting while a route is fetched, otherwise proceed to the route (a proposal waiting, a
  /// failed request). Guidance back (a replacement, or matched again): no pause. A mid-trip
  /// departure keeps its guidance, as on `main`.
  func testCarPlayIsToldWhyARestoredTripHasNoManeuver() throws {
    for (mode, network, answers, label) in [
      (NavOSSRerouteMode.adaptive, false, true, "adaptive, no network"),
      (.adaptive, true, true, "adaptive"),
      (.askFirst, true, true, "ask-first, proposal pending"),
      (.keepRoute, true, false, "keep-route, request pending"),
    ] {
      let phone = phone()
      _ = try driveThenKill(phone, through: 127)
      let restored = relaunch(
        phone, at: fixes[128].timestamp! - 0.5, mode: mode, network: network)
      restored.answersReroutes = answers
      try restored.fix(beside(128, meters: 100))
      // The restore and its first fix: finding its place.
      XCTAssertEqual(restored.host.publishedTripPauses, [.locating, .locating], label)
      for index in 129..<136 {
        try restored.fix(beside(index, meters: 100))
      }
      let pauses = restored.host.publishedTripPauses
      let last = try XCTUnwrap(pauses.last, label)
      switch label {
      case "adaptive, no network", "ask-first, proposal pending":
        XCTAssertEqual(last, .proceedToRoute, label)
        XCTAssertFalse(pauses.contains(nil), "\(label): \(pauses)")
      case "adaptive":
        XCTAssertNil(last, "\(label): guided on the replacement")
        XCTAssertNotNil(restored.host.publishedGuidance.last ?? nil, label)
      default:
        XCTAssertEqual(last, .rerouting, label)
        XCTAssertFalse(pauses.contains(nil), "\(label): \(pauses)")
        try restored.fix(fixes[150...160])
        XCTAssertEqual(restored.host.publishedTripPauses.last, .some(nil), "\(label): matched")
      }
    }
    // A mid-trip departure: guidance throughout, nothing in its place.
    let phone = phone()
    let driving = process(phone, mode: .askFirst)
    try driving.start(trip)
    try driving.fix(fixes[0...127])
    for index in 128..<136 {
      try driving.fix(beside(index, meters: 100))
    }
    XCTAssertTrue(driving.state.navigation.isOffRoute)
    XCTAssertTrue(driving.host.publishedTripPauses.allSatisfy { $0 == nil })
    XCTAssertTrue(driving.host.publishedGuidance.allSatisfy { $0 != nil })
  }

  // MARK: Poor fixes before the first match

  /// Parked 100 m from where the route starts, fixes of 80 m accuracy reporting 5 m/s against the
  /// route's direction: too poor to say anything, they neither count as leaving the route nor
  /// ask for one. On a fresh start and on a trip restored before its first match.
  func testPoorFixesBeforeTheFirstMatchNeverAskForARoute() throws {
    for restoring in [false, true] {
      let phone = phone()
      var process = self.process(phone)
      try process.start(trip)
      if restoring {
        try parkThenDrive(process, parkedSeconds: 10, drive: false)
        process.kill()
        process = relaunch(phone, at: phone.clock.time + 5)
      }
      for _ in 0..<8 {
        try process.fix(
          NavigationLocationSample(
            coordinate: parkingLot, courseDegrees: 25, horizontalAccuracyMeters: 80,
            speedMetersPerSecond: 5, timestamp: phone.clock.time + 1))
      }
      XCTAssertEqual(process.requests, 0, restoring ? "restored" : "fresh start")
      XCTAssertFalse(process.state.navigation.isOffRoute)
      XCTAssertNil(process.endReason)
    }
  }

  // MARK: A trip saved without progress

  /// Build 75 (d0594cd) saved trips under the current key and wrote no progress record, and it
  /// can still be installed; a damaged record reads the same way. Such a trip is withheld until
  /// it confirms its pass, but not for ever: after two minutes of accurate fixes without that it
  /// is released as if Start had just been tapped where it is.
  func testATripWithoutProgressIsReleasedAfterTwoMinutesOfAccurateFixes() throws {
    let phone = phone()
    phone.defaults.set(
      try Self.compatFixture("build85-trip.json"), forKey: Self.tripKey)
    let restored = relaunch(phone, at: phone.clock.time + 30)
    XCTAssertTrue(restored.state.isAcquiringPosition)
    var releasedAt: TimeInterval?
    let firstFix = phone.clock.time + 2
    for _ in 0..<70 {
      try restored.fix(
        NavigationLocationSample(
          coordinate: parkingLot, horizontalAccuracyMeters: 5,
          timestamp: phone.clock.time + 2))
      if releasedAt == nil, !restored.state.isAcquiringPosition {
        releasedAt = phone.clock.time - firstFix
      }
    }
    XCTAssertEqual(try XCTUnwrap(releasedAt, "never released"), 120, accuracy: 2)
    XCTAssertNotNil(restored.state.guidance, "as at Start: the route's first maneuver ahead")
    XCTAssertEqual(restored.requests, 0, "parked: not rerouted")
    XCTAssertNil(restored.endReason)
  }

  // MARK: Restore racing Start

  /// Start lands after the restore read the store and before it starts the saved trip: Start
  /// wins, and the restore neither replaces nor clears the new trip.
  func testAStartThatLandsDuringARestoreWins() throws {
    let phone = phone()
    _ = try driveThenKill(phone, through: 50)
    phone.clock.time = fixes[51].timestamp!
    let restored = process(phone)
    let newTrip = Self.replacement(
      from: Self.carPlay(fixes[51].coordinate), of: trip, fixes: fixes, id: "started-meanwhile")
    restored.engine.restoreWillStart = { try? restored.engine.startNavigation(newTrip) }
    restored.restore()
    XCTAssertEqual(restored.state.trip?.id, "started-meanwhile")
    XCTAssertFalse(restored.state.isAcquiringPosition)
    XCTAssertFalse(restored.host.events.contains(.companion("didStart(restored)")))
    XCTAssertEqual(phone.storage.store.load()?.id, "started-meanwhile")
    XCTAssertNil(restored.endReason)
  }

  // MARK: Records saved by builds 84 and 85

  /// The records build 85 wrote (`Fixtures/restore-compat/build85-*.json`, produced by its own
  /// `NavOSSActiveTripStore` at 3b57b04; build 84's store is the same code): the Calgary trip,
  /// saved a second before fix 0, and its checkpoint at fix 50. After the update the trip
  /// carries on from the checkpoint; saved before its first match (no record), it is kept
  /// while parked and guided once it reaches the road.
  func testRecordsSavedByBuild85RestoreAfterTheUpdate() throws {
    let tripData = try Self.compatFixture("build85-trip.json")
    let progressData = try Self.compatFixture("build85-progress.json")

    let resumed = phone()
    resumed.defaults.set(tripData, forKey: Self.tripKey)
    resumed.defaults.set(progressData, forKey: Self.progressKey)
    let restored = relaunch(resumed, at: fixes[53].timestamp! - 0.5)
    XCTAssertEqual(restored.state.trip, trip)
    try restored.fix(fixes[53...100])
    XCTAssertFalse(restored.state.isAcquiringPosition)
    XCTAssertEqual(restored.requests, 0)
    XCTAssertNil(restored.endReason)

    let parked = phone()
    parked.defaults.set(tripData, forKey: Self.tripKey)
    let beforeMatch = relaunch(parked, at: parked.clock.time + 30)
    XCTAssertEqual(beforeMatch.state.trip, trip)
    try parkThenDrive(beforeMatch, parkedSeconds: 600, drive: true)
    XCTAssertEqual(beforeMatch.requests, 0)
    XCTAssertNil(beforeMatch.endReason)
    XCTAssertFalse(beforeMatch.state.isAcquiringPosition)
    XCTAssertNotNil(beforeMatch.state.guidance)
  }

  static func compatFixture(_ name: String) throws -> Data {
    try Data(
      contentsOf: XCTUnwrap(
        Bundle.module.url(
          forResource: name, withExtension: nil, subdirectory: "Fixtures/restore-compat")))
  }

  /// Distance from `coordinate` to all of `trip`'s route, in a local flat frame.
  private static func distanceFromRoute(
    _ coordinate: NavigationCoordinate, of trip: NavOSSCarPlayTrip
  ) -> Double? {
    let scale = Double.pi * 6_371_000 / 180
    func local(_ point: NavOSSCarPlayCoordinate) -> (Double, Double) {
      (
        (point.longitude - coordinate.longitude) * scale * cos(coordinate.latitude * .pi / 180),
        (point.latitude - coordinate.latitude) * scale
      )
    }
    let points = trip.geometry.map(local)
    return zip(points, points.dropFirst()).map { start, end in
      let (dx, dy) = (end.0 - start.0, end.1 - start.1)
      let squared = dx * dx + dy * dy
      let t = squared == 0 ? 0 : max(0, min(1, -(start.0 * dx + start.1 * dy) / squared))
      return hypot(start.0 + t * dx, start.1 + t * dy)
    }.min()
  }
}
