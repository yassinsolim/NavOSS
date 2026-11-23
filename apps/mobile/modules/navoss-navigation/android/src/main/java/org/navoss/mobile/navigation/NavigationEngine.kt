package org.navoss.mobile.navigation

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

data class NavigationLocationSample(
  val coordinate: NavigationCoordinate,
  val courseDegrees: Double?,
  val horizontalAccuracyMeters: Double?,
  val speedMetersPerSecond: Double?,
  /** Fix time in milliseconds since the Unix epoch. */
  val timestampMs: Double,
)

/**
 * A trip as the phone hands it over. `payload` is the validated contract object (`NativeCarPlayTrip`)
 * that a snapshot reports back while the trip is active.
 */
data class NavigationTrip(
  val id: String,
  val destination: NavigationDestination,
  val geometry: List<NavigationCoordinate>,
  val payload: Map<String, Any?>,
)

enum class NavigationPhase(val raw: String) { IDLE("idle"), TRACKING("tracking"), ARRIVED("arrived") }

/**
 * What the engine knows, in the shape of the JS `NativeNavigationSnapshot` minus fields this engine
 * never produces. Absent values are omitted from the payload, never invented.
 */
data class NavigationSnapshot(
  val phase: NavigationPhase,
  val isOffRoute: Boolean,
  val isDeadReckoning: Boolean,
  val rerouteCount: Int,
  val rerouteMode: RerouteMode,
  val routeProgress: Double,
  val routeStatus: String,
  val routeVersion: Int,
  val sequence: Int,
  val speedingState: String,
  val stateVersion: Int,
  val rawCoordinate: NavigationCoordinate?,
  val horizontalAccuracyMeters: Double?,
  val speedMetersPerSecond: Double?,
  val trip: NavigationTrip?,
)

class InvalidNavigationInput(message: String) : IllegalArgumentException(message)

/**
 * The boundary between the Expo module and whatever runs navigation on Android: a port of the
 * Swift core, or the Swift core itself cross-compiled. Kept narrow on purpose.
 */
interface NavigationEngine {
  fun setRoute(trip: NavigationTrip): NavigationSnapshot
  fun updateLocation(sample: NavigationLocationSample): NavigationSnapshot
  fun clearRoute(): NavigationSnapshot
  fun snapshot(): NavigationSnapshot
  fun acceptRerouteProposal(id: String): Boolean
  fun declineRerouteProposal(id: String): Boolean
  fun setAudioMode(mode: NavigationAudioMode)
  fun setRerouteMode(mode: RerouteMode)
  fun setSpeedingWarning(toleranceKph: Int, audible: Boolean)
  fun stopAnnouncements()
  /** Called after every state change, on the thread that made it. `null` removes the listener. */
  fun setSnapshotListener(listener: ((NavigationSnapshot) -> Unit)?)
}

/**
 * Keeps the trip and the last fix and reports `idle` / `tracking` honestly. It does no matching,
 * guidance, rerouting, speech or arrival: no step, progress, matched position or speed state is
 * ever reported, and it never proposes a reroute.
 */
class PlaceholderNavigationEngine(
  private var rerouteMode: RerouteMode,
) : NavigationEngine {
  private val lock = Any()
  private var trip: NavigationTrip? = null
  private var lastFix: NavigationLocationSample? = null
  private var routeVersion = 0
  private var sequence = 0
  private var stateVersion = 0
  private var listener: ((NavigationSnapshot) -> Unit)? = null

  override fun setRoute(trip: NavigationTrip): NavigationSnapshot = change {
    this.trip = trip
    routeVersion += 1
  }

  override fun updateLocation(sample: NavigationLocationSample): NavigationSnapshot {
    if (!sample.coordinate.isValid || !sample.timestampMs.isFinite() || sample.timestampMs <= 0) {
      throw InvalidNavigationInput("A live fix needs a valid coordinate and a capture time.")
    }
    return change {
      lastFix = sample
      sequence += 1
    }
  }

  override fun clearRoute(): NavigationSnapshot = change { trip = null }

  override fun snapshot(): NavigationSnapshot = synchronized(lock) { snapshotLocked() }

  override fun acceptRerouteProposal(id: String): Boolean = false

  override fun declineRerouteProposal(id: String): Boolean = false

  override fun setAudioMode(mode: NavigationAudioMode) = Unit

  override fun setRerouteMode(mode: RerouteMode) {
    change { rerouteMode = mode }
  }

  override fun setSpeedingWarning(toleranceKph: Int, audible: Boolean) = Unit

  override fun stopAnnouncements() = Unit

  override fun setSnapshotListener(listener: ((NavigationSnapshot) -> Unit)?) {
    synchronized(lock) { this.listener = listener }
  }

  private inline fun change(update: () -> Unit): NavigationSnapshot {
    val (snapshot, listener) = synchronized(lock) {
      update()
      stateVersion += 1
      snapshotLocked() to listener
    }
    listener?.invoke(snapshot)
    return snapshot
  }

  private fun snapshotLocked(): NavigationSnapshot {
    val fix = lastFix
    val trip = trip
    return NavigationSnapshot(
      phase = if (trip == null) NavigationPhase.IDLE else NavigationPhase.TRACKING,
      isOffRoute = false,
      isDeadReckoning = false,
      rerouteCount = 0,
      rerouteMode = rerouteMode,
      routeProgress = 0.0,
      routeStatus = "tracking",
      routeVersion = routeVersion,
      sequence = sequence,
      speedingState = "unknown",
      stateVersion = stateVersion,
      rawCoordinate = fix?.coordinate,
      horizontalAccuracyMeters = fix?.horizontalAccuracyMeters,
      speedMetersPerSecond = fix?.speedMetersPerSecond,
      trip = trip,
    )
  }
}
