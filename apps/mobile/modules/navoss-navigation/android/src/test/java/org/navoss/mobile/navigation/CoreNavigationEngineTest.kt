package org.navoss.mobile.navigation

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class CoreNavigationEngineTest {
  private val host = object : NavigationCoreHost {
    override fun onStateChanged(snapshotJson: String) = Unit
    override fun speak(text: String, kind: String, generation: Long) = Unit
    override fun cancelSpeech(generation: Long) = Unit
    override fun needsLocationUpdates() = Unit
    override fun reconcileLocationUpdates(generation: Long, shouldTrack: Boolean) = Unit
    override fun startClock(generation: Long) = Unit
    override fun stopClock(generation: Long) = Unit
    override fun httpRequest(requestId: Long, requestJson: String) = Unit
    override fun cancelHttpRequest(requestId: Long) = Unit
    override fun storageRead(key: String): String? = null
    override fun storageWrite(key: String, value: String?) = Unit
    override fun nowMs(): Double = 0.0
  }

  /** Scripted core: records calls and answers what the test sets. */
  private class ScriptedCore : NavigationCore {
    val calls = mutableListOf<String>()
    var answer = """{"phase":"tracking","sequence":3,"trip":{"id":"a","steps":[]},"routeProgress":0.25}"""

    override fun resumePersistedTrip() = answer.also { calls += "resume" }
    override fun setRoute(tripJson: String) = answer.also { calls += "setRoute $tripJson" }
    override fun updateLocation(sampleJson: String): String {
      failure?.let { throw it }
      return answer.also { calls += "update $sampleJson" }
    }
    override fun clearRoute() = answer.also { calls += "clear" }
    override fun getSnapshot() = answer
    override fun acceptRerouteProposal(id: String) = id == "p"
    override fun declineRerouteProposal(id: String) = false
    override fun setRerouteMode(mode: String) { calls += "reroute $mode" }
    override fun setAudioMode(mode: String) { calls += "audio $mode" }
    override fun setSpeedingWarning(kph: Int, audible: Boolean) { calls += "speeding $kph $audible" }
    override fun setAnnounceRoadReports(enabled: Boolean) { calls += "announce $enabled" }
    override fun getPreferences() = "{}"
    override fun clockTick() { calls += "tick" }
    override fun isCurrentGeneration(generation: Long) = generation == 4L
    override fun completeHttpRequest(requestId: Long, responseJson: String) { calls += "http $requestId $responseJson" }
    var failure: Throwable? = null
  }

  private fun loader(error: Throwable? = null, core: NavigationCore = ScriptedCore(), refuse: RuntimeException? = null) =
    object : NavigationCoreLoader {
      var config: String? = null
      override fun loadError() = error
      override fun contractVersion() = 11
      var host: NavigationCoreHost? = null
      override fun create(configJson: String, host: NavigationCoreHost): NavigationCore {
        refuse?.let { throw it }
        config = configJson
        this.host = host
        return core
      }
    }

  @Test
  fun `snapshots and inputs pass through untouched`() {
    val core = ScriptedCore()
    val engine = CoreNavigationEngine.create(loader(core = core), "{}", host) { RerouteMode.ADAPTIVE }
    assertEquals(11, engine.contractVersion)
    val trip = """{"id":"a","geometry":[{"latitude":51.0,"longitude":-114.0}]}"""
    assertSame(core.answer, engine.setRoute(trip))
    engine.updateLocation("""{"latitude":51.0,"longitude":-114.0,"timestampMs":1}""")
    engine.setRerouteMode(RerouteMode.KEEP_ROUTE)
    engine.setAudioMode(NavigationAudioMode.ALERTS_ONLY)
    engine.setSpeedingWarning(7, true)
    engine.completeHttpRequest(9, """{"error":"timeout"}""")
    assertEquals(
      listOf(
        "setRoute $trip",
        """update {"latitude":51.0,"longitude":-114.0,"timestampMs":1}""",
        "reroute keep-route",
        "audio alerts-only",
        "speeding 7 true",
        """http 9 {"error":"timeout"}""",
      ),
      core.calls,
    )
    assertTrue(engine.acceptRerouteProposal("p"))
    assertTrue(engine.isCurrentGeneration(4))
  }

  @Test
  fun `a missing library or ABI mismatch falls back to guidance unavailable`() {
    val error = UnsatisfiedLinkError("dlopen failed")
    val engine = CoreNavigationEngine.create(loader(error = error), "{}", host) { RerouteMode.ASK_FIRST }
    assertNull(engine.contractVersion)
    assertSame(error, (engine as UnavailableNavigationEngine).reason)
    val snapshot = JSONObject(engine.snapshot())
    assertEquals("idle", snapshot.getString("phase"))
    assertEquals("ask-first", snapshot.getString("rerouteMode"))
    assertFalse(snapshot.has("guidance"))
    assertFalse(snapshot.has("trip"))
    try {
      engine.setRoute("{}")
      fail("an unavailable engine must refuse trips")
    } catch (refused: NavigationEngineException) {
      assertEquals(UnavailableNavigationEngine.GUIDANCE_UNAVAILABLE, refused.code)
    }
  }

  @Test
  fun `a core that refuses its configuration falls back instead of crashing`() {
    val engine = CoreNavigationEngine.create(
      loader(refuse = IllegalStateException("ABI 2, expected 1")),
      "{}",
      host,
    ) { RerouteMode.ADAPTIVE }
    assertNull(engine.contractVersion)
  }

  /** A core whose every call throws [failure]. */
  private fun failingCore(failure: () -> Throwable): NavigationCore =
    java.lang.reflect.Proxy.newProxyInstance(
      NavigationCore::class.java.classLoader,
      arrayOf(NavigationCore::class.java),
    ) { _, _, _ -> throw failure() } as NavigationCore

  private fun everyCall(engine: NavigationEngine): List<() -> Unit> = listOf(
    { engine.resumePersistedTrip() },
    { engine.setRoute("{}") },
    { engine.updateLocation("{}") },
    { engine.clearRoute() },
    { engine.snapshot() },
    { engine.acceptRerouteProposal("p") },
    { engine.declineRerouteProposal("p") },
    { engine.setAudioMode(NavigationAudioMode.ALL_GUIDANCE) },
    { engine.setRerouteMode(RerouteMode.ADAPTIVE) },
    { engine.setSpeedingWarning(5, true) },
    { engine.setAnnounceRoadReports(true) },
    { engine.isCurrentGeneration(1) },
    { engine.clockTick() },
    { engine.completeHttpRequest(1, "{}") },
  )

  @Test
  fun `out of memory at any core call, raw or refused by the core, goes to the fatal handler first`() {
    val failures = listOf<() -> Throwable>(
      { OutOfMemoryError("NewString") },
      { NavigationEngineException(CoreNavigationEngine.OUT_OF_MEMORY, null) },
    )
    for (failure in failures) {
      var fatal = 0
      val engine = CoreNavigationEngine.create(
        loader(core = failingCore(failure)),
        "{}",
        host,
        onOutOfMemory = { fatal += 1 },
      ) { RerouteMode.ADAPTIVE }
      val calls = everyCall(engine)
      for ((index, call) in calls.withIndex()) {
        try {
          call()
          fail("expected a refusal")
        } catch (refused: NavigationEngineException) {
          assertEquals(CoreNavigationEngine.OUT_OF_MEMORY, refused.code)
        }
        assertEquals("call $index", index + 1, fatal)
      }
    }
  }

  @Test
  fun `out of memory while the core is created goes to the fatal handler`() {
    for (failure in listOf<Throwable>(OutOfMemoryError(), NavigationEngineException(CoreNavigationEngine.OUT_OF_MEMORY, null))) {
      var fatal = 0
      CoreNavigationEngine.create(
        object : NavigationCoreLoader {
          override fun loadError(): Throwable? = null
          override fun contractVersion() = 11
          override fun create(configJson: String, host: NavigationCoreHost): NavigationCore = throw failure
        },
        "{}",
        host,
        onOutOfMemory = { fatal += 1 },
      ) { RerouteMode.ADAPTIVE }
      assertEquals(1, fatal)
    }
  }

  @Test
  fun `out of memory anywhere in the factory is fatal, not a missing core`() {
    fun loader(loadError: () -> Throwable?, contractVersion: () -> Int) = object : NavigationCoreLoader {
      override fun loadError(): Throwable? = loadError()
      override fun contractVersion() = contractVersion()
      override fun create(configJson: String, host: NavigationCoreHost): NavigationCore = ScriptedCore()
    }
    val stages = listOf(
      loader({ throw OutOfMemoryError() }, { 11 }),
      loader({ OutOfMemoryError() }, { 11 }),
      loader({ null }, { throw OutOfMemoryError() }),
    )
    for (stage in stages) {
      var fatal = 0
      CoreNavigationEngine.create(stage, "{}", host, onOutOfMemory = { fatal += 1 }) { RerouteMode.ADAPTIVE }
      assertEquals(1, fatal)
    }
    // A library that is simply missing is still only "guidance unavailable".
    var fatal = 0
    val engine = CoreNavigationEngine.create(
      loader({ UnsatisfiedLinkError("missing") }, { 11 }),
      "{}",
      host,
      onOutOfMemory = { fatal += 1 },
    ) { RerouteMode.ADAPTIVE }
    assertEquals(0, fatal)
    assertNull(engine.contractVersion)
  }

  @Test
  fun `other refusals pass through without the fatal handler`() {
    var fatal = 0
    val core = ScriptedCore().apply { failure = NavigationEngineException("internal", "DecodingError") }
    val engine = CoreNavigationEngine.create(loader(core = core), "{}", host, onOutOfMemory = { fatal += 1 }) {
      RerouteMode.ADAPTIVE
    }
    try {
      engine.updateLocation("{}")
      fail("expected a refusal")
    } catch (refused: NavigationEngineException) {
      assertEquals("internal", refused.code)
      assertEquals("DecodingError", refused.message)
    }
    assertEquals(0, fatal)
  }

  @Test
  fun `the host's own exceptions in callbacks are reported and never reach the core`() {
    val throwing = object : NavigationCoreHost by host {
      override fun onStateChanged(snapshotJson: String) = throw IllegalStateException("listener")
      override fun storageRead(key: String): String? = throw java.io.IOException("disk")
      override fun nowMs(): Double = throw OutOfMemoryError()
    }
    val reported = mutableListOf<String>()
    val loader = loader()
    CoreNavigationEngine.create(
      loader,
      "{}",
      throwing,
      reportHostFailure = { callback, error -> reported += "$callback ${error.javaClass.simpleName}" },
    ) { RerouteMode.ADAPTIVE }
    val guarded = loader.host!!
    guarded.onStateChanged("{}")
    assertNull(guarded.storageRead("k"))
    val before = System.currentTimeMillis().toDouble()
    assertTrue(guarded.nowMs() >= before)
    assertEquals(
      listOf("onStateChanged IllegalStateException", "storageRead IOException", "nowMs OutOfMemoryError"),
      reported,
    )
  }
}
