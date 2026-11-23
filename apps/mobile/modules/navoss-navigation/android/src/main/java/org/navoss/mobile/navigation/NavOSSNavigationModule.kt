package org.navoss.mobile.navigation

import android.Manifest
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import android.util.Log

private const val NAVIGATION_SNAPSHOT_EVENT = "onNavigationSnapshot"
private const val NAVIGATION_PREFERENCES_EVENT = "onNavigationPreferencesChanged"
private const val CARPLAY_STATE_EVENT = "onCarPlayStateChanged"
private const val CARPLAY_NAVIGATION_ENDED_EVENT = "onCarPlayNavigationEnded"
private const val OFFLINE_STATE_EVENT = "onOfflineStateChanged"
private const val COMMUNITY_STATE_EVENT = "onCommunityStateChanged"
private const val SIMULATED_DRIVE_EVENT = "onSimulatedDriveChanged"
private const val HOST_STATUS_EVENT = "onHostStatusChanged"

private const val SHARES_TRAFFIC_SPEEDS = "org.navoss.mobile.community.share-traffic-speeds"
private const val SHARES_ROAD_REPORTS = "org.navoss.mobile.community.share-road-reports"

/**
 * Android side of the `NavOSSNavigation` contract (version 11). Navigation runs in the shared
 * Swift core behind [NavigationEngine], hosted by the process-wide [NavigationRuntime]; trips,
 * fixes and snapshots cross as the core's JSON, untouched. CarPlay, community reports, offline
 * maps and Google place details do not exist on Android and report themselves unavailable in the
 * shapes the JavaScript expects.
 */
class NavOSSNavigationModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val sharedPreferences: SharedPreferences by lazy {
    context.getSharedPreferences(NavigationRuntime.PREFERENCES_FILE, Context.MODE_PRIVATE)
  }
  private val navigation: NavigationRuntime by lazy { NavigationRuntime.get(context) }
  private val preferencesStore by lazy { navigation.preferences }
  private val destinationStore by lazy { DestinationStore(sharedPreferences) }
  private val engine: NavigationEngine
    get() = navigation.engine

  // The core's JSON text crosses the bridge untouched; JavaScript parses it once
  // (`nativeSnapshot` in native-navigation.ts). Converting a ~48 KB snapshot into a map, field by
  // field across JNI, every second would cost far more.
  private val snapshotListener: (String) -> Unit = { snapshot ->
    sendEvent(NAVIGATION_SNAPSHOT_EVENT, mapOf("snapshotJson" to snapshot))
  }
  private val simulationListener: (Boolean) -> Unit = { active ->
    sendEvent(SIMULATED_DRIVE_EVENT, mapOf("active" to active))
  }
  private val hostStatusListener: (NavigationRuntime.HostStatus) -> Unit = { status ->
    sendEvent(HOST_STATUS_EVENT, hostStatusPayload(status))
  }

  private fun hostStatusPayload(status: NavigationRuntime.HostStatus) =
    mapOf(
      "speechAvailable" to status.speechAvailable,
      "tripSaved" to status.tripSaved,
    )

  override fun definition() = ModuleDefinition {
    Name("NavOSSNavigation")

    Events(
      NAVIGATION_SNAPSHOT_EVENT,
      NAVIGATION_PREFERENCES_EVENT,
      CARPLAY_STATE_EVENT,
      CARPLAY_NAVIGATION_ENDED_EVENT,
      OFFLINE_STATE_EVENT,
      COMMUNITY_STATE_EVENT,
      SIMULATED_DRIVE_EVENT,
      HOST_STATUS_EVENT,
    )

    OnCreate {
      // Creating the runtime restores a trip saved before the process died, as iOS does at launch.
      navigation.addSnapshotListener(snapshotListener)
      navigation.addSimulationListener(simulationListener)
      navigation.addHostStatusListener(hostStatusListener)
    }

    OnDestroy {
      navigation.removeSnapshotListener(snapshotListener)
      navigation.removeSimulationListener(simulationListener)
      navigation.removeHostStatusListener(hostStatusListener)
    }

    Function("getCapabilities") { navigation.capabilities }

    // Android only: what the core's snapshot cannot say (speech engine, trip storage).
    Function("getHostStatus") { hostStatusPayload(navigation.hostStatus) }

    Function("isGooglePlaceRatingAvailable") { false }
    Function("isCarPlayVisualHarness") { false }
    Function("getGooglePlacesOpenSourceLicenseInfo") { null as String? }

    // Navigation

    Function("getSnapshot") { snapshot(engine.snapshot()) }

    Function("setRoute") { trip: Map<String, Any?> ->
      requestNotificationPermission()
      snapshot(guarded { navigation.setRoute(record(trip)) })
    }

    Function("updateLocation") { location: Map<String, Any?> ->
      snapshot(guarded { navigation.updateLocation(record(location)) })
    }

    Function("clearRoute") { snapshot(navigation.clearRoute()) }

    Function("clearCarPlayTrip") { navigation.clearRoute(); Unit }

    Function("acceptRerouteProposal") { id: String -> engine.acceptRerouteProposal(id) }

    Function("declineRerouteProposal") { id: String -> engine.declineRerouteProposal(id) }

    Function("stopAnnouncements") { navigation.stopAnnouncements() }

    // Android only: devices without GPS and the simulated drive.

    Function("getLocationAvailability") { navigation.locationAvailability().raw }

    Function("startSimulatedDrive") { trip: Map<String, Any?> ->
      requestNotificationPermission()
      snapshot(guarded { navigation.startSimulatedDrive(record(trip)) })
    }

    Function("isSimulatingDrive") { navigation.isSimulating }

    Function("isSimulatedTrip") { navigation.isSimulatedTrip }

    // Preferences

    Function("getNavigationPreferences") { navigationPreferencesPayload() }

    Function("getAudioMode") { preferencesStore.load().audioMode.raw }

    Function("setAudioMode") { raw: String ->
      val mode = NavigationAudioMode.from(raw) ?: return@Function
      preferencesStore.setAudioMode(mode)
      engine.setAudioMode(mode)
      emitNavigationPreferences()
    }

    Function("getRoutePreferences") { serialize(preferencesStore.load().routePreferences) }

    // Records arrive as maps and are read explicitly (JsRecords), not through Expo's
    // reflection-based Record conversion.
    Function("setRoutePreferences") { record: Map<String, Any?> ->
      preferencesStore.setRoutePreferences(JsRecords.routePreferences(record))
      emitNavigationPreferences()
    }

    Function("setRerouteMode") { raw: String ->
      val mode = RerouteMode.from(raw) ?: return@Function
      preferencesStore.setRerouteMode(mode)
      engine.setRerouteMode(mode)
      emitNavigationPreferences()
    }

    Function("setSpeedingWarning") { toleranceKph: Int, audible: Boolean ->
      preferencesStore.setSpeedingWarning(toleranceKph, audible)
      val stored = preferencesStore.load()
      engine.setSpeedingWarning(stored.speedingToleranceKph, stored.speedingAudibleWarning)
      emitNavigationPreferences()
    }

    // Saved places

    Function("getDestinationCatalog") { serialize(destinationStore.snapshot()) }

    Function("getRecentDestinationIds") { destinationStore.snapshot().recents.map { it.id } }

    Function("recordRecentDestination") { record: Map<String, Any?> ->
      JsRecords.destination(record)?.let(destinationStore::recordRecent)
    }

    Function("clearRecentDestinations") { destinationStore.clearRecents() }

    Function("clearDestinationHistory") { destinationStore.clearDestinations() }

    Function("isFavoriteDestination") { id: String -> destinationStore.isFavorite(id) }

    Function("toggleFavoriteDestination") { record: Map<String, Any?> ->
      JsRecords.destination(record)?.let(destinationStore::toggleFavorite) ?: false
    }

    Function("replaceFavoriteDestinations") { records: List<Any?> ->
      destinationStore.replaceFavorites(JsRecords.destinations(records))
    }

    Function("setHomeDestination") { record: Map<String, Any?>? ->
      destinationStore.setHome(JsRecords.destination(record))
    }

    Function("setWorkDestination") { record: Map<String, Any?>? ->
      destinationStore.setWork(JsRecords.destination(record))
    }

    // CarPlay does not exist on Android.

    Function("getCarPlayState") { mapOf("connected" to false, "hasActiveTrip" to false) }

    // Community reports and traffic sharing need Apple App Attest; Android has neither yet.

    AsyncFunction("getCommunityState") { communityStatePayload() }

    AsyncFunction("fetchCommunityReports") { _: Map<String, Any?> -> communityUnsupported() }

    AsyncFunction("submitCommunityReport") { _: Map<String, Any?> -> communityUnsupported() }

    AsyncFunction("voteCommunityReport") { _: String, _: String, _: Map<String, Any?>? ->
      communityUnsupported()
    }

    AsyncFunction("withdrawCommunityReport") { _: String -> communityUnsupported() }

    AsyncFunction("resetCommunityIdentity") { communityUnsupported() }

    Function("dismissStillThere") { _: String -> }

    Function("setShareTrafficSpeeds") { enabled: Boolean ->
      setCommunityPreference(SHARES_TRAFFIC_SPEEDS, enabled)
    }

    Function("setShareRoadReports") { enabled: Boolean ->
      setCommunityPreference(SHARES_ROAD_REPORTS, enabled)
    }

    Function("setAnnounceRoadReports") { enabled: Boolean ->
      setCommunityPreference(NavigationRuntime.ANNOUNCES_ROAD_REPORTS, enabled)
      engine.setAnnounceRoadReports(enabled)
    }

    // Offline maps: there is no on-device map, search or routing engine for Android.

    Function("getOfflineState") { offlineStatePayload() }

    AsyncFunction("refreshOfflineManifest") { offlineStatePayload() }

    Function("downloadOfflineRegion") { _: String -> }

    Function("pauseOfflineRegion") { _: String -> }

    Function("deleteOfflineRegion") { _: String -> "deleted" }

    Function("offlineRegionCovers") { _: List<Map<String, Any?>> -> false }

    Function("setPreferOfflineMaps") { _: Boolean -> }

    Function("getOfflineMapStyle") { _: String, _: Double?, _: Double? -> null as Map<String, Any?>? }

    AsyncFunction("planOfflineRoutes") { _: Map<String, Any?> ->
      mapOf("ok" to false, "code" to "engine-unavailable")
    }

    AsyncFunction("searchOffline") { _: String, _: Double?, _: Double?, _: Int, _: String? ->
      mapOf("ok" to false, "code" to "engine-unavailable")
    }
  }

  private fun <T> guarded(body: () -> T): T = try {
    body()
  } catch (error: NavigationEngineException) {
    throw CodedException("ERR_NAVOSS_" + error.code.uppercase().replace('-', '_'), error.message, error)
  }

  private fun snapshot(json: String): Map<String, Any?> = mapOf("snapshotJson" to json)

  /** A trip or fix for the core, `null` values kept as JSON `null`; each new null path is logged once (names only). */
  private fun record(map: Map<String, Any?>): String = JsRecordJson.encode(map) { path ->
    if (reportedNullPaths.add(path)) Log.i(NavigationRuntime.LOG_TAG, "null field $path")
  }

  private val reportedNullPaths = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

  /** Android 13+ shows the trip notification only with this permission; guidance works without it. */
  private fun requestNotificationPermission() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
    appContext.permissions?.askForPermissions({ _ -> }, Manifest.permission.POST_NOTIFICATIONS)
  }

  private fun emitNavigationPreferences() {
    sendEvent(NAVIGATION_PREFERENCES_EVENT, navigationPreferencesPayload())
  }

  private fun navigationPreferencesPayload(): Map<String, Any?> {
    val preferences = preferencesStore.load()
    return mapOf(
      "audioMode" to preferences.audioMode.raw,
      "rerouteMode" to preferences.rerouteMode.raw,
      "routePreferences" to serialize(preferences.routePreferences),
      "speedingAudibleWarning" to preferences.speedingAudibleWarning,
      "speedingToleranceKph" to preferences.speedingToleranceKph,
    )
  }

  private fun setCommunityPreference(key: String, enabled: Boolean) {
    sharedPreferences.edit().putBoolean(key, enabled).apply()
    sendEvent(COMMUNITY_STATE_EVENT, communityStatePayload())
  }

  private fun communityStatePayload(): Map<String, Any?> = mapOf(
    "canWrite" to false,
    "hasIdentity" to false,
    "preferences" to mapOf(
      "announcesRoadReports" to sharedPreferences.getBoolean(NavigationRuntime.ANNOUNCES_ROAD_REPORTS, true),
      "sharesRoadReports" to sharedPreferences.getBoolean(SHARES_ROAD_REPORTS, false),
      "sharesTrafficSpeeds" to sharedPreferences.getBoolean(SHARES_TRAFFIC_SPEEDS, false),
    ),
    "reports" to emptyList<Any>(),
    "trafficSharing" to mapOf("state" to "unavailable", "reason" to "unsupported"),
  )

  private fun communityUnsupported(): Map<String, Any?> = mapOf("ok" to false, "error" to "unsupported")

  private fun offlineStatePayload(): Map<String, Any?> = mapOf(
    "catalog" to "unsupported",
    // Not measured: no offline feature reads it while the catalog is unsupported.
    "networkAvailable" to true,
    "preferOffline" to false,
    "regions" to emptyList<Any>(),
    "stale" to false,
    "storageBytes" to 0,
  )

  private fun serialize(preferences: RoutePreferences): Map<String, Any?> = mapOf(
    "avoidFerries" to preferences.avoidFerries,
    "avoidHighways" to preferences.avoidHighways,
    "avoidTolls" to preferences.avoidTolls,
    "avoidUnpaved" to preferences.avoidUnpaved,
  )

  private fun serialize(destination: NavigationDestination): Map<String, Any?> = buildMap {
    destination.category?.let { put("category", it) }
    put("id", destination.id)
    put("label", destination.label)
    put("latitude", destination.latitude)
    put("longitude", destination.longitude)
    put("name", destination.name)
  }

  private fun serialize(catalog: DestinationCatalog): Map<String, Any?> = buildMap {
    put("favorites", catalog.favorites.map(::serialize))
    put("recents", catalog.recents.map(::serialize))
    catalog.home?.let { put("home", serialize(it)) }
    catalog.work?.let { put("work", serialize(it)) }
  }
}
