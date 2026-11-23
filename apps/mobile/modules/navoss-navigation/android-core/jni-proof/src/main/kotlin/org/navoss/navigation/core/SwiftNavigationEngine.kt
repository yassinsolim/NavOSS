package org.navoss.navigation.core

/**
 * The Swift navigation core behind JNI. Every argument and result is JSON. Calls are synchronous
 * on the caller's thread; [Listener.onEvent] runs on the thread that caused the event.
 */
class SwiftNavigationEngine(listener: Listener) : AutoCloseable {
  fun interface Listener {
    /** `kind` is `state` or `speech`; `json` is the payload. */
    fun onEvent(kind: String, json: String)
  }

  private var handle: Long = nativeCreate(listener)

  fun setRoute(requestJson: String): String = nativeSetRoute(live(), requestJson)

  fun updateLocation(fixJson: String): String = nativeUpdateLocation(live(), fixJson)

  fun clearRoute(): String = nativeClearRoute(live())

  fun snapshot(): String = nativeSnapshot(live())

  fun setSpeedingWarning(toleranceKph: Int, audible: Boolean) =
    nativeSetSpeedingWarning(live(), toleranceKph, audible)

  override fun close() {
    if (handle != 0L) {
      nativeDestroy(handle)
      handle = 0L
    }
  }

  private fun live(): Long = handle.also { check(it != 0L) { "engine closed" } }

  private companion object {
    init {
      System.loadLibrary("NavOSSNavigationJNI")
    }

    @JvmStatic external fun nativeCreate(listener: Listener): Long
    @JvmStatic external fun nativeDestroy(handle: Long)
    @JvmStatic external fun nativeSetRoute(handle: Long, json: String): String
    @JvmStatic external fun nativeUpdateLocation(handle: Long, json: String): String
    @JvmStatic external fun nativeClearRoute(handle: Long): String
    @JvmStatic external fun nativeSnapshot(handle: Long): String
    @JvmStatic external fun nativeSetSpeedingWarning(handle: Long, toleranceKph: Int, audible: Boolean)
  }
}
