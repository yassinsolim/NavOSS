package org.navoss.mobile.navigation

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class OutOfMemoryStopTest {
  private val directory: File = Files.createTempDirectory("navoss-oom").toFile()
  private val storage = TripStorage(directory)
  private val events = mutableListOf<String>()
  private var record: String? = null
  private val stopRecord = StopRecord(read = { record }, write = { record = it })
  private val stop = OutOfMemoryStop(
    deleteSavedTrip = {
      events += "trip deleted"
      storage.deleteAll(refuseLaterWrites = true)
    },
    stopHost = { events += "host stopped" },
    recordStop = {
      events += "recorded"
      stopRecord.record(CoreNavigationEngine.OUT_OF_MEMORY)
    },
    notifyDriver = { events += "notified" },
    exitProcess = { events += "exit" },
  )

  private fun outOfMemory(): Nothing = throw NavigationEngineException(CoreNavigationEngine.OUT_OF_MEMORY, null)

  @Test
  fun `an out-of-memory refusal deletes the saved trip on disk, stops the host, records, notifies and exits`() {
    storage.write("trip", "{}")
    storage.write("trip.progress", "{}")
    // The body stands for the core call that ran out of memory; the stop makes no other core call
    // (it is given none), so the files can only have been removed directly.
    assertNull(stop.run { outOfMemory() })
    assertEquals(listOf("trip deleted", "host stopped", "recorded", "notified", "exit"), events)
    assertTrue(directory.listFiles().isNullOrEmpty())
    assertTrue(stop.isStopping)
  }

  @Test
  fun `a write still in flight from another call cannot recreate the trip before the exit`() {
    stop.run { outOfMemory() }
    storage.write("trip", "{}")
    assertTrue(directory.listFiles().isNullOrEmpty())
    assertNull(storage.read("trip"))
  }

  @Test
  fun `every later step and the exit still run when one step fails`() {
    val failing = OutOfMemoryStop(
      deleteSavedTrip = { throw OutOfMemoryError() },
      stopHost = { events += "host stopped" },
      recordStop = { throw IllegalStateException() },
      notifyDriver = { events += "notified" },
      exitProcess = { events += "exit" },
    )
    failing.run { outOfMemory() }
    assertEquals(listOf("host stopped", "notified", "exit"), events)
  }

  @Test
  fun `only the first refusal stops anything`() {
    stop.run { outOfMemory() }
    stop.run { outOfMemory() }
    assertEquals(1, events.count { it == "exit" })
  }

  @Test
  fun `the next launch reads the record once`() {
    stop.run { outOfMemory() }
    assertEquals(CoreNavigationEngine.OUT_OF_MEMORY, stopRecord.consume())
    assertNull(stopRecord.consume())
  }

  @Test
  fun `other refusals are the caller's and stop nothing`() {
    assertThrows(NavigationEngineException::class.java) {
      stop.run { throw NavigationEngineException("no-active-trip", null) }
    }
    assertEquals(emptyList<String>(), events)
    assertFalse(stop.isStopping)
  }

  @Test
  fun `a successful call passes its result through`() {
    assertEquals("snapshot", stop.run { "snapshot" })
    assertEquals(emptyList<String>(), events)
  }
}
