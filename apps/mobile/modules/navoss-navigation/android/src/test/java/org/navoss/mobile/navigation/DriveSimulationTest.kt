package org.navoss.mobile.navigation

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DriveSimulationTest {
  /** About 1.11 km due north, as two steps: 556 m in 100 s (5.56 m/s), then 556 m in 20 s. */
  private val trip = """
    {"id":"t","distanceMeters":1112,"durationSeconds":120,
     "geometry":[{"latitude":51.0,"longitude":-114.0},{"latitude":51.005,"longitude":-114.0},{"latitude":51.01,"longitude":-114.0}],
     "steps":[{"distanceMeters":556,"durationSeconds":100},{"distanceMeters":556,"durationSeconds":20}]}
  """.trimIndent()

  @Test
  fun `drives each step at its own speed, heading along the route`() {
    val simulation = DriveSimulation.fromTrip(trip)!!
    val first = JSONObject(simulation.next(1.0, 1_000)!!)
    assertEquals(5.56, first.getDouble("speedMetersPerSecond"), 0.01)
    assertEquals(0.0, first.getDouble("courseDegrees"), 0.01)
    assertEquals(1_000L, first.getLong("timestampMs"))
    assertEquals(5.0, first.getDouble("horizontalAccuracyMeters"), 0.0)
    repeat(110) { simulation.next(1.0, 0) }
    val fast = JSONObject(simulation.next(1.0, 0)!!)
    // 556 m in 20 s is 100 km/h.
    assertEquals(27.8, fast.getDouble("speedMetersPerSecond"), 0.01)
  }

  @Test
  fun `waits at the destination, then stops`() {
    val simulation = DriveSimulation.fromTrip(trip)!!
    var last: JSONObject? = null
    var fixes = 0
    while (true) {
      val next = simulation.next(1.0, 0) ?: break
      last = JSONObject(next)
      fixes += 1
      assertTrue(fixes < 1_000)
    }
    assertEquals(51.01, last!!.getDouble("latitude"), 1e-9)
    assertEquals(0.0, last.getDouble("speedMetersPerSecond"), 0.0)
    assertFalse(last.has("courseDegrees"))
  }

  @Test
  fun `a trip without geometry cannot be simulated`() {
    assertNull(DriveSimulation.fromTrip("""{"geometry":[{"latitude":51.0,"longitude":-114.0}],"steps":[]}"""))
  }

  @Test
  fun `the notification names the next maneuver and its distance`() {
    val snapshot = """{"phase":"tracking","routeStatus":"tracking","guidance":{"instruction":"Turn left onto 9 Ave SW","distanceToManeuverMeters":432}}"""
    assertEquals(
      TripNotificationContent("In 450 m", "Turn left onto 9 Ave SW"),
      TripNotificationContent.from(snapshot, simulating = false),
    )
    assertEquals("In 450 m (simulation)", TripNotificationContent.from(snapshot, simulating = true).title)
    assertEquals("1.5 km", TripNotificationContent.formatDistance(1_490.0))
    assertEquals("40 m", TripNotificationContent.formatDistance(37.0))
    assertEquals(
      "Finding your position",
      TripNotificationContent.from("""{"phase":"tracking","isAcquiringPosition":true}""", false).title,
    )
  }

  @Test
  fun `the notification says why a restored trip has no maneuver yet`() {
    fun paused(reason: String) =
      TripNotificationContent.from("""{"phase":"tracking","routeStatus":"tracking","isOffRoute":true,"tripPause":"$reason"}""", false)
    assertEquals(TripNotificationContent("Off route", "Finding a way back to your route."), paused("proceed-to-route"))
    assertEquals("Finding a new route", paused("rerouting").title)
    assertEquals("Finding your place", paused("locating").title)
    // A pause reason this build does not know reads as a trip under way, never as a maneuver.
    assertEquals("Navigating", paused("something-new").title)
    // A paused trip never shows a maneuver, even if a stale one were present in the snapshot.
    val stale = """{"phase":"tracking","tripPause":"proceed-to-route","guidance":{"instruction":"Turn left","distanceToManeuverMeters":100}}"""
    assertEquals("Off route", TripNotificationContent.from(stale, false).title)
  }
}
