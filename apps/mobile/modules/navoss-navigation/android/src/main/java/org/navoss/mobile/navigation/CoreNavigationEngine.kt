package org.navoss.mobile.navigation

/**
 * The calls of `org.navoss.navigation.core.NavOSSCore` (contract v2,
 * `docs/architecture/android-core.md`), one for one, except `close()`: the host never closes the
 * core (see [NavigationRuntime]). Production adapts the real binding to it ([NavOSSCoreBinding]);
 * JVM tests script it. Failing calls throw [NavigationEngineException] carrying the core's error
 * `code`, or [OutOfMemoryError] when the JVM could not allocate a string at the boundary.
 */
interface NavigationCore {
  fun resumePersistedTrip(): String
  fun setRoute(tripJson: String): String
  fun updateLocation(sampleJson: String): String
  fun clearRoute(): String
  fun getSnapshot(): String
  fun acceptRerouteProposal(id: String): Boolean
  fun declineRerouteProposal(id: String): Boolean
  fun setRerouteMode(mode: String)
  fun setAudioMode(mode: String)
  fun setSpeedingWarning(kph: Int, audible: Boolean)
  fun setAnnounceRoadReports(enabled: Boolean)
  fun getPreferences(): String
  fun clockTick()
  fun isCurrentGeneration(generation: Long): Boolean
  fun completeHttpRequest(requestId: Long, responseJson: String)
}

/** `NavOSSCore.Host`: what the core asks of Android. See the contract for threading rules. */
interface NavigationCoreHost {
  fun onStateChanged(snapshotJson: String)
  fun speak(text: String, kind: String, generation: Long)
  fun cancelSpeech(generation: Long)
  fun needsLocationUpdates()
  fun reconcileLocationUpdates(generation: Long, shouldTrack: Boolean)
  fun startClock(generation: Long)
  fun stopClock(generation: Long)
  fun httpRequest(requestId: Long, requestJson: String)
  fun cancelHttpRequest(requestId: Long)
  fun storageRead(key: String): String?
  fun storageWrite(key: String, value: String?)
  fun nowMs(): Double
}

/** Loads the core: the contract version it reports, and a constructor. */
interface NavigationCoreLoader {
  /** `null` when the library loaded and its ABI matches; otherwise why it cannot be used. */
  fun loadError(): Throwable?
  fun contractVersion(): Int
  fun create(configJson: String, host: NavigationCoreHost): NavigationCore
}

/**
 * [NavigationEngine] over the shared Swift core: every snapshot is the core's JSON, untouched.
 *
 * This is the one boundary every call into the core crosses, so out of memory is handled here:
 * an [OutOfMemoryError] the boundary raises (contract v2, "JNI failures") or the core's own
 * `out-of-memory` refusal goes to [onOutOfMemory] (which ends the process, see [OutOfMemoryStop])
 * before anything is allocated; should it return, the call is refused with code `out-of-memory`.
 */
