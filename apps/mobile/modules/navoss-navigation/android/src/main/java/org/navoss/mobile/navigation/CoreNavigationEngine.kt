package org.navoss.mobile.navigation

/**
 * The calls of `org.navoss.navigation.core.NavOSSCore` (contract v1,
 * `docs/architecture/android-core.md`), one for one. Production adapts the real binding to it
 * ([NavOSSCoreBinding]); JVM tests script it. Failing calls throw [NavigationEngineException]
 * carrying the core's error `code`.
 */
interface NavigationCore : AutoCloseable {
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

/** [NavigationEngine] over the shared Swift core: every snapshot is the core's JSON, untouched. */
class CoreNavigationEngine(
  private val core: NavigationCore,
  override val contractVersion: Int,
) : NavigationEngine {
  override fun resumePersistedTrip(): String = core.resumePersistedTrip()

  override fun setRoute(tripJson: String): String = core.setRoute(tripJson)

  override fun updateLocation(sampleJson: String): String = core.updateLocation(sampleJson)

  override fun clearRoute(): String = core.clearRoute()

  override fun snapshot(): String = core.getSnapshot()

  override fun acceptRerouteProposal(id: String): Boolean = core.acceptRerouteProposal(id)

  override fun declineRerouteProposal(id: String): Boolean = core.declineRerouteProposal(id)

  override fun setAudioMode(mode: NavigationAudioMode) = core.setAudioMode(mode.raw)

  override fun setRerouteMode(mode: RerouteMode) = core.setRerouteMode(mode.raw)

  override fun setSpeedingWarning(toleranceKph: Int, audible: Boolean) =
    core.setSpeedingWarning(toleranceKph, audible)

  override fun setAnnounceRoadReports(enabled: Boolean) = core.setAnnounceRoadReports(enabled)

  override fun isCurrentGeneration(generation: Long): Boolean = core.isCurrentGeneration(generation)

  override fun clockTick() = core.clockTick()

  override fun completeHttpRequest(requestId: Long, responseJson: String) =
    core.completeHttpRequest(requestId, responseJson)

  override fun close() = core.close()

  companion object {
    /**
     * The core when [loader] can provide one, otherwise [UnavailableNavigationEngine]. A missing
     * library, an ABI mismatch or a refused configuration never crashes the app.
     */
    fun create(
      loader: NavigationCoreLoader,
      configJson: String,
      host: NavigationCoreHost,
      rerouteMode: () -> RerouteMode,
    ): NavigationEngine {
      val error = try {
        loader.loadError()
      } catch (error: Throwable) {
        error
      }
      if (error != null) return UnavailableNavigationEngine(rerouteMode, error)
      return try {
        CoreNavigationEngine(loader.create(configJson, host), loader.contractVersion())
      } catch (error: RuntimeException) {
        UnavailableNavigationEngine(rerouteMode, error)
      } catch (error: LinkageError) {
        UnavailableNavigationEngine(rerouteMode, error)
      }
    }
  }
}
