import Foundation
import XCTest

@testable import NavOSSNavigationCore

/// `NavigationEngine` against a recording host, a scripted network and a real trip store: the
/// order of what it asks the platform to do, what a restored trip may show before it is
/// matched, checkpoints against clear and restart, and reroute results that arrive too late.
final class NavigationEngineTests: XCTestCase {
  private typealias Trace = NavigationTrace

  /// North 800 m, east 900 m, north 900 m: three legs and an arrival.
  private static let corners: [(Double, Double)] = [(0, 0), (0, 800), (900, 800), (900, 1_700)]
  private static let startTime: TimeInterval = 800_000_000

  private static func carPlay(_ coordinates: [NavigationCoordinate]) -> [NavOSSCarPlayCoordinate] {
    coordinates.map { NavOSSCarPlayCoordinate(latitude: $0.latitude, longitude: $0.longitude) }
  }

  private static func trip(id: String, corners: [(Double, Double)] = corners) -> NavOSSCarPlayTrip {
    var steps: [NavOSSCarPlayRouteStep] = []
    for (index, (start, end)) in zip(corners, corners.dropFirst()).enumerated() {
      let length = hypot(end.0 - start.0, end.1 - start.1)
      steps.append(
        NavOSSCarPlayRouteStep(
          distanceMeters: length, durationSeconds: length / 12,
          geometry: carPlay(Trace.route([start, end])),
          instruction: index == 0 ? "Head north" : "Turn \(index == 1 ? "right" : "left")",
          maneuverType: index == 0 ? "depart" : "turn", roadName: "Engine Road \(index)"))
    }
    let last = corners[corners.count - 1]
    steps.append(
      NavOSSCarPlayRouteStep(
        distanceMeters: 0, durationSeconds: 0, geometry: carPlay(Trace.route([last, last])),
        instruction: "You have arrived", maneuverType: "arrive", roadName: ""))
    let destination = Trace.coordinate(last.0, last.1)
    return NavOSSCarPlayTrip(
      destination: NavOSSCarPlayDestination(
        id: "engine-destination", label: "Engine test", latitude: destination.latitude,
        longitude: destination.longitude, name: "Engine test"),
      distanceMeters: steps.reduce(0) { $0 + $1.distanceMeters },
      durationSeconds: steps.reduce(0) { $0 + $1.durationSeconds },
      geometry: carPlay(Trace.route(corners)), id: id, steps: steps)
  }

  /// An engine with everything around it under the test's control.
  private final class Rig {
    let clock = EngineTestClock(NavigationEngineTests.startTime)
    let host = RecordingEngineHost()
    let network: ScriptedEngineNetwork
    let storeFixture: EngineTripStoreFixture
    let companion: RecordingEngineCompanion
    let engine: NavigationEngine

    var store: NavOSSActiveTripStore { storeFixture.store }
    var state: NavOSSNavigationServiceState { engine.currentState() }
    var labels: [String] { host.events.map(\.label) }
    /// Every effect but speech, which depends on where a prompt falls.
    var effects: [String] { labels.filter { !$0.hasPrefix("speak") } }
    /// Reroute requests the engine has started. Counted here, as each fix returns, because the
    /// network sees a request only once its task runs.
    private(set) var requests = 0
    private var lastRequest: Task<Void, Never>?

    init(
      audioMode: NavOSSCarPlayAudioMode = .allGuidance,
      rerouteMode: NavOSSRerouteMode = .adaptive,
      answer: @escaping (ScriptedEngineNetwork.Request) throws -> [NavOSSCarPlayTrip] = { _ in
        throw NavOSSNavigationAPIError.invalidResponse
      }
    ) {
      network = ScriptedEngineNetwork(answer: answer)
      storeFixture = EngineTripStoreFixture(clock: clock)
      companion = RecordingEngineCompanion(host: host)
      engine = NavigationEngine(
        tripStore: storeFixture.store, audioMode: audioMode,
        preferences: NavOSSNavigationPreferences(rerouteMode: rerouteMode), network: network,
        clock: { [clock] in clock.now })
      engine.host = host
      engine.companion = companion
    }

    func start(_ trip: NavOSSCarPlayTrip) throws {
      try engine.startNavigation(trip)
      engine.completePendingSafetyCameraFetch()
    }

