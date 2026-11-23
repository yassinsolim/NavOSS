package org.navoss.mobile.navigation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class GuidanceSpeechTest {
  private val events = mutableListOf<String>()
  private var currentGeneration = 1L
  private var focusGranted = true
  private var synthesizerAccepts = true
  private var lastId = ""
  private val scheduled = mutableListOf<Pair<Long, () -> Unit>>()
  private lateinit var speech: GuidanceSpeech

  private val synthesizer = object : SpeechSynthesizer {
    override fun speak(utteranceId: String, text: String): Boolean {
      events += "speak:$text"
      lastId = utteranceId
      return synthesizerAccepts
    }

    override fun stop() {
      events += "stop"
    }
  }

  private val focus = object : GuidanceAudioFocus {
    override fun request(): Boolean {
      events += "focus"
      return focusGranted
    }

    override fun abandon() {
      events += "abandon"
    }
  }

  private val scheduler = object : SpeechScheduler {
    override fun schedule(delayMs: Long, action: () -> Unit): Cancellable {
      val entry = delayMs to action
      scheduled += entry
      return Cancellable { scheduled.remove(entry) }
    }
  }

  @Before
  fun setUp() {
    speech = GuidanceSpeech(synthesizer, focus, scheduler) { it == currentGeneration }
  }

  private fun finishCurrent() {
    val id = lastId
    speech.onStart(id)
    speech.onDone(id)
  }

  @Test
  fun `holds focus only while a prompt speaks`() {
    speech.speak("Turn left", 1)
    assertEquals(listOf("focus", "speak:Turn left"), events)
    assertTrue(speech.holdsAudioFocus)
    finishCurrent()
    assertEquals(listOf("focus", "speak:Turn left", "abandon"), events)
    assertFalse(speech.holdsAudioFocus)
    assertTrue(scheduled.isEmpty())
  }

  @Test
  fun `queued prompts never overlap and share one focus request`() {
    speech.speak("Turn left", 1)
    speech.speak("Speed camera ahead", 1)
    assertEquals(listOf("focus", "speak:Turn left"), events)
    finishCurrent()
    assertEquals(listOf("focus", "speak:Turn left", "speak:Speed camera ahead"), events)
    finishCurrent()
    assertEquals(listOf("focus", "speak:Turn left", "speak:Speed camera ahead", "abandon"), events)
  }

  @Test
  fun `a prompt queued for an ended trip is dropped when its turn comes`() {
    speech.speak("Turn left", 1)
    speech.speak("Turn right", 1)
    currentGeneration = 2
    finishCurrent()
    assertEquals(listOf("focus", "speak:Turn left", "abandon"), events)
  }

  @Test
  fun `a prompt whose callbacks never arrive releases focus by deadline`() {
    speech.speak("Turn left", 1)
    val (delay, fire) = scheduled.single()
    assertEquals(GuidanceSpeech.START_TIMEOUT_MS, delay)
    fire()
    assertEquals(listOf("focus", "speak:Turn left", "stop", "abandon"), events)
    assertFalse(speech.isActive)
  }

  @Test
  fun `the speaking deadline follows the prompt length once it starts`() {
    speech.speak("Turn left", 1)
    speech.onStart(lastId)
    val (delay, _) = scheduled.single()
    assertEquals(9 * GuidanceSpeech.MS_PER_CHARACTER + GuidanceSpeech.SPEAKING_GRACE_MS, delay)
  }

  @Test
  fun `denied focus drops the burst without speaking over a call`() {
    focusGranted = false
    speech.speak("Turn left", 1)
    speech.speak("Turn right", 1)
    assertEquals(listOf("focus", "focus"), events)
    assertFalse(speech.isActive)
  }

  @Test
  fun `cancel for an earlier trip changes nothing`() {
    speech.speak("Turn left", 1)
    currentGeneration = 2
    speech.cancel(1)
    assertEquals(listOf("focus", "speak:Turn left"), events)
    speech.cancel(2)
    assertEquals(listOf("focus", "speak:Turn left", "stop", "abandon"), events)
  }

  @Test
  fun `losing focus stops guidance and releases focus`() {
    speech.speak("Turn left", 1)
    speech.speak("Turn right", 1)
    speech.onFocusLost()
    assertEquals(listOf("focus", "speak:Turn left", "stop", "abandon"), events)
    assertFalse(speech.isActive)
  }

  @Test
  fun `a refusing engine never leaves focus held`() {
    synthesizerAccepts = false
    speech.speak("Turn left", 1)
    assertEquals(listOf("focus", "speak:Turn left", "abandon"), events)
    assertFalse(speech.holdsAudioFocus)
  }

  @Test
  fun `late callbacks for a stopped prompt are ignored`() {
    speech.speak("Turn left", 1)
    val first = lastId
    speech.stopAll()
    speech.speak("Turn right", 1)
    speech.onDone(first)
    assertTrue(speech.isActive)
    assertEquals(listOf("focus", "speak:Turn left", "stop", "abandon", "focus", "speak:Turn right"), events)
  }
}
