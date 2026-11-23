package org.navoss.mobile.navigation

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class JsRecordJsonTest {
  @Test
  fun `null values are dropped at every depth and reported by path only`() {
    val dropped = mutableListOf<String>()
    val json = JSONObject(
      JsRecordJson.encode(
        mapOf(
          "id" to "a",
          "speed" to null,
          "destination" to mapOf("name" to null, "latitude" to 51.0),
          "steps" to listOf(mapOf("lanes" to null, "instruction" to "Turn left")),
        ),
        dropped::add,
      ),
    )
    assertEquals(listOf("speed", "destination.name", "steps[0].lanes"), dropped)
    assertFalse(json.has("speed"))
    assertFalse(json.getJSONObject("destination").has("name"))
    assertEquals(51.0, json.getJSONObject("destination").getDouble("latitude"), 0.0)
    assertFalse(json.getJSONArray("steps").getJSONObject(0).has("lanes"))
    assertEquals("Turn left", json.getJSONArray("steps").getJSONObject(0).getString("instruction"))
  }

  @Test
  fun `a record without nulls is unchanged`() {
    val record = mapOf("latitude" to 51.0, "longitude" to -114.0, "timestampMs" to 1.0, "flags" to listOf(true, false))
    val dropped = mutableListOf<String>()
    val json = JSONObject(JsRecordJson.encode(record, dropped::add))
    assertEquals(emptyList<String>(), dropped)
    assertEquals(setOf("latitude", "longitude", "timestampMs", "flags"), json.keys().asSequence().toSet())
    assertEquals(-114.0, json.getDouble("longitude"), 0.0)
    assertTrue(json.getJSONArray("flags").getBoolean(0))
  }
}
