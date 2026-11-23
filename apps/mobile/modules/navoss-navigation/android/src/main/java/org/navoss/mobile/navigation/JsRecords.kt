package org.navoss.mobile.navigation

/**
 * Reads the records JavaScript passes to [NavOSSNavigationModule] from plain maps. Expo's
 * `Record` conversion reads `@Field` properties by reflection when its generated metadata is
 * missing (it is for local modules: the release build logged "Introspectable data is missing"),
 * and so depends on R8 keeping those members (expo-modules-core's own keep rule does today).
 * Explicit reads depend on nothing R8 can remove. A field that is missing or of the wrong type
 * takes its default; a destination without a usable id, name and position is refused (null).
 */
internal object JsRecords {
  fun routePreferences(map: Map<String, Any?>): RoutePreferences =
    RoutePreferences(
      avoidFerries = map["avoidFerries"] as? Boolean ?: false,
      avoidHighways = map["avoidHighways"] as? Boolean ?: false,
      avoidTolls = map["avoidTolls"] as? Boolean ?: false,
      avoidUnpaved = map["avoidUnpaved"] as? Boolean ?: false,
    )

  fun destination(map: Map<String, Any?>?): NavigationDestination? {
    if (map == null) return null
    val destination =
      NavigationDestination(
        category = map["category"] as? String,
        id = map["id"] as? String ?: return null,
        label = map["label"] as? String ?: "",
        latitude = (map["latitude"] as? Number)?.toDouble() ?: return null,
        longitude = (map["longitude"] as? Number)?.toDouble() ?: return null,
        name = map["name"] as? String ?: return null,
      )
    return destination.takeIf { it.isValid }
  }

  /** Every usable destination of a JavaScript array, in order; anything else is skipped. */
  fun destinations(list: List<Any?>): List<NavigationDestination> =
    list.mapNotNull { item ->
      @Suppress("UNCHECKED_CAST")
      destination(item as? Map<String, Any?>)
    }
}
