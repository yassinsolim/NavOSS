import Foundation
import XCTest

@testable import NavOSSNavigationCore

/// Resuming a trip after a relaunch: where it had got to is saved beside the trip, and the
/// restored trip is matched from there on the same evidence an uninterrupted trip would ask for.
/// Each test is a reproduction from the reviews of that change (the independent reviewer's
/// probes, rewritten with physically possible timing), or the case it must keep working.
final class NavigationTripRestoreTests: XCTestCase {
  private typealias Trace = NavigationTrace

  private func along(_ snapshot: NavigationSnapshot, _ core: NavigationCore) -> Double {
    snapshot.routeProgress * (core.routeLengthMeters ?? 0)
  }

  private func along(_ snapshot: NavigationSnapshot, _ session: NavigationSession) -> Double {
    snapshot.routeProgress * (session.routeLengthMeters ?? 0)
  }

  private static func carPlay(_ coordinates: [NavigationCoordinate]) -> [NavOSSCarPlayCoordinate] {
    coordinates.map { NavOSSCarPlayCoordinate(latitude: $0.latitude, longitude: $0.longitude) }
  }

  private static func trip(_ corners: [(Double, Double)], id: String = "evidence")
    -> NavOSSCarPlayTrip
  {
    var steps: [NavOSSCarPlayRouteStep] = []
    for (index, (start, end)) in zip(corners, corners.dropFirst()).enumerated() {
      let length = hypot(end.0 - start.0, end.1 - start.1)
      steps.append(
        NavOSSCarPlayRouteStep(
          distanceMeters: length, durationSeconds: length / 15,
          geometry: carPlay(Trace.route([start, end])),
          instruction: "Leg \(index)", maneuverType: index == 0 ? "depart" : "turn",
          roadName: "Road \(index)"
        )
      )
    }
    let last = corners[corners.count - 1]
    steps.append(
      NavOSSCarPlayRouteStep(
        distanceMeters: 0, durationSeconds: 0, geometry: carPlay(Trace.route([last, last])),
        instruction: "Arrive", maneuverType: "arrive", roadName: ""
      )
    )
    let destination = Trace.coordinate(last.0, last.1)
    return NavOSSCarPlayTrip(
      destination: NavOSSCarPlayDestination(
        id: "d", label: "d", latitude: destination.latitude, longitude: destination.longitude,
        name: "Destination"
      ),
      distanceMeters: steps.reduce(0) { $0 + $1.distanceMeters },
      durationSeconds: steps.reduce(0) { $0 + $1.durationSeconds },
      geometry: carPlay(Trace.route(corners)), id: id, steps: steps
    )
  }

  /// A checkpoint as the matcher writes one, for tests that start from a given place.
  private static func progress(
    _ alongMeters: Double,
    time: TimeInterval?,
    speed: Double? = nil,
    deferredAt: Double? = nil
  ) -> NavigationResumeContext {
    NavigationResumeContext(
      alongMeters: alongMeters,
      highWaterAlongMeters: alongMeters,
      uncertaintyMeters: 5,
      timestamp: time,
      speedMetersPerSecond: speed,
      arrivalDeferral: deferredAt.map {
        NavigationResumeContext.ArrivalDeferral(alongMeters: $0, uncertaintyMeters: 5)
      }
    )
  }

  private static func store(clock: @escaping () -> Date = Date.init) throws
    -> (NavOSSActiveTripStore, UserDefaults, String)
  {
    let suite = "NavOSSTripRestore.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    return (NavOSSActiveTripStore(defaults: defaults, clock: clock), defaults, suite)
  }

  private static let progressKey = "org.navoss.mobile.active-navigation-trip.v2.progress"

  /// Saves `session`'s checkpoint for `trip` through the store and starts a new session from
  /// what the store gives back, as a relaunch does.
  private static func relaunch(
    _ session: NavigationSession,
    _ trip: NavOSSCarPlayTrip,
    store: NavOSSActiveTripStore
  ) throws -> NavigationSession {
    store.save(trip)
    store.saveProgress(try XCTUnwrap(session.resumeContext), forTripId: trip.id)
    let restored = NavigationSession()
    let saved = try XCTUnwrap(store.load())
    try restored.start(saved, resume: store.loadProgress(for: saved))
    return restored
  }

  private static func decision(_ update: NavigationSessionUpdate)
    -> NavOSSPersistedNavigationDecision
  {
    navOSSPersistedNavigationDecision(update.snapshot)
  }

  private static let straight: [(Double, Double)] = [(0, 0), (0, 1_000)]
  private static let dividedRoad: [(Double, Double)] = [
    (0, 0), (0, 3_000), (200, 3_000), (200, 0),
  ]
  private static let outAndBack: [(Double, Double)] = [
    (0, 0), (0, 3_000), (400, 3_000), (400, 0),
  ]
  private static let longLoop: [(Double, Double)] = [
    (0, 0), (0, 3_000), (3_000, 3_000), (3_000, 0), (20, 0),
  ]

  // MARK: The first fix of a route

  /// The first fix of a route, at the point where the route both starts and ends.
  func testTheFirstFixTakesTheEarliestPassThatFits() throws {
    for x in [0.0, 10, 20, 30] {
      let core = NavigationCore()
      try core.setRoute(Trace.route(Self.longLoop))
      var snapshot = try core.updateLocation(Trace.sample(x: x, y: 0, speed: 0, time: 0))
      XCTAssertLessThan(along(snapshot, core), 40, "x \(x)")
      for second in 1...3 {
        snapshot = try core.updateLocation(
          Trace.sample(x: x, y: 0, speed: 0, time: Double(second))
        )
      }
      XCTAssertEqual(snapshot.phase, .tracking, "x \(x)")
    }
  }

