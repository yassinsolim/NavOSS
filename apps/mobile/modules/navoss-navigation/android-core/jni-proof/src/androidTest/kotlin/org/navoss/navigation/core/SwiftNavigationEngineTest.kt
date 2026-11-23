package org.navoss.navigation.core

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.abs
import kotlin.math.max

/**
 * Drives the Swift core through JNI with the recorded Calgary route and the replay trace, and
 * compares every result with the same replay run on macOS (`calgary-deerfoot-glenmore.replay-macos.txt`).
 */
@RunWith(AndroidJUnit4::class)
class SwiftNavigationEngineTest {
  private val assets = InstrumentationRegistry.getInstrumentation().context.assets

  private fun asset(name: String) = assets.open(name).bufferedReader().use { it.readText() }

  private fun routeRequest(): String {
    val fixture = JSONObject(asset("calgary-deerfoot-glenmore.v2.json"))
    val destination = fixture.getJSONObject("request").getJSONObject("destination")
      .put("id", "replay-destination")
      .put("label", "Replay destination")
      .put("name", "Replay destination")
    return JSONObject()
      .put("destination", destination)
      .put("routeIndex", 0)
      .put("response", fixture.getJSONObject("response"))
      .toString()
  }

  private fun fixes(): List<String> {
    val fixes = JSONObject(asset("calgary-deerfoot-glenmore.trace.json")).getJSONArray("fixes")
    return (0 until fixes.length()).map { fixes.getJSONObject(it).toString() }
  }

  private class Recorder : SwiftNavigationEngine.Listener {
    val events = mutableListOf<Pair<String, String>>()
    override fun onEvent(kind: String, json: String) {
      events += kind to json
    }
  }

  @Test
  fun threeFixesOnTheRecordedRouteAreMatchedAndGuided() {
    val recorder = Recorder()
    SwiftNavigationEngine(recorder).use { engine ->
      val route = JSONObject(engine.setRoute(routeRequest()))
      assertEquals("tracking", route.getString("phase"))
      val states = fixes().take(3).map { JSONObject(engine.updateLocation(it)) }
      states.forEachIndexed { index, state ->
        assertEquals("tracking", state.getString("phase"))
        assertEquals(false, state.getBoolean("isOffRoute"))
        assertEquals(index + 2, state.getInt("sequence"))
        assertNotNull(state.optJSONObject("matchedCoordinate"))
        assertEquals("Deerfoot Trail SE", state.getString("currentRoadName"))
        assertEquals(
          "Take exit 248 toward Glenmore Trail.",
          state.getJSONObject("guidance").getString("instruction"),
        )
      }
      assertTrue(states[2].getDouble("routeProgress") > states[0].getDouble("routeProgress"))
      // Every update also reached Kotlin through the Swift-to-Kotlin callback.
      assertEquals(3, recorder.events.count { it.first == "state" })
      assertEquals(
        states.map { it.toString() },
        recorder.events.filter { it.first == "state" }.map { JSONObject(it.second).toString() },
      )
      assertEquals("idle", JSONObject(engine.clearRoute()).getString("phase"))
    }
  }

  @Test
  fun anUntimedFixIsRefusedAsAnException() {
    SwiftNavigationEngine(Recorder()).use { engine ->
      engine.setRoute(routeRequest())
      val untimed = JSONObject(fixes().first()).apply { remove("timestampMs") }.toString()
      assertThrows(IllegalStateException::class.java) { engine.updateLocation(untimed) }
    }
  }

  @Test
  fun theWholeReplayMatchesMacOsAndSpeechArrivesThroughTheCallback() {
    val recorder = Recorder()
    val transcript = mutableListOf<String>()
    val latenciesNs = mutableListOf<Long>()
    SwiftNavigationEngine(recorder).use { engine ->
      engine.setSpeedingWarning(5, true)
      transcript += "route " + engine.setRoute(routeRequest())
      for (fix in fixes()) {
        recorder.events.clear()
        val start = System.nanoTime()
        val state = engine.updateLocation(fix)
        latenciesNs += System.nanoTime() - start
        recorder.events.filter { it.first == "speech" }.forEach { transcript += "speech " + it.second }
        assertEquals(state, recorder.events.last { it.first == "state" }.second)
        transcript += "state $state"
      }
      transcript += "clear " + engine.clearRoute()

      val snapshotNs = (1..500).map {
        val start = System.nanoTime()
        engine.snapshot()
        System.nanoTime() - start
      }
      report("updateLocation", latenciesNs)
      report("snapshot", snapshotNs)
    }

    val expected = asset("calgary-deerfoot-glenmore.replay-macos.txt").trimEnd('\n').split('\n')
    assertEquals(expected.size, transcript.size)
    var identical = 0
    var maxRelative = 0.0
    expected.zip(transcript).forEachIndexed { line, (mac, android) ->
      val (macKind, macJson) = mac.split(' ', limit = 2)
      val (kind, json) = android.split(' ', limit = 2)
      assertEquals("line ${line + 1}", macKind, kind)
      if (mac == android) identical++
      maxRelative = max(maxRelative, compare("line ${line + 1}", JSONObject(macJson), JSONObject(json)))
    }
    val speech = transcript.count { it.startsWith("speech ") }
    Log.i(TAG, "replay lines=${transcript.size} identical=$identical speech=$speech maxRelativeDifference=$maxRelative")
    assertEquals(14, speech)
    assertTrue("max relative difference $maxRelative", maxRelative < 1e-12)
  }

  /** Same keys, same strings, integers and booleans; floating point within 1e-12 relative. */
  private fun compare(path: String, expected: Any?, actual: Any?): Double = when (expected) {
    is JSONObject -> {
      actual as JSONObject
      assertEquals(path, expected.keys().asSequence().toSet(), actual.keys().asSequence().toSet())
      expected.keys().asSequence().maxOfOrNull { compare("$path.$it", expected.get(it), actual.get(it)) } ?: 0.0
    }
    is JSONArray -> {
      actual as JSONArray
      assertEquals(path, expected.length(), actual.length())
      (0 until expected.length()).maxOfOrNull { compare("$path[$it]", expected.get(it), actual.get(it)) } ?: 0.0
    }
    is Double, is Float -> {
      val e = (expected as Number).toDouble()
      val a = (actual as Number).toDouble()
      if (e == a) 0.0 else abs(e - a) / max(abs(e), Double.MIN_VALUE)
    }
    is Number -> {
      // org.json reads 0.5-free numbers as Int or Long; a whole-valued double prints the same.
      assertEquals(path, expected.toDouble(), (actual as Number).toDouble(), 0.0)
      0.0
    }
    else -> {
      assertEquals(path, expected, actual)
      0.0
    }
  }

  private fun report(name: String, samplesNs: List<Long>) {
    val sorted = samplesNs.sorted()
    fun us(ns: Long) = "%.1f".format(ns / 1000.0)
    Log.i(
      TAG,
      "$name n=${sorted.size} median=${us(sorted[sorted.size / 2])}us " +
        "p95=${us(sorted[sorted.size * 95 / 100])}us max=${us(sorted.last())}us " +
        "first=${us(samplesNs.first())}us",
    )
  }

  private companion object {
    const val TAG = "NavOSSSwiftCoreSpike"
  }
}
