package org.navoss.navigation.core

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** The handle's lifetime rules, on the JVM without the native library. */
class HandleGateTest {
  private val events = ArrayList<String>()

  private fun log(event: String) = synchronized(events) { events += event }

  private fun gate() = HandleGate(42L) { log("release $it") }

  @Test
  fun aCallGetsTheHandleAndCloseReleasesItOnce() {
    val gate = gate()
    assertEquals(42L, gate.call { it })
    gate.close { log("shutDown $it") }
    gate.close { log("shutDown again") }
    assertEquals(listOf("shutDown 42", "release 42"), events)
  }

  @Test
  fun aCallAfterCloseFailsWithoutTouchingTheHandle() {
    val gate = gate()
    gate.close {}
    val error = assertThrows(NavOSSCoreException::class.java) { gate.call { log("used $it") } }
    assertEquals("closed", error.code)
    assertEquals(listOf("release 42"), events)
  }

  /** The use-after-free: the handle outlives a close that overtakes a call using it. */
  @Test
  fun theHandleIsReleasedOnlyWhenACallThatWasRunningReturns() {
    val gate = gate()
    val inCall = CountDownLatch(1)
    val closed = CountDownLatch(1)
    val caller = thread {
      gate.call {
        inCall.countDown()
        assertTrue(closed.await(30, TimeUnit.SECONDS))
        log("still using $it")
      }
    }
    assertTrue(inCall.await(30, TimeUnit.SECONDS))
    gate.close { log("shutDown $it") }
    // Closed, and not released: the call is still inside.
    assertEquals(listOf("shutDown 42"), synchronized(events) { events.toList() })
    assertThrows(NavOSSCoreException::class.java) { gate.call {} }
    closed.countDown()
    caller.join(30_000)
    assertEquals(listOf("shutDown 42", "still using 42", "release 42"), events)
  }

  /** `close()` from inside a callback, which is inside a call: no deadlock, released after. */
  @Test
  fun closeFromInsideACallReleasesWhenTheOutermostCallReturns() {
    val gate = gate()
    gate.call {
      gate.call { gate.close { log("shutDown $it") } }
      log("outer call continues")
      assertThrows(NavOSSCoreException::class.java) { gate.call {} }
    }
    assertEquals(listOf("shutDown 42", "outer call continues", "release 42"), events)
  }

  @Test
  fun aFailingCallOrShutDownStillLetsGo() {
    val gate = gate()
    assertThrows(IllegalStateException::class.java) { gate.call { error("boom") } }
    assertThrows(IllegalStateException::class.java) { gate.close { error("boom") } }
    assertEquals(listOf("release 42"), events)
  }

  @Test
  fun manyThreadsRacingCloseNeverUseAReleasedHandle() {
    repeat(200) {
      var released = false
      var usedAfterRelease = false
      val gate = HandleGate(7L) { released = true }
      val start = CountDownLatch(1)
      val callers =
        (1..4).map {
          thread {
            start.await()
            repeat(50) {
              try {
                // `released` is written only when no call is inside, so reading it here is safe.
                gate.call { if (released) usedAfterRelease = true }
              } catch (expected: NavOSSCoreException) {
                assertEquals("closed", expected.code)
              }
            }
          }
        }
      start.countDown()
      gate.close {}
      callers.forEach { it.join() }
      assertTrue(released)
      assertTrue(!usedAfterRelease)
    }
  }
}