    /// One fix, a second after the last.
    @discardableResult
    func fix(_ x: Double, _ y: Double, course: Double?, speed: Double = 12) throws
      -> NavigationEngineFixOutcome
    {
      clock.advance(1)
      let outcome = try engine.ingest(
        NavigationLocationSample(
          coordinate: Trace.coordinate(x, y), courseDegrees: course, horizontalAccuracyMeters: 5,
          speedMetersPerSecond: speed, timestamp: clock.time))
      if let request = engine.pendingRerouteTask, request != lastRequest {
        requests += 1
        lastRequest = request
      }
      return outcome
    }

    /// A fix a second along `path` at `speed`, skipping its first position.
    func drive(_ path: [(Double, Double)], speed: Double = 12) throws {
      for position in Trace.positions(along: path, every: speed).dropFirst() {
        try fix(position.x, position.y, course: position.courseDegrees, speed: speed)
      }
    }

    /// Matches on the first leg up to 300 m, then leaves it at a right angle (east for a
    /// positive `direction`, west for a negative one) until the engine asks for a replacement.
    func driveOffTheFirstLeg(direction: Double = 1) throws {
      try drive([(0, 0), (0, 300)])
      try leaveTheFirstLeg(at: 300, direction: direction)
    }

    func leaveTheFirstLeg(at y: Double, direction: Double) throws {
      let before = requests
      var x = 0.0
      while requests == before, abs(x) < 600 {
        x += 12 * direction
        try fix(x, y, course: direction > 0 ? 90 : 270)
      }
    }
  }

  private static func replacement(id: String, from origin: NavOSSCarPlayCoordinate)
    -> NavOSSCarPlayTrip
  {
    let start = Trace.local(
      NavigationCoordinate(latitude: origin.latitude, longitude: origin.longitude))
    return trip(id: id, corners: [(start.x, start.y), (start.x, 800), (900, 800), (900, 1_700)])
  }

  // MARK: Order of host effects

  func testStartingATripAsksTheHostInTheServicesOrder() throws {
    let rig = Rig()
    let trip = Self.trip(id: "start-order")
    try rig.start(trip)
    XCTAssertEqual(
      rig.effects,
      [
        "companion.didStart", "cancelSpeech#1", "publication#1", "stateDidChange",
        "needsLocationUpdates", "startClock#1",
      ])
    XCTAssertEqual(rig.store.load()?.id, trip.id)
    XCTAssertEqual(rig.network.cameraFetchCount, 1)
    XCTAssertEqual(rig.state.trip?.id, trip.id)
    XCTAssertFalse(rig.state.isAcquiringPosition)
  }

  func testClearingATripAsksTheHostInTheServicesOrderAndEmptiesTheStore() throws {
    let rig = Rig()
    try rig.start(Self.trip(id: "clear-order"))
    try rig.drive([(0, 0), (0, 100)])
    rig.host.removeAll()
    rig.engine.clearNavigation()
    XCTAssertEqual(
      rig.labels,
      [
        "stopClock#2", "companion.didEnd", "clearTrip#2", "stateDidChange", "reconcile#2",
        "cancelSpeech#2",
      ])
    XCTAssertNil(rig.store.load())
    XCTAssertNil(rig.state.trip)
    XCTAssertNil(rig.state.tripEndReason)
  }

  func testArrivingEndsTheCompanionTripThenStopsTheClockAndReconcilesLocation() throws {
    let rig = Rig()
    let trip = Self.trip(id: "arrival-order")
    try rig.start(trip)
    let path = Trace.positions(along: Self.corners, every: 20).dropFirst()
    let parked = Array(repeating: path[path.endIndex - 1], count: 4)
    for (index, position) in (path + parked).enumerated()
    where rig.state.navigation.phase != .arrived {
      rig.host.removeAll()
      let moving = index < path.count
      try rig.fix(
        position.x, position.y, course: moving ? position.courseDegrees : nil,
        speed: moving ? 20 : 0)
    }
    XCTAssertEqual(rig.state.navigation.phase, .arrived)
    XCTAssertEqual(Array(rig.effects.prefix(2)), ["publication#1", "stateDidChange"])
    XCTAssertEqual(
      Array(rig.effects.suffix(3)), ["companion.didEnd", "stopClock#1", "reconcile#1"])
    XCTAssertNil(rig.store.load(), "an arrived trip is not restored")
  }

