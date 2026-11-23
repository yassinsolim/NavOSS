package org.navoss.mobile.navigation

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import java.io.File
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import org.json.JSONException
import org.json.JSONObject

/**
 * The Android host of the shared navigation core, one per process so a trip outlives the React
 * context, the activity and the screen (iOS `NavOSSNavigationService`). It owns the platform side
 * of the contract: trip location and the foreground service, speech and audio focus, the
 * one-second clock, HTTP, trip storage and the simulated drive.
 *
 * Effects the core asks for are posted to one navigation thread and checked against the current
 * navigation generation there, as the iOS service does on its main queue.
 */
class NavigationRuntime private constructor(
  context: Context,
  loader: NavigationCoreLoader,
) : NavigationCoreHost {
  private val context = context.applicationContext
  private val thread = HandlerThread("NavOSSNavigation").apply { start() }
  private val handler = Handler(thread.looper)
  private val settings = this.context.getSharedPreferences(PREFERENCES_FILE, Context.MODE_PRIVATE)
  val preferences = NavigationPreferencesStore(settings)

  /** The API origin the JS bundle was built with (`EXPO_PUBLIC_API_URL`, written by the config plugin). */
  private val apiBaseUrl: String? = this.context.packageManager
    .getApplicationInfo(this.context.packageName, PackageManager.GET_META_DATA)
    .metaData?.getString(API_URL_META_DATA)

  private val snapshotLock = Any()
  @Volatile private var lastSnapshot: String? = null
  private var lastStateVersion = -1L
  private var notificationUpdatePosted = false
  private val snapshotListeners = CopyOnWriteArraySet<(String) -> Unit>()
  private val simulationListeners = CopyOnWriteArraySet<(Boolean) -> Unit>()
  private val hostStatusListeners = CopyOnWriteArraySet<(HostStatus) -> Unit>()

  private val storage = TripStorage(File(this.context.noBackupFilesDir, "navoss-navigation")) { durable ->
    if (!durable) Log.w(LOG_TAG, "trip storage write failed; retrying at the next checkpoint")
    // Called with the engine lock held: never call back into the core from here.
    handler.post(::publishHostStatus)
  }
  private val http = HttpTransport(
    apiBaseUrl ?: "",
    executor = Executors.newCachedThreadPool { Thread(it, "NavOSSNavigationHttp").apply { isDaemon = true } },
    timer = Executors.newSingleThreadScheduledExecutor { Thread(it, "NavOSSNavigationHttpTimer").apply { isDaemon = true } },
    complete = { id, response -> engine.completeHttpRequest(id, response) },
  )
  private val clock = NavigationClock(HandlerTicker(handler), ::isCurrentGeneration) { engine.clockTick() }
  private lateinit var speech: GuidanceSpeech
  private val synthesizer = AndroidSpeechSynthesizer(
    this.context,
    handler,
    onStart = { speech.onStart(it) },
    onDone = { speech.onDone(it) },
    onAvailabilityChanged = { publishHostStatus() },
  )
  private val focus = AndroidGuidanceAudioFocus(this.context, handler) { speech.onFocusLost() }
  private val location = NavigationLocationProvider(this.context, handler, ::onFix)
  private val fixFilter = LocationFixFilter()
  internal val notification = TripNotification(this.context)

  private var serviceRequested = false
  private var simulation: DriveSimulation? = null
  private var simulationTick: Runnable? = null

  /** A simulated drive owns the trip's input: real fixes are ignored while it runs. */
  @Volatile var isSimulating = false
    private set

  @Volatile var engine: NavigationEngine = UnavailableNavigationEngine({ preferences.load().rerouteMode }, null)
    private set

  init {
    speech = GuidanceSpeech(synthesizer, focus, HandlerScheduler(handler), ::isCurrentGeneration)
    engine = CoreNavigationEngine.create(loader, createConfig(), this) { preferences.load().rerouteMode }
    (engine as? UnavailableNavigationEngine)?.reason?.let {
      Log.w(LOG_TAG, "navigation core unavailable: ${it.javaClass.simpleName}: ${it.message}")
    }
    if (apiBaseUrl == null) Log.w(LOG_TAG, "no API URL in the manifest: reroutes and safety cameras are unavailable")
    acceptSnapshot(engine.resumePersistedTrip())
    // Phase and flags only: never coordinates or the trip.
    parse(lastSnapshot ?: "")?.let {
      Log.i(LOG_TAG, "resume phase=${it.optString("phase")} acquiring=${it.optBoolean("isAcquiringPosition")} " +
        "endReason=${it.optString("tripEndReason", "none")}")
    }
  }

  /** What the host knows that the core's snapshot does not say (Android only). */
  data class HostStatus(
    /** `false` once text-to-speech failed to start or has no usable voice: prompts are not spoken. */
    val speechAvailable: Boolean,
    /** `false` while the active trip is not on disk: it would not be restored if the app closed. */
    val tripSaved: Boolean,
  )

  val hostStatus: HostStatus
    get() = HostStatus(speechAvailable = synthesizer.isAvailable, tripSaved = storage.isDurable)

  fun addHostStatusListener(listener: (HostStatus) -> Unit) = hostStatusListeners.add(listener)

  fun removeHostStatusListener(listener: (HostStatus) -> Unit) = hostStatusListeners.remove(listener)

  private fun publishHostStatus() {
    val status = hostStatus
    hostStatusListeners.forEach { it(status) }
  }

  val capabilities: Map<String, Any?>
    get() {
      val guidance = engine.contractVersion != null
      return mapOf(
        "arrivalDetection" to guidance,
        "backgroundLocation" to guidance,
        "carPlayTripBridge" to false,
        "courseMatching" to guidance,
        "deadReckoning" to guidance,
        "geometryGuidance" to guidance,
        "implementation" to "native-android",
        "nativeSafetyCameraAlerts" to guidance,
        "offRouteDetection" to guidance,
        "replayInput" to guidance,
        "rerouteConsent" to guidance,
        "routeContinuity" to guidance,
        "routeMatching" to guidance,
        "safetyCameraAnnouncements" to guidance,
        "speedingWarning" to guidance,
        // The JS contract the module implements; an unavailable core still answers it, with
        // every guidance flag off.
        "version" to (engine.contractVersion ?: MODULE_CONTRACT_VERSION),
      )
    }

  fun locationAvailability(): LocationAvailability = location.availability()

  fun addSnapshotListener(listener: (String) -> Unit) = snapshotListeners.add(listener)

  fun removeSnapshotListener(listener: (String) -> Unit) = snapshotListeners.remove(listener)

  fun addSimulationListener(listener: (Boolean) -> Unit) = simulationListeners.add(listener)

  fun removeSimulationListener(listener: (Boolean) -> Unit) = simulationListeners.remove(listener)

  // Navigation calls from the module

  fun setRoute(tripJson: String): String {
    if (isSimulating) handler.post { stopSimulation() }
    setSimulating(false)
    return engine.setRoute(tripJson)
  }

  /** Starts `tripJson` driven by [DriveSimulation] instead of real fixes. */
  fun startSimulatedDrive(tripJson: String): String {
    val path = try {
      DriveSimulation.fromTrip(tripJson)
    } catch (_: JSONException) {
      null
    } ?: throw NavigationEngineException("invalid-route", "This route cannot be simulated.")
    setSimulating(true)
    val snapshot = try {
      engine.setRoute(tripJson)
    } catch (error: RuntimeException) {
      setSimulating(false)
      throw error
    }
    handler.post { startSimulation(path) }
    return snapshot
  }

  fun updateLocation(sampleJson: String): String {
    if (isSimulating) {
      throw NavigationEngineException("simulation-active", "A simulated drive is running; real fixes are ignored.")
    }
    return engine.updateLocation(sampleJson)
  }

  fun stopAnnouncements() {
    handler.post { speech.stopAll() }
  }

  internal fun endTripFromNotification() {
    engine.clearRoute()
  }

  internal fun notificationContent(): TripNotificationContent =
    TripNotificationContent.from(lastSnapshot, isSimulating)

  // NavigationCoreHost

  override fun onStateChanged(snapshotJson: String) {
    if (!acceptSnapshot(snapshotJson)) return
    snapshotListeners.forEach { it(snapshotJson) }
    synchronized(snapshotLock) {
      if (notificationUpdatePosted) return
      notificationUpdatePosted = true
    }
    // Coalesced: one parse for however many snapshots arrived meanwhile, of the newest.
    handler.post {
      val latest = synchronized(snapshotLock) {
        notificationUpdatePosted = false
        lastSnapshot
      }
      if (serviceRequested) notification.update(TripNotificationContent.from(latest, isSimulating))
    }
  }

  /**
   * Caches [snapshotJson] unless a newer one is already cached: the core's callbacks run on
   * several threads, so snapshot N can arrive after N+1. Returns whether it was accepted.
   */
  private fun acceptSnapshot(snapshotJson: String): Boolean = synchronized(snapshotLock) {
    val version = stateVersionOf(snapshotJson)
    if (version != null && version < lastStateVersion) return false
    if (version != null) lastStateVersion = version
    lastSnapshot = snapshotJson
    true
  }

  override fun speak(text: String, kind: String, generation: Long) {
    handler.post { speech.speak(text, generation) }
  }

  override fun cancelSpeech(generation: Long) {
    handler.post { speech.cancel(generation) }
  }

  override fun needsLocationUpdates() {
    // Called outside the engine lock, so a reroute's request can be queued after End's stop:
    // start only for a trip that is still active when it runs.
    handler.post { if (hasActiveTrip()) startTripLocation() }
  }

  override fun reconcileLocationUpdates(generation: Long, shouldTrack: Boolean) {
    handler.post {
      if (!isCurrentGeneration(generation)) return@post
      if (shouldTrack) startTripLocation() else stopTripLocation()
    }
  }

  override fun startClock(generation: Long) {
    handler.post { clock.start(generation) }
  }

  override fun stopClock(generation: Long) {
    handler.post { clock.stop(generation) }
  }

  override fun httpRequest(requestId: Long, requestJson: String) = http.request(requestId, requestJson)

  override fun cancelHttpRequest(requestId: Long) = http.cancel(requestId)

  override fun storageRead(key: String): String? = storage.read(key)

  // A simulated drive is never written to disk, so it can never be restored as a real trip; a
  // real trip it replaced is removed. Checked under the engine lock the core writes with, and
  // the flag is set before the simulated route reaches the core.
  override fun storageWrite(key: String, value: String?) = storage.write(key, if (isSimulating) null else value)

  override fun nowMs(): Double = System.currentTimeMillis().toDouble()

  // Navigation thread

  private fun isCurrentGeneration(generation: Long): Boolean = engine.isCurrentGeneration(generation)

  private fun hasActiveTrip(): Boolean = parse(engine.snapshot())?.let { it.has("trip") && !it.isNull("trip") } == true

  private fun startTripLocation() {
    if (!isSimulating && !location.start()) {
      Log.w(LOG_TAG, "trip location unavailable: ${location.availability().raw}")
      return
    }
    if (serviceRequested) return
    serviceRequested = true
    startService()
  }

  private fun startService() {
    try {
      val intent = Intent(context, NavigationForegroundService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    } catch (error: RuntimeException) {
      // Started from the background (a reroute while the service was not running): location
      // keeps working while the process lives; the next foreground start retries the service.
      serviceRequested = false
      Log.w(LOG_TAG, "foreground service not started: ${error.javaClass.simpleName}")
    }
  }

  private fun stopTripLocation() {
    location.stop()
    fixFilter.reset()
    stopSimulation()
    if (serviceRequested) {
      serviceRequested = false
      context.stopService(Intent(context, NavigationForegroundService::class.java))
    }
  }

  private fun onFix(fix: RawFix) {
    if (isSimulating) return
    val sample = fixFilter.accept(fix, System.currentTimeMillis()) ?: return
    try {
      engine.updateLocation(sample)
    } catch (_: NavigationEngineException) {
      // No active trip any more, or the core refused this fix; the next fix tries again.
    }
  }

  private fun startSimulation(path: DriveSimulation) {
    stopSimulation(keepFlag = true)
    location.stop()
    simulation = path
    var lastTick = SystemClock.elapsedRealtime()
    val tick = object : Runnable {
      override fun run() {
        if (simulation !== path || !isSimulating) return
        val now = SystemClock.elapsedRealtime()
        val sample = path.next((now - lastTick) / 1_000.0, System.currentTimeMillis())
        lastTick = now
        val phase = sample?.let {
          try {
            JSONObject(engine.updateLocation(it)).optString("phase")
          } catch (_: RuntimeException) {
            null
          }
        }
        if (phase != "tracking") {
          stopSimulation()
          // Out of samples (an arrival still waiting for movement) or refused: a simulated trip
          // never outlives its simulation. An arrival stays on screen; the core has ended it.
          if (phase != "arrived") engine.clearRoute()
          return
        }
        handler.postDelayed(this, SIMULATION_TICK_MS)
      }
    }
    simulationTick = tick
    handler.post(tick)
    startTripLocation()
  }

  private fun stopSimulation(keepFlag: Boolean = false) {
    simulationTick?.let(handler::removeCallbacks)
    simulationTick = null
    simulation = null
    if (!keepFlag) setSimulating(false)
  }

  private fun setSimulating(value: Boolean) {
    if (isSimulating == value) return
    isSimulating = value
    simulationListeners.forEach { it(value) }
    // A running service is promoted again with the type the new trip needs.
    handler.post { if (serviceRequested) startService() }
  }

  private fun createConfig(): String {
    val stored = preferences.load()
    return JSONObject()
      .put("apiBaseUrl", apiBaseUrl ?: "")
      .put("audioMode", stored.audioMode.raw)
      .put("rerouteMode", stored.rerouteMode.raw)
      .put("speedingToleranceKph", stored.speedingToleranceKph)
      .put("speedingAudibleWarning", stored.speedingAudibleWarning)
      .put("announceRoadReports", settings.getBoolean(ANNOUNCES_ROAD_REPORTS, true))
      .toString()
  }

  private class HandlerTicker(private val handler: Handler) : Ticker {
    private var runnable: Runnable? = null

    override fun start(intervalMs: Long, tick: () -> Unit) {
      stop()
      val next = object : Runnable {
        override fun run() {
          tick()
          handler.postDelayed(this, intervalMs)
        }
      }
      runnable = next
      handler.postDelayed(next, intervalMs)
    }

    override fun stop() {
      runnable?.let(handler::removeCallbacks)
      runnable = null
    }
  }

  private class HandlerScheduler(private val handler: Handler) : SpeechScheduler {
    override fun schedule(delayMs: Long, action: () -> Unit): Cancellable {
      val runnable = Runnable(action)
      handler.postDelayed(runnable, delayMs)
      return Cancellable { handler.removeCallbacks(runnable) }
    }
  }

  companion object {
    internal const val LOG_TAG = "NavOSSNavigation"
    const val PREFERENCES_FILE = "org.navoss.mobile.navigation"
    const val ANNOUNCES_ROAD_REPORTS = "org.navoss.mobile.community.announce-road-reports"
    const val MODULE_CONTRACT_VERSION = 11
    const val API_URL_META_DATA = "org.navoss.mobile.API_URL"
    private const val SIMULATION_TICK_MS = 1_000L

    @Volatile private var instance: NavigationRuntime? = null

    fun get(context: Context): NavigationRuntime =
      instance ?: synchronized(this) {
        instance ?: NavigationRuntime(context, NavOSSCoreLoader).also { instance = it }
      }

    private val STATE_VERSION = Regex("\"stateVersion\":(\\d+)")

    /** The top-level `stateVersion` without parsing the whole (large) snapshot: keys are sorted, and nothing nested before it carries one. */
    internal fun stateVersionOf(snapshotJson: String): Long? =
      STATE_VERSION.find(snapshotJson)?.groupValues?.get(1)?.toLongOrNull()

    /** Parses snapshot JSON for the bridge, or `null` when it is not an object. */
    fun parse(json: String): JSONObject? = try {
      JSONObject(json)
    } catch (_: JSONException) {
      null
    }
  }
}
