import Foundation
import XCTest

@testable import NavOSSNavigationCore

#if canImport(AVFoundation)
  import AVFoundation
#endif

/// The driver-visible bug: after a prompt the audio session stayed live, so music stayed ducked
/// and the car's volume knob kept adjusting guidance. These drive the lifecycle the way
/// `NavOSSNavigationService` does and check what reaches the session, in order.
final class GuidanceAudioLifecycleTests: XCTestCase {
  private typealias Lifecycle = NavOSSGuidanceAudioLifecycle
  private typealias Effect = NavOSSGuidanceAudioLifecycle.Effect

  /// Plays the part of the service: carries out effects and answers them.
  private struct Driver {
    var lifecycle = Lifecycle()
    var now: TimeInterval = 1_000
    /// Every effect, in the order the service would carry it out.
    var log: [Effect] = []
    /// What the simulated `setActive(false)` returns, per call; `true` when exhausted.
    var deactivationResults: [Bool] = []
    var sessionActive = false
    var audioRunning = false
    /// Set when the session was deactivated while audio was still running: the condition that
    /// let the synthesizer's audio queue bring the session back.
    var deactivatedUnderRunningAudio = false
    /// Set when a deadline came due and firing the timer changed nothing.
    var timerStalled = false
    /// Whether the session is in the ducking voice-prompt category, as `.activate` leaves it.
    var categoryDucksMusic = false
    /// Whether the app's own `.activate` is in force.
    var activatedByApp = false
    /// Set when a render started on a session that would duck music with nothing to play yet.
    var duckedBeforeAudioWasReady = false
    /// Set when audio started without the app's activation.
    var soundedWithoutActivation = false
    /// Renders not yet answered, and prompts sounding, oldest first.
    var pendingRenders: [Lifecycle.PromptID] = []
    var sounding: [Lifecycle.PromptID] = []

    mutating func apply(_ effects: [Effect]) {
      for effect in effects {
        log.append(effect)
        switch effect {
        case .idleCategory:
          categoryDucksMusic = false
        case .activate:
          categoryDucksMusic = true
          activatedByApp = true
          sessionActive = true
        case .render(let id), .renderWarmUp(let id):
          // The synthesizer activates the app's session on its own when it starts a render.
          sessionActive = true
          if categoryDucksMusic, !activatedByApp { duckedBeforeAudioWasReady = true }
          pendingRenders.append(id)
        case .play(let id), .speakDirectly(let id):
          if !activatedByApp { soundedWithoutActivation = true }
          sessionActive = true
          audioRunning = true
          sounding.append(id)
        case .stopAudio:
          audioRunning = false
        case .deactivate:
          if audioRunning { deactivatedUnderRunningAudio = true }
          let succeeded = deactivationResults.isEmpty ? true : deactivationResults.removeFirst()
          if succeeded {
            sessionActive = false
            activatedByApp = false
          }
          lifecycle.deactivated(succeeded: succeeded, now: now)
        }
      }
    }

    @discardableResult
    mutating func speak(characters: Int = 40) -> Lifecycle.PromptID? {
      guard let (id, effects) = lifecycle.enqueue(characterCount: characters, now: now) else {
        return nil
      }
      apply(effects)
      return id
    }

    mutating func beginTrip() {
      apply(lifecycle.beginTrip(now: now))
    }

    mutating func rendered(_ id: Lifecycle.PromptID, seconds: TimeInterval? = 2.5) {
      pendingRenders.removeAll { $0 == id }
      apply(lifecycle.rendered(id, audioSeconds: seconds, now: now))
    }

    mutating func finished(_ id: Lifecycle.PromptID) {
      // A player that has finished is no longer running audio; a synthesizer that reported
      // didFinish still is.
      if log.contains(.play(id)) { audioRunning = false }
      sounding.removeAll { $0 == id }
      apply(lifecycle.finished(id, now: now))
    }

    /// Advances the clock, firing the timer at each deadline on the way.
    mutating func advance(_ seconds: TimeInterval) {
      let end = now + seconds
      while let deadline = lifecycle.nextDeadline, deadline <= end {
        now = max(now, deadline)
        let before = lifecycle
        apply(lifecycle.timerFired(now: now))
        if lifecycle == before {
          // A due deadline that changes nothing would spin the service's timer.
          timerStalled = true
          break
        }
      }
      now = end
    }