  func testInstallingAReplacementAsksTheHostInTheServicesOrder() throws {
    let rig = Rig(answer: { [Self.replacement(id: "replacement", from: $0.origin)] })
    try rig.start(Self.trip(id: "install-order"))
    try rig.driveOffTheFirstLeg()
    XCTAssertEqual(rig.state.routeStatus, .rerouting)
    rig.host.removeAll()
    XCTAssertTrue(rig.engine.completePendingReroute(through: rig.network))
    XCTAssertEqual(
      rig.effects,
      [
        "companion.routeDidChange", "cancelSpeech#2", "publication#2", "stateDidChange",
        "needsLocationUpdates",
      ])
    XCTAssertEqual(rig.state.trip?.id, "replacement")
    XCTAssertEqual(rig.state.rerouteCount, 1)
    XCTAssertEqual(rig.store.load()?.id, "replacement")
  }

  // MARK: A restored trip

  /// Saved at 400 m on the first leg ten minutes ago; the vehicle is on the last leg when the
  /// app comes back.
  private func restoredRig(audioMode: NavOSSCarPlayAudioMode = .allGuidance) -> (Rig, NavOSSCarPlayTrip)
  {
    let rig = Rig(audioMode: audioMode)
    let trip = Self.trip(id: "restored")
    rig.store.save(trip)
    rig.store.saveProgress(
      NavigationResumeContext(
        alongMeters: 400, highWaterAlongMeters: 400, uncertaintyMeters: 5,
        timestamp: rig.clock.time - 600, speedMetersPerSecond: nil, arrivalDeferral: nil),
      forTripId: trip.id)
    rig.engine.resumePersistedNavigation()
    rig.engine.completePendingSafetyCameraFetch()
    return (rig, trip)
  }

  private func assertWithheld(
    _ state: NavOSSNavigationServiceState, _ label: String, file: StaticString = #filePath,
    line: UInt = #line
  ) {
    XCTAssertNotNil(state.trip, label, file: file, line: line)
    XCTAssertTrue(state.isAcquiringPosition, label, file: file, line: line)
    XCTAssertNil(state.guidance, label, file: file, line: line)
    XCTAssertNil(state.navigation.matchedCoordinate, label, file: file, line: line)
    XCTAssertEqual(state.navigation.routeProgress, 0, label, file: file, line: line)
    XCTAssertNil(state.roadContext.currentRoadName, "\(label): live road", file: file, line: line)
    XCTAssertNil(state.roadContext.speedLimitKph, label, file: file, line: line)
    XCTAssertNil(state.safetyCameraAlert, label, file: file, line: line)
  }

  func testARestoredTripIsWithheldUntilAFixIsMatchedOnAKnownPass() throws {
    let (rig, trip) = restoredRig()
    XCTAssertEqual(
      rig.labels,
      [
        "companion.didStart(restored)", "cancelSpeech#1", "acquisition#1", "stateDidChange",
        "needsLocationUpdates", "startClock#1",
      ])
    assertWithheld(rig.state, "restored")

    // The clock does not dead-reckon a trip that has no position yet.
    rig.clock.advance(1)
    rig.engine.clockTick()
    assertWithheld(rig.state, "after a tick")

    // A held first fix on the last leg: still nothing guided, read or spoken.
    rig.host.removeAll()
    guard case .acquiring = try rig.fix(900, 1_000, course: 0) else {
      return XCTFail("the held fix was not withheld")
    }
    assertWithheld(rig.state, "held fix")
    XCTAssertNotNil(rig.state.navigation.rawCoordinate)
    XCTAssertEqual(rig.labels, ["acquisition#1", "stateDidChange"])
    rig.clock.advance(1)
    rig.engine.clockTick()
    XCTAssertEqual(rig.labels, ["acquisition#1", "stateDidChange"], "nothing from the clock")
    XCTAssertEqual(rig.store.loadProgress(for: trip), .progress(
      NavigationResumeContext(
        alongMeters: 400, highWaterAlongMeters: 400, uncertaintyMeters: 5,
        timestamp: Self.startTime - 600, speedMetersPerSecond: nil, arrivalDeferral: nil)),
      "no checkpoint from a fix that is not matched")

    // The confirming fix: the step the vehicle is on, and nothing from where it was saved.
    rig.host.removeAll()
    guard case .published = try rig.fix(900, 1_012, course: 0) else {
      return XCTFail("the confirming fix was not published")
    }
    XCTAssertFalse(rig.state.isAcquiringPosition)
    XCTAssertEqual(rig.state.guidance?.stepIndex, 2)
    XCTAssertEqual(rig.state.roadContext.currentRoadName, "Engine Road 2")
    XCTAssertEqual(Array(rig.labels.prefix(2)), ["publication#1", "stateDidChange"])
    // The saved step's maneuver is the right turn onto the second leg; it is behind.
    XCTAssertFalse(rig.host.spoken.contains { $0.text.lowercased().contains("right") })
  }

