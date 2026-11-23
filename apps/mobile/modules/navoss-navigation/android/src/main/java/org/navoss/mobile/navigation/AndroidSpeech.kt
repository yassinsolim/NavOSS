package org.navoss.mobile.navigation

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.Locale

internal const val SPEECH_LOG_TAG = "NavOSSSpeech"

/** Navigation guidance, spoken: the usage the system and car head units route and duck as guidance. */
internal val guidanceAudioAttributes: AudioAttributes = AudioAttributes.Builder()
  .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
  .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
  .build()

/**
 * The device's text-to-speech engine and voice. Prompts that arrive while the engine starts wait
 * for it; when no engine is installed or it fails to start, every prompt is refused and guidance
 * continues on screen. Logs utterance ids and lengths only, never the text (it names streets).
 */
internal class AndroidSpeechSynthesizer(
  context: Context,
  private val handler: Handler,
  private val onStart: (String) -> Unit,
  private val onDone: (String) -> Unit,
  /** Called on [handler]'s thread when [isAvailable] turns false. */
  private val onAvailabilityChanged: () -> Unit = {},
) : SpeechSynthesizer {
  private enum class State { STARTING, READY, FAILED }

  @Volatile private var state = State.STARTING

  /** False once the engine failed to start or has no English voice: prompts are not spoken. */
  val isAvailable: Boolean
    get() = state != State.FAILED
  private var waiting: Pair<String, String>? = null
  private val engine: TextToSpeech = TextToSpeech(context.applicationContext) { status ->
    handler.post { initialized(status) }
  }

  override fun speak(utteranceId: String, text: String): Boolean = when (state) {
    State.FAILED -> false
    State.STARTING -> {
      waiting = utteranceId to text
      true
    }
    State.READY -> {
      val result = engine.speak(text, TextToSpeech.QUEUE_ADD, null, utteranceId)
      Log.i(SPEECH_LOG_TAG, "speak $utteranceId chars=${text.length} result=$result")
      result == TextToSpeech.SUCCESS
    }
  }

  override fun stop() {
    waiting = null
    if (state == State.READY) engine.stop()
  }

  fun shutdown() {
    engine.shutdown()
  }

  private fun initialized(status: Int) {
    if (status != TextToSpeech.SUCCESS || !configure()) {
      state = State.FAILED
      Log.w(SPEECH_LOG_TAG, "text-to-speech unavailable (status=$status)")
      waiting?.let { (id, _) -> onDone(id) }
      waiting = null
      onAvailabilityChanged()
      return
    }
    state = State.READY
    engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
      override fun onStart(utteranceId: String) {
        Log.i(SPEECH_LOG_TAG, "start $utteranceId")
        handler.post { this@AndroidSpeechSynthesizer.onStart(utteranceId) }
      }

      override fun onDone(utteranceId: String) {
        Log.i(SPEECH_LOG_TAG, "done $utteranceId")
        handler.post { this@AndroidSpeechSynthesizer.onDone(utteranceId) }
      }

      override fun onStop(utteranceId: String, interrupted: Boolean) {
        handler.post { this@AndroidSpeechSynthesizer.onDone(utteranceId) }
      }

      @Deprecated("Deprecated in Java")
      override fun onError(utteranceId: String) {
        Log.w(SPEECH_LOG_TAG, "error $utteranceId")
        handler.post { this@AndroidSpeechSynthesizer.onDone(utteranceId) }
      }

      override fun onError(utteranceId: String, errorCode: Int) {
        Log.w(SPEECH_LOG_TAG, "error $utteranceId code=$errorCode")
        handler.post { this@AndroidSpeechSynthesizer.onDone(utteranceId) }
      }
    })
    val pending = waiting
    waiting = null
    if (pending != null && !speak(pending.first, pending.second)) onDone(pending.first)
  }

  /** Guidance audio attributes and an English voice: the server's instructions are English. */
  private fun configure(): Boolean {
    engine.setAudioAttributes(guidanceAudioAttributes)
    val device = Locale.getDefault()
    val candidates = buildList {
      if (device.language == Locale.ENGLISH.language) add(device)
      add(Locale.CANADA)
      add(Locale.US)
      add(Locale.UK)
      add(Locale.ENGLISH)
    }
    for (locale in candidates) {
      val result = engine.setLanguage(locale)
      if (result != TextToSpeech.LANG_MISSING_DATA && result != TextToSpeech.LANG_NOT_SUPPORTED) {
        Log.i(SPEECH_LOG_TAG, "voice locale ${engine.voice?.locale ?: locale}")
        return true
      }
    }
    return false
  }
}

/**
 * Transient, ducking focus (`AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK`) with navigation-guidance
 * attributes: music lowers while a prompt speaks and returns when focus is abandoned. A loss
 * (call, another app taking exclusive focus) stops guidance speech.
 */
internal class AndroidGuidanceAudioFocus(
  context: Context,
  private val handler: Handler,
  private val onLoss: () -> Unit,
) : GuidanceAudioFocus {
  private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val listener = AudioManager.OnAudioFocusChangeListener { change ->
    if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
      Log.i(SPEECH_LOG_TAG, "audio focus lost ($change)")
      handler.post(onLoss)
    }
  }
  private val request: Any? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
    AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
      .setAudioAttributes(guidanceAudioAttributes)
      .setOnAudioFocusChangeListener(listener, handler)
      .build()
  } else {
    null
  }

  override fun request(): Boolean {
    val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      audioManager.requestAudioFocus(request as AudioFocusRequest)
    } else {
      @Suppress("DEPRECATION")
      audioManager.requestAudioFocus(
        listener,
        AudioManager.STREAM_MUSIC,
        AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK,
      )
    }
    Log.i(SPEECH_LOG_TAG, "audio focus request result=$result")
    return result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
  }

  override fun abandon() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      audioManager.abandonAudioFocusRequest(request as AudioFocusRequest)
    } else {
      @Suppress("DEPRECATION")
      audioManager.abandonAudioFocus(listener)
    }
    Log.i(SPEECH_LOG_TAG, "audio focus abandoned")
  }
}