    var deactivations: [Lifecycle.DeactivationReason] {
      log.compactMap { if case .deactivate(let reason) = $0 { reason } else { nil } }
    }
  }

  // MARK: A prompt releases the session when its audio ends

  func testAPromptIsRenderedThenPlayedAndTheSessionIsReleasedWhenThePlayerFinishes() throws {
    var driver = Driver()
    let id = try XCTUnwrap(driver.speak())
    XCTAssertEqual(driver.log, [.idleCategory, .render(id)], "music is not ducked for a render")
    XCTAssertTrue(driver.lifecycle.owesRelease, "the synthesizer activates the session itself")

    driver.rendered(id)
    XCTAssertEqual(Array(driver.log.suffix(2)), [.activate, .play(id)])
    XCTAssertTrue(driver.sessionActive)
    XCTAssertFalse(driver.duckedBeforeAudioWasReady)

    driver.finished(id)
    XCTAssertEqual(
      Array(driver.log.suffix(2)), [.stopAudio, .deactivate(.promptsFinished)],
      "audio is stopped first, then the session is released, in the same turn")
    XCTAssertFalse(driver.sessionActive)
    XCTAssertFalse(driver.lifecycle.owesRelease)
    XCTAssertFalse(driver.deactivatedUnderRunningAudio)
  }

  func testTheSessionIsHeldAcrossQueuedPromptsAndReleasedOnceAfterTheLast() throws {
    var driver = Driver()
    let first = try XCTUnwrap(driver.speak())
    let second = try XCTUnwrap(driver.speak())
    driver.rendered(first)
    driver.finished(first)
    XCTAssertEqual(
      Array(driver.log.suffix(2)), [.play(first), .render(second)],
      "the held session keeps its category while the next prompt renders")
    XCTAssertTrue(driver.deactivations.isEmpty, "not released under the next prompt")

    driver.rendered(second)
    driver.finished(second)
    XCTAssertEqual(driver.deactivations, [.promptsFinished])
    XCTAssertEqual(driver.log.filter { $0 == .activate }.count, 1, "one activation for the batch")
    XCTAssertFalse(driver.sessionActive)
  }

  func testAPromptAfterAReleaseActivatesAgain() throws {
    var driver = Driver()
    let first = try XCTUnwrap(driver.speak())
    driver.rendered(first)
    driver.finished(first)
    driver.advance(0.3)

    let second = try XCTUnwrap(driver.speak())
    XCTAssertEqual(Array(driver.log.suffix(2)), [.idleCategory, .render(second)])
    driver.rendered(second, seconds: 10)
    XCTAssertEqual(Array(driver.log.suffix(2)), [.activate, .play(second)])
    driver.advance(5)
    XCTAssertEqual(
      driver.deactivations, [.promptsFinished],
      "the confirmation of the first release must not deactivate under the second prompt")
    XCTAssertTrue(driver.sessionActive)
  }

  // MARK: Nothing can bring the session back unnoticed

  /// The synthesizer activates the app's session itself, asynchronously, when it starts a
  /// prompt. If that lands after a quick cancel, only a second deactivation releases it.
  func testASuccessfulReleaseIsConfirmedOnceAfterASecond() throws {
    var driver = Driver()
    let id = try XCTUnwrap(driver.speak())
    driver.apply(driver.lifecycle.cancelAll(now: driver.now))
    XCTAssertEqual(driver.deactivations, [.cancelled])
    // The synthesizer's own activation arrives late.
    driver.sessionActive = true

    driver.advance(Lifecycle.confirmationDelaySeconds - 0.01)
    XCTAssertEqual(driver.deactivations, [.cancelled])
    driver.advance(0.02)
    XCTAssertEqual(driver.deactivations, [.cancelled, .confirmation])
    XCTAssertFalse(driver.sessionActive, "prompt \(id) left the session live")

    driver.advance(60)
    XCTAssertEqual(driver.deactivations.count, 2, "confirmed once, not forever")
    XCTAssertNil(driver.lifecycle.nextDeadline)
  }

