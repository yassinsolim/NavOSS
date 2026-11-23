package org.navoss.mobile.input

import android.app.Activity
import android.content.Context
import android.os.Bundle
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.Window
import android.widget.EditText
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityHandler
import expo.modules.core.interfaces.ReactActivityLifecycleListener

/**
 * Hooks the activity for handheld controls (see [MapInput]). Shoulder buttons and R3 reach the
 * activity only when no view used them; they never type text or move focus, so they are consumed
 * here. The right stick arrives as joystick motion, which no React Native view handles: the
 * window's callback is wrapped to read it before the view hierarchy (Android turns only the left
 * stick and the hat into D-pad keys, so nothing else is lost).
 */
class NavOSSInputPackage : Package {
  override fun createReactActivityHandlers(activityContext: Context): List<ReactActivityHandler> =
    listOf(
      object : ReactActivityHandler {
        override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
          if (!MapInput.mapControlsActive(textFieldFocused(activityContext))) return false
          val command = MapInput.commandFor(keyCode) ?: return false
          if (event == null || event.repeatCount == 0) MapInput.listener?.onCommand(command)
          return true
        }

        override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean =
          MapInput.mapControlsActive(textFieldFocused(activityContext)) &&
            MapInput.commandFor(keyCode) != null
      },
    )

  override fun createReactActivityLifecycleListeners(
    activityContext: Context,
  ): List<ReactActivityLifecycleListener> =
    listOf(
      object : ReactActivityLifecycleListener {
        override fun onCreate(activity: Activity, savedInstanceState: Bundle?) {
          val window = activity.window ?: return
          val callback = window.callback ?: return
          if (callback !is StickWindowCallback) {
            window.callback = StickWindowCallback(activity, callback)
          }
          // Editing begins: the stick belongs to the text field now, so any pan stops.
          window.decorView.viewTreeObserver.addOnGlobalFocusChangeListener { _, focused ->
            if (focused is EditText) MapInput.releaseStick()
          }
        }

        override fun onPause(activity: Activity) {
          MapInput.releaseStick()
        }
      },
    )
}

private fun textFieldFocused(context: Context): Boolean =
  (context as? Activity)?.currentFocus is EditText

/**
 * Passes everything to [base]; reads the right stick from joystick motion first. Only this
 * window's input arrives here: when another window (a modal sheet) takes focus the stick is
 * released, since its own release would go to that window.
 */
private class StickWindowCallback(
  private val activity: Activity,
  private val base: Window.Callback,
) : Window.Callback by base {
  override fun onWindowFocusChanged(hasFocus: Boolean) {
    if (!hasFocus) MapInput.releaseStick()
    base.onWindowFocusChanged(hasFocus)
  }

  override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean {
    if (
      event.isFromSource(InputDevice.SOURCE_JOYSTICK) && event.action == MotionEvent.ACTION_MOVE
    ) {
      if (!MapInput.mapControlsActive(textFieldFocused(activity))) {
        MapInput.releaseStick()
        return base.dispatchGenericMotionEvent(event)
      }
      val device = event.device
      val x =
        MapInput.axis(
          event.getAxisValue(MotionEvent.AXIS_Z),
          device?.getMotionRange(MotionEvent.AXIS_Z, event.source)?.flat ?: 0f,
        )
      val y =
        MapInput.axis(
          event.getAxisValue(MotionEvent.AXIS_RZ),
          device?.getMotionRange(MotionEvent.AXIS_RZ, event.source)?.flat ?: 0f,
        )
      MapInput.stick(x, y)
    }
    return base.dispatchGenericMotionEvent(event)
  }
}
