import Foundation
import XCTest

@testable import NavOSSNavigationCore

/// Resuming a trip after a relaunch: where it had got to is saved beside the trip, and the
/// restored trip is matched from there instead of being placed anywhere on the route that fits.
/// Each test is a reproduction from the reviews of that change, or the case it must keep
/// working.
final class NavigationTripRestoreTests: XCTestCase {
  private typealias Trace = NavigationTrace

  private func along(_ snapshot: NavigationSnapshot, _ core: NavigationCore) -> Double {
    snapshot.routeProgress * (core.routeLengthMeters ?? 0)
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

  private static let dividedRoad: [(Double, Double)] = [
    (0, 0), (0, 3_000), (200, 3_000), (200, 0),
  ]

  // MARK: The first fix, and resuming a trip

  private static let longLoop: [(Double, Double)] = [
    (0, 0), (0, 3_000), (3_000, 3_000), (3_000, 0), (20, 0),
  ]

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

  /// A trip saved at its start and restored through the real store: a fix on the loop's end
  /// point is a fix 20 m from where the trip was, not the end of the trip.
  func testARestoredTripResumesFromItsSavedProgress() throws {
    let suite = "NavOSSMatcherEvidence.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let store = NavOSSActiveTripStore(defaults: defaults)
    let original = Self.trip(Self.longLoop)
    store.save(original)
    XCTAssertNil(store.loadProgress(for: original), "nothing saved yet, as from an older build")

    // Without saved progress the first fix is placed on the earliest pass.
    let unsaved = NavigationSession()
    try unsaved.start(try XCTUnwrap(store.load()), resume: store.loadProgress(for: original))
    for second in 1...3 {
      let update = try unsaved.updateLocation(
        Trace.sample(x: 20, y: 0, speed: 0, time: Double(second))
      )
      XCTAssertEqual(update.snapshot.phase, .tracking)
      XCTAssertLessThan(update.snapshot.routeProgress, 0.01)
    }

    // Saved half way round, on the far side: the restored trip is there, not at the start.
    store.saveProgress(
      NavigationResumeContext(alongMeters: 7_500, timestamp: Trace.time(0)),
      forTripId: original.id)
    let restoredTrip = try XCTUnwrap(store.load())
    let resume = try XCTUnwrap(store.loadProgress(for: restoredTrip))
    XCTAssertEqual(
      resume, NavigationResumeContext(alongMeters: 7_500, timestamp: Trace.time(0)))
    let restored = NavigationSession()
    let started = try restored.start(restoredTrip, resume: resume)
    XCTAssertEqual(started.snapshot.routeProgress * 11_980, 7_500, accuracy: 5)
    XCTAssertEqual(started.guidance?.stepIndex, 2)
    let first = try restored.updateLocation(
      Trace.sample(x: 3_000, y: 1_480, courseDegrees: 180, speed: 10, time: 5)
    )
    XCTAssertFalse(first.snapshot.isOffRoute)
    XCTAssertEqual(first.snapshot.routeProgress * 11_980, 7_520, accuracy: 5)

    // A first fix off the route on a resumed trip is a departure with no matched position: the
    // rejected projection is published only as the very first placement of a fresh route.
    let astray = NavigationSession()
    try astray.start(restoredTrip, resume: resume)
    let off = try astray.updateLocation(Trace.sample(x: 2_800, y: 1_500, speed: 0, time: 5))
    XCTAssertFalse(off.snapshot.isOffRoute)
    XCTAssertNil(off.snapshot.matchedCoordinate)
    XCTAssertEqual(off.snapshot.routeProgress * 11_980, 7_500, accuracy: 5)

    // Saved near the end, restored at the start/end point: still not an arrival from a fix
    // that also fits the start, and not a return to the start either.
    store.saveProgress(
      NavigationResumeContext(alongMeters: 11_900, timestamp: Trace.time(0)),
      forTripId: original.id)
    let nearEnd = NavigationSession()
    try nearEnd.start(restoredTrip, resume: store.loadProgress(for: restoredTrip))
    var update = nearEnd.currentUpdate()
    for (second, x) in [(1.0, 80.0), (2, 60), (3, 40), (4, 20), (5, 20), (6, 20)] {
      update = try nearEnd.updateLocation(
        Trace.sample(x: x, y: 0, courseDegrees: x > 20 ? 270 : nil, speed: x > 20 ? 20 : 0,
          time: second)
      )
    }
    XCTAssertEqual(update.snapshot.phase, .arrived)

    // Another trip's progress, and a replaced route, do not carry over.
    XCTAssertNil(store.loadProgress(for: Self.trip(Self.longLoop, id: "other")))
    store.save(original)
    XCTAssertNil(store.loadProgress(for: original))
    store.saveProgress(
      NavigationResumeContext(alongMeters: 100, timestamp: nil), forTripId: original.id)
    XCTAssertNotNil(store.loadProgress(for: original))
    store.clear()
    XCTAssertNil(store.loadProgress(for: original))
  }

  /// The start of the route is a checkpoint like any other. Without it the restored trip's
  /// first fix would be placed freely, and two fixes 44 m from the start of a loop end it.
  func testACheckpointAtTheStartOfTheRouteIsAnAnchor() throws {
    let (store, defaults, suite) = try Self.store()
    defer { defaults.removePersistentDomain(forName: suite) }
    let original = Self.trip(Self.longLoop)
    store.save(original)
    let before = NavigationSession()
    try before.start(original)
    _ = try before.updateLocation(Trace.sample(x: 0, y: 0, speed: 0, time: 0))
    let checkpoint = try XCTUnwrap(before.resumeContext)
    XCTAssertEqual(checkpoint.alongMeters, 0)
    store.saveProgress(checkpoint, forTripId: original.id)

    let restored = NavigationSession()
    try restored.start(try XCTUnwrap(store.load()), resume: store.loadProgress(for: original))
    for second in 1...4 {
      let update = try restored.updateLocation(
        Trace.sample(x: 44, y: 0, speed: 0, time: Double(second))
      )
      XCTAssertEqual(update.snapshot.phase, .tracking)
      XCTAssertEqual(update.snapshot.routeProgress, 0)
    }
  }

  /// A jump onto the destination is believed but does not arrive until the vehicle moves. That
  /// is still true after the app is relaunched there.
  func testAnArrivalStillWaitingForMovementSurvivesARestore() throws {
    let (store, defaults, suite) = try Self.store()
    defer { defaults.removePersistentDomain(forName: suite) }
    let corners: [(Double, Double)] = [(0, 0), (0, 3_000), (400, 3_000), (400, 0)]
    let original = Self.trip(corners)
    store.save(original)
    let before = NavigationSession()
    try before.start(original)
    _ = try before.updateLocation(Trace.sample(x: 0, y: 0, speed: 0, time: 0))
    XCTAssertEqual(before.resumeContext?.isArrivalDeferred, false)
    var update = before.currentUpdate()
    for second in 1...15 {
      update = try before.updateLocation(
        Trace.sample(x: 400, y: 0, speed: 0, time: Double(second))
      )
      XCTAssertEqual(update.snapshot.phase, .tracking)
    }
    XCTAssertTrue(navOSSIsProgressCheckpoint(update.snapshot))
    let checkpoint = try XCTUnwrap(before.resumeContext)
    XCTAssertTrue(checkpoint.isArrivalDeferred)
    store.saveProgress(checkpoint, forTripId: original.id)

    let resume = try XCTUnwrap(store.loadProgress(for: original))
    XCTAssertEqual(resume, checkpoint)
    let restored = NavigationSession()
    try restored.start(try XCTUnwrap(store.load()), resume: resume)
    for second in 20...30 {
      update = try restored.updateLocation(
        Trace.sample(x: 400, y: 0, speed: 0, time: Double(second))
      )
      XCTAssertEqual(update.snapshot.phase, .tracking, "fix at \(second)")
    }
    XCTAssertEqual(restored.resumeContext?.isArrivalDeferred, true)

    // Driving in from 100 m out, on a trip restored there, does arrive, and then there is
    // nothing left to resume.
    store.saveProgress(
      NavigationResumeContext(
        alongMeters: 6_300, timestamp: Trace.time(15), isArrivalDeferred: true),
      forTripId: original.id)
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

  /// What a checkpoint holds: a distance, a capture time and the deferral. Before the first
  /// fix there is nothing to resume from.
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
    XCTAssertEqual(accepted.timestamp, Trace.time(7))
    XCTAssertFalse(accepted.isArrivalDeferred)
    // A held fix changes nothing in it.
    let held = try session.updateLocation(Trace.sample(x: 0, y: 2_500, speed: 0, time: 8))
    XCTAssertTrue(navOSSIsProgressCheckpoint(held.snapshot))
    XCTAssertEqual(session.resumeContext, accepted)
    session.clear()
    XCTAssertNil(session.resumeContext)
  }

  /// The progress record is part of the trip: it goes when the trip expires, when the trip
  /// cannot be read, and it is never taken from a record that is damaged or another trip's.
  func testTheProgressRecordLivesAndDiesWithItsTrip() throws {
    let suite = "NavOSSMatcherEvidence.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let key = "org.navoss.mobile.active-navigation-trip.v2"
    var now = Date(timeIntervalSinceReferenceDate: 800_000_000)
    let store = NavOSSActiveTripStore(defaults: defaults, clock: { now })
    let trip = Self.trip(Self.longLoop)
    let checkpoint = NavigationResumeContext(alongMeters: 1_200, timestamp: Trace.time(3))

    store.save(trip)
    store.saveProgress(checkpoint, forTripId: trip.id)
    now.addTimeInterval(12 * 60 * 60 - 1)
    XCTAssertNotNil(store.load())
    XCTAssertEqual(store.loadProgress(for: trip), checkpoint)
    now.addTimeInterval(1)
    XCTAssertNil(store.load(), "expired at twelve hours")
    XCTAssertNil(defaults.object(forKey: key))
    XCTAssertNil(defaults.object(forKey: key + ".progress"), "the progress record expires with it")
    XCTAssertNil(store.loadProgress(for: trip))

    // A trip record that cannot be read takes its progress with it.
    store.save(trip)
    store.saveProgress(checkpoint, forTripId: trip.id)
    defaults.set(Data("not a trip".utf8), forKey: key)
    XCTAssertNil(store.load())
    XCTAssertNil(defaults.object(forKey: key + ".progress"))

    // Damaged progress, and progress with values that cannot be progress, are no progress.
    store.save(trip)
    for damaged in [
      "not progress", #"{"alongMeters":-5,"tripId":"\#(trip.id)"}"#,
      #"{"alongMeters":"far","tripId":"\#(trip.id)"}"#, #"{"alongMeters":100}"#,
    ] {
      defaults.set(Data(damaged.utf8), forKey: key + ".progress")
      XCTAssertNil(store.loadProgress(for: trip), damaged)
    }
    // A record with only what the first version of it wrote still resumes.
    defaults.set(
      Data(#"{"alongMeters":100,"tripId":"\#(trip.id)","recordedAt":0}"#.utf8),
      forKey: key + ".progress")
    XCTAssertEqual(
      store.loadProgress(for: trip), NavigationResumeContext(alongMeters: 100, timestamp: nil)
    )

    // A trip saved by build 70, under its own key, is not restored at all.
    let build70 = NavOSSActiveTripStore(
      defaults: defaults, key: "org.navoss.mobile.active-navigation-trip", clock: { now })
    store.clear()
    build70.save(trip)
    XCTAssertNil(store.load())
  }

  /// A checkpoint is written for the trip the store holds now. One that arrives after the trip
  /// was cleared, restarted or replaced is dropped: it cannot bring progress back or overwrite
  /// the new trip's.
  func testACheckpointForATripTheStoreNoLongerHoldsIsDropped() throws {
    let (store, defaults, suite) = try Self.store()
    defer { defaults.removePersistentDomain(forName: suite) }
    let first = Self.trip(Self.longLoop, id: "first")
    let second = Self.trip(Self.longLoop, id: "second")
    let late = NavigationResumeContext(alongMeters: 900, timestamp: Trace.time(0))

    store.save(first)
    store.clear()
    store.saveProgress(late, forTripId: first.id)
    XCTAssertNil(store.loadProgress(for: first), "after clear")

    store.save(first)
    store.save(second)
    store.saveProgress(
      NavigationResumeContext(alongMeters: 50, timestamp: Trace.time(1)), forTripId: second.id)
    store.saveProgress(late, forTripId: first.id)
    XCTAssertEqual(
      store.loadProgress(for: second),
      NavigationResumeContext(alongMeters: 50, timestamp: Trace.time(1)), "after a restart"
    )
    XCTAssertNil(store.loadProgress(for: first))

    // A store that has not loaded or saved a trip in this process holds none.
    let fresh = NavOSSActiveTripStore(defaults: defaults)
    fresh.saveProgress(late, forTripId: second.id)
    XCTAssertEqual(store.loadProgress(for: second)?.alongMeters, 50)
    XCTAssertNotNil(fresh.load())
    fresh.saveProgress(late, forTripId: second.id)
    XCTAssertEqual(store.loadProgress(for: second)?.alongMeters, 900)
  }

  /// Saved at 400 m; the vehicle is on the last leg when the app comes back. The first fix is
  /// held, so the trip still stands at the step it was saved on: nothing is published or
  /// spoken from it until a fix is matched.
  func testARestoredTripIsNotPublishedUntilAFixIsMatched() throws {
    let corners: [(Double, Double)] = [(0, 0), (0, 800), (900, 800), (900, 1_700)]
    let trip = Self.trip(corners)
    let session = NavigationSession()
    let started = try session.start(
      trip, resume: NavigationResumeContext(alongMeters: 400, timestamp: Trace.time(0)))
    XCTAssertEqual(started.guidance?.stepIndex, 0)
    func decision(_ update: NavigationSessionUpdate) -> NavOSSPersistedNavigationDecision {
      navOSSPersistedNavigationDecision(
        distanceFromRouteMeters: update.snapshot.distanceFromRouteMeters,
        horizontalAccuracyMeters: update.snapshot.horizontalAccuracyMeters,
        isOffRoute: update.snapshot.isOffRoute,
        isMatched: update.snapshot.matchedCoordinate != nil
      )
    }
    let held = try session.updateLocation(
      Trace.sample(x: 900, y: 1_000, courseDegrees: 0, speed: 10, time: 3_600)
    )
    XCTAssertEqual(held.snapshot.distanceFromRouteMeters ?? .infinity, 0, accuracy: 1)
    XCTAssertFalse(held.snapshot.isOffRoute)
    XCTAssertEqual(held.guidance?.stepIndex, 0, "the session still stands where it was saved")
    XCTAssertEqual(decision(held), .wait)
    XCTAssertFalse(navOSSIsProgressCheckpoint(held.snapshot))

    let matched = try session.updateLocation(
      Trace.sample(x: 900, y: 1_010, courseDegrees: 0, speed: 10, time: 3_601)
    )
    XCTAssertEqual(decision(matched), .publish)
    XCTAssertEqual(matched.guidance?.stepIndex, 2)
    XCTAssertTrue(navOSSIsProgressCheckpoint(matched.snapshot))

    // Somewhere off the route, the restored trip is dropped, as before.
    let elsewhere = NavigationSession()
    try elsewhere.start(
      trip, resume: NavigationResumeContext(alongMeters: 400, timestamp: Trace.time(0)))
    XCTAssertEqual(
      decision(
        try elsewhere.updateLocation(Trace.sample(x: 500, y: 300, speed: 0, time: 3_600))),
      .discard
    )
  }

  /// When a checkpoint is written: from the first eligible fix, then every fifteen seconds,
  /// and not later because the wall clock was set back.
  func testCheckpointsAreThrottledByAClockThatMayMoveBackward() {
    let start = Date(timeIntervalSinceReferenceDate: 800_000_000)
    XCTAssertTrue(navOSSShouldPersistProgress(now: start, lastPersistedAt: nil))
    XCTAssertFalse(navOSSShouldPersistProgress(now: start, lastPersistedAt: start))
    XCTAssertFalse(
      navOSSShouldPersistProgress(now: start.addingTimeInterval(14.9), lastPersistedAt: start)
    )
    XCTAssertTrue(
      navOSSShouldPersistProgress(now: start.addingTimeInterval(15), lastPersistedAt: start)
    )
    XCTAssertTrue(
      navOSSShouldPersistProgress(now: start.addingTimeInterval(-3_600), lastPersistedAt: start)
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

  private static func store() throws -> (NavOSSActiveTripStore, UserDefaults, String) {
    let suite = "NavOSSMatcherEvidence.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    return (NavOSSActiveTripStore(defaults: defaults), defaults, suite)
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
