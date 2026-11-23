package org.navoss.navigation.core

/**
 * The lifetime of a native handle shared by threads: a call may use the handle only between
 * [enter] and [leave], and the handle is released once it is closed and no call is using it.
 * `@Volatile` on the handle would not do this: a caller could read it, lose the processor to
 * `close()`, and hand freed memory to the native side.
 *
 * - After [close] has begun, [enter] throws `NavOSSCoreException("closed")`; the native side is
 *   not touched.
 * - [close] runs `shutDown` (which stops callbacks) while holding the handle like a call, then
 *   lets go. `release` runs exactly once, on whichever thread ends the last use: the closing
 *   thread, or a call that was still running (also a call made from inside a callback, in
 *   which case it runs when the outermost such call returns).
 * - No lock is held while `body`, `shutDown` or `release` run, so a callback may call back in,
 *   and may call [close].
 */
internal class HandleGate(private var handle: Long, private val release: (Long) -> Unit) {
  private var closed = false
  private var inUse = 0

  inline fun <T> call(body: (Long) -> T): T {
    val live = enter()
    try {
      return body(live)
    } finally {
      leave()
    }
  }

  fun enter(): Long =
    synchronized(this) {
      if (closed) throw NavOSSCoreException("closed", "The engine was closed")
      inUse++
      handle
    }

  fun leave() {
    val released =
      synchronized(this) {
        inUse--
        if (closed && inUse == 0) handle.also { handle = 0L } else 0L
      }
    if (released != 0L) release(released)
  }

  /** Idempotent: only the first call runs `shutDown`; a later or concurrent one returns. */
  inline fun close(shutDown: (Long) -> Unit) {
    val live = beginClose()
    if (live == 0L) return
    try {
      shutDown(live)
    } finally {
      leave()
    }
  }

  fun beginClose(): Long =
    synchronized(this) {
      if (closed) return 0L
      closed = true
      inUse++
      handle
    }
}
