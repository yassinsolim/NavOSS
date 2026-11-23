package org.navoss.mobile.updater

import java.util.concurrent.atomic.AtomicBoolean

/**
 * Whether a trip is active, for the installer. Set synchronously from the start-navigation path
 * and cleared at End. It never blocks and never refuses anything: navigation always starts.
 *
 * The installer reads it immediately before committing a session (and abandons the session during
 * a trip), and the result receiver reads it before opening Android's confirmation prompt. A trip
 * that starts in the instant after that check, or while Android installs an update the driver
 * approved seconds earlier, is not prevented: Android may then replace the app, and the trip is
 * restored when NavOSS reopens (see docs/release/android.md).
 */
class InstallGate {
  private val tripActive = AtomicBoolean(false)

  fun setTripActive(active: Boolean) = tripActive.set(active)

  val isTripActive: Boolean
    get() = tripActive.get()

  /** Runs [commit] unless a trip is active; no lock is held while it runs. */
  fun commitUnlessTrip(commit: () -> Unit): Boolean {
    if (tripActive.get()) return false
    commit()
    return true
  }

  companion object {
    /** The app's one flag, shared by the module, the installer and the result receiver. */
    val shared = InstallGate()
  }
}