  /// A first fix from a vehicle already moving along the last leg is placed on the last leg,
  /// as heading always chose between two carriageways. It does not end the trip: stopping
  /// there is not arriving, driving on in is.
  func testTheFirstFixFollowsTheHeadingOfAMovingVehicleButDoesNotArrive() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route(Self.longLoop))
    var snapshot = try core.updateLocation(
      Trace.sample(x: 25, y: 0, courseDegrees: 270, speed: 10, time: 0)
    )
    XCTAssertEqual(along(snapshot, core), 11_975, accuracy: 5)
    for second in 1...5 {
      snapshot = try core.updateLocation(
        Trace.sample(x: 20, y: 0, speed: 0, time: Double(second))
      )
      XCTAssertEqual(snapshot.phase, .tracking)
    }

    let driven = NavigationCore()
    try driven.setRoute(Trace.route(Self.longLoop))
    var time = 0.0
    for x in stride(from: 120.0, through: 20, by: -10) + [20, 20] {
      snapshot = try driven.updateLocation(
        Trace.sample(x: x, y: 0, courseDegrees: 270, speed: x > 20 ? 10 : 0, time: time)
      )
      time += 1
    }
    XCTAssertEqual(snapshot.phase, .arrived)
  }

  // MARK: Resuming from saved progress

  /// A trip saved half way round a loop and restored through the real store is there, not at
  /// the start, and a fix that also fits the start does not take it back there.
  func testARestoredTripResumesFromItsSavedProgress() throws {
    let (store, defaults, suite) = try Self.store()
    defer { defaults.removePersistentDomain(forName: suite) }
    let original = Self.trip(Self.longLoop)
    store.save(original)

    store.saveProgress(Self.progress(7_500, time: Trace.time(0)), forTripId: original.id)
    let restoredTrip = try XCTUnwrap(store.load())
    let resume = store.loadProgress(for: restoredTrip)
    XCTAssertEqual(resume, .progress(Self.progress(7_500, time: Trace.time(0))))
    let restored = NavigationSession()
    let started = try restored.start(restoredTrip, resume: resume)
    XCTAssertEqual(started.snapshot.routeProgress * 11_980, 7_500, accuracy: 5)
    XCTAssertEqual(restored.resumeContext, Self.progress(7_500, time: Trace.time(0)))
    let first = try restored.updateLocation(
      Trace.sample(x: 3_000, y: 1_480, courseDegrees: 180, speed: 10, time: 5)
    )
    XCTAssertFalse(first.snapshot.isOffRoute)
    XCTAssertEqual(first.snapshot.routeProgress * 11_980, 7_520, accuracy: 5)
    XCTAssertEqual(Self.decision(first), .publish)
    XCTAssertEqual(first.guidance?.stepIndex, 2)

    // A first fix off the route on a resumed trip is a departure with no matched position.
    let astray = NavigationSession()
    try astray.start(restoredTrip, resume: resume)
    let off = try astray.updateLocation(Trace.sample(x: 2_800, y: 1_500, speed: 0, time: 5))
    XCTAssertFalse(off.snapshot.isOffRoute)
    XCTAssertNil(off.snapshot.matchedCoordinate)
    XCTAssertEqual(off.snapshot.routeProgress * 11_980, 7_500, accuracy: 5)

    // Saved near the end, restored at the start/end point: driving in arrives, and does not
    // return to the start.
    store.saveProgress(Self.progress(11_900, time: Trace.time(0)), forTripId: original.id)
    let nearEnd = NavigationSession()
    try nearEnd.start(restoredTrip, resume: store.loadProgress(for: restoredTrip))
    var update = nearEnd.currentUpdate()
    for (second, x) in [(1.0, 80.0), (2, 60), (3, 40), (4, 20), (5, 20), (6, 20)] {
      update = try nearEnd.updateLocation(
        Trace.sample(
          x: x, y: 0, courseDegrees: x > 20 ? 270 : nil, speed: x > 20 ? 20 : 0, time: second)
      )
    }
    XCTAssertEqual(update.snapshot.phase, .arrived)
    XCTAssertNil(nearEnd.resumeContext)
  }

  /// The start of the route is a checkpoint like any other. Without it the restored trip's
  /// first fix would be placed freely, and two fixes 44 m from the start of a loop end it.
  func testACheckpointAtTheStartOfTheRouteIsAnAnchor() throws {
    let (store, defaults, suite) = try Self.store()
    defer { defaults.removePersistentDomain(forName: suite) }
    let original = Self.trip(Self.longLoop)
    let before = NavigationSession()
    try before.start(original)
    _ = try before.updateLocation(Trace.sample(x: 0, y: 0, speed: 0, time: 0))
    XCTAssertEqual(before.resumeContext?.alongMeters, 0)

    let restored = try Self.relaunch(before, original, store: store)
    for second in 1...4 {
      let update = try restored.updateLocation(
        Trace.sample(x: 44, y: 0, speed: 0, time: Double(second))
      )
      XCTAssertEqual(update.snapshot.phase, .tracking)
      XCTAssertEqual(update.snapshot.routeProgress, 0)
    }
  }

  /// A checkpoint, written and read back, is the matcher's state again: a restored session
  /// would write the same checkpoint before it has seen a fix.
  func testAStoredCheckpointRestoresTheSameAnchor() throws {
    let (store, defaults, suite) = try Self.store()
    defer { defaults.removePersistentDomain(forName: suite) }
    let original = Self.trip(Self.outAndBack)
    let before = NavigationSession()
    try before.start(original)
    _ = try before.updateLocation(Trace.sample(x: 0, y: 0, speed: 0, time: 0))
    _ = try before.updateLocation(Trace.sample(x: 412, y: 100, speed: 0, time: 600))
    _ = try before.updateLocation(Trace.sample(x: 412, y: 100, speed: 0, time: 601))
    for (second, y) in [(602.0, 90.0), (603, 80)] {
      _ = try before.updateLocation(
        Trace.sample(x: 410, y: y, courseDegrees: 180, speed: 10, time: second))
    }
    let saved = try XCTUnwrap(before.resumeContext)
    XCTAssertTrue(saved.isArrivalDeferred)
    XCTAssertEqual(saved.speedMetersPerSecond, 10)
    XCTAssertEqual(saved.timestamp, Trace.time(603))
    // 5 m of accuracy and 10 m beside the route.
    XCTAssertEqual(saved.uncertaintyMeters, 15, accuracy: 0.5)
    XCTAssertEqual(try XCTUnwrap(saved.arrivalDeferral).uncertaintyMeters, 17, accuracy: 0.5)

    let restored = try Self.relaunch(before, original, store: store)
    let again = try XCTUnwrap(restored.resumeContext)
    XCTAssertEqual(again.alongMeters, saved.alongMeters, accuracy: 0.01)
    XCTAssertEqual(again.highWaterAlongMeters, saved.highWaterAlongMeters, accuracy: 0.01)
    XCTAssertEqual(again.uncertaintyMeters, saved.uncertaintyMeters, accuracy: 0.01)
    XCTAssertEqual(again.timestamp, saved.timestamp)
    XCTAssertEqual(again.speedMetersPerSecond, saved.speedMetersPerSecond)
    XCTAssertEqual(
      try XCTUnwrap(again.arrivalDeferral).alongMeters,
      try XCTUnwrap(saved.arrivalDeferral).alongMeters, accuracy: 0.01)
    XCTAssertEqual(
      try XCTUnwrap(again.arrivalDeferral).uncertaintyMeters,
      try XCTUnwrap(saved.arrivalDeferral).uncertaintyMeters, accuracy: 0.01)
  }

  /// Review finding: restoring dropped the accepted fix's reported speed, so stationary fixes
  /// biased 100 m on towards the destination were believed as driving and arrived, where the
  /// uninterrupted trip held them as a jump and kept arrival waiting. Here the checkpoint is
  /// fully current: nothing is lost to the write cadence.
  func testARestoredTripKeepsTheMotionEvidenceOfItsAcceptedFix() throws {
    let (store, defaults, suite) = try Self.store()
    defer { defaults.removePersistentDomain(forName: suite) }
    let trip = Self.trip(Self.straight)
    let uninterrupted = NavigationSession()
    try uninterrupted.start(trip)
    _ = try uninterrupted.updateLocation(Trace.sample(x: 0, y: 900, speed: 0, time: 0))
    let restored = try Self.relaunch(uninterrupted, trip, store: store)

    for second in 3...8 {
      let biased = Trace.sample(x: 0, y: 1_000, speed: 0, time: Double(second))
      let continuing = try uninterrupted.updateLocation(biased)
      let resumed = try restored.updateLocation(biased)
      XCTAssertEqual(continuing.snapshot.phase, .tracking, "uninterrupted at \(second)")
      XCTAssertEqual(resumed.snapshot.phase, .tracking, "restored at \(second)")
    }
    XCTAssertEqual(uninterrupted.resumeContext?.isArrivalDeferred, true)
    XCTAssertEqual(restored.resumeContext?.isArrivalDeferred, true)
  }

  /// Final review finding: the same checkpoint, but with a capture time that cannot be used
  /// (in the future after the clock was set back, or missing). Without a time the saved
  /// standstill explains nothing, so the biased fixes were believed and arrived. The fix the
  /// trip is reacquired from is not movement: arrival waits for the vehicle to move on from it.
  /// Driving in does arrive.
  func testARestoredTripWithAnUnusableCaptureTimeStillNeedsMovementToArrive() throws {
    let trip = Self.trip(Self.straight)
    for (label, savedTime) in [("future", Trace.time(3_600)), ("missing", nil)]
      as [(String, TimeInterval?)]
    {
      let saved = NavigationResumeContext(
        alongMeters: 900, highWaterAlongMeters: 900, uncertaintyMeters: 5, timestamp: savedTime,
        speedMetersPerSecond: 0, arrivalDeferral: nil)
      let parked = NavigationSession()
      try parked.start(trip, resume: .progress(saved))
      for second in 3...8 {
        let update = try parked.updateLocation(
          Trace.sample(x: 0, y: 1_000, speed: 0, time: Double(second)))
        XCTAssertEqual(update.snapshot.phase, .tracking, "\(label) at \(second)")
        XCTAssertNotEqual(Self.decision(update), .discard, "\(label) at \(second)")
      }
      XCTAssertEqual(parked.resumeContext?.isArrivalDeferred, true, label)

      let driving = NavigationSession()
      try driving.start(trip, resume: .progress(saved))
      var update = driving.currentUpdate()
      var time = 3.0
      for y in stride(from: 910.0, through: 1_000, by: 10) + [1_000, 1_000] {
        update = try driving.updateLocation(
          Trace.sample(x: 0, y: y, courseDegrees: 0, speed: y < 1_000 ? 10 : 0, time: time))
        time += 1
      }
      XCTAssertEqual(update.snapshot.phase, .arrived, label)
    }
  }

  /// Review finding: an arrival deferred between two fifteen-second checkpoints was still
  /// "not deferred" on disk, and the restored trip arrived on stationary fixes. A change of
  /// deferral is written at once.
  func testAnArrivalDeferralIsCheckpointedAtOnce() throws {
    let (store, defaults, suite) = try Self.store()
    defer { defaults.removePersistentDomain(forName: suite) }
    let trip = Self.trip(Self.straight)
    store.save(trip)
    let uninterrupted = NavigationSession()
    try uninterrupted.start(trip)
    var lastPersisted: NavigationResumeContext?
    var lastPersistedAt: Date?
    // The service's cadence, fed with wall-clock seconds as it is.
    for (second, y) in [(0.0, 900.0), (3, 1_000), (4, 1_000)] {
      let update = try uninterrupted.updateLocation(
        Trace.sample(x: 0, y: y, speed: 0, time: second))
      let now = Date(timeIntervalSinceReferenceDate: Trace.time(second))
      if navOSSIsProgressCheckpoint(update.snapshot),
        let progress = uninterrupted.resumeContext,
        navOSSShouldPersistProgress(
          progress, lastPersisted: lastPersisted, now: now, lastPersistedAt: lastPersistedAt)
      {
        store.saveProgress(progress, forTripId: trip.id)
        lastPersisted = progress
        lastPersistedAt = now
      }
    }
    XCTAssertEqual(uninterrupted.resumeContext?.isArrivalDeferred, true)
    guard case .progress(let onDisk) = store.loadProgress(for: trip) else {
      return XCTFail("no checkpoint")
    }
    XCTAssertTrue(onDisk.isArrivalDeferred)

    let restored = NavigationSession()
    try restored.start(trip, resume: .progress(onDisk))
    for second in 5...10 {
      let update = try restored.updateLocation(
        Trace.sample(x: 0, y: 1_000, speed: 0, time: Double(second)))
      XCTAssertEqual(update.snapshot.phase, .tracking, "fix at \(second)")
    }
  }

  /// The write cadence itself: the first eligible fix, then every fifteen seconds, not later
  /// because the wall clock was set back, and at once when the deferral changes either way.
  func testCheckpointCadence() {
    let start = Date(timeIntervalSinceReferenceDate: 800_000_000)
    let plain = Self.progress(100, time: 0)
    let deferred = Self.progress(100, time: 0, deferredAt: 100)
    func due(_ progress: NavigationResumeContext, after seconds: TimeInterval,
      last: NavigationResumeContext? = Self.progress(100, time: 0)) -> Bool
    {
      navOSSShouldPersistProgress(
        progress, lastPersisted: last, now: start.addingTimeInterval(seconds),
        lastPersistedAt: start)
    }
    XCTAssertTrue(
      navOSSShouldPersistProgress(plain, lastPersisted: nil, now: start, lastPersistedAt: nil))
    XCTAssertFalse(due(plain, after: 0))
    XCTAssertFalse(due(plain, after: 14.9))
    XCTAssertTrue(due(plain, after: 15))
    XCTAssertTrue(due(plain, after: -3_600))
    XCTAssertTrue(due(deferred, after: 1))
    XCTAssertFalse(due(deferred, after: 1, last: deferred))
    XCTAssertTrue(due(plain, after: 1, last: deferred))
  }

  /// Review finding: restoring restarted a deferred arrival at the checkpoint, with a 35 m
  /// uncertainty, discarding the movement already seen. A jump landed 100 m before the
  /// destination of an out-and-back (after ten minutes, so the travel was possible); the
  /// vehicle drove 40 m and the trip was saved; after the relaunch it drives the last 60 m and
  /// stops. Uninterrupted, that arrives. Restored, it waited forever: the reset deferral needed
  /// more ground than was left.
  func testARestoredDeferralKeepsWhereItStartedWaiting() throws {
    let (store, defaults, suite) = try Self.store()
    defer { defaults.removePersistentDomain(forName: suite) }
    let trip = Self.trip(Self.outAndBack)
    let uninterrupted = NavigationSession()
    try uninterrupted.start(trip)
    _ = try uninterrupted.updateLocation(Trace.sample(x: 0, y: 0, speed: 0, time: 0))
    _ = try uninterrupted.updateLocation(Trace.sample(x: 400, y: 100, speed: 0, time: 600))
    _ = try uninterrupted.updateLocation(Trace.sample(x: 400, y: 100, speed: 0, time: 601))
    XCTAssertEqual(
      try XCTUnwrap(uninterrupted.resumeContext).arrivalDeferral?.alongMeters ?? 0, 6_300,
      accuracy: 1)
    var second = 602.0
    for y in [90.0, 80, 70, 60] {
      _ = try uninterrupted.updateLocation(
        Trace.sample(x: 400, y: y, courseDegrees: 180, speed: 10, time: second))
      second += 1
    }
    XCTAssertEqual(uninterrupted.resumeContext?.isArrivalDeferred, true)
    let saved = try XCTUnwrap(uninterrupted.resumeContext)
    let restored = try Self.relaunch(uninterrupted, trip, store: store)

    var continuing = uninterrupted.currentUpdate()
    var resumed = restored.currentUpdate()
    for y in [50.0, 40, 30, 20, 10, 0, 0, 0, 0, 0] {
      let sample = Trace.sample(
        x: 400, y: y, courseDegrees: y > 0 ? 180 : nil, speed: y > 0 ? 10 : 0, time: second)
      continuing = try uninterrupted.updateLocation(sample)
      resumed = try restored.updateLocation(sample)
      second += 1
    }
    XCTAssertEqual(continuing.snapshot.phase, .arrived)
    XCTAssertEqual(resumed.snapshot.phase, .arrived)

    // Review finding: with the same checkpoint's capture time unusable (in the future after
    // the clock was set back, or missing), the first fix moved the deferral's origin on 50 m,
    // leaving less road than clearing it needs, and the trip never arrived. The saved origin is
    // kept, and the last 60 m still arrive.
    let origin = try XCTUnwrap(saved.arrivalDeferral).alongMeters
    for (label, savedTime) in [("future", Trace.time(5_000)), ("missing", nil)]
      as [(String, TimeInterval?)]
    {
      let unusable = NavigationResumeContext(
        alongMeters: saved.alongMeters, highWaterAlongMeters: saved.highWaterAlongMeters,
        uncertaintyMeters: saved.uncertaintyMeters, timestamp: savedTime,
        speedMetersPerSecond: saved.speedMetersPerSecond, arrivalDeferral: saved.arrivalDeferral)
      let clockMoved = NavigationSession()
      try clockMoved.start(trip, resume: .progress(unusable))
      var update = clockMoved.currentUpdate()
      var time = 20.0
      for (index, y) in [50.0, 40, 30, 20, 10, 0, 0, 0, 0, 0].enumerated() {
        update = try clockMoved.updateLocation(
          Trace.sample(
            x: 400, y: y, courseDegrees: y > 0 ? 180 : nil, speed: y > 0 ? 10 : 0, time: time))
        if index == 0 {
          XCTAssertEqual(
            try XCTUnwrap(clockMoved.resumeContext?.arrivalDeferral).alongMeters, origin,
            accuracy: 0.01, label)
        }
        time += 1
      }
      XCTAssertEqual(update.snapshot.phase, .arrived, label)
    }
  }

  /// A jump onto the destination is believed but does not arrive until the vehicle moves.
  /// That is still true after the app is relaunched there, and driving in then does arrive.
  func testAnArrivalStillWaitingForMovementSurvivesARestore() throws {
    let (store, defaults, suite) = try Self.store()
    defer { defaults.removePersistentDomain(forName: suite) }
    let original = Self.trip(Self.outAndBack)
    let before = NavigationSession()
    try before.start(original)
    _ = try before.updateLocation(Trace.sample(x: 0, y: 0, speed: 0, time: 0))
    XCTAssertEqual(before.resumeContext?.isArrivalDeferred, false)
    var update = before.currentUpdate()
    for second in 600...615 {
      update = try before.updateLocation(
        Trace.sample(x: 400, y: 0, speed: 0, time: Double(second))
      )
      XCTAssertEqual(update.snapshot.phase, .tracking)
    }
    XCTAssertTrue(navOSSIsProgressCheckpoint(update.snapshot))
    XCTAssertEqual(before.resumeContext?.isArrivalDeferred, true)

    let restored = try Self.relaunch(before, original, store: store)
    for second in 620...630 {
      update = try restored.updateLocation(
        Trace.sample(x: 400, y: 0, speed: 0, time: Double(second))
      )
      XCTAssertEqual(update.snapshot.phase, .tracking, "fix at \(second)")
    }
    XCTAssertEqual(restored.resumeContext?.isArrivalDeferred, true)

    // Driving in from 100 m out, on a trip restored there, arrives.
    store.saveProgress(
      Self.progress(6_300, time: Trace.time(15), deferredAt: 6_300), forTripId: original.id)
    let driven = NavigationSession()
    try driven.start(original, resume: store.loadProgress(for: original))
    var time = 20.0
    for y in stride(from: 100.0, through: 0, by: -10) + [0, 0] {
      update = try driven.updateLocation(
        Trace.sample(x: 400, y: y, courseDegrees: 180, speed: y > 0 ? 10 : 0, time: time)
      )
      time += 1
    }
    XCTAssertEqual(update.snapshot.phase, .arrived)
    XCTAssertNil(driven.resumeContext)
  }

  // MARK: Capture times that cannot be used

  /// Review finding: a saved capture time later than the first fix (the clock was set back
  /// while the app was not running) allowed no travel at all, so the vehicle on the return
  /// carriageway of a divided road, heading home, was "off the route" and the trip was dropped.
  /// A missing capture time did the same. With a capture time that is merely old (580 s at the
  /// reported 10 m/s, time enough to drive round) the heading takes the vehicle to the return
  /// carriageway. With one that cannot be used there is no such evidence either way, so the
  /// trip is placed again from the fresh fixes, which fit only the return carriageway: it is
  /// kept, and arrival waits for movement in every case. The same road still continues.
  func testACaptureTimeThatCannotBeUsedIsNoElapsedTime() throws {
    let trip = Self.trip(Self.dividedRoad)
    for (label, savedTime) in [
      ("stale", Trace.time(-580)), ("future", Trace.time(3_600)), ("missing", nil),
    ] as [(String, TimeInterval?)] {
      let returning = NavigationSession()
      try returning.start(
        trip, resume: .progress(Self.progress(500, time: savedTime, speed: 10)))
      var update = returning.currentUpdate()
      for second in 0...3 {
        update = try returning.updateLocation(
          Trace.sample(
            x: 200, y: 500 - Double(second) * 10, courseDegrees: 180, speed: 10,
            time: Double(second)))
        XCTAssertNotEqual(Self.decision(update), .discard, "\(label) at \(second)")
      }
      XCTAssertEqual(Self.decision(update), .publish, label)
      XCTAssertEqual(along(update.snapshot, returning), 5_730, accuracy: 15, label)
      XCTAssertEqual(returning.resumeContext?.isArrivalDeferred, true, label)

      let sameRoad = NavigationSession()
      try sameRoad.start(
        trip, resume: .progress(Self.progress(500, time: savedTime, speed: 10)))
      let continuing = try sameRoad.updateLocation(
        Trace.sample(x: 0, y: 520, courseDegrees: 0, speed: 10, time: 0))
      XCTAssertEqual(Self.decision(continuing), .publish, label)
      XCTAssertEqual(along(continuing.snapshot, sameRoad), 520, accuracy: 5, label)

      // Fitting no pass at all is still leaving the route.
      let astray = NavigationSession()
      try astray.start(
        trip, resume: .progress(Self.progress(500, time: savedTime, speed: 10)))
      let away = try astray.updateLocation(
        Trace.sample(x: 100, y: 1_500, courseDegrees: 0, speed: 10, time: 0))
      XCTAssertEqual(Self.decision(away), .discard, label)
    }
  }

  // MARK: Progress that cannot be used

  /// Review finding: a progress record in an earlier development shape (no deferral field)
  /// was read as "arrival not deferred", and a restored trip whose jump had landed on the
  /// destination arrived on stationary fixes. Records not in the current format are not read:
  /// the trip resumes from its first fix with arrival waiting for movement.
  func testAProgressRecordInAnotherFormatDoesNotLetARestoredTripArrive() throws {
    let (store, defaults, suite) = try Self.store()
    defer { defaults.removePersistentDomain(forName: suite) }
    let trip = Self.trip(Self.outAndBack)
    store.save(trip)
    for record in [
      #"{"alongMeters":6400,"tripId":"\#(trip.id)","recordedAt":800000002}"#,
      #"{"alongMeters":6400,"arrivalDeferred":false,"capturedAt":800000002,"tripId":"\#(trip.id)"}"#,
      #"{"format":1,"alongMeters":6400,"highWaterAlongMeters":6400,"uncertaintyMeters":5,"tripId":"\#(trip.id)"}"#,
      "not progress",
    ] {
      defaults.set(Data(record.utf8), forKey: Self.progressKey)
      XCTAssertEqual(store.loadProgress(for: trip), .unusable, record)
      let restored = NavigationSession()
      try restored.start(trip, resume: store.loadProgress(for: trip))
      var update = restored.currentUpdate()
      for second in 0...6 {
        update = try restored.updateLocation(
          Trace.sample(x: 400, y: 0, speed: 0, time: Double(second)))
        XCTAssertEqual(update.snapshot.phase, .tracking, record)
      }
      // Driving in does arrive.
      let driven = NavigationSession()
      try driven.start(trip, resume: store.loadProgress(for: trip))
      var time = 0.0
      for y in stride(from: 100.0, through: 0, by: -10) + [0, 0] {
        update = try driven.updateLocation(
          Trace.sample(x: 400, y: y, courseDegrees: 180, speed: y > 0 ? 10 : 0, time: time))
        time += 1
      }
      XCTAssertEqual(update.snapshot.phase, .arrived, record)
    }
  }

  /// A trip saved without progress (main's records, written before progress was) is placed
  /// by its first fix. Where that fix fits more than one pass, as at the shared start and end
  /// of a loop, and the vehicle stands still, the pass is unknown: nothing is guided or saved
  /// from it. Moving tells the passes apart: away from where they meet, or by a heading that
  /// opposes one and agrees with the other.
  func testATripRestoredWithoutProgressWaitsUntilItsPassIsKnown() throws {
    let (store, defaults, suite) = try Self.store()
    defer { defaults.removePersistentDomain(forName: suite) }
    let trip = Self.trip(Self.longLoop)
    store.save(trip)
    XCTAssertEqual(store.loadProgress(for: trip), .withoutProgress)

    let parked = NavigationSession()
    try parked.start(trip, resume: .withoutProgress)
    for second in 0...10 {
      let update = try parked.updateLocation(
        Trace.sample(x: 20, y: 0, speed: 0, time: Double(second)))
      XCTAssertNotNil(update.snapshot.matchedCoordinate)
      XCTAssertFalse(update.snapshot.isPassConfirmed)
      XCTAssertEqual(Self.decision(update), .wait, "fix at \(second)")
      XCTAssertFalse(navOSSIsProgressCheckpoint(update.snapshot))
    }

    // Heading west along the last leg: only the end of the trip agrees.
    let leaving = NavigationSession()
    try leaving.start(trip, resume: .withoutProgress)
    let west = try leaving.updateLocation(
      Trace.sample(x: 40, y: 0, courseDegrees: 270, speed: 10, time: 0))
    XCTAssertTrue(west.snapshot.isPassConfirmed)
    XCTAssertEqual(Self.decision(west), .publish)
    XCTAssertEqual(along(west.snapshot, leaving), 11_960, accuracy: 5)

    // Heading north from the start: the first leg, confirmed once only it fits.
    let starting = NavigationSession()
    try starting.start(trip, resume: .withoutProgress)
    var update = starting.currentUpdate()
    var confirmedAt: Double?
    for second in 0...10 {
      update = try starting.updateLocation(
        Trace.sample(x: 0, y: Double(second) * 10, speed: 2, time: Double(second)))
      if confirmedAt == nil, update.snapshot.isPassConfirmed {
        confirmedAt = along(update.snapshot, starting)
      }
    }
    XCTAssertEqual(Self.decision(update), .publish)
    XCTAssertLessThan(try XCTUnwrap(confirmedAt), 120)
    XCTAssertEqual(along(update.snapshot, starting), 100, accuracy: 5)

    // A single pass at the destination is known at once, and arrives as before.
    let outAndBack = Self.trip(Self.outAndBack)
    let atDestination = NavigationSession()
    try atDestination.start(outAndBack, resume: .withoutProgress)
    for second in 0...1 {
      update = try atDestination.updateLocation(
        Trace.sample(x: 400, y: 0, speed: 0, time: Double(second)))
    }
    XCTAssertEqual(update.snapshot.phase, .arrived)
  }

  // MARK: The record

  /// What a checkpoint holds: distances along the route, a capture time and a speed. Before
  /// the first fix there is nothing to resume from, and a held fix changes nothing in it.
  func testTheCheckpointIsTheConfirmedProgressOfTheAcceptedFix() throws {
    let session = NavigationSession()
    XCTAssertNil(session.resumeContext)
    try session.start(Self.trip(Self.dividedRoad))
    XCTAssertNil(session.resumeContext)
    _ = try session.updateLocation(
      Trace.sample(x: 0, y: 500, courseDegrees: 0, speed: 10, time: 7)
    )
    let accepted = try XCTUnwrap(session.resumeContext)
    XCTAssertEqual(accepted.alongMeters, 500, accuracy: 0.01)
    XCTAssertEqual(accepted.highWaterAlongMeters, 500, accuracy: 0.01)
    XCTAssertEqual(accepted.uncertaintyMeters, 5, accuracy: 0.01)
    XCTAssertEqual(accepted.timestamp, Trace.time(7))
    XCTAssertEqual(accepted.speedMetersPerSecond, 10)
    XCTAssertNil(accepted.arrivalDeferral)
    let held = try session.updateLocation(Trace.sample(x: 0, y: 2_500, speed: 0, time: 8))
    XCTAssertTrue(navOSSIsProgressCheckpoint(held.snapshot))
    XCTAssertEqual(session.resumeContext, accepted)
    session.clear()
    XCTAssertNil(session.resumeContext)
  }

  /// The progress record is part of the trip: it goes when the trip expires, when the trip
  /// cannot be read, and is never taken from a record that is damaged or another trip's.
  /// Records written by main (a trip and no progress) still resume; build 70's key does not.
  func testTheProgressRecordLivesAndDiesWithItsTrip() throws {
    var now = Date(timeIntervalSinceReferenceDate: 800_000_000)
    let (store, defaults, suite) = try Self.store(clock: { now })
    defer { defaults.removePersistentDomain(forName: suite) }
    let key = "org.navoss.mobile.active-navigation-trip.v2"
    let trip = Self.trip(Self.longLoop)
    let checkpoint = Self.progress(1_200, time: Trace.time(3), speed: 12)

    store.save(trip)
    store.saveProgress(checkpoint, forTripId: trip.id)
    let fields = try XCTUnwrap(
      JSONSerialization.jsonObject(with: try XCTUnwrap(defaults.data(forKey: Self.progressKey)))
        as? [String: Any]
    ).keys.sorted()
    XCTAssertEqual(
      fields,
      ["alongMeters", "capturedAt", "format", "highWaterAlongMeters", "speedMetersPerSecond",
        "tripId", "uncertaintyMeters"])
    now.addTimeInterval(12 * 60 * 60 - 1)
    XCTAssertNotNil(store.load())
    XCTAssertEqual(store.loadProgress(for: trip), .progress(checkpoint))
    now.addTimeInterval(1)
    XCTAssertNil(store.load(), "expired at twelve hours")
    XCTAssertNil(defaults.object(forKey: key))
    XCTAssertNil(defaults.object(forKey: Self.progressKey), "the progress record expires too")

    // A trip record that cannot be read takes its progress with it.
    store.save(trip)
    store.saveProgress(checkpoint, forTripId: trip.id)
    defaults.set(Data("not a trip".utf8), forKey: key)
    XCTAssertNil(store.load())
    XCTAssertNil(defaults.object(forKey: Self.progressKey))

    // Values that cannot be progress are not saved, and not read.
    store.save(trip)
    store.saveProgress(Self.progress(-5, time: nil), forTripId: trip.id)
    XCTAssertEqual(store.loadProgress(for: trip), .withoutProgress)
    for damaged in [
      #"{"format":2,"alongMeters":-5,"highWaterAlongMeters":0,"uncertaintyMeters":5,"tripId":"\#(trip.id)"}"#,
      #"{"format":2,"alongMeters":100,"highWaterAlongMeters":50,"uncertaintyMeters":5,"tripId":"\#(trip.id)"}"#,
      #"{"format":2,"alongMeters":100,"highWaterAlongMeters":100,"uncertaintyMeters":5,"speedMetersPerSecond":90,"tripId":"\#(trip.id)"}"#,
      #"{"format":2,"alongMeters":100,"highWaterAlongMeters":100,"uncertaintyMeters":5,"tripId":"other"}"#,
    ] {
      defaults.set(Data(damaged.utf8), forKey: Self.progressKey)
      XCTAssertEqual(store.loadProgress(for: trip), .unusable, damaged)
    }
    // The current format, as written, reads back, capture time and speed included or not.
    defaults.set(
      Data(
        #"{"format":2,"alongMeters":100,"highWaterAlongMeters":120,"uncertaintyMeters":7,"tripId":"\#(trip.id)"}"#
          .utf8),
      forKey: Self.progressKey)
    XCTAssertEqual(
      store.loadProgress(for: trip),
      .progress(
        NavigationResumeContext(
          alongMeters: 100, highWaterAlongMeters: 120, uncertaintyMeters: 7, timestamp: nil,
          speedMetersPerSecond: nil, arrivalDeferral: nil)))

    // Main's record: the trip, as encoded, and no progress.
    store.clear()
    defaults.set(
      try JSONSerialization.data(withJSONObject: [
        "expiresAt": now.timeIntervalSinceReferenceDate + 3_600,
        "trip": try JSONSerialization.jsonObject(with: JSONEncoder().encode(trip)),
      ]),
      forKey: key)
    let mainTrip = try XCTUnwrap(store.load())
    XCTAssertEqual(store.loadProgress(for: mainTrip), .withoutProgress)

    // A trip saved by build 70, under its own key, is not restored at all.
    let build70 = NavOSSActiveTripStore(
      defaults: defaults, key: "org.navoss.mobile.active-navigation-trip", clock: { now })
    store.clear()
    build70.save(trip)
    XCTAssertNil(store.load())
  }

  /// A checkpoint is written for the trip the store holds now. One that arrives after the trip
  /// was cleared or replaced by another trip is dropped. (A new route for the same trip keeps
  /// its identifier; the service orders checkpoints against those under its own lock.)
  func testACheckpointForATripTheStoreNoLongerHoldsIsDropped() throws {
    let (store, defaults, suite) = try Self.store()
    defer { defaults.removePersistentDomain(forName: suite) }
    let first = Self.trip(Self.longLoop, id: "first")
    let second = Self.trip(Self.longLoop, id: "second")
    let late = Self.progress(900, time: Trace.time(0))

    store.save(first)
    store.clear()
    store.saveProgress(late, forTripId: first.id)
    XCTAssertEqual(store.loadProgress(for: first), .withoutProgress, "after clear")

    store.save(first)
    store.save(second)
    store.saveProgress(Self.progress(50, time: Trace.time(1)), forTripId: second.id)
    store.saveProgress(late, forTripId: first.id)
    XCTAssertEqual(
      store.loadProgress(for: second), .progress(Self.progress(50, time: Trace.time(1))),
      "after a restart")

    // A store that has not loaded or saved a trip in this process holds none.
    let fresh = NavOSSActiveTripStore(defaults: defaults)
    fresh.saveProgress(late, forTripId: second.id)
    XCTAssertEqual(store.loadProgress(for: second), .progress(Self.progress(50, time: Trace.time(1))))
    XCTAssertNotNil(fresh.load())
    fresh.saveProgress(late, forTripId: second.id)
    XCTAssertEqual(store.loadProgress(for: second), .progress(late))
  }

  // MARK: What a restored trip shows

  /// Saved at 400 m; the vehicle is on the last leg when the app comes back. The first fix is
  /// held, so the session still stands at the step it was saved on: the decision waits, and
  /// what every surface reads in the meantime carries no guidance from it.
  func testARestoredTripIsNotGuidedUntilAFixIsMatched() throws {
    let corners: [(Double, Double)] = [(0, 0), (0, 800), (900, 800), (900, 1_700)]
    let trip = Self.trip(corners)
    let session = NavigationSession()
    let started = try session.start(
      trip, resume: .progress(Self.progress(400, time: Trace.time(0))))
    XCTAssertEqual(started.guidance?.stepIndex, 0)
    let held = try session.updateLocation(
      Trace.sample(x: 900, y: 1_000, courseDegrees: 0, speed: 10, time: 3_600)
    )
    XCTAssertEqual(held.snapshot.distanceFromRouteMeters ?? .infinity, 0, accuracy: 1)
    XCTAssertFalse(held.snapshot.isOffRoute)
    XCTAssertEqual(held.guidance?.stepIndex, 0, "the session still stands where it was saved")
    XCTAssertEqual(Self.decision(held), .wait)
    XCTAssertFalse(navOSSIsProgressCheckpoint(held.snapshot))

    // What `getSnapshot`, change events and CarPlay's live guidance read while it waits.
    let state = NavOSSNavigationServiceState(
      guidance: held.guidance,
      navigation: held.snapshot,
      rerouteCount: 0,
      rerouteMode: .adaptive,
      rerouteProposal: nil,
      roadContext: NavigationRoadContext(currentRoadName: "Road 0", speedLimitKph: 50),
      routeStatus: .tracking,
      safetyCameraAlert: nil,
      speedingState: .withinLimit,
      stateVersion: 7,
      trip: trip,
      tripEndReason: nil
    ).acquiringRestoredTrip()
    XCTAssertNotNil(held.guidance)
    XCTAssertTrue(state.isAcquiringPosition)
    XCTAssertNil(state.guidance)
    XCTAssertEqual(state.roadContext, .unknown)
    XCTAssertEqual(state.speedingState, .unknown)
    XCTAssertNil(state.navigation.matchedCoordinate)
    XCTAssertEqual(state.navigation.routeProgress, 0)
    XCTAssertEqual(state.navigation.rawCoordinate, held.snapshot.rawCoordinate)
    XCTAssertEqual(state.navigation.phase, .tracking)
    XCTAssertEqual(state.trip?.id, trip.id)
    XCTAssertEqual(state.stateVersion, 7)

    let matched = try session.updateLocation(
      Trace.sample(x: 900, y: 1_010, courseDegrees: 0, speed: 10, time: 3_601)
    )
    XCTAssertEqual(Self.decision(matched), .publish)
    XCTAssertEqual(matched.guidance?.stepIndex, 2)
    XCTAssertTrue(navOSSIsProgressCheckpoint(matched.snapshot))

    // Somewhere off the route, the restored trip is dropped, as before.
    let elsewhere = NavigationSession()
    try elsewhere.start(trip, resume: .progress(Self.progress(400, time: Trace.time(0))))
    XCTAssertEqual(
      Self.decision(
        try elsewhere.updateLocation(Trace.sample(x: 500, y: 300, speed: 0, time: 3_600))),
      .discard
    )
  }

  /// What a checkpoint is written from.
  func testOnlyAMatchedFixOnTheRouteIsACheckpoint() throws {
    let core = NavigationCore()
    try core.setRoute(Trace.route(Self.dividedRoad))
    XCTAssertFalse(navOSSIsProgressCheckpoint(core.currentSnapshot()))
    let accepted = try core.updateLocation(
      Trace.sample(x: 0, y: 100, courseDegrees: 0, speed: 10, time: 0)
    )
    XCTAssertTrue(navOSSIsProgressCheckpoint(accepted))
    XCTAssertFalse(navOSSIsProgressCheckpoint(try XCTUnwrap(core.deadReckon(at: Trace.time(3)))))
    var snapshot = accepted
    for second in 4...6 {
      snapshot = try core.updateLocation(
        Trace.sample(x: 100, y: 100, courseDegrees: 90, speed: 10, time: Double(second))
      )
    }
    XCTAssertTrue(snapshot.isOffRoute)
    XCTAssertFalse(navOSSIsProgressCheckpoint(snapshot))
  }

  // MARK: Asking for a route again

  /// A failed request for a replacement route is retried, less and less often.
  func testFailedRerouteRequestsBackOff() {
    XCTAssertEqual(
      (0...8).map { navigationRerouteRetryDelaySeconds(consecutiveFailures: $0) },
      [10, 10, 20, 40, 80, 120, 120, 120, 120]
    )
    XCTAssertEqual(navigationRerouteRetryDelaySeconds(consecutiveFailures: 1_000_000), 120)
  }

  // MARK: Untimed input is for replays

  func testLiveIngestionRefusesAFixWithoutACaptureTime() throws {
    XCTAssertThrowsError(try navOSSLiveNavigationFix(Trace.sample(x: 0, y: 0))) { error in
      XCTAssertEqual(error as? NavigationCoreError, .untimedLiveFix)
    }
    let timed = Trace.sample(x: 0, y: 0, time: 0)
    XCTAssertEqual(try navOSSLiveNavigationFix(timed), timed)
  }
}
