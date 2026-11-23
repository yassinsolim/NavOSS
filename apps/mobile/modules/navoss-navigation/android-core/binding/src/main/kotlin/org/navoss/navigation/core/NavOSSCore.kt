package org.navoss.navigation.core

/**
 * The Swift navigation core (`libNavOSSCore.so`) behind its JSON boundary. The contract (every
 * call, callback, thread rule and error code) is `docs/architecture/android-core.md`.
 *
 * Calls are synchronous and may come from any thread. Arguments and results are JSON strings in
 * the shapes of `modules/navoss-navigation/index.ts`. A failing call throws
 * [NavOSSCoreException]; nothing else crosses the boundary, except an `OutOfMemoryError` from
 * a string the JVM could not allocate.
 *
 * Every call after [close] throws `NavOSSCoreException("closed")`. See [close] for what it
 * waits for.
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

    /**
     * Stop request [requestId] and do not answer it. Always after its [httpRequest] returned,
     * never with the engine lock held; may arrive for a request already answered (ignore it).
     */
    fun cancelHttpRequest(requestId: Long)

    /** Called with the engine lock held: must not call into [NavOSSCore]. */
    fun storageRead(key: String): String?

    /** Called with the engine lock held: must not call into [NavOSSCore]. `null` removes. */
    fun storageWrite(key: String, value: String?)

    /** Called with the engine lock held: must not call into [NavOSSCore]. Unix milliseconds. */
    fun nowMs(): Double
  }

  private val gate: HandleGate

  init {
    loadError()?.let { throw IllegalStateException("The navigation core is unavailable", it) }
    gate = HandleGate(nativeCreate(configJson, host), ::nativeDestroy)
  }

  fun resumePersistedTrip(): String = gate.call { nativeResumePersistedTrip(it) }

  fun setRoute(tripJson: String): String = gate.call { nativeSetRoute(it, tripJson) }

  fun updateLocation(sampleJson: String): String = gate.call { nativeUpdateLocation(it, sampleJson) }

  fun clearRoute(): String = gate.call { nativeClearRoute(it) }

  fun getSnapshot(): String = gate.call { nativeGetSnapshot(it) }

  fun acceptRerouteProposal(id: String): Boolean = gate.call { nativeAcceptRerouteProposal(it, id) }

  fun declineRerouteProposal(id: String): Boolean = gate.call { nativeDeclineRerouteProposal(it, id) }

  fun setRerouteMode(mode: String) = gate.call { nativeSetRerouteMode(it, mode) }

  fun setAudioMode(mode: String) = gate.call { nativeSetAudioMode(it, mode) }

  fun setSpeedingWarning(toleranceKph: Int, audible: Boolean) =
    gate.call { nativeSetSpeedingWarning(it, toleranceKph, audible) }

  fun setAnnounceRoadReports(enabled: Boolean) = gate.call { nativeSetAnnounceRoadReports(it, enabled) }

  fun getPreferences(): String = gate.call { nativeGetPreferences(it) }

  fun clockTick() = gate.call { nativeClockTick(it) }

  fun isCurrentGeneration(generation: Long): Boolean =
    gate.call { nativeIsCurrentGeneration(it, generation) }

  fun completeHttpRequest(requestId: Long, responseJson: String) =
    gate.call { nativeCompleteHttpRequest(it, requestId, responseJson) }

  /**
   * Closes the engine. From then on every call throws `NavOSSCoreException("closed")` and no
   * [Host] callback starts.
   *
   * Before it returns it cancels the requests the host still holds ([Host.cancelHttpRequest],
   * on this thread) and waits for callbacks running on other threads to return. So do not
   * call it while holding a lock that a callback takes, or from a thread a callback is
   * waiting for.
   *
   * Called from inside a callback it cannot wait for the callback it is in, so it does not
   * wait at all: callbacks already running (that one, and any on other threads) finish, and
   * none starts.
   *
   * Calls that were running when it was called finish normally against an engine that no
   * longer calls back; the native memory is released when the last of them returns.
   * Idempotent; a second call, also one made while the first is still waiting, returns at once.
   */
  override fun close() = gate.close { nativeClose(it) }

  companion object {
    /** The boundary version this binding speaks; the library must report the same. */
    const val ABI_VERSION = 2

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

    /** Cancels pending requests and stops callbacks; the handle stays valid. */
    @JvmStatic private external fun nativeClose(handle: Long)

    /** Releases the handle. Once, after [nativeClose], with no call using it. */
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