  func testAFailedDeactivationIsRetriedUntilItSucceeds() throws {
    var driver = Driver()
    driver.deactivationResults = Array(repeating: false, count: 20)
    let id = try XCTUnwrap(driver.speak())
    driver.rendered(id)
    driver.finished(id)
    XCTAssertTrue(driver.sessionActive)
    XCTAssertTrue(driver.lifecycle.owesRelease)

    driver.advance(120)
    XCTAssertFalse(driver.sessionActive, "twenty failures must not abandon the release")
    XCTAssertFalse(driver.lifecycle.owesRelease)
    XCTAssertEqual(driver.deactivations.filter { $0 == .retry }.count, 20)
    XCTAssertEqual(driver.deactivations.last, .confirmation)
  }

  func testRetriesBackOffAndThenHold() throws {
    var driver = Driver()
    driver.deactivationResults = Array(repeating: false, count: 8)
    let id = try XCTUnwrap(driver.speak())
    driver.rendered(id)
    driver.finished(id)
    var delays: [TimeInterval] = []
    for _ in 0..<7 {
      let deadline = try XCTUnwrap(driver.lifecycle.nextDeadline)
      delays.append(deadline - driver.now)
      driver.advance(deadline - driver.now)
    }
    XCTAssertEqual(delays[0], 0.2, accuracy: 1e-9)
    XCTAssertEqual(delays[1], 0.4, accuracy: 1e-9)
    XCTAssertEqual(delays[6], 3.0, accuracy: 1e-9)
    XCTAssertTrue(delays.allSatisfy { $0 <= 3.0 + 1e-9 })
  }

  func testARetryDoesNotDeactivateUnderANewPrompt() throws {
    var driver = Driver()
    driver.deactivationResults = [false]
    let first = try XCTUnwrap(driver.speak())
    driver.rendered(first)
    driver.finished(first)

    let second = try XCTUnwrap(driver.speak())
    driver.rendered(second, seconds: 4)
    driver.advance(3)
    XCTAssertEqual(driver.deactivations, [.promptsFinished], "the new prompt owns the session")
    driver.finished(second)
    XCTAssertFalse(driver.sessionActive)
  }

  // MARK: Lost callbacks

  func testAPlayerThatNeverReportsIsBoundedByTheAudioLength() throws {
    var driver = Driver()
    let id = try XCTUnwrap(driver.speak())
    driver.rendered(id, seconds: 3)

    driver.advance(3 + Lifecycle.playbackGraceSeconds - 0.1)
    XCTAssertTrue(driver.deactivations.isEmpty, "never cuts a prompt that is still playing")
    driver.advance(0.2)
    XCTAssertEqual(driver.deactivations, [.promptsFinished])
    XCTAssertFalse(driver.sessionActive)
    XCTAssertFalse(driver.deactivatedUnderRunningAudio)
  }

  func testAQueuedPromptDoesNotExpireBeforeItsTurn() throws {
    var driver = Driver()
    let long = try XCTUnwrap(driver.speak())
    let short = try XCTUnwrap(driver.speak())
    driver.rendered(long, seconds: 30)
    driver.advance(20)
    XCTAssertFalse(driver.log.contains(.render(short)))
    driver.finished(long)
    XCTAssertEqual(driver.log.last, .render(short))
  }

  // MARK: Rendering unavailable

  func testAPromptThatRendersNothingIsSpokenDirectlyAndStillReleased() throws {
    var driver = Driver()
    let id = try XCTUnwrap(driver.speak())
    driver.rendered(id, seconds: nil)
    XCTAssertEqual(driver.log.last, .speakDirectly(id), "the driver still hears the prompt")

    // didFinish: the synthesizer's audio queue is still running.
    driver.finished(id)
    XCTAssertTrue(driver.deactivations.isEmpty, "not released at didFinish")
    driver.advance(Lifecycle.directTailSeconds + 0.01)
    XCTAssertEqual(Array(driver.log.suffix(2)), [.stopAudio, .deactivate(.promptsFinished)])
    XCTAssertFalse(driver.deactivatedUnderRunningAudio)
    XCTAssertFalse(driver.sessionActive)
  }

