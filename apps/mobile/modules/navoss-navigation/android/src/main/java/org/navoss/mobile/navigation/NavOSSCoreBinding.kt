package org.navoss.mobile.navigation

import org.navoss.navigation.core.NavOSSCore
import org.navoss.navigation.core.NavOSSCoreException

/** Loads the Swift core through its Kotlin binding (`android-core/binding`). */
internal object NavOSSCoreLoader : NavigationCoreLoader {
  override fun loadError(): Throwable? = NavOSSCore.loadError()

  override fun contractVersion(): Int = NavOSSCore.contractVersion()

  override fun create(configJson: String, host: NavigationCoreHost): NavigationCore =
    NavOSSCoreBinding(coreCall { NavOSSCore(configJson, HostAdapter(host)) })
}

/** [NavigationCore] over the real binding: its exceptions become [NavigationEngineException]. */
private class NavOSSCoreBinding(private val core: NavOSSCore) : NavigationCore {
  override fun resumePersistedTrip(): String = coreCall { core.resumePersistedTrip() }
  override fun setRoute(tripJson: String): String = coreCall { core.setRoute(tripJson) }
  override fun updateLocation(sampleJson: String): String = coreCall { core.updateLocation(sampleJson) }
  override fun clearRoute(): String = coreCall { core.clearRoute() }
  override fun getSnapshot(): String = coreCall { core.getSnapshot() }
  override fun acceptRerouteProposal(id: String): Boolean = coreCall { core.acceptRerouteProposal(id) }
  override fun declineRerouteProposal(id: String): Boolean = coreCall { core.declineRerouteProposal(id) }
  override fun setRerouteMode(mode: String) = coreCall { core.setRerouteMode(mode) }
  override fun setAudioMode(mode: String) = coreCall { core.setAudioMode(mode) }
  override fun setSpeedingWarning(kph: Int, audible: Boolean) = coreCall { core.setSpeedingWarning(kph, audible) }
  override fun setAnnounceRoadReports(enabled: Boolean) = coreCall { core.setAnnounceRoadReports(enabled) }
  override fun getPreferences(): String = coreCall { core.getPreferences() }
  override fun clockTick() = coreCall { core.clockTick() }
  override fun isCurrentGeneration(generation: Long): Boolean = coreCall { core.isCurrentGeneration(generation) }
  override fun completeHttpRequest(requestId: Long, responseJson: String) =
    coreCall { core.completeHttpRequest(requestId, responseJson) }
  override fun close() = core.close()
}

private class HostAdapter(private val host: NavigationCoreHost) : NavOSSCore.Host {
  override fun onStateChanged(snapshotJson: String) = host.onStateChanged(snapshotJson)
  override fun speak(text: String, kind: String, generation: Long) = host.speak(text, kind, generation)
  override fun cancelSpeech(generation: Long) = host.cancelSpeech(generation)
  override fun needsLocationUpdates() = host.needsLocationUpdates()
  override fun reconcileLocationUpdates(generation: Long, shouldTrack: Boolean) =
    host.reconcileLocationUpdates(generation, shouldTrack)
  override fun startClock(generation: Long) = host.startClock(generation)
  override fun stopClock(generation: Long) = host.stopClock(generation)
  override fun httpRequest(requestId: Long, requestJson: String) = host.httpRequest(requestId, requestJson)
  override fun cancelHttpRequest(requestId: Long) = host.cancelHttpRequest(requestId)
  override fun storageRead(key: String): String? = host.storageRead(key)
  override fun storageWrite(key: String, value: String?) = host.storageWrite(key, value)
  override fun nowMs(): Double = host.nowMs()
}

private inline fun <T> coreCall(body: () -> T): T = try {
  body()
} catch (error: NavOSSCoreException) {
  throw NavigationEngineException(error.code, error.message, error)
}