  /// A trip saved without progress is placed by its first fix, but where that fix fits two
  /// passes (the shared start and end of a loop) nothing is guided until the pass is known.
  /// The clock must not move it meanwhile: dead reckoning from the moving fix would publish
  /// guidance for a pass the vehicle has not been confirmed to be on.
  func testTheClockDoesNotPublishARestoredTripThatIsPlacedButNotConfirmed() throws {
    let rig = Rig()
    rig.store.save(
      Self.trip(
        id: "restored-without-progress",
        corners: [(0, 0), (0, 3_000), (3_000, 3_000), (3_000, 0), (20, 0)]))
    rig.engine.resumePersistedNavigation()
    rig.engine.completePendingSafetyCameraFetch()
    guard case .acquiring(let held) = try rig.fix(0, 10, course: nil, speed: 5) else {
      return XCTFail("the first fix of a trip without progress was not withheld")
    }
    XCTAssertNotNil(held.update.snapshot.matchedCoordinate, "placed on the route")
    XCTAssertFalse(held.update.snapshot.isPassConfirmed)
    rig.host.removeAll()
    for _ in 0..<5 {
      rig.clock.advance(1)
      rig.engine.clockTick()
    }
    XCTAssertEqual(rig.labels, [], "five seconds without a fix")
    assertWithheld(rig.state, "after five ticks")
  }

  func testARestoredTripWhoseFirstFixIsOffItsRouteIsDiscarded() throws {
    let (rig, _) = restoredRig()
    rig.host.removeAll()
    guard case .discarded = try rig.fix(500, 300, course: 90) else {
      return XCTFail("the fix 500 m from the route did not discard the trip")
    }
    XCTAssertEqual(
      rig.labels,
      [
        "stopClock#2", "companion.didEnd", "clearTrip#2", "stateDidChange", "reconcile#2",
        "cancelSpeech#2",
      ], "ended, and never published, shown as acquiring or spoken")
    XCTAssertNil(rig.state.trip)
    XCTAssertEqual(rig.state.tripEndReason, .restoredTripOffRoute)
    XCTAssertNil(rig.store.load())
    XCTAssertThrowsError(try rig.fix(500, 300, course: 90), "no trip to feed")

    // The reason belongs to the trip that ended: a new trip starts without it.
    try rig.start(Self.trip(id: "next"))
    rig.engine.clearNavigation()
    XCTAssertNil(rig.state.tripEndReason)
  }

  func testNothingToRestoreStartsNothing() {
    let rig = Rig()
    rig.engine.resumePersistedNavigation()
    XCTAssertEqual(rig.labels, [])
    XCTAssertNil(rig.state.trip)
  }

  // MARK: Checkpoints

  func testAMatchedFixWritesACheckpointAtMostEveryFifteenSeconds() throws {
    let rig = Rig()
    let trip = Self.trip(id: "checkpoint")
    try rig.start(trip)
    XCTAssertEqual(rig.store.loadProgress(for: trip), .withoutProgress)
    try rig.drive([(0, 0), (0, 120)])
    guard case .progress(let first) = rig.store.loadProgress(for: trip) else {
      return XCTFail("no checkpoint from matched fixes")
    }
    XCTAssertLessThan(first.alongMeters, 30, "written from the first matched fix, then held")
    try rig.drive([(0, 120), (0, 240)])
    guard case .progress(let second) = rig.store.loadProgress(for: trip) else {
      return XCTFail("the checkpoint was lost")
    }
    XCTAssertGreaterThan(second.alongMeters, 150, "rewritten after fifteen seconds")
  }