  func testRenderingThatNeverAnswersIsSpokenDirectlyWithinTheTimeout() throws {
    var driver = Driver()
    let id = try XCTUnwrap(driver.speak())
    driver.advance(Lifecycle.renderTimeoutSeconds - 0.01)
    XCTAssertFalse(driver.log.contains(.speakDirectly(id)))
    driver.advance(0.02)
    XCTAssertEqual(Array(driver.log.suffix(2)), [.activate, .speakDirectly(id)])
    XCTAssertLessThanOrEqual(
      Lifecycle.renderTimeoutSeconds, 1.5, "a turn prompt this late is a missed turn")
    // The late answer for the abandoned render changes nothing.
    driver.rendered(id)
    XCTAssertEqual(driver.log.last, .speakDirectly(id))
    driver.finished(id)
    driver.advance(Lifecycle.directTailSeconds + 0.01)
    XCTAssertFalse(driver.sessionActive)
  }

  func testANewTripRendersAgainAfterATripThatWentDirect() throws {
    var driver = Driver()
    for _ in 0..<Lifecycle.renderFailuresBeforeDirect {
      let id = try XCTUnwrap(driver.speak())
      driver.rendered(id, seconds: nil)
      driver.finished(id)
      driver.advance(5)
    }
    XCTAssertFalse(driver.lifecycle.rendersPrompts)

    driver.beginTrip()
    XCTAssertTrue(driver.lifecycle.rendersPrompts)
    let id = try XCTUnwrap(driver.speak())
    XCTAssertEqual(driver.log.last, .render(id))
  }

  // MARK: Warm-up

  func testATripStartLoadsTheVoiceWithoutSoundOrDucking() throws {
    var driver = Driver()
    driver.beginTrip()
    let warmUp = try XCTUnwrap(driver.pendingRenders.first)
    XCTAssertEqual(driver.log, [.idleCategory, .renderWarmUp(warmUp)])

    driver.rendered(warmUp, seconds: 0.6)
    XCTAssertEqual(
      driver.log, [.idleCategory, .renderWarmUp(warmUp), .stopAudio, .deactivate(.warmUp)],
      "the synthesizer activated the session for the render, so it is released")
    XCTAssertTrue(driver.sounding.isEmpty, "the warm-up is never played")
    XCTAssertFalse(driver.log.contains(.activate))
    XCTAssertFalse(driver.duckedBeforeAudioWasReady)
    XCTAssertFalse(driver.sessionActive)
  }

  func testAPromptDoesNotWaitBehindTheWarmUp() throws {
    var driver = Driver()
    driver.beginTrip()
    let warmUp = try XCTUnwrap(driver.pendingRenders.first)
    let id = try XCTUnwrap(driver.speak())
    XCTAssertEqual(Array(driver.log.suffix(3)), [.stopAudio, .idleCategory, .render(id)])

    // The abandoned warm-up answers late and must not count or play.
    driver.rendered(warmUp, seconds: nil)
    driver.rendered(id)
    XCTAssertEqual(driver.log.last, .play(id))
    XCTAssertTrue(driver.lifecycle.rendersPrompts)
  }

  func testAWarmUpThatNeverAnswersIsReleasedAndCountsAsOneFailure() throws {
    var driver = Driver()
    driver.beginTrip()
    driver.advance(Lifecycle.warmUpTimeoutSeconds + 0.01)
    XCTAssertEqual(driver.deactivations, [.warmUp])
    XCTAssertFalse(driver.sessionActive)
    XCTAssertTrue(driver.lifecycle.rendersPrompts, "one failure does not decide the trip")

    // The voice that could not warm up fails the first prompt too: found before the second.
    let first = try XCTUnwrap(driver.speak())
    driver.rendered(first, seconds: nil)
    XCTAssertEqual(driver.log.last, .speakDirectly(first))
    XCTAssertFalse(driver.lifecycle.rendersPrompts)
  }

  func testNoWarmUpWhileAPromptOrVoiceSearchHoldsTheSession() throws {
    var driver = Driver()
    let id = try XCTUnwrap(driver.speak())
    driver.beginTrip()
    XCTAssertEqual(driver.log, [.idleCategory, .render(id)])

    var capturing = Driver()
    capturing.apply(capturing.lifecycle.beginVoiceInput())
    capturing.beginTrip()
    XCTAssertEqual(capturing.log, [.stopAudio])
  }

  func testADirectPromptTheSynthesizerNeverReportsIsStillReleased() throws {
    var driver = Driver()
    let id = try XCTUnwrap(driver.speak(characters: 40))
    driver.rendered(id, seconds: nil)
    driver.advance(40 * Lifecycle.directSecondsPerCharacter + Lifecycle.directGraceSeconds + 0.1)
    XCTAssertEqual(driver.deactivations, [.promptsFinished])
    XCTAssertFalse(driver.sessionActive)
    XCTAssertFalse(driver.deactivatedUnderRunningAudio)
  }

