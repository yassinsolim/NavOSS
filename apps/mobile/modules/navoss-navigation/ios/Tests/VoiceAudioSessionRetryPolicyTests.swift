import Foundation
import XCTest

@testable import NavOSSNavigationCore

final class VoiceAudioSessionRetryPolicyTests: XCTestCase {
  func testCarPlayRecordingClaimRetriesTwiceThenReportsFinalFailure() {
    let policy = NavOSSVoiceAudioSessionRetryPolicy.carPlayRecordingClaim

    XCTAssertEqual(policy.delay(afterFailedAttempt: 0), 0.15)
    XCTAssertEqual(policy.delay(afterFailedAttempt: 1), 0.3)
    XCTAssertNil(
      policy.delay(afterFailedAttempt: 2),
      "the 3rd failure must give up and let the coordinator show the real failure message"
    )
  }

  func testBackoffCapsAtMaximumDelayBeforeExhausting() {
    let policy = NavOSSVoiceAudioSessionRetryPolicy(
      maximumAttempts: 5,
      initialDelay: 0.1,
      maximumDelay: 0.25
    )

    XCTAssertEqual(policy.delay(afterFailedAttempt: 0), 0.1)
    XCTAssertEqual(policy.delay(afterFailedAttempt: 1), 0.2)
    XCTAssertEqual(policy.delay(afterFailedAttempt: 2), 0.25, "0.4 scaled must clamp to the cap")
    XCTAssertEqual(policy.delay(afterFailedAttempt: 3), 0.25)
    XCTAssertNil(policy.delay(afterFailedAttempt: 4))
  }
}
