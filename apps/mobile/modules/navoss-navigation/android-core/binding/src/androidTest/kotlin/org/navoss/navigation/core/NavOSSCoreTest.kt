package org.navoss.navigation.core

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.abs
import kotlin.math.max
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The Swift navigation core through JNI on a device: the replay script of the macOS facade tests
 * (`android-core/Tests/NavOSSCoreTestSupport.swift`, `runReplay`), compared line by line with
 * the committed macOS transcript, plus errors, restore and text outside the BMP.
 */
@RunWith(AndroidJUnit4::class)
class NavOSSCoreTest {
  private val assets = InstrumentationRegistry.getInstrumentation().context.assets

  private fun asset(name: String) = assets.open(name).bufferedReader().use { it.readText() }

  private fun fixes(): List<JSONObject> {
    val fixes = JSONObject(asset("calgary-deerfoot-glenmore.trace.json")).getJSONArray("fixes")
    return (0 until fixes.length()).map { fixes.getJSONObject(it) }
  }

  /** The server's answer of a recorded fixture (`response`). */
  private fun recordedBody(name: String) = JSONObject(asset(name)).getJSONObject("response").toString()

  private fun ok(body: String) = JSONObject().put("status", 200).put("body", body).toString()

  /** Records callbacks; HTTP requests wait until the test answers them. */
  private class RecordingHost : NavOSSCore.Host {
    val lock = ReentrantLock()
    val changed = lock.newCondition()
    var nowMs = 1_800_000_000_000.0
    val storage = HashMap<String, String>()
    val requests = ArrayList<Pair<Long, JSONObject>>()
    val spoken = ArrayList<String>()
    var lastSnapshot = ""
    var stateChanges = 0
    val threads = HashSet<String>()

    override fun onStateChanged(snapshotJson: String) = lock.withLock {
      lastSnapshot = snapshotJson
      stateChanges++
      threads += Thread.currentThread().name
      changed.signalAll()
    }

    override fun speak(text: String, kind: String, generation: Long) = lock.withLock {
      spoken += "speak $kind $text"
      Unit
    }

    override fun cancelSpeech(generation: Long) {}

    override fun needsLocationUpdates() {}

    override fun reconcileLocationUpdates(generation: Long, shouldTrack: Boolean) {}

    override fun startClock(generation: Long) {}

    override fun stopClock(generation: Long) {}

    override fun httpRequest(requestId: Long, requestJson: String) = lock.withLock {
      requests += requestId to JSONObject(requestJson)
      changed.signalAll()
    }

    override fun cancelHttpRequest(requestId: Long) {}

    override fun storageRead(key: String): String? = lock.withLock { storage[key] }

    override fun storageWrite(key: String, value: String?) {
      lock.withLock { if (value == null) storage.remove(key) else storage[key] = value }
    }

    override fun nowMs(): Double = lock.withLock { nowMs }

    fun setNow(ms: Double) = lock.withLock { nowMs = ms }

    fun drainSpoken(): List<String> = lock.withLock { spoken.toList().also { spoken.clear() } }

    fun takeRequest(vararg suffixes: String): Pair<Long, JSONObject>? {
      lock.lock()
      try {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
        while (true) {
          val index = requests.indexOfFirst { (_, request) ->
            suffixes.any { request.getString("url").endsWith(it) }
          }
          if (index >= 0) return requests.removeAt(index)
          val left = deadline - System.nanoTime()
          if (left <= 0) return null
          changed.awaitNanos(left)
        }
      } finally {
        lock.unlock()
      }
    }

    fun waitUntilNotRerouting(): String? = lock.withLock {
      val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
      while (lastSnapshot.contains("\"routeStatus\":\"rerouting\"")) {
        val left = deadline - System.nanoTime()
        if (left <= 0) return null
        changed.awaitNanos(left)
      }
      lastSnapshot
    }
  }

  private val config = """{"apiBaseUrl":"https://navoss.test","speedingAudibleWarning":true}"""

  @Test
  fun theLibraryLoadsAndSpeaksThisAbi() {
    assertNull(NavOSSCore.loadError())
    assertEquals(11, NavOSSCore.contractVersion())
  }