  // MARK: Cancel, interruption, end of trip

  func testCancellingStopsAudioAndReleasesAtEveryStage() throws {
    for stage in ["rendering", "playing", "direct", "direct-tail", "queued"] {
      var driver = Driver()
      let id = try XCTUnwrap(driver.speak())
      switch stage {
      case "playing":
        driver.rendered(id)
      case "direct":
        driver.rendered(id, seconds: nil)
      case "direct-tail":
        driver.rendered(id, seconds: nil)
        driver.finished(id)
      case "queued":
        driver.speak()
        driver.rendered(id)
      default:
        break
      }
      driver.apply(driver.lifecycle.cancelAll(now: driver.now))
      XCTAssertEqual(
        Array(driver.log.suffix(2)), [.stopAudio, .deactivate(.cancelled)], stage)
      XCTAssertFalse(driver.sessionActive, stage)
      XCTAssertFalse(driver.deactivatedUnderRunningAudio, stage)
      XCTAssertFalse(driver.lifecycle.hasPrompts, stage)

      // Callbacks for the cancelled prompt arrive afterwards and must not disturb anything.
      let before = driver.log
      driver.rendered(id)
      driver.finished(id)
      XCTAssertEqual(driver.log, before, stage)
    }
  }

  func testCancellingWithNothingSpokenLeavesTheSessionAlone() {
    var driver = Driver()
    driver.apply(driver.lifecycle.cancelAll(now: driver.now))
    XCTAssertTrue(driver.log.isEmpty, "ending a silent trip must not touch other apps' audio")
  }

  // MARK: CarPlay voice search

  func testVoiceSearchStopsThePromptHoldsTheSessionAndReleasesWhenItEnds() throws {
    var driver = Driver()
    let id = try XCTUnwrap(driver.speak())
    driver.rendered(id)

    driver.apply(driver.lifecycle.beginVoiceInput())
    XCTAssertEqual(driver.log.last, .stopAudio)
    XCTAssertTrue(driver.deactivations.isEmpty, "recording must not be deactivated from under")
    XCTAssertTrue(driver.lifecycle.owesRelease)
    XCTAssertNil(driver.speak(), "a prompt during capture is deferred by the caller")
    driver.finished(id)
    driver.advance(30)
    XCTAssertTrue(driver.deactivations.isEmpty)

    driver.apply(driver.lifecycle.endVoiceInput())
    XCTAssertEqual(driver.deactivations, [.voiceSearchEnded])
    XCTAssertFalse(driver.sessionActive)
    XCTAssertFalse(driver.lifecycle.owesRelease)
  }

  func testVoiceSearchStartingDuringAConfirmationWindowKeepsTheMicrophone() throws {
    var driver = Driver()
    let id = try XCTUnwrap(driver.speak())
    driver.rendered(id)
    driver.finished(id)

    driver.apply(driver.lifecycle.beginVoiceInput())
    driver.sessionActive = true
    driver.advance(10)
    XCTAssertEqual(driver.deactivations, [.promptsFinished])
    XCTAssertTrue(driver.sessionActive, "the confirmation must not cut a recording")
    XCTAssertFalse(driver.timerStalled)
  }

  func testADeferredPromptAfterVoiceSearchGetsItsOwnActivationAndRelease() throws {
    var driver = Driver()
    driver.apply(driver.lifecycle.beginVoiceInput())
    driver.apply(driver.lifecycle.endVoiceInput())
    let id = try XCTUnwrap(driver.speak())
    driver.rendered(id)
    driver.finished(id)
    XCTAssertEqual(driver.deactivations, [.voiceSearchEnded, .promptsFinished])
    XCTAssertFalse(driver.sessionActive)
  }

  // MARK: Any order of events

