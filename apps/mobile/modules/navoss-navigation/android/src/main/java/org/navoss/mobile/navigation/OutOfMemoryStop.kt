package org.navoss.mobile.navigation

/**
 * Ends a trip the host can no longer drive because the core refused a call for lack of memory
 * (`out-of-memory`). The JNI layer builds its returned strings after the core has taken the
 * input and may skip callbacks when an allocation fails, so after such a refusal guidance could
 * go silent with the trip still active. Instead the host stops everything it runs for the trip
 * ([stopHost]: location, simulation, speech, clock, foreground service), clears the trip in the
 * core ([clearTrip], which also removes the saved trip), and tells the driver ([announce]).
 *
 * The saved trip is not kept: the process survives the refusal, so a relaunch in it would never
 * restore the trip, and a restore after some later process death could bring back, hours later,
 * a trip the driver was told had ended.
 */
internal class OutOfMemoryStop(
  private val stopHost: () -> Unit,
  private val clearTrip: () -> Unit,
  private val announce: () -> Unit,
) {
  /** Runs [body]; an out-of-memory refusal stops the trip and returns `null`, other refusals propagate. */
  fun <T> run(body: () -> T): T? = try {
    body()
  } catch (error: NavigationEngineException) {
    if (error.code != CoreNavigationEngine.OUT_OF_MEMORY) throw error
    stop()
    null
  }

  private fun stop() {
    stopHost()
    try {
      clearTrip()
    } catch (_: NavigationEngineException) {
      // Still out of memory: the host has stopped driving the trip either way.
    }
    announce()
  }
}