  /// A checkpoint held inside its critical section, at the store write, while a clear or a
  /// restart of the same trip identifier on new geometry is issued: the competitor waits for
  /// the lock, nothing deadlocks, and the store ends with the competitor's state.
  func testACheckpointRacingAClearOrARestartLeavesTheCompetitorsState() throws {
    for competitor in ["clear", "same-id-new-geometry"] {
      let rig = Rig()
      let trip = Self.trip(id: "race")
      let restarted = Self.trip(
        id: trip.id, corners: [(0, 0), (0, 400), (-600, 400), (-600, 1_400)])
      try rig.start(trip)
      let inside = DispatchSemaphore(value: 0)
      let release = DispatchSemaphore(value: 0)
      let checkpointDone = DispatchSemaphore(value: 0)
      let competitorDone = DispatchSemaphore(value: 0)
      rig.engine.checkpointWillWrite = {
        inside.signal()
        release.wait()
      }
      DispatchQueue.global().async {
        _ = try? rig.fix(0, 300, course: 0)
        checkpointDone.signal()
      }
      guard inside.wait(timeout: .now() + 10) == .success else {
        release.signal()
        XCTFail("\(competitor): the checkpoint was never reached")
        continue
      }
      rig.engine.checkpointWillWrite = nil
      DispatchQueue.global().async {
        if competitor == "clear" {
          rig.engine.clearNavigation()
        } else {
          try? rig.engine.startNavigation(restarted)
        }
        competitorDone.signal()
      }
      XCTAssertEqual(
        competitorDone.wait(timeout: .now() + 0.5), .timedOut,
        "\(competitor) did not wait for the checkpoint's critical section")
      release.signal()
      XCTAssertEqual(checkpointDone.wait(timeout: .now() + 10), .success, "\(competitor): deadlock")
      XCTAssertEqual(competitorDone.wait(timeout: .now() + 10), .success, "\(competitor): deadlock")
      if competitor == "clear" {
        XCTAssertNil(rig.store.load())
        XCTAssertEqual(rig.store.loadProgress(for: trip), .withoutProgress)
      } else {
        XCTAssertEqual(rig.store.load()?.geometry.count, restarted.geometry.count)
        XCTAssertEqual(
          rig.store.loadProgress(for: restarted), .withoutProgress,
          "the replaced route's checkpoint must not survive under the same identifier")
        // The restarted trip's own first checkpoint is written as usual.
        try rig.fix(0, 200, course: 0)
        guard case .progress(let progress) = rig.store.loadProgress(for: restarted) else {
          XCTFail("the restarted trip wrote no checkpoint")
          continue
        }
        XCTAssertEqual(progress.alongMeters, 200, accuracy: 10)
      }
    }
  }

  // MARK: Reroute results that arrive too late

  func testARerouteResultArrivingAfterTheTripWasClearedChangesNothing() throws {
    for fails in [false, true] {
      let rig = Rig(answer: {
        if fails { throw NavOSSNavigationAPIError.invalidResponse }
        return [Self.replacement(id: "late", from: $0.origin)]
      })
      try rig.start(Self.trip(id: "cleared"))
      try rig.driveOffTheFirstLeg()
      XCTAssertEqual(rig.state.routeStatus, .rerouting)
      let inFlight = try XCTUnwrap(rig.engine.pendingRerouteTask)
      rig.engine.clearNavigation()
      rig.host.removeAll()
      rig.network.setGateOpen(true)
      waitForEngineTask(inFlight)
      XCTAssertEqual(rig.network.requests.count, 1, "the request was answered")
      XCTAssertEqual(rig.labels, [], "fails=\(fails)")
      XCTAssertNil(rig.state.trip, "fails=\(fails)")
      XCTAssertEqual(rig.state.routeStatus, .tracking, "fails=\(fails)")
      XCTAssertEqual(rig.state.rerouteCount, 0)
      XCTAssertNil(rig.store.load())
    }
  }

  func testARerouteResultArrivingAfterANewerTripStartedChangesNothing() throws {
    for fails in [false, true] {
      let rig = Rig(answer: {
        if fails { throw NavOSSNavigationAPIError.invalidResponse }
        return [Self.replacement(id: "late", from: $0.origin)]
      })
      try rig.start(Self.trip(id: "older"))
      try rig.driveOffTheFirstLeg()
      let inFlight = try XCTUnwrap(rig.engine.pendingRerouteTask)
      let newer = Self.trip(id: "newer", corners: [(0, 0), (0, 400), (-600, 400), (-600, 1_400)])
      try rig.start(newer)
      rig.host.removeAll()
      let version = rig.state.stateVersion
      rig.network.setGateOpen(true)
      waitForEngineTask(inFlight)
      XCTAssertEqual(rig.network.requests.count, 1, "the request was answered")
      XCTAssertEqual(rig.labels, [], "fails=\(fails)")
      XCTAssertEqual(rig.state.trip?.id, "newer", "fails=\(fails)")
      XCTAssertEqual(rig.state.routeStatus, .tracking, "fails=\(fails)")
      XCTAssertEqual(rig.state.rerouteCount, 0)
      XCTAssertEqual(rig.state.stateVersion, version)
      XCTAssertEqual(rig.store.load()?.geometry.count, newer.geometry.count)
    }
  }

