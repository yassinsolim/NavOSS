package org.navoss.mobile.navigation

import android.content.Context
import android.content.SharedPreferences
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

private const val NAVIGATION_SNAPSHOT_EVENT = "onNavigationSnapshot"
private const val NAVIGATION_PREFERENCES_EVENT = "onNavigationPreferencesChanged"
private const val CARPLAY_STATE_EVENT = "onCarPlayStateChanged"
private const val CARPLAY_NAVIGATION_ENDED_EVENT = "onCarPlayNavigationEnded"
private const val OFFLINE_STATE_EVENT = "onOfflineStateChanged"
private const val COMMUNITY_STATE_EVENT = "onCommunityStateChanged"

private const val PREFERENCES_FILE = "org.navoss.mobile.navigation"
private const val SHARES_TRAFFIC_SPEEDS = "org.navoss.mobile.community.share-traffic-speeds"
private const val ANNOUNCES_ROAD_REPORTS = "org.navoss.mobile.community.announce-road-reports"
private const val SHARES_ROAD_REPORTS = "org.navoss.mobile.community.share-road-reports"

class NavigationLocationRecord : Record {
  @Field val courseDegrees: Double? = null
  @Field val horizontalAccuracyMeters: Double? = null
  @Field val latitude: Double = Double.NaN
  @Field val longitude: Double = Double.NaN
  @Field val speedMetersPerSecond: Double? = null
  @Field val timestampMs: Double? = null
}

class NavigationDestinationRecord : Record {
  @Field val category: String? = null
  @Field val id: String = ""
  @Field val label: String = ""
  @Field val latitude: Double = 0.0
  @Field val longitude: Double = 0.0
  @Field val name: String = ""

  val destination: NavigationDestination
    get() = NavigationDestination(category, id, label, latitude, longitude, name)
}

class RoutePreferencesRecord : Record {
  @Field val avoidFerries: Boolean = false
  @Field val avoidHighways: Boolean = false
  @Field val avoidTolls: Boolean = false
  @Field val avoidUnpaved: Boolean = false

  val preferences: RoutePreferences
    get() = RoutePreferences(avoidFerries, avoidHighways, avoidTolls, avoidUnpaved)
}

/**
 * Android side of the `NavOSSNavigation` contract (version 11). Navigation itself runs behind
 * [NavigationEngine]; CarPlay, community reports, offline maps and Google place details do not
 * exist on Android and report themselves unavailable in the shapes the JavaScript expects.
 */
class NavOSSNavigationModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val sharedPreferences: SharedPreferences by lazy {
    context.getSharedPreferences(PREFERENCES_FILE, Context.MODE_PRIVATE)
  }
  private val preferencesStore by lazy { NavigationPreferencesStore(sharedPreferences) }
  private val destinationStore by lazy { DestinationStore(sharedPreferences) }
  private val engine: NavigationEngine by lazy {
    PlaceholderNavigationEngine(preferencesStore.load().rerouteMode)
  }

  override fun definition() = ModuleDefinition {
    Name("NavOSSNavigation")

    Events(
      NAVIGATION_SNAPSHOT_EVENT,
      NAVIGATION_PREFERENCES_EVENT,
      CARPLAY_STATE_EVENT,
      CARPLAY_NAVIGATION_ENDED_EVENT,
      OFFLINE_STATE_EVENT,
      COMMUNITY_STATE_EVENT,
    )

    OnCreate {
      engine.setSnapshotListener { snapshot ->
        sendEvent(NAVIGATION_SNAPSHOT_EVENT, serialize(snapshot))
      }
    }

    OnDestroy {
      engine.setSnapshotListener(null)
    }

    Function("getCapabilities") {
      // The contract flags describe the module interface this build implements. The placeholder
      // engine behind it does no matching or guidance yet; snapshots say so by carrying none.
      mapOf(
        "arrivalDetection" to true,
        "backgroundLocation" to false,
        "carPlayTripBridge" to true,
        "courseMatching" to true,
        "deadReckoning" to true,
        "geometryGuidance" to true,
        "implementation" to "native-android",
        "nativeSafetyCameraAlerts" to true,
        "offRouteDetection" to true,
        "replayInput" to true,
        "rerouteConsent" to true,
        "routeContinuity" to true,
        "routeMatching" to true,
        "safetyCameraAnnouncements" to true,
        "speedingWarning" to true,
        "version" to 11,
      )
    }

    Function("isGooglePlaceRatingAvailable") { false }
    Function("isCarPlayVisualHarness") { false }
    Function("getGooglePlacesOpenSourceLicenseInfo") { null as String? }

    // Navigation

    Function("getSnapshot") { serialize(engine.snapshot()) }

    Function("setRoute") { trip: Map<String, Any?> ->
      serialize(guarded { engine.setRoute(parseTrip(trip)) })
    }

    Function("updateLocation") { location: NavigationLocationRecord ->
      val sample = NavigationLocationSample(
        coordinate = NavigationCoordinate(location.latitude, location.longitude),
        courseDegrees = location.courseDegrees,
        horizontalAccuracyMeters = location.horizontalAccuracyMeters,
        speedMetersPerSecond = location.speedMetersPerSecond,
        timestampMs = location.timestampMs ?: Double.NaN,
      )
      serialize(guarded { engine.updateLocation(sample) })
    }

    Function("clearRoute") { serialize(engine.clearRoute()) }

    Function("clearCarPlayTrip") { engine.clearRoute(); Unit }

    Function("acceptRerouteProposal") { id: String -> engine.acceptRerouteProposal(id) }

    Function("declineRerouteProposal") { id: String -> engine.declineRerouteProposal(id) }

    Function("stopAnnouncements") { engine.stopAnnouncements() }

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

    Function("setRoutePreferences") { record: RoutePreferencesRecord ->
      preferencesStore.setRoutePreferences(record.preferences)
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

    Function("recordRecentDestination") { record: NavigationDestinationRecord ->
      destinationStore.recordRecent(record.destination)
    }

    Function("clearRecentDestinations") { destinationStore.clearRecents() }

    Function("clearDestinationHistory") { destinationStore.clearDestinations() }

    Function("isFavoriteDestination") { id: String -> destinationStore.isFavorite(id) }

    Function("toggleFavoriteDestination") { record: NavigationDestinationRecord ->
      destinationStore.toggleFavorite(record.destination)
    }

    Function("replaceFavoriteDestinations") { records: List<NavigationDestinationRecord> ->
      destinationStore.replaceFavorites(records.map { it.destination })
    }

    Function("setHomeDestination") { record: NavigationDestinationRecord? ->
      destinationStore.setHome(record?.destination)
    }

    Function("setWorkDestination") { record: NavigationDestinationRecord? ->
      destinationStore.setWork(record?.destination)
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
      setCommunityPreference(ANNOUNCES_ROAD_REPORTS, enabled)
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
  } catch (error: InvalidNavigationInput) {
    throw CodedException("ERR_NAVOSS_INVALID_INPUT", error.message, error)
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
      "announcesRoadReports" to sharedPreferences.getBoolean(ANNOUNCES_ROAD_REPORTS, true),
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

  private fun serialize(coordinate: NavigationCoordinate): Map<String, Any?> =
    mapOf("latitude" to coordinate.latitude, "longitude" to coordinate.longitude)

  private fun serialize(snapshot: NavigationSnapshot): Map<String, Any?> = buildMap {
    put("isDeadReckoning", snapshot.isDeadReckoning)
    put("isOffRoute", snapshot.isOffRoute)
    put("phase", snapshot.phase.raw)
    put("rerouteCount", snapshot.rerouteCount)
    put("rerouteMode", snapshot.rerouteMode.raw)
    put("routeProgress", snapshot.routeProgress)
    put("routeStatus", snapshot.routeStatus)
    put("routeVersion", snapshot.routeVersion)
    put("sequence", snapshot.sequence)
    put("speedingState", snapshot.speedingState)
    put("stateVersion", snapshot.stateVersion)
    snapshot.rawCoordinate?.let { put("rawCoordinate", serialize(it)) }
    snapshot.horizontalAccuracyMeters?.let { put("horizontalAccuracyMeters", it) }
    snapshot.speedMetersPerSecond?.let { put("speedMetersPerSecond", it) }
    if (snapshot.phase != NavigationPhase.IDLE) {
      snapshot.trip?.let { put("trip", it.payload) }
    }
  }

  private fun parseTrip(value: Map<String, Any?>): NavigationTrip {
    val id = value["id"] as? String
    if (id.isNullOrEmpty()) throw InvalidNavigationInput("A trip needs an id.")
    val destination = (value["destination"] as? Map<*, *>)?.let(::parseDestination)
      ?.takeIf { it.isValid }
      ?: throw InvalidNavigationInput("A trip needs a valid destination.")
    val geometry = (value["geometry"] as? List<*>)?.mapNotNull { point ->
      val map = point as? Map<*, *> ?: return@mapNotNull null
      val latitude = (map["latitude"] as? Number)?.toDouble() ?: return@mapNotNull null
      val longitude = (map["longitude"] as? Number)?.toDouble() ?: return@mapNotNull null
      NavigationCoordinate(latitude, longitude).takeIf { it.isValid }
    }.orEmpty()
    if (geometry.size < 2 || geometry.size != (value["geometry"] as List<*>).size) {
      throw InvalidNavigationInput("A trip needs a geometry of at least two valid points.")
    }
    if (value["steps"] !is List<*>) throw InvalidNavigationInput("A trip needs its steps.")
    return NavigationTrip(id, destination, geometry, value)
  }

  private fun parseDestination(value: Map<*, *>): NavigationDestination? {
    return NavigationDestination(
      category = value["category"] as? String,
      id = value["id"] as? String ?: return null,
      label = value["label"] as? String ?: return null,
      latitude = (value["latitude"] as? Number)?.toDouble() ?: return null,
      longitude = (value["longitude"] as? Number)?.toDouble() ?: return null,
      name = value["name"] as? String ?: return null,
    )
  }
}