  /// Whatever happens during a drive, once things go quiet the session is inactive, and it was
  /// never deactivated with audio still running.
  func testRandomDrivesAlwaysEndWithTheSessionReleased() {
    var generator = SplitMix64(seed: 0x6A75_6469_6F)
    for run in 0..<400 {
      var driver = Driver()
      var capturing = false
      for _ in 0..<40 {
        switch generator.next() % 12 {
        case 0, 1, 2:
          driver.speak(characters: Int(generator.next() % 80))
        case 3, 4:
          if let id = driver.pendingRenders.first {
            driver.rendered(id, seconds: generator.next() % 4 == 0 ? nil : 2)
          }
        case 5:
          if let id = driver.sounding.first { driver.finished(id) }
        case 6:
          driver.apply(driver.lifecycle.cancelAll(now: driver.now))
        case 7:
          if capturing {
            driver.apply(driver.lifecycle.endVoiceInput())
          } else {
            driver.apply(driver.lifecycle.beginVoiceInput())
          }
          capturing.toggle()
        case 8:
          driver.deactivationResults.append(false)
        case 9:
          driver.beginTrip()
        default:
          driver.advance(Double(generator.next() % 40) / 10)
        }
        // The synthesizer may activate the session at any moment a prompt is in hand.
        if driver.lifecycle.hasPrompts { driver.sessionActive = true }
      }
      if capturing { driver.apply(driver.lifecycle.endVoiceInput()) }
      driver.advance(600)
      XCTAssertFalse(driver.sessionActive, "run \(run) left the session live: \(driver.log)")
      XCTAssertFalse(driver.lifecycle.owesRelease, "run \(run)")
      XCTAssertFalse(driver.lifecycle.hasPrompts, "run \(run)")
      XCTAssertNil(driver.lifecycle.nextDeadline, "run \(run)")
      XCTAssertFalse(driver.deactivatedUnderRunningAudio, "run \(run): \(driver.log)")
      XCTAssertFalse(driver.timerStalled, "run \(run): \(driver.log)")
      XCTAssertFalse(driver.duckedBeforeAudioWasReady, "run \(run): \(driver.log)")
      XCTAssertFalse(driver.soundedWithoutActivation, "run \(run): \(driver.log)")
    }
  }

  private struct SplitMix64 {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
      state &+= 0x9E37_79B9_7F4A_7C15
      var z = state
      z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
      z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
      return z ^ (z >> 31)
    }
  }

  // MARK: Rendered audio container

  func testWaveFileRejectsWhatCannotBePlayed() {
    let mono = NavOSSGuidanceSpeechPCMFormat(
      sampleRate: 22_050, channelCount: 1, bitsPerSample: 32, isFloat: true)
    XCTAssertNil(NavOSSGuidanceSpeechWaveFile(format: mono, samples: Data()), "nothing rendered")
    XCTAssertNil(
      NavOSSGuidanceSpeechWaveFile(
        format: NavOSSGuidanceSpeechPCMFormat(
          sampleRate: 0, channelCount: 1, bitsPerSample: 16, isFloat: false),
        samples: Data(count: 64)))
    XCTAssertNil(
      NavOSSGuidanceSpeechWaveFile(
        format: NavOSSGuidanceSpeechPCMFormat(
          sampleRate: 22_050, channelCount: 1, bitsPerSample: 16, isFloat: true),
        samples: Data(count: 64)))
  }

  #if canImport(AVFoundation)
    /// Checked against the system's own decoder: the formats the synthesizer delivers must open
    /// in `AVAudioPlayer` with the expected length, or the driver hears nothing.
    func testWaveFileOpensInTheSystemPlayerForEveryFormatTheSynthesizerDelivers() throws {
      let formats = [
        NavOSSGuidanceSpeechPCMFormat(
          sampleRate: 22_050, channelCount: 1, bitsPerSample: 32, isFloat: true),
        NavOSSGuidanceSpeechPCMFormat(
          sampleRate: 22_050, channelCount: 1, bitsPerSample: 16, isFloat: false),
        NavOSSGuidanceSpeechPCMFormat(
          sampleRate: 24_000, channelCount: 1, bitsPerSample: 16, isFloat: false),
        NavOSSGuidanceSpeechPCMFormat(
          sampleRate: 48_000, channelCount: 2, bitsPerSample: 32, isFloat: true),
      ]
      for format in formats {
        let frames = Int(format.sampleRate * 1.5)
        let samples = Data(count: frames * format.channelCount * format.bitsPerSample / 8)
        let file = try XCTUnwrap(NavOSSGuidanceSpeechWaveFile(format: format, samples: samples))
        let expected = 1.5 + NavOSSGuidanceSpeechWaveFile.trailingSilenceSeconds
        XCTAssertEqual(file.durationSeconds, expected, accuracy: 0.001)

        let player = try AVAudioPlayer(data: file.data, fileTypeHint: AVFileType.wav.rawValue)
        XCTAssertEqual(player.duration, expected, accuracy: 0.001, "\(format)")
        XCTAssertEqual(player.format.sampleRate, format.sampleRate, "\(format)")
        XCTAssertEqual(Int(player.format.channelCount), format.channelCount, "\(format)")
      }
    }
  #endif
}

