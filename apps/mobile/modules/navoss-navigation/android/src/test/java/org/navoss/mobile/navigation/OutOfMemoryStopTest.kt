package org.navoss.mobile.navigation

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Test

class OutOfMemoryStopTest {
  private val events = mutableListOf<String>()

  @Test
  fun `an out-of-memory refusal posts the prebuilt notification and ends the process, even when posting throws`() {
    val stop = OutOfMemoryStop(notifyDriver = { events += "notified" }, exitProcess = { events += "exit" })
    stop.stop()
    assertEquals(listOf("notified", "exit"), events)

    events.clear()
    for (failure in listOf<Throwable>(OutOfMemoryError(), SecurityException(), IllegalStateException())) {
      val failing = OutOfMemoryStop(notifyDriver = { throw failure }, exitProcess = { events += "exit" })
      failing.stop()
    }
    assertEquals(listOf("exit", "exit", "exit"), events)
  }

  @Test
  fun `nothing on disk is written or deleted, so the next launch restores the trip`() {
    val directory: File = Files.createTempDirectory("navoss-oom").toFile()
    val storage = TripStorage(directory)
    storage.write("trip", "{\"id\":1}")
    storage.write("trip.progress", "{\"step\":3}")
    val before = directory.listFiles()!!.associate { it.name to it.readText() }

    val stop = OutOfMemoryStop(notifyDriver = {}, exitProcess = {})
    stop.stop()

    assertEquals(before, directory.listFiles()!!.associate { it.name to it.readText() })
    assertEquals("{\"id\":1}", TripStorage(directory).read("trip"))
  }

  @Test
  fun `only the first stop ends the process`() {
    val stop = OutOfMemoryStop(notifyDriver = { events += "notified" }, exitProcess = { events += "exit" })
    stop.stop()
    stop.stop()
    assertEquals(listOf("notified", "exit"), events)
  }
}
