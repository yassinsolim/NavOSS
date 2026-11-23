package org.navoss.navigation.core

/**
 * The Swift navigation core (`libNavOSSCore.so`) behind its JSON boundary. The contract (every
 * call, callback, thread rule and error code) is `docs/architecture/android-core.md`.
 *
 * Calls are synchronous and may come from any thread. Arguments and results are JSON strings in
 * the shapes of `modules/navoss-navigation/index.ts`. A failing call throws
 * [NavOSSCoreException]; nothing else crosses the boundary.
 */
class NavOSSCore(configJson: String, host: Host) : AutoCloseable {
  /** The platform side, called by Swift. See "Callbacks" in the contract. */
  interface Host {
    fun onStateChanged(snapshotJson: String)

    /** `kind` is `alert` or `maneuver`. Check [isCurrentGeneration] before speaking later. */
    fun speak(text: String, kind: String, generation: Long)

    fun cancelSpeech(generation: Long)

    fun needsLocationUpdates()

    fun reconcileLocationUpdates(generation: Long, shouldTrack: Boolean)

    fun startClock(generation: Long)

    fun stopClock(generation: Long)

    /** Must return at once; answer later with [completeHttpRequest]. */
    fun httpRequest(requestId: Long, requestJson: String)

    fun cancelHttpRequest(requestId: Long)

    /** Called with the engine lock held: must not call into [NavOSSCore]. */
    fun storageRead(key: String): String?

    /** Called with the engine lock held: must not call into [NavOSSCore]. `null` removes. */
    fun storageWrite(key: String, value: String?)

    /** Called with the engine lock held: must not call into [NavOSSCore]. Unix milliseconds. */
    fun nowMs(): Double
  }

  @Volatile private var handle: Long

  init {
    loadError()?.let { throw IllegalStateException("The navigation core is unavailable", it) }
    handle = nativeCreate(configJson, host)
  }

  fun resumePersistedTrip(): String = nativeResumePersistedTrip(live())

  fun setRoute(tripJson: String): String = nativeSetRoute(live(), tripJson)

  fun updateLocation(sampleJson: String): String = nativeUpdateLocation(live(), sampleJson)

  fun clearRoute(): String = nativeClearRoute(live())

  fun getSnapshot(): String = nativeGetSnapshot(live())

  fun acceptRerouteProposal(id: String): Boolean = nativeAcceptRerouteProposal(live(), id)

  fun declineRerouteProposal(id: String): Boolean = nativeDeclineRerouteProposal(live(), id)

  fun setRerouteMode(mode: String) = nativeSetRerouteMode(live(), mode)

  fun setAudioMode(mode: String) = nativeSetAudioMode(live(), mode)

  fun setSpeedingWarning(toleranceKph: Int, audible: Boolean) =
    nativeSetSpeedingWarning(live(), toleranceKph, audible)

  fun setAnnounceRoadReports(enabled: Boolean) = nativeSetAnnounceRoadReports(live(), enabled)

  fun getPreferences(): String = nativeGetPreferences(live())

  fun clockTick() = nativeClockTick(live())

  fun isCurrentGeneration(generation: Long): Boolean = nativeIsCurrentGeneration(live(), generation)

  fun completeHttpRequest(requestId: Long, responseJson: String) =
    nativeCompleteHttpRequest(live(), requestId, responseJson)

  /** Idempotent. Not from inside a [Host] callback. */
  override fun close() {
    val closing = synchronized(this) { handle.also { handle = 0L } }
    if (closing != 0L) nativeDestroy(closing)
  }

  private fun live(): Long =
    handle.also { if (it == 0L) throw NavOSSCoreException("closed", "The engine was closed") }

  companion object {
    /** The boundary version this binding speaks; the library must report the same. */
    const val ABI_VERSION = 1

    private val loadFailure: Throwable? by lazy {
      try {
        System.loadLibrary("NavOSSCore")
        val native = nativeAbiVersion()
        if (native == ABI_VERSION) {
          null
        } else {
          IllegalStateException("libNavOSSCore.so speaks ABI $native, this binding $ABI_VERSION")
        }
      } catch (error: UnsatisfiedLinkError) {
        error
      }
    }

    /** `null` when the library is loaded and speaks [ABI_VERSION]; otherwise why not. */
    @JvmStatic fun loadError(): Throwable? = loadFailure

    /** The JS contract version (`getCapabilities().version`) the snapshots follow. */
    @JvmStatic
    fun contractVersion(): Int {
      loadError()?.let { throw IllegalStateException("The navigation core is unavailable", it) }
      return nativeContractVersion()
    }

    @JvmStatic private external fun nativeAbiVersion(): Int

    @JvmStatic private external fun nativeContractVersion(): Int

    @JvmStatic private external fun nativeCreate(configJson: String, host: Host): Long

    @JvmStatic private external fun nativeDestroy(handle: Long)

    @JvmStatic private external fun nativeResumePersistedTrip(handle: Long): String

    @JvmStatic private external fun nativeSetRoute(handle: Long, tripJson: String): String

    @JvmStatic private external fun nativeUpdateLocation(handle: Long, sampleJson: String): String

    @JvmStatic private external fun nativeClearRoute(handle: Long): String

    @JvmStatic private external fun nativeGetSnapshot(handle: Long): String

    @JvmStatic private external fun nativeAcceptRerouteProposal(handle: Long, id: String): Boolean

    @JvmStatic private external fun nativeDeclineRerouteProposal(handle: Long, id: String): Boolean

    @JvmStatic private external fun nativeSetRerouteMode(handle: Long, mode: String)

    @JvmStatic private external fun nativeSetAudioMode(handle: Long, mode: String)

    @JvmStatic
    private external fun nativeSetSpeedingWarning(handle: Long, toleranceKph: Int, audible: Boolean)

    @JvmStatic private external fun nativeSetAnnounceRoadReports(handle: Long, enabled: Boolean)

    @JvmStatic private external fun nativeGetPreferences(handle: Long): String

    @JvmStatic private external fun nativeClockTick(handle: Long)

    @JvmStatic private external fun nativeIsCurrentGeneration(handle: Long, generation: Long): Boolean

    @JvmStatic
    private external fun nativeCompleteHttpRequest(handle: Long, requestId: Long, responseJson: String)
  }
}
