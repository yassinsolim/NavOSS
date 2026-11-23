package org.navoss.mobile.updater

/**
 * Keeps an update install and a trip apart, under one lock.
 *
 * - While a trip is held, no install session is committed and no install prompt opens.
 * - While a committed install has not reported its result, a trip cannot start: Android would
 *   replace (and close) the app in the middle of it.
 *
 * The trip side is set synchronously from JavaScript at Start (see [beginTrip]) and cleared at
 * End; the install side by [commitUnlessTrip] and the installer's result.
 */
class InstallGate {
  private val lock = Any()
  private var tripHeld = false
  private var committed = false

  /** Holds or releases installs for a trip (also used while a route is previewed). */
  fun setTripHeld(held: Boolean) = synchronized(lock) { tripHeld = held }

  val isTripHeld: Boolean
    get() = synchronized(lock) { tripHeld }

  /** True while a committed install has not reported its result. */
  val isCommitted: Boolean
    get() = synchronized(lock) { committed }

  /** Starts holding installs for a trip, unless an install is committed (then false). */
  fun beginTrip(): Boolean =
    synchronized(lock) {
      if (committed) return false
      tripHeld = true
      true
    }

  /**
   * Runs [commit] (the session commit) only when no trip is held, under the same lock as
   * [beginTrip], and marks the install committed. Returns false, without running it, during a trip.
   */
  fun commitUnlessTrip(commit: () -> Unit): Boolean =
    synchronized(lock) {
      if (tripHeld) return false
      commit()
      committed = true
      true
    }

  /** The installer reported a final result (or the session was abandoned): trips may start. */
  fun finished() = synchronized(lock) { committed = false }

  companion object {
    /** The app's one gate, shared by the module and the installer's result receiver. */
    val shared = InstallGate()
  }
}
