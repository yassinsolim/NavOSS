package org.navoss.mobile.input

import android.view.KeyEvent
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * The handheld controls the map answers, independent of the activity so they can be unit tested:
 * L1 zooms out, R1 zooms in, pressing the right stick (R3) recenters, and the right stick pans.
 * The D-pad and the left stick stay with focus navigation (Android turns the left stick into
 * D-pad keys itself), A presses, B goes back.
 */
object MapInput {
  const val ZOOM_IN = "zoom-in"
  const val ZOOM_OUT = "zoom-out"
  const val RECENTER = "recenter"

  /** Stick deflection below this is the stick resting, whatever the device reports as flat. */
  private const val MIN_DEAD_ZONE = 0.15f

  /** Deflection is sent in steps of a tenth: enough for speed, few events while held. */
  private const val STEPS = 10

  /** The map command for a key code, or null for keys the map leaves alone. */
  fun commandFor(keyCode: Int): String? =
    when (keyCode) {
      KeyEvent.KEYCODE_BUTTON_L1 -> ZOOM_OUT
      KeyEvent.KEYCODE_BUTTON_R1 -> ZOOM_IN
      KeyEvent.KEYCODE_BUTTON_THUMBR -> RECENTER
      else -> null
    }

  /**
   * One stick axis as the map pans it: zero inside the dead zone (the larger of [flat] and
   * [MIN_DEAD_ZONE]), otherwise rescaled from the dead zone's edge to 1 and rounded to a tenth.
   */
  fun axis(value: Float, flat: Float): Float {
    val deadZone = maxOf(abs(flat), MIN_DEAD_ZONE)
    val magnitude = abs(value)
    if (value.isNaN() || magnitude <= deadZone) return 0f
    val scaled = ((minOf(magnitude, 1f) - deadZone) / (1f - deadZone) * STEPS).roundToInt()
    return Math.copySign(scaled.toFloat() / STEPS, value)
  }

  private var stickX = 0f
  private var stickY = 0f

  /** The right stick moved to (x, y) (each from [axis]); a change is sent once. */
  @Synchronized
  fun stick(x: Float, y: Float) {
    if (x == stickX && y == stickY) return
    stickX = x
    stickY = y
    listener?.onStick(x, y)
  }

  /**
   * The stick's release may never reach the activity (a modal sheet's window took the input, the
   * activity paused, a text field took focus): stop any pan now. Sends (0, 0) once if it was held.
   */
  fun releaseStick() = stick(0f, 0f)

  /** Receives commands and stick changes while the JavaScript module is alive. */
  @Volatile var listener: Listener? = null

  interface Listener {
    fun onCommand(command: String)

    /** Right stick, each axis in -1..1 (x right, y down); (0, 0) when released. */
    fun onStick(x: Float, y: Float)
  }
}
