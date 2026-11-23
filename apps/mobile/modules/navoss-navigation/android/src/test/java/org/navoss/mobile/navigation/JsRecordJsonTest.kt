package org.navoss.mobile.navigation

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class JsRecordJsonTest {
  @Test
  fun `null values are forwarded as JSON null at every depth and reported by path only`() {
    // An absent non-optional field is defaulted by the core (a zero coordinate would pass
    // validation); an explicit null is refused for a required field and read as nil for an
    // optional one (core golden `record-rules.json`). So nulls must reach the core as null.
    val seen = mutableListOf<String>()
    val json = JSONObject(
      JsRecordJson.encode(
        mapOf(
          "id" to "a",
          "speed" to null,
          "destination" to mapOf("name" to null, "latitude" to null, "longitude" to -114.0),
          "steps" to listOf(mapOf("lanes" to null, "instruction" to "Turn left")),
        ),
        seen::add,
      ),
    )
    assertEquals(listOf("speed", "destination.name", "destination.latitude", "steps[0].lanes"), seen)
    assertTrue(json.isNull("speed") && json.has("speed"))
    val destination = json.getJSONObject("destination")
    assertTrue(destination.has("latitude") && destination.isNull("latitude"))
    assertTrue(destination.has("name") && destination.isNull("name"))
    assertEquals(-114.0, destination.getDouble("longitude"), 0.0)
    val step = json.getJSONArray("steps").getJSONObject(0)
    assertTrue(step.has("lanes") && step.isNull("lanes"))
    assertEquals("Turn left", step.getString("instruction"))
  }

  @Test
  fun `a fix with a null coordinate keeps the key so the core can refuse it`() {
    val text = JsRecordJson.encode(mapOf("latitude" to null, "longitude" to -114.0, "timestampMs" to 1.0))
    assertTrue(text.contains("\"latitude\":null"))
  }

  @Test
  fun `a record without nulls is unchanged`() {
    val record = mapOf("latitude" to 51.0, "longitude" to -114.0, "timestampMs" to 1.0, "flags" to listOf(true, false))
    val seen = mutableListOf<String>()
    val json = JSONObject(JsRecordJson.encode(record, seen::add))
    assertEquals(emptyList<String>(), seen)
    assertEquals(setOf("latitude", "longitude", "timestampMs", "flags"), json.keys().asSequence().toSet())
    assertEquals(-114.0, json.getDouble("longitude"), 0.0)
    assertTrue(json.getJSONArray("flags").getBoolean(0))
  }
}