  /// Two requests for the same trip, the earlier one overtaken. `overtake` makes the engine
  /// drop the first request (which left the route eastward) and takes the vehicle off the
  /// route westward, so that everything about the late result matches the trip's current state
  /// except what `overtake` changed. The late result is dropped whether it carries a route or
  /// a failure, in every reroute mode, and the current request's result is the one used.
  private func assertAnOvertakenRerouteResultIsDropped(
    _ label: String, overtake: (Rig, NavOSSCarPlayTrip) throws -> Void,
    file: StaticString = #filePath, line: UInt = #line
  ) throws {
    for mode in [NavOSSRerouteMode.adaptive, .askFirst] {
      for staleFails in [false, true] {
        let context = "\(label), \(mode), staleFails=\(staleFails)"
        let fresh = DispatchSemaphore(value: 0)
        let rig = Rig(rerouteMode: mode, answer: { request in
          if Trace.local(
            NavigationCoordinate(
              latitude: request.origin.latitude, longitude: request.origin.longitude)
          ).x > 0 {
            if staleFails { throw NavOSSNavigationAPIError.invalidResponse }
            return [Self.replacement(id: "stale", from: request.origin)]
          }
          _ = fresh.wait(timeout: .now() + 60)
          return [Self.replacement(id: "fresh", from: request.origin)]
        })
        let trip = Self.trip(id: "same-trip")
        try rig.start(trip)
        try rig.driveOffTheFirstLeg(direction: 1)
        let stale = try XCTUnwrap(rig.engine.pendingRerouteTask, context, file: file, line: line)

        try overtake(rig, trip)
        XCTAssertEqual(rig.requests, 2, context, file: file, line: line)
        let current = try XCTUnwrap(rig.engine.pendingRerouteTask, context, file: file, line: line)
        XCTAssertEqual(rig.state.routeStatus, .rerouting, context, file: file, line: line)
        XCTAssertEqual(rig.state.trip?.id, trip.id, context, file: file, line: line)
        XCTAssertTrue(rig.state.navigation.isOffRoute, context, file: file, line: line)

        rig.host.removeAll()
        let version = rig.state.stateVersion
        rig.network.setGateOpen(true)
        waitForEngineTask(stale)
        XCTAssertEqual(rig.labels, [], context, file: file, line: line)
        XCTAssertEqual(rig.state.trip?.id, trip.id, context, file: file, line: line)
        XCTAssertNil(rig.state.rerouteProposal, context, file: file, line: line)
        XCTAssertEqual(rig.state.rerouteCount, 0, context, file: file, line: line)
        XCTAssertEqual(
          rig.state.routeStatus, .rerouting, "\(context): the current request is in flight",
          file: file, line: line)
        XCTAssertEqual(rig.state.stateVersion, version, context, file: file, line: line)

        fresh.signal()
        waitForEngineTask(current)
        if mode == .askFirst {
          let proposal = try XCTUnwrap(rig.state.rerouteProposal, context, file: file, line: line)
          XCTAssertTrue(rig.engine.acceptRerouteProposal(id: proposal.id), context, file: file, line: line)
        }
        XCTAssertEqual(rig.state.trip?.id, "fresh", context, file: file, line: line)
        XCTAssertEqual(rig.state.rerouteCount, 1, context, file: file, line: line)
        XCTAssertEqual(rig.store.load()?.id, "fresh", context, file: file, line: line)
      }
    }
  }

  /// The same trip started again while its reroute was in flight: the late result belongs to
  /// an earlier generation.
  func testARerouteResultFromAnEarlierGenerationOfTheSameTripIsDropped() throws {
    try assertAnOvertakenRerouteResultIsDropped("restarted") { rig, trip in
      try rig.start(trip)
      try rig.driveOffTheFirstLeg(direction: -1)
    }
  }

