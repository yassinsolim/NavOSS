package org.navoss.mobile.navigation

import java.util.concurrent.atomic.AtomicBoolean

/**
 * Treats out of memory at the core boundary ([CoreNavigationEngine], construction included) as a
 * crash, whether or not a trip is active. After it nothing in the process can be
 * relied on (the JNI layer may have skipped callbacks, and any further work may fail the same
 * way), so the host does no clean-up: during a trip it makes one best-effort attempt to post a
 * notification built in advance ([notifyDriver], no allocation beyond the binder call; it does
 * nothing without a trip), stops the guidance service ([stopService]) and finishes the app's
 * task ([finishTask]) so Android neither restarts the service nor relaunches a visible activity
 * on its own, and ends the process ([exitProcess]) whatever happens. Each step is best effort
 * and none can prevent the next.
 *
 * The saved trip stays on disk: the next launch restores it through the normal restore path, as
 * after Android's low-memory killer (which gives no callback at all) and as iOS does after an
 * allocation failure. The driver comes back through the notification ("Open NavOSS to continue
 * your trip"); opening the app is a user action, so a restore cannot loop on its own.
 */
internal class OutOfMemoryStop(
  private val notifyDriver: () -> Unit,
  private val stopService: () -> Unit,
  private val finishTask: () -> Unit,
  private val exitProcess: () -> Unit,
) {
  private val stopping = AtomicBoolean(false)

  /** Ends the process; only the first call does anything. */
  fun stop() {
    if (!stopping.compareAndSet(false, true)) return
    try {
      notifyDriver()
    } catch (_: Throwable) {
      // Out of memory again, or the platform refused: the next steps run anyway.
    }
    try {
      stopService()
    } catch (_: Throwable) {
      // As above.
    }
    try {
      finishTask()
    } catch (_: Throwable) {
      // As above.
    }
    exitProcess()
  }
}
