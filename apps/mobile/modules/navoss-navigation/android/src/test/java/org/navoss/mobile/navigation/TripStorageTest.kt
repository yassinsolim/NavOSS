package org.navoss.mobile.navigation

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class TripStorageTest {
  private val directory: File = Files.createTempDirectory("trip-storage").toFile()
  private val key = "org.navoss.mobile.active-navigation-trip.v2"

  @Test
  fun `values survive a new process byte for byte`() {
    val value = """{"name":"Café 🚗","steps":[]}"""
    TripStorage(directory).write(key, value)
    assertEquals(value, TripStorage(directory).read(key))
    assertFalse(File(directory, "$key.tmp").exists())
  }

  @Test
  fun `null removes the key`() {
    val storage = TripStorage(directory)
    storage.write(key, "{}")
    storage.write(key, null)
    assertNull(storage.read(key))
    assertNull(TripStorage(directory).read(key))
  }

  @Test
  fun `keys cannot escape the directory`() {
    TripStorage(directory).write("../escape/key", "x")
    assertEquals(listOf("..%2fescape%2fkey"), directory.list()!!.toList())
  }
}
