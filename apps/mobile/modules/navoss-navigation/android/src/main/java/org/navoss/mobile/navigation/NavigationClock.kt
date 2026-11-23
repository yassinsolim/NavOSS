package org.navoss.mobile.navigation

/** A repeating one-second timer. */
interface Ticker {
  fun start(intervalMs: Long, tick: () -> Unit)
  fun stop()
}

/**
 * The core's one-second clock while a trip is active (iOS `startNavigationClock`). Start and stop
 * are bound to the navigation generation that asked for them, so a stale stop queued by an
 * earlier trip cannot cancel the clock a newer trip started: `start` for a stale generation or
 * while the clock runs does nothing, and `stop` acts only for the current generation. All calls
 * run on one thread.
 */
class NavigationClock(
  private val ticker: Ticker,
  private val isCurrentGeneration: (Long) -> Boolean,
  private val tick: () -> Unit,
) {
  var isRunning = false
    private set

  fun start(generation: Long) {
    if (isRunning || !isCurrentGeneration(generation)) return
    isRunning = true
    ticker.start(TICK_MS, tick)
  }

  fun stop(generation: Long) {
    if (!isCurrentGeneration(generation)) return
    shutdown()
  }

  /** Stops unconditionally (the engine is closing). */
  fun shutdown() {
    if (!isRunning) return
    isRunning = false
    ticker.stop()
  }

  companion object {
    const val TICK_MS = 1_000L
  }
}
