package org.navoss.mobile.navigation

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LocationFixFilterTest {
  private val now = 1_800_000_000_000L

  private fun fix(
    timeMs: Long = now,
    accuracy: Float? = 4f,
    speed: Float? = 12f,
    bearing: Float? = 90f,
    mock: Boolean = false,
  ) = RawFix(51.0447, -114.0631, timeMs, accuracy, speed, bearing, mock)

  @Test
  fun `a fresh fix becomes the contract sample`() {
    val sample = JSONObject(LocationFixFilter().accept(fix(), now)!!)
    assertEquals(51.0447, sample.getDouble("latitude"), 0.0)
    assertEquals(-114.0631, sample.getDouble("longitude"), 0.0)
    assertEquals(now, sample.getLong("timestampMs"))
    assertEquals(4.0, sample.getDouble("horizontalAccuracyMeters"), 0.0)
    assertEquals(12.0, sample.getDouble("speedMetersPerSecond"), 0.0)
    assertEquals(90.0, sample.getDouble("courseDegrees"), 0.0)
  }

  @Test
  fun `unknown or negative values are omitted, never sent as -1`() {
    val sample = JSONObject(LocationFixFilter().accept(fix(accuracy = null, speed = -1f, bearing = 90f), now)!!)
    assertFalse(sample.has("horizontalAccuracyMeters"))
    assertFalse(sample.has("speedMetersPerSecond"))
    assertFalse(sample.has("courseDegrees"))
    assertTrue(sample.has("timestampMs"))
  }

  @Test
  fun `course needs at least two metres a second`() {
    assertFalse(JSONObject(LocationFixFilter().accept(fix(speed = 1.9f), now)!!).has("courseDegrees"))
    assertTrue(JSONObject(LocationFixFilter().accept(fix(speed = 2f), now)!!).has("courseDegrees"))
    assertFalse(JSONObject(LocationFixFilter().accept(fix(bearing = 360f), now)!!).has("courseDegrees"))
  }

  @Test
  fun `stale, future and out-of-order fixes are dropped`() {
    val filter = LocationFixFilter()
    assertNull(filter.accept(fix(timeMs = now - 15_001), now))
    assertNull(filter.accept(fix(timeMs = now + 5_001), now))
    assertTrue(filter.accept(fix(timeMs = now - 15_000), now) != null)
    assertTrue(filter.accept(fix(timeMs = now), now) != null)
    assertNull(filter.accept(fix(timeMs = now - 1), now))
    assertTrue(filter.accept(fix(timeMs = now), now) != null)
  }

  @Test
  fun `mock-location fixes never reach a trip`() {
    assertNull(LocationFixFilter().accept(fix(mock = true), now))
  }
}