  /** `runReplay` of the macOS tests, step for step. */
  @Test
  fun theReplayMatchesMacOsIncludingTheReroutesThroughTheHost() {
    val host = RecordingHost()
    val fixes = fixes()
    val configBody = recordedBody("new-server.v2-config.json")
    val routesBody = recordedBody("calgary-deerfoot-glenmore.v2.json")
    val lines = ArrayList<String>()
    val latenciesNs = ArrayList<Long>()
    host.setNow(fixes.first().getDouble("timestampMs"))
    NavOSSCore(config, host).use { engine ->
      fun emit(line: String) {
        lines += host.drainSpoken()
        lines += line
      }
      emit("route " + engine.setRoute(asset("calgary-deerfoot-glenmore.trip.json")))
      for (fix in fixes) {
        host.setNow(fix.getDouble("timestampMs"))
        val start = System.nanoTime()
        val state = engine.updateLocation(fix.toString())
        latenciesNs += System.nanoTime() - start
        emit("state $state")
        if (!state.contains("\"routeStatus\":\"rerouting\"")) continue
        while (true) {
          val (id, request) =
            host.takeRequest("/v2/config", "/v2/routes") ?: throw AssertionError("no route request")
          val isConfig = request.getString("url").endsWith("/v2/config")
          if (!isConfig) {
            // The core built the request; the host only carries it.
            assertEquals("POST", request.getString("method"))
            assertEquals("application/json", request.getJSONObject("headers").getString("content-type"))
            assertNotNull(JSONObject(request.getString("body")).getJSONObject("origin"))
          }
          lines += if (isConfig) "request GET /v2/config" else "request POST /v2/routes"
          // Answered from another thread, as a real HTTP client would.
          Thread { engine.completeHttpRequest(id, ok(if (isConfig) configBody else routesBody)) }
            .apply { start(); join() }
          if (!isConfig) break
        }
        assertNotNull("the reroute did not finish", host.waitUntilNotRerouting())
        emit("reroute " + engine.getSnapshot())
      }
      emit("clear " + engine.clearRoute())
    }

    val expected = asset("calgary-deerfoot-glenmore.replay.txt").trimEnd('\n').split('\n')
    assertEquals(expected.size, lines.size)
    var identical = 0
    var maxRelative = 0.0
    expected.zip(lines).forEachIndexed { index, (mac, android) ->
      if (mac == android) {
        identical++
        return@forEachIndexed
      }
      val (macKind, macRest) = mac.split(' ', limit = 2)
      val (kind, rest) = android.split(' ', limit = 2)
      assertEquals("line ${index + 1}", macKind, kind)
      assertTrue("line ${index + 1}: $mac != $android", kind in setOf("route", "state", "reroute", "clear"))
      maxRelative = max(maxRelative, compare("line ${index + 1}", JSONObject(macRest), JSONObject(rest)))
    }
    val speech = lines.count { it.startsWith("speak ") }
    val reroutes = lines.filter { it.startsWith("reroute ") }
    Log.i(TAG, "replay lines=${lines.size} identical=$identical speech=$speech reroutes=${reroutes.size} maxRelativeDifference=$maxRelative")
    report("updateLocation", latenciesNs)
    assertTrue("max relative difference $maxRelative", maxRelative < 1e-12)
    assertEquals(expected.count { it.startsWith("speak ") }, speech)
    assertEquals(2, reroutes.size)
    assertEquals(2, JSONObject(reroutes.last().substringAfter(' ')).getInt("rerouteCount"))
    // Reroute completions arrive on Swift's own threads, attached to the VM for the call.
    Log.i(TAG, "onStateChanged threads=${host.threads}")
  }

  @Test
  fun failuresAreExceptionsWithStableCodes() {
    val host = RecordingHost()
    fun code(body: () -> Unit): String =
      (assertThrows(NavOSSCoreException::class.java) { body() }).code
    assertEquals("invalid-json", code { NavOSSCore("{", host) })
    assertEquals("invalid-argument", code { NavOSSCore("""{"apiBaseUrl":"https://x","rerouteMode":"often"}""", host) })
    val engine = NavOSSCore(config, host)
    assertEquals("no-active-trip", code { engine.updateLocation("""{"latitude":51,"longitude":-114,"timestampMs":1}""") })
    assertEquals("invalid-route", code { engine.setRoute("{}") })
    assertEquals("invalid-json", code { engine.setRoute("[") })
    engine.setRoute(asset("calgary-deerfoot-glenmore.trip.json"))
    assertEquals("invalid-location", code { engine.updateLocation("""{"latitude":51,"longitude":-114}""") })
    assertEquals("invalid-argument", code { engine.setAudioMode("loud") })
    engine.close()
    engine.close()
    assertEquals("closed", code { engine.getSnapshot() })
  }

  @Test
  fun aTripRestoresThroughHostStorage() {
    val host = RecordingHost()
    NavOSSCore(config, host).use { engine ->
      engine.setRoute(asset("calgary-deerfoot-glenmore.trip.json"))
      for (fix in fixes().take(30)) {
        host.setNow(fix.getDouble("timestampMs"))
        engine.updateLocation(fix.toString())
      }
    }
    assertTrue(host.storage.containsKey("org.navoss.mobile.active-navigation-trip.v2"))
    NavOSSCore(config, host).use { restored ->
      val snapshot = JSONObject(restored.resumePersistedTrip())
      assertTrue(snapshot.getBoolean("isAcquiringPosition"))
      assertFalse(snapshot.has("guidance"))
      assertEquals("tracking", snapshot.getString("phase"))
    }
  }

  @Test
  fun textOutsideTheBmpSurvivesBothWays() {
    val name = "Caf\u00e9 \uD83C\uDF69 Stop"
    val trip = JSONObject(asset("calgary-deerfoot-glenmore.trip.json"))
    trip.getJSONObject("destination").put("name", name).put("label", name)
    NavOSSCore(config, RecordingHost()).use { engine ->
      val snapshot = JSONObject(engine.setRoute(trip.toString()))
      assertEquals(name, snapshot.getJSONObject("trip").getJSONObject("destination").getString("name"))
    }
  }

  /** Same keys, strings, integers and booleans; floating point within a relative difference. */
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
    is Number -> {
      val e = expected.toDouble()
      val a = (actual as Number).toDouble()
      if (e == a) 0.0 else abs(e - a) / max(abs(e), abs(a))
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
        "p95=${us(sorted[sorted.size * 95 / 100])}us max=${us(sorted.last())}us first=${us(samplesNs.first())}us",
    )
  }

  private companion object {
    const val TAG = "NavOSSCoreTest"
  }
}
