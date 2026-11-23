package org.navoss.mobile.navigation

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Test

class OutOfMemoryStopTest {
  private val events = mutableListOf<String>()

  @Test
  fun `an out-of-memory refusal posts the prebuilt notification, stops the service, finishes the task and ends the process, even when every step before the last throws`() {
    val stop = recording()
    stop.stop()
    assertEquals(listOf("notified", "stopped", "finished", "exit"), events)

    events.clear()
    for (failure in listOf<Throwable>(OutOfMemoryError(), SecurityException(), IllegalStateException())) {
      val failing = OutOfMemoryStop(
        notifyDriver = { throw failure },
        stopService = { throw failure },
        finishTask = { throw failure },
        exitProcess = { events += "exit" },
      )
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

    val stop = OutOfMemoryStop(notifyDriver = {}, stopService = {}, finishTask = {}, exitProcess = {})
    stop.stop()

    assertEquals(before, directory.listFiles()!!.associate { it.name to it.readText() })
    assertEquals("{\"id\":1}", TripStorage(directory).read("trip"))
  }

  @Test
  fun `only the first stop ends the process`() {
    val stop = recording()
    stop.stop()
    stop.stop()
    assertEquals(listOf("notified", "stopped", "finished", "exit"), events)
  }

  @Test
  fun `a failing notification still stops the service and finishes the task before the kill`() {
    val stop = recording(notifyDriver = { throw OutOfMemoryError() })
    stop.stop()
    assertEquals(listOf("stopped", "finished", "exit"), events)
  }

  @Test
  fun `a service that cannot be stopped does not keep the task from being finished`() {
    val stop = recording(stopService = { throw OutOfMemoryError() })
    stop.stop()
    assertEquals(listOf("notified", "finished", "exit"), events)
  }

  private fun recording(
    notifyDriver: () -> Unit = { events += "notified" },
    stopService: () -> Unit = { events += "stopped" },
  ) = OutOfMemoryStop(
    notifyDriver = notifyDriver,
    stopService = stopService,
    finishTask = { events += "finished" },
    exitProcess = { events += "exit" },
  )
}
