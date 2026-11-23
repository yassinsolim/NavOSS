package org.navoss.mobile.navigation

import java.util.concurrent.atomic.AtomicBoolean

/**
 * Treats out of memory at the core boundary ([CoreNavigationEngine], construction included) as a
 * crash, whether or not a trip is active. After it nothing in the process can be
 * relied on (the JNI layer may have skipped callbacks, and any further work may fail the same
 * way), so the host does no clean-up: during a trip it makes one best-effort attempt to post a
 * notification built in advance ([notifyDriver], no allocation beyond the binder call; it does
 * nothing without a trip) and ends the process ([exitProcess]) whatever happens.
 *
 * The saved trip stays on disk: the next launch restores it through the normal restore path, as
 * after Android's low-memory killer (which gives no callback at all) and as iOS does after an
 * allocation failure. Opening the app is a user action, and the guidance service is
 * `START_NOT_STICKY`, so a restore cannot loop on its own.
 */
internal class OutOfMemoryStop(
  private val notifyDriver: () -> Unit,
  private val exitProcess: () -> Unit,
) {
  private val stopping = AtomicBoolean(false)

  /** Ends the process; only the first call does anything. */
  fun stop() {
    if (!stopping.compareAndSet(false, true)) return
    try {
      notifyDriver()
    } catch (_: Throwable) {
      // Out of memory again, or the platform refused: the process ends anyway.
    } finally {
      exitProcess()
    }
  }
}
