package org.navoss.mobile.navigation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class OutOfMemoryStopTest {
  private val events = mutableListOf<String>()
  private var clearFails = false
  private val stop = OutOfMemoryStop(
    stopHost = { events += "host stopped" },
    clearTrip = {
      events += "clear"
      if (clearFails) throw NavigationEngineException(CoreNavigationEngine.OUT_OF_MEMORY, null)
    },
    announce = { events += "announced" },
  )

  @Test
  fun `an out-of-memory refusal during a trip stops the host, clears the trip and says so`() {
    val result = stop.run { throw NavigationEngineException(CoreNavigationEngine.OUT_OF_MEMORY, null) }
    assertNull(result)
    assertEquals(listOf("host stopped", "clear", "announced"), events)
  }

  @Test
  fun `the stop still happens and is announced when clearing runs out of memory too`() {
    clearFails = true
    stop.run { throw NavigationEngineException(CoreNavigationEngine.OUT_OF_MEMORY, null) }
    assertEquals(listOf("host stopped", "clear", "announced"), events)
  }

  @Test
  fun `other refusals are the caller's and stop nothing`() {
    assertThrows(NavigationEngineException::class.java) {
      stop.run { throw NavigationEngineException("no-active-trip", null) }
    }
    assertEquals(emptyList<String>(), events)
  }

  @Test
  fun `a successful call passes its result through`() {
    assertEquals("snapshot", stop.run { "snapshot" })
    assertEquals(emptyList<String>(), events)
  }
}
