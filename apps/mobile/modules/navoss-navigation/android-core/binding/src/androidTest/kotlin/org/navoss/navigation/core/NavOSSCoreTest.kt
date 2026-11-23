package org.navoss.navigation.core

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
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
    val cancelled = ArrayList<Long>()
    /** Every callback but the storage and clock ones, counted. */
    val callbacks = AtomicInteger()
    /** Runs inside `onStateChanged`, with no test lock held. */
    @Volatile var onState: (() -> Unit)? = null

    override fun onStateChanged(snapshotJson: String) {
      callbacks.incrementAndGet()
      lock.withLock {
        lastSnapshot = snapshotJson
        stateChanges++
        threads += Thread.currentThread().name
        changed.signalAll()
      }
      onState?.invoke()
    }

    override fun speak(text: String, kind: String, generation: Long) {
      callbacks.incrementAndGet()
      lock.withLock { spoken += "speak $kind $text" }
    }

    override fun cancelSpeech(generation: Long) {
      callbacks.incrementAndGet()
    }

    override fun needsLocationUpdates() {
      callbacks.incrementAndGet()
    }

    override fun reconcileLocationUpdates(generation: Long, shouldTrack: Boolean) {
      callbacks.incrementAndGet()
    }

    override fun startClock(generation: Long) {
      callbacks.incrementAndGet()
    }

    override fun stopClock(generation: Long) {
      callbacks.incrementAndGet()
    }

    override fun httpRequest(requestId: Long, requestJson: String) {
      callbacks.incrementAndGet()
      lock.withLock {
        requests += requestId to JSONObject(requestJson)
        changed.signalAll()
      }
    }

    override fun cancelHttpRequest(requestId: Long) {
      callbacks.incrementAndGet()
      lock.withLock { cancelled += requestId }
    }

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
    val expectedReroutes = expected.filter { it.startsWith("reroute ") }
    assertEquals(expectedReroutes.size, reroutes.size)
    if (expectedReroutes.isNotEmpty()) {
      assertEquals(
        JSONObject(expectedReroutes.last().substringAfter(' ')).getInt("rerouteCount"),
        JSONObject(reroutes.last().substringAfter(' ')).getInt("rerouteCount"),
      )
    }
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

  // Lifetime and failure paths. Run these with CheckJNI on (`adb shell setprop debug.checkjni 1`
  // before the test process starts): a JNI call made with an exception pending, or a use of a
  // released handle that the allocator notices, then aborts the process instead of passing.

  /** Calls racing `close()` either finish or fail as `closed`; none touches freed memory. */
  @Test
  fun callsRacingCloseFinishOrFailAsClosed() {
    val trip = asset("calgary-deerfoot-glenmore.trip.json")
    val fix = fixes().first().toString()
    repeat(40) {
      val host = RecordingHost()
      val engine = NavOSSCore(config, host)
      engine.setRoute(trip)
      val start = CountDownLatch(1)
      val unexpected = AtomicReference<Throwable?>(null)
      val callers =
        (0 until 4).map { index ->
          thread {
            start.await()
            try {
              repeat(200) {
                when (index) {
                  0 -> engine.getSnapshot()
                  1 -> engine.updateLocation(fix)
                  2 -> engine.setSpeedingWarning(it % 20, it % 2 == 0)
                  else -> engine.isCurrentGeneration(it.toLong())
                }
              }
            } catch (error: NavOSSCoreException) {
              if (error.code != "closed") unexpected.compareAndSet(null, error)
            } catch (error: Throwable) {
              unexpected.compareAndSet(null, error)
            }
          }
        }
      start.countDown()
      engine.close()
      callers.forEach { it.join(30_000) }
      assertNull(unexpected.get())
      assertEquals("closed", assertThrows(NavOSSCoreException::class.java) { engine.clockTick() }.code)
    }
  }

  /** `close()` from inside a callback returns, and nothing is called back afterwards. */
  @Test
  fun closeFromInsideACallbackReturnsAndStopsCallbacks() {
    val host = RecordingHost()
    val engine = NavOSSCore(config, host)
    val callbacksAtClose = AtomicInteger(-1)
    host.onState = {
      engine.close()
      callbacksAtClose.compareAndSet(-1, host.callbacks.get())
      assertEquals("closed", assertThrows(NavOSSCoreException::class.java) { engine.getSnapshot() }.code)
    }
    // The call that caused the callback still returns its snapshot.
    assertEquals("tracking", JSONObject(engine.setRoute(asset("calgary-deerfoot-glenmore.trip.json"))).getString("phase"))
    assertEquals(callbacksAtClose.get(), host.callbacks.get())
    assertEquals("closed", assertThrows(NavOSSCoreException::class.java) { engine.clearRoute() }.code)
    assertEquals(callbacksAtClose.get(), host.callbacks.get())
    assertEquals(0, host.requests.size)
  }

  /** `close()` waits for a callback running on another thread, and none starts after it. */
  @Test
  fun closeWaitsForARunningCallbackAndNoneFollows() {
    val host = RecordingHost()
    val engine = NavOSSCore(config, host)
    val inCallback = CountDownLatch(1)
    val letCallbackEnd = CountDownLatch(1)
    host.onState = {
      inCallback.countDown()
      letCallbackEnd.await(30, TimeUnit.SECONDS)
    }
    val caller = thread { engine.setRoute(asset("calgary-deerfoot-glenmore.trip.json")) }
    assertTrue(inCallback.await(30, TimeUnit.SECONDS))
    val closer = thread { engine.close() }
    closer.join(300)
    assertTrue("close() returned while a callback was running", closer.isAlive)
    letCallbackEnd.countDown()
    closer.join(30_000)
    caller.join(30_000)
    assertFalse(closer.isAlive)
    val callbacks = host.callbacks.get()
    assertEquals("closed", assertThrows(NavOSSCoreException::class.java) { engine.clockTick() }.code)
    Thread.sleep(200)
    assertEquals(callbacks, host.callbacks.get())
  }

  /** Closing cancels the requests the host holds; their late answers are refused as closed. */
  @Test
  fun closeCancelsPendingRequestsAtTheHost() {
    val host = RecordingHost()
    val engine = NavOSSCore(config, host)
    engine.setRoute(asset("calgary-deerfoot-glenmore.trip.json"))
    val cameras = host.takeRequest("/v1/cameras")
    assertNotNull(cameras)
    engine.close()
    assertEquals(listOf(cameras!!.first), host.cancelled)
    val callbacks = host.callbacks.get()
    assertEquals(
      "closed",
      assertThrows(NavOSSCoreException::class.java) { engine.completeHttpRequest(cameras.first, ok("[]")) }.code,
    )
    assertEquals(callbacks, host.callbacks.get())
  }

  /** A callback that throws is cleared in the native layer; the call and the engine carry on. */
  @Test
  fun aThrowingCallbackDoesNotBreakTheCall() {
    val host = RecordingHost()
    host.onState = { throw IllegalStateException("51.0447,-114.0719 must not reach logcat") }
    NavOSSCore(config, host).use { engine ->
      val snapshot = JSONObject(engine.setRoute(asset("calgary-deerfoot-glenmore.trip.json")))
      assertEquals("tracking", snapshot.getString("phase"))
      val fix = fixes().first()
      host.setNow(fix.getDouble("timestampMs"))
      assertEquals("tracking", JSONObject(engine.updateLocation(fix.toString())).getString("phase"))
    }
  }

  /** Error messages carry codes and field names, never what was sent. */
  @Test
  fun errorMessagesDoNotEchoTheirInput() {
    NavOSSCore(config, RecordingHost()).use { engine ->
      val mode = assertThrows(NavOSSCoreException::class.java) { engine.setRerouteMode("51.0447,-114.0719") }
      assertEquals("invalid-argument: Unknown reroute mode", mode.message)
      val trip = assertThrows(NavOSSCoreException::class.java) {
        engine.setRoute("""{"destination":{"name":"Secret Place","latitude":null}}""")
      }
      assertEquals("invalid-json: Missing value at destination.latitude", trip.message)
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
