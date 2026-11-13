import Foundation
import XCTest

@testable import NavOSSNavigationCore

final class NavigationPolicyTests: XCTestCase {
  private func trip(id: String, duration: Double = 600, distance: Double = 8_000)
    -> NavOSSCarPlayTrip
  {
    NavOSSCarPlayTrip(
      destination: NavOSSCarPlayDestination(
        id: "d", label: "d", latitude: 51.05, longitude: -114.07, name: "d"
      ),
      distanceMeters: distance,
      durationSeconds: duration,
      geometry: [
        NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.08),
        NavOSSCarPlayCoordinate(latitude: 51.05, longitude: -114.07),
      ],
      id: id,
      steps: [
        NavOSSCarPlayRouteStep(
          distanceMeters: distance,
          durationSeconds: duration,
          geometry: [
            NavOSSCarPlayCoordinate(latitude: 51.04, longitude: -114.08),
            NavOSSCarPlayCoordinate(latitude: 51.05, longitude: -114.07),
          ],
          instruction: "Head north",
          maneuverType: "depart",
          roadName: "Centre Street"
        ),
      ]
    )
  }

  // MARK: - Reroute consent

  func testAdaptiveAndKeepRouteInstallReplacementsAndNeverActOnRoute() {
    for mode in [NavOSSRerouteMode.adaptive, .keepRoute] {
      var consent = NavigationRerouteConsent()
      XCTAssertEqual(consent.evaluate(mode: mode, isOffRoute: false, canRequest: true, now: 0), .none)
      XCTAssertEqual(consent.evaluate(mode: mode, isOffRoute: true, canRequest: true, now: 0), .request)
      XCTAssertEqual(
        consent.received(trip(id: "r"), mode: mode, remainingDurationSeconds: 500, remainingDistanceMeters: 7_000, now: 1),
        .install
      )
      XCTAssertNil(consent.proposal)
    }
  }

  func testAskFirstProposesWithImpactAndInstallsOnlyOnAcceptance() {
    var consent = NavigationRerouteConsent()
    XCTAssertEqual(consent.evaluate(mode: .askFirst, isOffRoute: true, canRequest: true, now: 0), .request)
    guard case .propose(let proposal) = consent.received(
      trip(id: "r", duration: 660, distance: 8_400),
      mode: .askFirst,
      remainingDurationSeconds: 600,
      remainingDistanceMeters: 8_000,
      now: 2,
      id: "p1"
    ) else {
      return XCTFail("ask-first must propose")
    }
    XCTAssertEqual(proposal.durationDeltaSeconds, 60)
    XCTAssertEqual(proposal.distanceDeltaMeters, 400)
    XCTAssertEqual(consent.evaluate(mode: .askFirst, isOffRoute: true, canRequest: true, now: 10), .none, "waiting on the driver")
    XCTAssertNil(consent.accept(id: "stale", now: 11))
    XCTAssertEqual(consent.accept(id: "p1", now: 12)?.id, "r")
    XCTAssertNil(consent.proposal)
  }

  func testAskFirstProposalIsWithdrawnWhenTheDriverReturnsToTheRoute() {
    var consent = NavigationRerouteConsent()
    _ = consent.evaluate(mode: .askFirst, isOffRoute: true, canRequest: true, now: 0)
    _ = consent.received(trip(id: "r"), mode: .askFirst, remainingDurationSeconds: nil, remainingDistanceMeters: nil, now: 1, id: "p1")
    XCTAssertEqual(consent.evaluate(mode: .askFirst, isOffRoute: false, canRequest: false, now: 5), .withdrew)
    XCTAssertNil(consent.accept(id: "p1", now: 6), "a withdrawn proposal cannot be installed")
  }

  /// A CarPlay-only driver may never answer. Staying off the selected route must still end in a
  /// fresh, installed recovery route rather than silence.
  func testUnansweredAskFirstProposalFallsBackToAFreshAutomaticRecovery() {
    var consent = NavigationRerouteConsent()
    _ = consent.evaluate(mode: .askFirst, isOffRoute: true, canRequest: true, now: 0)
    _ = consent.received(trip(id: "stale"), mode: .askFirst, remainingDurationSeconds: nil, remainingDistanceMeters: nil, now: 1, id: "p1")
    XCTAssertEqual(consent.evaluate(mode: .askFirst, isOffRoute: true, canRequest: true, now: 45), .none)
    XCTAssertEqual(consent.evaluate(mode: .askFirst, isOffRoute: true, canRequest: true, now: 46), .request)
    XCTAssertNil(consent.proposal, "the stale proposal is dropped, not installed")
    XCTAssertEqual(
      consent.received(trip(id: "fresh"), mode: .askFirst, remainingDurationSeconds: nil, remainingDistanceMeters: nil, now: 48),
      .install
    )
  }

  func testDeclineIsHonouredForACooldownThenOfferedAgain() {
    var consent = NavigationRerouteConsent()
    _ = consent.evaluate(mode: .askFirst, isOffRoute: true, canRequest: true, now: 0)
    _ = consent.received(trip(id: "r"), mode: .askFirst, remainingDurationSeconds: nil, remainingDistanceMeters: nil, now: 1, id: "p1")
    XCTAssertTrue(consent.decline(id: "p1", now: 5))
    XCTAssertFalse(consent.decline(id: "p1", now: 6))
    XCTAssertEqual(consent.evaluate(mode: .askFirst, isOffRoute: true, canRequest: true, now: 60), .none)
    XCTAssertEqual(consent.evaluate(mode: .askFirst, isOffRoute: true, canRequest: true, now: 96), .request)
  }

  func testSwitchingAwayFromAskFirstInstallsThePendingProposal() {
    var consent = NavigationRerouteConsent()
    _ = consent.evaluate(mode: .askFirst, isOffRoute: true, canRequest: true, now: 0)
    guard case .propose(let proposal) = consent.received(
      trip(id: "r"), mode: .askFirst, remainingDurationSeconds: nil, remainingDistanceMeters: nil, now: 1, id: "p1"
    ) else {
      return XCTFail("expected a proposal")
    }
    XCTAssertEqual(consent.evaluate(mode: .adaptive, isOffRoute: true, canRequest: true, now: 3), .installProposal(proposal))
  }

  func testKeepRouteRejoinsAheadAndNeverBehindOrPastTheEnd() {
    XCTAssertEqual(navigationKeepRouteRejoinAlongMeters(fixAlongMeters: 1_000, routeLengthMeters: 10_000), 1_800)
    XCTAssertNil(navigationKeepRouteRejoinAlongMeters(fixAlongMeters: 9_000, routeLengthMeters: 10_000))
  }

  // MARK: - Speeding

  func testSpeedingNeedsTwoFixesOverTheToleranceAndReleasesWithHysteresis() {
    var monitor = NavigationSpeedingMonitor()
    let preferences = NavOSSNavigationPreferences(speedingToleranceKph: 5)
    func update(_ kph: Double, limit: Int? = 60, at time: TimeInterval = 0) -> Bool {
      monitor.update(speedMetersPerSecond: kph / 3.6, speedLimitKph: limit, preferences: preferences, now: time)
    }
    _ = update(64)
    XCTAssertEqual(monitor.state, .withinLimit)
    _ = update(66)
    XCTAssertEqual(monitor.state, .withinLimit, "one fix over is not enough")
    _ = update(66)
    XCTAssertEqual(monitor.state, .overLimit)
    _ = update(63)
    XCTAssertEqual(monitor.state, .overLimit, "hovering near the threshold does not flicker")
    _ = update(61)
    XCTAssertEqual(monitor.state, .withinLimit)
    _ = update(90, limit: nil)
    XCTAssertEqual(monitor.state, .unknown, "no posted limit, no claim")
  }

  func testAudibleSpeedingWarningIsOptInOncePerEpisodeAndRateLimited() {
    var silent = NavigationSpeedingMonitor()
    let quiet = NavOSSNavigationPreferences(speedingToleranceKph: 0, speedingAudibleWarning: false)
    XCTAssertFalse(silent.update(speedMetersPerSecond: 30, speedLimitKph: 50, preferences: quiet, now: 0))
    XCTAssertFalse(silent.update(speedMetersPerSecond: 30, speedLimitKph: 50, preferences: quiet, now: 1))

    var monitor = NavigationSpeedingMonitor()
    let audible = NavOSSNavigationPreferences(speedingToleranceKph: 0, speedingAudibleWarning: true)
    func warn(_ kph: Double, at time: TimeInterval) -> Bool {
      monitor.update(speedMetersPerSecond: kph / 3.6, speedLimitKph: 50, preferences: audible, now: time)
    }
    XCTAssertFalse(warn(60, at: 0))
    XCTAssertTrue(warn(60, at: 1))
    XCTAssertFalse(warn(60, at: 2), "once per episode")
    XCTAssertFalse(warn(40, at: 3))
    XCTAssertFalse(warn(60, at: 10))
    XCTAssertFalse(warn(60, at: 11), "a new episode inside 60 s stays quiet")
    XCTAssertFalse(warn(40, at: 70))
    XCTAssertFalse(warn(60, at: 71))
    XCTAssertTrue(warn(60, at: 72))
    XCTAssertEqual(navigationSpeedingWarningText(speedLimitKph: 50), "Speed limit 50.")
  }

  // MARK: - Shared preferences

  func testNavigationPreferencesPersistClampAndNotify() throws {
    let suiteName = "NavigationPolicyTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let center = NotificationCenter()
    let store = NavOSSNavigationPreferencesStore(defaults: defaults, notificationCenter: center)
    XCTAssertEqual(store.load(), NavOSSNavigationPreferences())
    XCTAssertEqual(store.load().speedingToleranceKph, 5)

    var notifications = 0
    let observer = center.addObserver(
      forName: .navOSSNavigationPreferencesDidChange, object: store, queue: nil
    ) { _ in notifications += 1 }
    defer { center.removeObserver(observer) }

    store.setRerouteMode(.keepRoute)
    store.setSpeedingWarning(toleranceKph: 99, audible: true)
    let reloaded = NavOSSNavigationPreferencesStore(defaults: defaults, notificationCenter: center).load()
    XCTAssertEqual(reloaded.rerouteMode, .keepRoute)
    XCTAssertEqual(reloaded.speedingToleranceKph, 20)
    XCTAssertTrue(reloaded.speedingAudibleWarning)
    XCTAssertEqual(notifications, 2)

    defaults.set("sometimes", forKey: "org.navoss.mobile.navigation.reroute-mode")
    XCTAssertEqual(store.load().rerouteMode, .adaptive, "unknown stored values fall back safely")
  }

  // MARK: - Speech audio release

  func testUtteranceLedgerReleasesOnLastCompletion() {
    var ledger = NavOSSSpeechUtteranceLedger()
    // Keep the objects alive: identifiers of deallocated objects can be reused.
    let utterances = [NSObject(), NSObject()]
    let first = ObjectIdentifier(utterances[0])
    let second = ObjectIdentifier(utterances[1])
    ledger.begin(first, characterCount: 30, now: 0)
    ledger.begin(second, characterCount: 30, now: 0)
    XCTAssertFalse(ledger.complete(first, now: 3))
    XCTAssertFalse(ledger.complete(first, now: 3), "a duplicate callback cannot release early")
    XCTAssertTrue(ledger.complete(second, now: 6))
    XCTAssertTrue(ledger.isEmpty)
  }

  /// The build 70 report: music stayed ducked. If the synthesizer never reports an utterance
  /// finished, the ledger still lets the session go once it is overdue.
  func testUtteranceLedgerExpiresAnUtteranceTheSynthesizerNeverReported() {
    var ledger = NavOSSSpeechUtteranceLedger()
    let utterance = NSObject()
    let lost = ObjectIdentifier(utterance)
    ledger.begin(lost, characterCount: 40, now: 100)
    ledger.start(lost, now: 101)
    let deadline = 101 + 40 * NavOSSSpeechUtteranceLedger.secondsPerCharacter
      + NavOSSSpeechUtteranceLedger.speakingGraceSeconds
    XCTAssertEqual(ledger.nextDeadline, deadline)
    XCTAssertGreaterThan(deadline, 101 + 40 * 0.06, "never cuts off real speech")
    XCTAssertFalse(ledger.expireOverdue(now: deadline - 0.1))
    XCTAssertTrue(ledger.expireOverdue(now: deadline + 0.1))
    XCTAssertTrue(ledger.isEmpty)
    XCTAssertFalse(ledger.expireOverdue(now: deadline + 5), "nothing left to release twice")
  }

  func testUtteranceLedgerKeepsTheSessionWhileAnotherUtteranceIsStillDue() {
    var ledger = NavOSSSpeechUtteranceLedger()
    let utterances = [NSObject(), NSObject()]
    let lost = ObjectIdentifier(utterances[0])
    let current = ObjectIdentifier(utterances[1])
    ledger.begin(lost, characterCount: 10, now: 0)
    ledger.begin(current, characterCount: 10, now: 1)
    XCTAssertFalse(ledger.expireOverdue(now: 10), "the next utterance still holds the session")
    XCTAssertEqual(ledger.count, 1)
    XCTAssertTrue(ledger.complete(current, now: 11))
  }

  func testUtteranceStartingDropsAnythingTheSynthesizerSkipped() {
    var ledger = NavOSSSpeechUtteranceLedger()
    let utterances = [NSObject(), NSObject()]
    ledger.begin(ObjectIdentifier(utterances[0]), characterCount: 10, now: 0)
    ledger.begin(ObjectIdentifier(utterances[1]), characterCount: 10, now: 0)
    ledger.start(ObjectIdentifier(utterances[1]), now: 1)
    XCTAssertEqual(ledger.count, 1)
    XCTAssertTrue(ledger.complete(ObjectIdentifier(utterances[1]), now: 3))
  }
}
