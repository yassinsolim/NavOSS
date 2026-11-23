package org.navoss.mobile.navigation

/**
 * Why the host ended the last process's trip on its own (a reason code such as `out-of-memory`;
 * never trip data), kept across the process exit that follows. The next launch reads it once:
 * [consume] returns it and clears it, so the driver is told once.
 */
internal class StopRecord(
  private val read: () -> String?,
  private val write: (String?) -> Unit,
) {
  fun record(reason: String) = write(reason)

  fun consume(): String? = read()?.also { write(null) }
}