  /// The vehicle rejoined the route, which withdraws the request, and left it again: the late
  /// result is for the same generation of the same trip, but not for the request in flight.
  func testARerouteResultFromAnEarlierRequestOfTheSameGenerationIsDropped() throws {
    try assertAnOvertakenRerouteResultIsDropped("rejoined") { rig, _ in
      let generation = rig.host.events.last.map(\.label)
      let x = try XCTUnwrap(rig.state.navigation.rawCoordinate.map { Trace.local($0).x })
      try rig.drive([(x, 300), (0, 300), (0, 420)])
      XCTAssertFalse(rig.state.navigation.isOffRoute)
      XCTAssertEqual(rig.state.routeStatus, .tracking)
      XCTAssertNil(rig.engine.pendingRerouteTask, "rejoining withdraws the request")
      XCTAssertFalse(
        rig.labels.contains { $0.hasSuffix("#2") }, "no new generation (was \(generation ?? "-"))")
      try rig.leaveTheFirstLeg(at: 420, direction: -1)
    }
  }

  /// An update overtaken between its publication and what follows it: the host restarts the
  /// trip from inside the state-change callback of the fix that left the route, as another
  /// thread could between the engine's critical sections. The overtaken update must not ask
  /// for a replacement for the restarted trip, which is not off its route.
  func testAnUpdateOvertakenByARestartIsNotReroutedFromOrCheckpointed() throws {
    let rig = Rig()
    let trip = Self.trip(id: "overtaken")
    try rig.start(trip)
    var restarted = false
    rig.host.onStateDidChange = { [unowned rig] in
      guard !restarted, rig.state.navigation.isOffRoute else { return }
      restarted = true
      try? rig.engine.startNavigation(trip)
    }
    try rig.drive([(0, 0), (0, 300)])
    var x = 0.0
    while !restarted, x < 600 {
      x += 12
      try rig.fix(x, 300, course: 90)
    }
    XCTAssertTrue(restarted, "the vehicle never left the route")
    XCTAssertNil(rig.engine.pendingRerouteTask, "a replacement was requested from a stale update")
    XCTAssertEqual(rig.state.routeStatus, .tracking)
    XCTAssertFalse(rig.state.navigation.isOffRoute)
    XCTAssertEqual(rig.store.loadProgress(for: trip), .withoutProgress)
  }

  func testARerouteResultArrivingBackOnTheRouteIsNotInstalled() throws {
    let rig = Rig(answer: { [Self.replacement(id: "late", from: $0.origin)] })
    let trip = Self.trip(id: "rejoined")
    try rig.start(trip)
    try rig.driveOffTheFirstLeg()
    let inFlight = try XCTUnwrap(rig.engine.pendingRerouteTask)
    // Back onto the first leg and along it.
    let x = try XCTUnwrap(rig.state.navigation.rawCoordinate.map { Trace.local($0).x })
    try rig.drive([(x, 300), (0, 300), (0, 420)])
    XCTAssertFalse(rig.state.navigation.isOffRoute)
    XCTAssertEqual(rig.state.routeStatus, .tracking)
    rig.network.setGateOpen(true)
    waitForEngineTask(inFlight)
    XCTAssertEqual(rig.state.trip?.id, trip.id)
    XCTAssertEqual(rig.state.rerouteCount, 0)
  }

  func testAFailedRerouteIsRetriedOnlyAfterItsBackoff() throws {
    let rig = Rig()
    try rig.start(Self.trip(id: "backoff"))
    try rig.driveOffTheFirstLeg()
    XCTAssertTrue(rig.engine.completePendingReroute(through: rig.network))
    XCTAssertEqual(rig.state.routeStatus, .rerouteFailed)
    let x = try XCTUnwrap(rig.state.navigation.rawCoordinate.map { Trace.local($0).x })
    for second in 1...8 {
      try rig.fix(x + Double(second) * 12, 300, course: 90)
    }
    XCTAssertEqual(rig.requests, 1, "no retry inside ten seconds")
    for second in 9...12 {
      try rig.fix(x + Double(second) * 12, 300, course: 90)
    }
    XCTAssertEqual(rig.requests, 2)
  }

  // MARK: Speech and the audio mode

  /// The first leg past a camera 500 m along it and round the turn onto the second leg.
  private func driveThePastACameraAndATurn(_ mode: NavOSSCarPlayAudioMode) throws -> (
    spoken: [NavigationEngineSpeech], sawCameraAlert: Bool
  ) {
    let rig = Rig(audioMode: mode)
    let camera = Trace.coordinate(0, 500)
    rig.network.cameras = {
      [
        NavOSSSafetyCamera(
          id: "engine-camera", latitude: camera.latitude, longitude: camera.longitude,
          direction: .northbound, location: "Engine Road 0")
      ]
    }
    try rig.start(Self.trip(id: "speech-\(mode.rawValue)"))
    var sawCameraAlert = false
    for position in Trace.positions(along: [(0, 0), (0, 800), (300, 800)], every: 12).dropFirst() {
      try rig.fix(position.x, position.y, course: position.courseDegrees)
      sawCameraAlert = sawCameraAlert || rig.state.safetyCameraAlert != nil
    }
    return (rig.host.spoken, sawCameraAlert)
  }