/// Review of #189: the session was activated before the prompt was rendered, and one slow render
/// put every later prompt of the run on direct speech.
final class GuidanceAudioPromptOrderTests: XCTestCase {
  private typealias Lifecycle = NavOSSGuidanceAudioLifecycle

  /// Speaks one prompt whose render fails or succeeds, through to the release.
  private func speak(
    _ lifecycle: inout Lifecycle, at now: inout TimeInterval, renders: Bool
  ) throws -> [Lifecycle.Effect] {
    let (id, queued) = try XCTUnwrap(lifecycle.enqueue(characterCount: 40, now: now))
    guard queued.contains(.render(id)) else {
      // Spoken directly without a render attempt.
      XCTAssertTrue(queued.contains(.speakDirectly(id)))
      finish(&lifecycle, id, at: &now)
      return queued
    }
    now += 0.05
    let answered = lifecycle.rendered(id, audioSeconds: renders ? 2 : nil, now: now)
    finish(&lifecycle, id, at: &now)
    return queued + answered
  }

  private func finish(_ lifecycle: inout Lifecycle, _ id: Lifecycle.PromptID, at now: inout TimeInterval) {
    now += 2
    var effects = lifecycle.finished(id, now: now)
    for _ in 0..<4 {
      if effects.contains(where: { if case .deactivate = $0 { true } else { false } }) {
        lifecycle.deactivated(succeeded: true, now: now)
      }
      guard let deadline = lifecycle.nextDeadline else { break }
      now = max(now, deadline)
      effects = lifecycle.timerFired(now: now)
    }
  }

  func testTheSessionIsActivatedWhenThePromptIsReadyToPlayNotBeforeItRenders() throws {
    var lifecycle = Lifecycle()
    let (id, queued) = try XCTUnwrap(lifecycle.enqueue(characterCount: 40, now: 0))
    XCTAssertTrue(queued.contains(.render(id)))
    XCTAssertFalse(queued.contains(.activate), "music would be ducked while nothing is said")

    let ready = lifecycle.rendered(id, audioSeconds: 2.5, now: 0.05)
    XCTAssertEqual(Array(ready.suffix(2)), [.activate, .play(id)])
  }

  func testASlowRenderCostsThatPromptOnly() throws {
    var lifecycle = Lifecycle()
    var now: TimeInterval = 0
    let (slow, _) = try XCTUnwrap(lifecycle.enqueue(characterCount: 40, now: now))
    now = try XCTUnwrap(lifecycle.nextDeadline)
    XCTAssertTrue(lifecycle.timerFired(now: now).contains(.speakDirectly(slow)))
    finish(&lifecycle, slow, at: &now)

    let (next, queued) = try XCTUnwrap(lifecycle.enqueue(characterCount: 40, now: now))
    XCTAssertTrue(queued.contains(.render(next)), "one slow render must not end rendering")
    XCTAssertFalse(queued.contains(.speakDirectly(next)))
  }

  func testOnlyTwoFailedRendersInARowSpeakTheRestDirectly() throws {
    var lifecycle = Lifecycle()
    var now: TimeInterval = 0
    // Fail, succeed, fail, succeed: never two in a row.
    for renders in [false, true, false, true] {
      let effects = try speak(&lifecycle, at: &now, renders: renders)
      XCTAssertTrue(
        effects.contains { if case .render = $0 { true } else { false } },
        "a failure followed by a success starts the count again")
    }
    // Two failures in a row.
    _ = try speak(&lifecycle, at: &now, renders: false)
    _ = try speak(&lifecycle, at: &now, renders: false)
    let (id, queued) = try XCTUnwrap(lifecycle.enqueue(characterCount: 40, now: now))
    XCTAssertTrue(queued.contains(.speakDirectly(id)), "a voice that cannot render stops being asked")
    XCTAssertFalse(queued.contains(.render(id)))
  }
}
