package org.navoss.mobile.input

import android.view.View
import android.view.ViewTreeObserver
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val MAP_COMMAND_EVENT = "onMapCommand"
private const val MAP_STICK_EVENT = "onMapStick"

/**
 * Handheld controls for JavaScript: map commands and the right stick (see [MapInput]), and
 * moving keyboard focus to a control for a driver using keys.
 */
class NavOSSInputModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("NavOSSInput")

    Events(MAP_COMMAND_EVENT, MAP_STICK_EVENT)

    OnCreate {
      MapInput.listener =
        object : MapInput.Listener {
          override fun onCommand(command: String) {
            sendEvent(MAP_COMMAND_EVENT, mapOf("command" to command))
          }

          override fun onStick(x: Float, y: Float) {
            sendEvent(MAP_STICK_EVENT, mapOf("x" to x, "y" to y))
          }
        }
    }

    OnDestroy { MapInput.listener = null }

    /**
     * Focuses the view with [viewTag] when the window is navigated by keys (not in touch mode), so
     * a touch never brings up a focus ring. Answers whether the view took focus.
     */
    AsyncFunction("focusForKeys") { viewTag: Int ->
      val view = appContext.findView<View>(viewTag) ?: return@AsyncFunction false
      if (view.isInTouchMode) return@AsyncFunction false
      if (view.hasWindowFocus()) return@AsyncFunction view.requestFocus()
      // A modal sheet's window is still opening: focus moves in once it has the keys.
      view.viewTreeObserver.addOnWindowFocusChangeListener(
        object : ViewTreeObserver.OnWindowFocusChangeListener {
          override fun onWindowFocusChanged(hasFocus: Boolean) {
            if (!hasFocus) return
            view.viewTreeObserver.removeOnWindowFocusChangeListener(this)
            if (!view.isInTouchMode) view.requestFocus()
          }
        },
      )
      true
    }.runOnQueue(Queues.MAIN)
  }
}
