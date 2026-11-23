package org.navoss.mobile.input

import android.app.Activity
import android.content.Context
import android.os.Bundle
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.Window
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
          val command = MapInput.commandFor(keyCode) ?: return false
          if (event == null || event.repeatCount == 0) MapInput.listener?.onCommand(command)
          return true
        }

        override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean =
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
          if (callback !is StickWindowCallback) window.callback = StickWindowCallback(callback)
        }
      },
    )
}

/** Passes everything to [base]; reads the right stick from joystick motion first. */
private class StickWindowCallback(private val base: Window.Callback) : Window.Callback by base {
  private var lastX = 0f
  private var lastY = 0f

  override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean {
    if (
      event.isFromSource(InputDevice.SOURCE_JOYSTICK) && event.action == MotionEvent.ACTION_MOVE
    ) {
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
      if (x != lastX || y != lastY) {
        lastX = x
        lastY = y
        MapInput.listener?.onStick(x, y)
      }
    }
    return base.dispatchGenericMotionEvent(event)
  }
}
