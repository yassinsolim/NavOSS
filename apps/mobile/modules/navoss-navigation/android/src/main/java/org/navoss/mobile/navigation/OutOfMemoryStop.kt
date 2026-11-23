package org.navoss.mobile.navigation

import java.util.concurrent.atomic.AtomicBoolean

/**
 * Fails closed when the core refuses a call for lack of memory (`out-of-memory`). After such a
 * refusal the core's state is unknown: the JNI layer may have skipped callbacks (a snapshot, a
 * storage write), so neither the trip on screen nor the trip on disk can be trusted, and any
 * further call into the core could fail the same way. The host therefore never calls the core
 * again and restarts clean:
 *
 * 1. [deleteSavedTrip] removes the saved trip and checkpoint directly on disk (and refuses any
 *    later write), so no later process can restore a trip the driver was told had ended;
 * 2. [stopHost] stops location, simulation, speech (abandoning audio focus), the clock and the
 *    foreground service;
 * 3. [recordStop] writes a small, non-private record (a reason code, no trip data) that the next
 *    launch reads once to say why the trip ended;
 * 4. [notifyDriver] posts a dismissible notification that opens the app;
 * 5. [exitProcess] ends the process. The service is `START_NOT_STICKY`, so it does not come back.
 *
 * Nothing survives in this process, so stale screen state and a stop racing a new trip cannot
 * happen. Each step runs even if an earlier one throws; only the first refusal stops anything.
 */
internal class OutOfMemoryStop(
  private val deleteSavedTrip: () -> Unit,
  private val stopHost: () -> Unit,
  private val recordStop: () -> Unit,
  private val notifyDriver: () -> Unit,
  private val exitProcess: () -> Unit,
) {
  private val stopping = AtomicBoolean(false)

  /** Whether an out-of-memory stop has begun: nothing may start or call the core any more. */
  val isStopping: Boolean
    get() = stopping.get()

  /** Runs [body]; an out-of-memory refusal stops everything and returns `null`, other refusals propagate. */
  fun <T> run(body: () -> T): T? = try {
    body()
  } catch (error: NavigationEngineException) {
    if (error.code != CoreNavigationEngine.OUT_OF_MEMORY) throw error
    stop()
    null
  }

  private fun stop() {
    if (!stopping.compareAndSet(false, true)) return
    for (step in listOf(deleteSavedTrip, stopHost, recordStop, notifyDriver)) {
      try {
        step()
      } catch (_: Throwable) {
        // Out of memory again, or a platform refusal: the remaining steps and the exit still run.
      }
    }
    exitProcess()
  }
}
