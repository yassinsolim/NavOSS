package org.navoss.mobile.navigation

import org.json.JSONObject

/** How native navigation recovers once the driver leaves the selected route (iOS `NavOSSRerouteMode`). */
enum class RerouteMode(val raw: String) {
  ADAPTIVE("adaptive"),
  ASK_FIRST("ask-first"),
  KEEP_ROUTE("keep-route");

  companion object {
    fun from(raw: String?): RerouteMode? = entries.firstOrNull { it.raw == raw }
  }
}

/** Spoken guidance level (iOS `NavOSSCarPlayAudioMode`). */
enum class NavigationAudioMode(val raw: String) {
  ALL_GUIDANCE("all-guidance"),
  ALERTS_ONLY("alerts-only"),
  MUTED("muted");

  companion object {
    fun from(raw: String?): NavigationAudioMode? = entries.firstOrNull { it.raw == raw }
  }
}

data class NavigationCoordinate(val latitude: Double, val longitude: Double) {
  val isValid: Boolean
    get() = latitude.isFinite() && longitude.isFinite() &&
      latitude in -90.0..90.0 && longitude in -180.0..180.0
}

/**
 * A refused navigation call, with the stable `code` of the core's error table
 * (`docs/architecture/android-core.md`), or `guidance-unavailable` when no core is loaded.
 */
class NavigationEngineException(val code: String, message: String?, cause: Throwable? = null) :
  RuntimeException(message, cause)

/**
 * The boundary between the Expo module and the navigation core. Trips, location samples and
 * snapshots cross as the JSON of the JavaScript contract (`modules/navoss-navigation/index.ts`):
 * the module hands JS objects in as JSON and returns the snapshot JSON to JS without touching a
 * field. Failing calls throw [NavigationEngineException].
 */
interface NavigationEngine : AutoCloseable {
  /** The JS contract version of the loaded core, or `null` when guidance is unavailable. */
  val contractVersion: Int?

  /** Restores a trip saved before the process died. Called once, after creation. */
  fun resumePersistedTrip(): String
  fun setRoute(tripJson: String): String
  fun updateLocation(sampleJson: String): String
  fun clearRoute(): String
  fun snapshot(): String
  fun acceptRerouteProposal(id: String): Boolean
  fun declineRerouteProposal(id: String): Boolean
  fun setAudioMode(mode: NavigationAudioMode)
  fun setRerouteMode(mode: RerouteMode)
  fun setSpeedingWarning(toleranceKph: Int, audible: Boolean)
  fun setAnnounceRoadReports(enabled: Boolean)

  /** Whether `generation` is still the engine's navigation generation. */
  fun isCurrentGeneration(generation: Long): Boolean
  fun clockTick()
  fun completeHttpRequest(requestId: Long, responseJson: String)
}

/**
 * Stands in when the native core is missing or its ABI does not match: it reports an idle,
 * guidance-free state and refuses trips, so the app says guidance is unavailable instead of
 * crashing or pretending to navigate.
 */
class UnavailableNavigationEngine(
  private val rerouteMode: () -> RerouteMode,
  /** Why the core could not be loaded; kept for diagnostics, never shown verbatim. */
  val reason: Throwable?,
) : NavigationEngine {
  override val contractVersion: Int? = null

  override fun resumePersistedTrip(): String = snapshot()

  override fun setRoute(tripJson: String): String = throw unavailable()

  override fun updateLocation(sampleJson: String): String = throw unavailable()

  override fun clearRoute(): String = snapshot()

  override fun snapshot(): String = JSONObject()
    .put("isDeadReckoning", false)
    .put("isOffRoute", false)
    .put("phase", "idle")
    .put("rerouteCount", 0)
    .put("rerouteMode", rerouteMode().raw)
    .put("routeProgress", 0)
    .put("routeStatus", "tracking")
    .put("routeVersion", 0)
    .put("sequence", 0)
    .put("speedingState", "unknown")
    .put("stateVersion", 0)
    .toString()

  override fun acceptRerouteProposal(id: String): Boolean = false

  override fun declineRerouteProposal(id: String): Boolean = false

  override fun setAudioMode(mode: NavigationAudioMode) = Unit

  override fun setRerouteMode(mode: RerouteMode) = Unit

  override fun setSpeedingWarning(toleranceKph: Int, audible: Boolean) = Unit

  override fun setAnnounceRoadReports(enabled: Boolean) = Unit

  override fun isCurrentGeneration(generation: Long): Boolean = false

  override fun clockTick() = Unit

  override fun completeHttpRequest(requestId: Long, responseJson: String) = Unit

  override fun close() = Unit

  private fun unavailable() = NavigationEngineException(
    GUIDANCE_UNAVAILABLE,
    "Turn-by-turn guidance is not available in this build.",
    reason,
  )

  companion object {
    const val GUIDANCE_UNAVAILABLE = "guidance-unavailable"
  }
}
