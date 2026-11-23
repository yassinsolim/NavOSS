package org.navoss.mobile.input

import android.view.View
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
  private val pendingFocus = PendingFocus()

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

    OnDestroy {
      MapInput.listener = null
      MapInput.releaseStick()
      appContext.currentActivity?.runOnUiThread { pendingFocus.cancelAll() }
    }

    /**
     * Focuses the view with [viewTag] when the window is navigated by keys (not in touch mode), so
     * a touch never brings up a focus ring. Answers whether the view took focus.
     */
    AsyncFunction("focusForKeys") { viewTag: Int ->
      val view = appContext.findView<View>(viewTag) ?: return@AsyncFunction false
      if (view.isInTouchMode || !view.isAttachedToWindow) return@AsyncFunction false
      if (view.hasWindowFocus()) return@AsyncFunction view.requestFocus()
      // A modal sheet's window is still opening: focus moves in once it has the keys.
      pendingFocus.defer(view)
      true
    }.runOnQueue(Queues.MAIN)
  }
}
