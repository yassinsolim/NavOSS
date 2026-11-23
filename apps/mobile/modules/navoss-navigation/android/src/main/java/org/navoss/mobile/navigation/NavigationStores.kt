package org.navoss.mobile.navigation

import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

data class RoutePreferences(
  val avoidFerries: Boolean = false,
  val avoidHighways: Boolean = false,
  val avoidTolls: Boolean = false,
  val avoidUnpaved: Boolean = false,
)

data class NavigationPreferences(
  val audioMode: NavigationAudioMode,
  val routePreferences: RoutePreferences,
  val rerouteMode: RerouteMode,
  val speedingToleranceKph: Int,
  val speedingAudibleWarning: Boolean,
)

/**
 * Navigation, audio and route preferences, with the iOS keys and defaults
 * (`NavOSSCarPlayPreferencesStore`, `NavOSSNavigationPreferencesStore`).
 */
class NavigationPreferencesStore(private val preferences: SharedPreferences) {
  fun load(): NavigationPreferences = NavigationPreferences(
    audioMode = NavigationAudioMode.from(preferences.getString(AUDIO_MODE, null))
      ?: NavigationAudioMode.ALL_GUIDANCE,
    routePreferences = RoutePreferences(
      avoidFerries = preferences.getBoolean(AVOID_FERRIES, false),
      avoidHighways = preferences.getBoolean(AVOID_HIGHWAYS, false),
      avoidTolls = preferences.getBoolean(AVOID_TOLLS, false),
      avoidUnpaved = preferences.getBoolean(AVOID_UNPAVED, false),
    ),
    rerouteMode = RerouteMode.from(preferences.getString(REROUTE_MODE, null)) ?: RerouteMode.ADAPTIVE,
    speedingToleranceKph = clampTolerance(preferences.getInt(SPEEDING_TOLERANCE, DEFAULT_SPEEDING_TOLERANCE_KPH)),
    speedingAudibleWarning = preferences.getBoolean(SPEEDING_AUDIBLE, false),
  )

  fun setAudioMode(mode: NavigationAudioMode) {
    preferences.edit().putString(AUDIO_MODE, mode.raw).apply()
  }

  fun setRoutePreferences(value: RoutePreferences) {
    preferences.edit()
      .putBoolean(AVOID_FERRIES, value.avoidFerries)
      .putBoolean(AVOID_HIGHWAYS, value.avoidHighways)
      .putBoolean(AVOID_TOLLS, value.avoidTolls)
      .putBoolean(AVOID_UNPAVED, value.avoidUnpaved)
      .apply()
  }

  fun setRerouteMode(mode: RerouteMode) {
    preferences.edit().putString(REROUTE_MODE, mode.raw).apply()
  }

  fun setSpeedingWarning(toleranceKph: Int, audible: Boolean) {
    preferences.edit()
      .putInt(SPEEDING_TOLERANCE, clampTolerance(toleranceKph))
      .putBoolean(SPEEDING_AUDIBLE, audible)
      .apply()
  }

  companion object {
    const val DEFAULT_SPEEDING_TOLERANCE_KPH = 5
    private const val AUDIO_MODE = "org.navoss.mobile.carplay.audio-mode"
    private const val AVOID_FERRIES = "org.navoss.mobile.carplay.avoid-ferries"
    private const val AVOID_HIGHWAYS = "org.navoss.mobile.carplay.avoid-highways"
    private const val AVOID_TOLLS = "org.navoss.mobile.carplay.avoid-tolls"
    private const val AVOID_UNPAVED = "org.navoss.mobile.carplay.avoid-unpaved"
    private const val REROUTE_MODE = "org.navoss.mobile.navigation.reroute-mode"
    private const val SPEEDING_TOLERANCE = "org.navoss.mobile.navigation.speeding-tolerance-kph"
    private const val SPEEDING_AUDIBLE = "org.navoss.mobile.navigation.speeding-audible-warning"

    fun clampTolerance(value: Int): Int = value.coerceIn(0, 20)
  }
}

data class NavigationDestination(
  val category: String?,
  val id: String,
  val label: String,
  val latitude: Double,
  val longitude: Double,
  val name: String,
) {
  val isValid: Boolean
    get() = id.isNotEmpty() && name.isNotEmpty() &&
      NavigationCoordinate(latitude, longitude).isValid

  fun toJson(): JSONObject = JSONObject().apply {
    category?.let { put("category", it) }
    put("id", id)
    put("label", label)
    put("latitude", latitude)
    put("longitude", longitude)
    put("name", name)
  }

  companion object {
    fun fromJson(json: JSONObject): NavigationDestination = NavigationDestination(
      category = if (json.has("category")) json.getString("category") else null,
      id = json.getString("id"),
      label = json.getString("label"),
      latitude = json.getDouble("latitude"),
      longitude = json.getDouble("longitude"),
      name = json.getString("name"),
    )
  }
}

