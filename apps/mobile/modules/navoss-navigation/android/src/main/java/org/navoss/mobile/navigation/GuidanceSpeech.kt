package org.navoss.mobile.navigation

/** The text-to-speech engine, one utterance at a time. Its callbacks must reach [GuidanceSpeech] on its thread. */
interface SpeechSynthesizer {
  /** Starts speaking `text` now; `false` when the engine refused it (not ready, no voice). */
  fun speak(utteranceId: String, text: String): Boolean

  /** Stops whatever is being spoken. */
  fun stop()

  /** `false` once the engine cannot speak at all: prompts are dropped without taking audio focus. */
  val isAvailable: Boolean
}

/** Transient, ducking audio focus for navigation guidance. */
interface GuidanceAudioFocus {
  /** `true` when focus was granted; other audio is now ducked. */
  fun request(): Boolean
  fun abandon()
}

/** Runs delayed work on the speech thread. */
interface SpeechScheduler {
  fun schedule(delayMs: Long, action: () -> Unit): Cancellable
}

fun interface Cancellable {
  fun cancel()
}

/**
 * Speaks guidance prompts one after another, holding transient ducking audio focus only while a
 * prompt is queued or speaking. Mirrors the iOS rules (`AudioSessionOwnership.swift`,
 * `NavOSSNavigationService.speak`), whose bug history is music left ducked after guidance:
 *
 * - focus is requested when the first prompt of a burst is about to speak and abandoned as soon
 *   as the queue is empty, never kept "for the next prompt";
 * - a prompt whose engine callbacks never arrive cannot hold focus forever: the head of the queue
 *   gets [START_TIMEOUT_MS] to start and its estimated length plus [SPEAKING_GRACE_MS] to finish;
 * - the navigation generation is checked when a prompt is about to speak, not only when it was
 *   queued, so a prompt queued behind another never speaks for a trip that has since ended;
 * - losing focus (a phone call) stops guidance speech instead of talking over it.
 *
 * The core has already applied the audio mode, so nothing here filters by it. Not thread-safe:
 * every call, including engine callbacks, runs on one thread.
 */
class GuidanceSpeech(
  private val synthesizer: SpeechSynthesizer,
  private val focus: GuidanceAudioFocus,
  private val scheduler: SpeechScheduler,
  private val isCurrentGeneration: (Long) -> Boolean,
) {
  private class Prompt(val id: String, val text: String, val generation: Long)

  private val queue = ArrayDeque<Prompt>()
  private var speaking: Prompt? = null
  private var holdsFocus = false
  private var watchdog: Cancellable? = null
  private var nextId = 0L

  /** Whether a prompt is speaking or waiting; focus is held exactly while this is true. */
  val isActive: Boolean
    get() = speaking != null || queue.isNotEmpty()

  val holdsAudioFocus: Boolean
    get() = holdsFocus

  fun speak(text: String, generation: Long) {
    if (text.isBlank()) return
    nextId += 1
    queue.addLast(Prompt("navoss-guidance-$nextId", text, generation))
    if (speaking == null) speakNext()
  }

  /** Stops the current trip's speech. A stale generation (an earlier trip) changes nothing. */
  fun cancel(generation: Long) {
    if (!isCurrentGeneration(generation)) return
    stopAll()
  }

  /** Stops all guidance speech now (`stopAnnouncements`, focus loss, shutdown). */
  fun stopAll() {
    queue.clear()
    if (speaking != null) {
      speaking = null
      synthesizer.stop()
    }
    finishBurst()
  }

  fun onStart(utteranceId: String) {
    val current = speaking ?: return
    if (current.id != utteranceId) return
    val deadline = current.text.length * MS_PER_CHARACTER + SPEAKING_GRACE_MS
    armWatchdog(deadline)
  }

  /** The engine finished, failed or dropped `utteranceId`. */
  fun onDone(utteranceId: String) {
    if (speaking?.id != utteranceId) return
    speaking = null
    speakNext()
  }

  /** Another app or a call took focus: guidance must not talk over it. */
  fun onFocusLost() {
    stopAll()
  }

  private fun speakNext() {
    while (true) {
      val prompt = queue.removeFirstOrNull() ?: return finishBurst()
      if (!isCurrentGeneration(prompt.generation)) continue
      if (!synthesizer.isAvailable) {
        // No engine or no voice: ducking the driver's audio for silence helps nobody.
        queue.clear()
        return finishBurst()
      }
      if (!holdsFocus) {
        if (!focus.request()) {
          // A call or another app holds exclusive focus: drop the burst rather than talk over it.
          queue.clear()
          return finishBurst()
        }
        holdsFocus = true
      }
      speaking = prompt
      if (!synthesizer.speak(prompt.id, prompt.text)) {
        speaking = null
        continue
      }
      armWatchdog(START_TIMEOUT_MS)
      return
    }
  }

  private fun armWatchdog(delayMs: Long) {
    watchdog?.cancel()
    val id = speaking?.id ?: return
    watchdog = scheduler.schedule(delayMs) {
      if (speaking?.id == id) {
        // The engine never reported this prompt; treat it as lost so focus is not held forever.
        synthesizer.stop()
        onDone(id)
      }
    }
  }

  private fun finishBurst() {
    watchdog?.cancel()
    watchdog = null
    if (holdsFocus) {
      holdsFocus = false
      focus.abandon()
    }
  }

  companion object {
    /** How long the head prompt may take to start (engine warm-up, Bluetooth route setup). */
    const val START_TIMEOUT_MS = 6_000L
    /** Generous: real guidance speaks faster than ten characters a second. */
    const val MS_PER_CHARACTER = 100L
    const val SPEAKING_GRACE_MS = 3_000L
  }
}