class CoreNavigationEngine(
  private val core: NavigationCore,
  override val contractVersion: Int,
  private val onOutOfMemory: () -> Unit = {},
) : NavigationEngine {
  override fun resumePersistedTrip(): String = call { core.resumePersistedTrip() }

  override fun setRoute(tripJson: String): String = call { core.setRoute(tripJson) }

  override fun updateLocation(sampleJson: String): String = call { core.updateLocation(sampleJson) }

  override fun clearRoute(): String = call { core.clearRoute() }

  override fun snapshot(): String = call { core.getSnapshot() }

  override fun acceptRerouteProposal(id: String): Boolean = call { core.acceptRerouteProposal(id) }

  override fun declineRerouteProposal(id: String): Boolean = call { core.declineRerouteProposal(id) }

  override fun setAudioMode(mode: NavigationAudioMode) = call { core.setAudioMode(mode.raw) }

  override fun setRerouteMode(mode: RerouteMode) = call { core.setRerouteMode(mode.raw) }

  override fun setSpeedingWarning(toleranceKph: Int, audible: Boolean) =
    call { core.setSpeedingWarning(toleranceKph, audible) }

  override fun setAnnounceRoadReports(enabled: Boolean) = call { core.setAnnounceRoadReports(enabled) }

  override fun isCurrentGeneration(generation: Long): Boolean = call { core.isCurrentGeneration(generation) }

  override fun clockTick() = call { core.clockTick() }

  override fun completeHttpRequest(requestId: Long, responseJson: String) =
    call { core.completeHttpRequest(requestId, responseJson) }

  private inline fun <T> call(body: () -> T): T = outOfMemoryBoundary(onOutOfMemory, body)

  companion object {
    const val OUT_OF_MEMORY = "out-of-memory"

    /** Runs a core call; out of memory goes to [onOutOfMemory] first, then the call is refused. */
    private inline fun <T> outOfMemoryBoundary(onOutOfMemory: () -> Unit, body: () -> T): T = try {
      body()
    } catch (error: OutOfMemoryError) {
      onOutOfMemory()
      throw NavigationEngineException(OUT_OF_MEMORY, "Not enough memory for this navigation call.", error)
    } catch (error: NavigationEngineException) {
      if (error.code == OUT_OF_MEMORY) onOutOfMemory()
      throw error
    }

    /**
     * The core when [loader] can provide one, otherwise [UnavailableNavigationEngine]. A missing
     * library, an ABI mismatch or a refused configuration never crashes the app.
     */
    fun create(
      loader: NavigationCoreLoader,
      configJson: String,
      host: NavigationCoreHost,
      reportHostFailure: (callback: String, error: Throwable) -> Unit = { _, _ -> },
      onOutOfMemory: () -> Unit = {},
      rerouteMode: () -> RerouteMode,
    ): NavigationEngine {
      val error = try {
        loader.loadError()
      } catch (error: Throwable) {
        error
      }
      if (error != null) return UnavailableNavigationEngine(rerouteMode, error)
      return try {
        val core = outOfMemoryBoundary(onOutOfMemory) { loader.create(configJson, GuardedHost(host, reportHostFailure)) }
        CoreNavigationEngine(core, loader.contractVersion(), onOutOfMemory)
      } catch (error: RuntimeException) {
        UnavailableNavigationEngine(rerouteMode, error)
      } catch (error: LinkageError) {
        UnavailableNavigationEngine(rerouteMode, error)
      }
    }
  }
}

/**
 * Catches what [host] throws inside a core callback and reports it, so the host's own failures
 * are visible: the core would clear them with one fixed log line naming only the callback
 * (contract v2, "Errors"). A failed `storageRead` reads as no value and a failed `nowMs` as the
 * system clock, as the core does.
 */
internal class GuardedHost(
  private val host: NavigationCoreHost,
  private val report: (callback: String, error: Throwable) -> Unit,
) : NavigationCoreHost {
  private inline fun <T> guard(callback: String, fallback: T, body: () -> T): T = try {
    body()
  } catch (error: Throwable) {
    try {
      report(callback, error)
    } catch (_: Throwable) {
      // Reporting must never throw into the core either.
    }
    fallback
  }

  override fun onStateChanged(snapshotJson: String) = guard("onStateChanged", Unit) { host.onStateChanged(snapshotJson) }
  override fun speak(text: String, kind: String, generation: Long) = guard("speak", Unit) { host.speak(text, kind, generation) }
  override fun cancelSpeech(generation: Long) = guard("cancelSpeech", Unit) { host.cancelSpeech(generation) }
  override fun needsLocationUpdates() = guard("needsLocationUpdates", Unit) { host.needsLocationUpdates() }
  override fun reconcileLocationUpdates(generation: Long, shouldTrack: Boolean) =
    guard("reconcileLocationUpdates", Unit) { host.reconcileLocationUpdates(generation, shouldTrack) }
  override fun startClock(generation: Long) = guard("startClock", Unit) { host.startClock(generation) }
  override fun stopClock(generation: Long) = guard("stopClock", Unit) { host.stopClock(generation) }
  override fun httpRequest(requestId: Long, requestJson: String) =
    guard("httpRequest", Unit) { host.httpRequest(requestId, requestJson) }
  override fun cancelHttpRequest(requestId: Long) = guard("cancelHttpRequest", Unit) { host.cancelHttpRequest(requestId) }
  override fun storageRead(key: String): String? = guard("storageRead", null) { host.storageRead(key) }
  override fun storageWrite(key: String, value: String?) = guard("storageWrite", Unit) { host.storageWrite(key, value) }
  override fun nowMs(): Double = guard("nowMs", System.currentTimeMillis().toDouble()) { host.nowMs() }
}