  func testTheAudioModeDecidesWhatIsSpokenNotWhatIsShown() throws {
    let cameraAlert = NavigationEngineSpeech(
      text: "Red light and speed camera ahead.", kind: .alert)

    let all = try driveThePastACameraAndATurn(.allGuidance)
    XCTAssertTrue(all.sawCameraAlert)
    XCTAssertEqual(all.spoken.filter { $0.kind == .alert }, [cameraAlert])
    XCTAssertTrue(all.spoken.contains { $0.kind == .maneuver && $0.text.contains("right") })

    let alertsOnly = try driveThePastACameraAndATurn(.alertsOnly)
    XCTAssertTrue(alertsOnly.sawCameraAlert)
    XCTAssertEqual(alertsOnly.spoken, [cameraAlert], "alerts, and no maneuver prompt")

    let muted = try driveThePastACameraAndATurn(.muted)
    XCTAssertTrue(muted.sawCameraAlert, "the alert is still shown")
    XCTAssertEqual(muted.spoken, [], "nothing is spoken when muted")
  }

  func testACompanionAnnouncementIsEvaluatedAndSpokenOnlyWhenAlertsAreAllowed() throws {
    for mode in NavOSSCarPlayAudioMode.allCases {
      let rig = Rig(audioMode: mode)
      var evaluations = 0
      rig.companion.announcement = {
        evaluations += 1
        return "Crash reported ahead."
      }
      try rig.start(Self.trip(id: "companion-\(mode.rawValue)"))
      let spoken = rig.host.spoken.filter { $0.text == "Crash reported ahead." }
      XCTAssertEqual(spoken.count, mode == .muted ? 0 : 1, "\(mode)")
      XCTAssertEqual(evaluations, mode == .muted ? 0 : 1, "\(mode)")
      XCTAssertEqual(spoken.first?.kind, mode == .muted ? nil : .alert, "\(mode)")
    }
  }

  func testAnAskFirstProposalIsAnnouncedOnlyWhenAlertsAreAllowed() throws {
    for mode in NavOSSCarPlayAudioMode.allCases {
      let rig = Rig(
        audioMode: mode, rerouteMode: .askFirst,
        answer: { [Self.replacement(id: "proposed", from: $0.origin)] })
      let trip = Self.trip(id: "ask-first-\(mode.rawValue)")
      try rig.start(trip)
      try rig.driveOffTheFirstLeg()
      rig.host.removeAll()
      XCTAssertTrue(rig.engine.completePendingReroute(through: rig.network))
      XCTAssertNotNil(rig.state.rerouteProposal, "\(mode): the proposal is shown")
      XCTAssertEqual(rig.state.trip?.id, trip.id, "\(mode): nothing installed without consent")
      XCTAssertEqual(
        rig.labels,
        mode == .muted ? ["stateDidChange"] : ["stateDidChange", "speak(alert)#1"], "\(mode)")
      XCTAssertEqual(
        rig.host.spoken.map(\.text), mode == .muted ? [] : ["A new route is ready."], "\(mode)")

      // Accepting installs it for the generation that is current now.
      let id = try XCTUnwrap(rig.state.rerouteProposal?.id)
      XCTAssertTrue(rig.engine.acceptRerouteProposal(id: id))
      XCTAssertEqual(rig.state.trip?.id, "proposed")
      XCTAssertFalse(rig.engine.acceptRerouteProposal(id: id), "already answered")
    }
  }

  func testLeavingAllGuidanceStopsSpeechForTheCurrentGeneration() throws {
    let rig = Rig()
    try rig.start(Self.trip(id: "audio-mode"))
    rig.host.removeAll()
    rig.engine.setAudioMode(.alertsOnly)
    XCTAssertEqual(rig.labels, ["cancelSpeech#1"])
    rig.engine.setAudioMode(.alertsOnly)
    XCTAssertEqual(rig.labels, ["cancelSpeech#1"], "no change, no effect")
    rig.engine.setAudioMode(.allGuidance)
    XCTAssertEqual(rig.labels, ["cancelSpeech#1"], "turning guidance on stops nothing")
    XCTAssertEqual(rig.engine.audioMode(), .allGuidance)
  }
}