data class DestinationCatalog(
  val favorites: List<NavigationDestination> = emptyList(),
  val home: NavigationDestination? = null,
  val recents: List<NavigationDestination> = emptyList(),
  val work: NavigationDestination? = null,
)

/**
 * Home, Work, favourites and recents, with the iOS rules (`NavOSSCarPlayDestinationStore`):
 * invalid places are ignored, one OpenStreetMap object is one place whatever id form it arrives
 * in, at most 12 recents (newest first) and 20 favourites.
 */
class DestinationStore(private val preferences: SharedPreferences) {
  private val lock = Any()

  fun snapshot(): DestinationCatalog = synchronized(lock) { read() }

  fun recordRecent(destination: NavigationDestination) {
    if (!destination.isValid) return
    update { catalog ->
      val key = identityKey(destination.id)
      catalog.copy(
        recents = (listOf(destination) + catalog.recents.filter { identityKey(it.id) != key })
          .take(MAXIMUM_RECENTS),
      )
    }
  }

  fun clearRecents() = update { it.copy(recents = emptyList()) }

  fun clearDestinations() {
    synchronized(lock) { preferences.edit().remove(KEY).apply() }
  }

  fun replaceFavorites(favorites: List<NavigationDestination>) = update { catalog ->
    val seen = HashSet<String>()
    catalog.copy(
      favorites = favorites.filter { it.isValid && seen.add(identityKey(it.id)) }.take(MAXIMUM_FAVORITES),
    )
  }

  fun isFavorite(id: String): Boolean {
    val key = identityKey(id)
    return snapshot().favorites.any { identityKey(it.id) == key }
  }

  /** Returns whether the place is a favourite afterwards. */
  fun toggleFavorite(destination: NavigationDestination): Boolean {
    if (!destination.isValid) return false
    val key = identityKey(destination.id)
    var added = false
    update { catalog ->
      if (catalog.favorites.any { identityKey(it.id) == key }) {
        catalog.copy(favorites = catalog.favorites.filter { identityKey(it.id) != key })
      } else {
        added = true
        catalog.copy(favorites = (listOf(destination) + catalog.favorites).take(MAXIMUM_FAVORITES))
      }
    }
    return added
  }

  fun setHome(destination: NavigationDestination?) =
    update { it.copy(home = destination?.takeIf { place -> place.isValid }) }

  fun setWork(destination: NavigationDestination?) =
    update { it.copy(work = destination?.takeIf { place -> place.isValid }) }

  private fun update(transform: (DestinationCatalog) -> DestinationCatalog) {
    synchronized(lock) { write(transform(read())) }
  }

  private fun read(): DestinationCatalog {
    val stored = preferences.getString(KEY, null) ?: return DestinationCatalog()
    return try {
      val json = JSONObject(stored)
      DestinationCatalog(
        favorites = list(json.optJSONArray("favorites")),
        home = json.optJSONObject("home")?.let(NavigationDestination::fromJson),
        recents = list(json.optJSONArray("recents")),
        work = json.optJSONObject("work")?.let(NavigationDestination::fromJson),
      )
    } catch (_: org.json.JSONException) {
      DestinationCatalog()
    }
  }

  private fun write(catalog: DestinationCatalog) {
    val json = JSONObject().apply {
      put("favorites", JSONArray(catalog.favorites.map { it.toJson() }))
      catalog.home?.let { put("home", it.toJson()) }
      put("recents", JSONArray(catalog.recents.map { it.toJson() }))
      catalog.work?.let { put("work", it.toJson()) }
    }
    // Synchronous: a saved place must survive the app being killed right after the tap.
    preferences.edit().putString(KEY, json.toString()).commit()
  }

  private fun list(array: JSONArray?): List<NavigationDestination> =
    if (array == null) emptyList()
    else (0 until array.length()).map { NavigationDestination.fromJson(array.getJSONObject(it)) }

  companion object {
    private const val KEY = "org.navoss.mobile.carplay-destinations.v1"
    private const val MAXIMUM_RECENTS = 12
    private const val MAXIMUM_FAVORITES = 20

    /** `map-poi:<osm id>` and `nominatim:<type>:<osm id>` name the same OpenStreetMap object. */
    fun identityKey(id: String): String {
      if (id.startsWith("map-poi:")) {
        val osmId = id.removePrefix("map-poi:")
        if (osmId.isNotEmpty() && osmId.all(Char::isDigit)) return "osm:$osmId"
      }
      val components = id.split(":")
      if (components.size == 3 && components[0] == "nominatim") {
        val osmId = components[2]
        if (osmId.isNotEmpty() && osmId.all(Char::isDigit)) return "osm:$osmId"
      }
      return "id:$id"
    }
  }
}
