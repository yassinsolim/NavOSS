import Foundation
import XCTest

@testable import NavOSSNavigationCore

final class AudioSessionOwnershipTests: XCTestCase {
  func testClaimRequiresProvenReleaseBeforeItStopsNeedingRelease() {
    var ownership = NavOSSAudioSessionOwnership()
    XCTAssertFalse(ownership.needsRelease)

    let epoch = ownership.claim()
    XCTAssertTrue(ownership.needsRelease)

    // A failed attempt (the old "finishCarPlayVoiceInput blindly clears the flag" bug) must
    // never be mistaken for a release: ownership stays claimed until success is proven.
    _ = ownership.releaseFailed(epoch: epoch)
    XCTAssertTrue(ownership.needsRelease)

    ownership.releaseSucceeded(epoch: epoch)
    XCTAssertFalse(ownership.needsRelease)
  }

  func testFailedReleaseNeverExhaustsPastTheOldFourAttemptBudget() {
    var ownership = NavOSSAudioSessionOwnership()
    let epoch = ownership.claim()

    // The previous implementation gave up permanently after 4 attempts (0.8s). Drive well past
    // that and confirm the model still asks for a retry every time instead of abandoning release.
    var delays: [TimeInterval] = []
    for _ in 0..<20 {
      guard case .retryAfter(let delay) = ownership.releaseFailed(epoch: epoch) else {
        XCTFail("release must keep retrying until it actually succeeds or a new owner claims it")
        return
      }
      delays.append(delay)
    }

    XCTAssertTrue(ownership.needsRelease, "20 failures must not silently abandon the release")
    XCTAssertEqual(delays.first, 0.2)
    XCTAssertEqual(delays.last, 3.0, "backoff must cap at maximumDelay instead of growing forever")
    XCTAssertTrue(delays.allSatisfy { $0 <= 3.0 })
  }

  func testStaleRetryFromAPriorClaimCannotActAgainstANewOwner() {
    var ownership = NavOSSAudioSessionOwnership()
    let firstEpoch = ownership.claim()
    _ = ownership.releaseFailed(epoch: firstEpoch)

    // A new owner (fresh guidance speech, or a new CarPlay recording lease) takes the session
    // before the scheduled retry for `firstEpoch` fires.
    let secondEpoch = ownership.claim()
    XCTAssertNotEqual(firstEpoch, secondEpoch)

    // The stale, already-scheduled retry closure fires with its captured old epoch.
    XCTAssertEqual(ownership.releaseFailed(epoch: firstEpoch), .stale)
    ownership.releaseSucceeded(epoch: firstEpoch)
    XCTAssertTrue(
      ownership.needsRelease,
      "a stale releaseSucceeded for the old epoch must not clear the new owner's claim"
    )

    // The current owner's own release still works normally.
    ownership.releaseSucceeded(epoch: secondEpoch)
    XCTAssertFalse(ownership.needsRelease)
  }

  func testReleaseFailedForAnEpochThatNeverClaimedIsStale() {
    var ownership = NavOSSAudioSessionOwnership()
    let neverClaimed = ownership.claim()
    ownership.releaseSucceeded(epoch: neverClaimed)

    XCTAssertEqual(ownership.releaseFailed(epoch: neverClaimed), .stale)
  }

  func testIsCurrentClaimIsTheAuthoritativeGuardBeforeTouchingTheRealSession() {
    var ownership = NavOSSAudioSessionOwnership()
    XCTAssertFalse(ownership.isCurrentClaim(ownership.epoch), "nothing is claimed yet")

    let firstEpoch = ownership.claim()
    XCTAssertTrue(ownership.isCurrentClaim(firstEpoch))

    // A caller (e.g. a scheduled release retry) must be able to check this *before* attempting
    // the real AVAudioSession.setActive(false) call, not only after via releaseSucceeded/Failed.
    let secondEpoch = ownership.claim()
    XCTAssertFalse(
      ownership.isCurrentClaim(firstEpoch),
      "a retry captured against the old epoch must refuse to act once superseded"
    )
    XCTAssertTrue(ownership.isCurrentClaim(secondEpoch))
  }
}
