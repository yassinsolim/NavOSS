package org.navoss.mobile.navigation

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class JsRecordsTest {
  private val tower =
    mapOf(
      "category" to "Tower",
      "id" to "osm:node:1",
      "label" to "101 9 Avenue SE, Calgary",
      "latitude" to 51.0443,
      "longitude" to -114.0631,
      "name" to "Calgary Tower",
    )

  @Test
  fun routePreferencesReadEveryFlag() {
    assertEquals(
      RoutePreferences(avoidFerries = true, avoidHighways = true, avoidTolls = true, avoidUnpaved = true),
      JsRecords.routePreferences(
        mapOf("avoidFerries" to true, "avoidHighways" to true, "avoidTolls" to true, "avoidUnpaved" to true),
      ),
    )
    assertEquals(
      RoutePreferences(avoidTolls = true),
      JsRecords.routePreferences(mapOf("avoidTolls" to true, "avoidHighways" to false)),
    )
  }

  @Test
  fun routePreferencesDefaultMissingOrWrongTypedFlagsToFalse() {
    assertEquals(RoutePreferences(), JsRecords.routePreferences(emptyMap()))
    assertEquals(
      RoutePreferences(avoidHighways = true),
      JsRecords.routePreferences(
        mapOf("avoidTolls" to "true", "avoidFerries" to 1, "avoidUnpaved" to null, "avoidHighways" to true),
      ),
    )
  }

  @Test
  fun destinationKeepsEveryField() {
    assertEquals(
      NavigationDestination("Tower", "osm:node:1", "101 9 Avenue SE, Calgary", 51.0443, -114.0631, "Calgary Tower"),
      JsRecords.destination(tower),
    )
    // JavaScript numbers can arrive as integers.
    assertEquals(51.0, JsRecords.destination(tower + ("latitude" to 51))?.latitude)
  }

  @Test
  fun destinationOptionalFieldsDefault() {
    val destination = JsRecords.destination(tower - "category" - "label")
    assertNull(destination?.category)
    assertEquals("", destination?.label)
    assertEquals("osm:node:1", destination?.id)
  }

  @Test
  fun destinationWithoutIdNameOrPositionIsRefused() {
    assertNull(JsRecords.destination(null))
    assertNull(JsRecords.destination(tower - "id"))
    assertNull(JsRecords.destination(tower - "name"))
    assertNull(JsRecords.destination(tower - "latitude"))
    assertNull(JsRecords.destination(tower + ("id" to "")))
    assertNull(JsRecords.destination(tower + ("id" to 7)))
    assertNull(JsRecords.destination(tower + ("longitude" to "-114")))
    assertNull(JsRecords.destination(tower + ("latitude" to 123.0)))
  }

  @Test
  fun destinationsSkipUnusableEntries() {
    val other = tower + ("id" to "osm:node:2")
    assertEquals(
      listOf("osm:node:1", "osm:node:2"),
      JsRecords.destinations(listOf(tower, null, "x", tower - "name", other)).map { it.id },
    )
  }

  /**
   * Expo `Record`s in local modules are read by reflection, so a release build depends on R8
   * keeping their members (a missed field silently keeps its default). None may appear in NavOSS's
   * Android modules; read maps explicitly as [JsRecords] does.
   */
  @Test
  fun noExpoRecordsInNavOSSAndroidModules() {
    val modules = File(System.getProperty("user.dir")).resolve("../..").canonicalFile
    val sources =
      modules
        .listFiles { dir -> dir.isDirectory && dir.name.startsWith("navoss-") }!!
        .flatMap { module -> module.resolve("android/src/main").walkTopDown().filter { it.extension == "kt" || it.extension == "java" }.toList() }
    assertTrue("no Android sources found under $modules", sources.isNotEmpty())
    val offenders =
      sources.filter { file ->
        val text = file.readText()
        text.contains("expo.modules.kotlin.records") || Regex(""":\s*Record\b""").containsMatchIn(text)
      }
    assertEquals("Expo Records (read by reflection) in: $offenders", emptyList<File>(), offenders)
  }
}
