package org.navoss.mobile.navigation

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TripStorageTest {
  private val directory: File = Files.createTempDirectory("trip-storage").toFile()
  private val key = "org.navoss.mobile.active-navigation-trip.v2"
  private val progressKey = "$key.progress"

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

  @Test
  fun `a failed write is retried at the next write and reported until it lands`() {
    val storage = TripStorage(directory)
    directory.setWritable(false)
    try {
      storage.write(key, "trip")
      assertFalse(storage.isDurable)
      assertEquals("trip", storage.read(key))
      assertNull(TripStorage(directory).read(key))
      // A checkpoint while the trip itself is not saved stays in memory too: a durable
      // progress record must never be newer than the durable trip it belongs to.
      storage.write(progressKey, "p1")
      assertNull(TripStorage(directory).read(progressKey))
    } finally {
      directory.setWritable(true)
    }
    storage.write(progressKey, "p2")
    assertTrue(storage.isDurable)
    assertEquals("trip", TripStorage(directory).read(key))
    assertEquals("p2", TripStorage(directory).read(progressKey))
  }

  @Test
  fun `a replacement trip write keeps its place ahead of a pending checkpoint`() {
    val storage = TripStorage(directory)
    storage.write(key, "t0")
    storage.write(progressKey, "p0")
    // Only the trip's own file fails: a directory where it belongs makes its rename fail.
    File(directory, key).delete()
    File(directory, key).mkdirs()
    storage.write(key, "t1")
    storage.write(progressKey, "p1")
    // A reroute replaces the unsaved trip while the checkpoint waits behind it.
    storage.write(key, "t2")
    // The checkpoint must not land ahead of the trip it belongs to (reroutes keep the trip id).
    assertEquals("p0", TripStorage(directory).read(progressKey))
    assertFalse(storage.isDurable)

    File(directory, key).delete()
    storage.write(progressKey, "p2")
    assertTrue(storage.isDurable)
    assertEquals("t2", TripStorage(directory).read(key))
    assertEquals("p2", TripStorage(directory).read(progressKey))
  }

  @Test
  fun `a failed rename leaves no staging file behind`() {
    val storage = TripStorage(directory)
    // A directory where the final file belongs makes the rename fail after staging.
    File(directory, key).mkdirs()
    storage.write(key, "route data")
    assertFalse(storage.isDurable)
    assertFalse(File(directory, "$key.tmp").exists())
  }

  @Test
  fun `deleting a key deletes its staging file and startup sweeps leftovers`() {
    File(directory, "$key.tmp").writeText("route data")
    File(directory, "$progressKey.tmp").writeText("progress")
    val storage = TripStorage(directory)
    assertEquals(emptyList<String>(), directory.list()!!.toList())

    storage.write(key, "trip")
    File(directory, "$key.tmp").writeText("route data")
    storage.write(key, null)
    assertEquals(emptyList<String>(), directory.list()!!.toList())
  }

  @Test
  fun `durability changes are reported`() {
    val changes = mutableListOf<Boolean>()
    val storage = TripStorage(directory) { changes += it }
    directory.setWritable(false)
    try {
      storage.write(key, "trip")
      storage.write(progressKey, "p1")
    } finally {
      directory.setWritable(true)
    }
    storage.write(progressKey, "p2")
    assertEquals(listOf(false, true), changes)
  }

  @Test
  fun `deleteAll removes every key and staging file, and the storage keeps working at launch`() {
    val storage = TripStorage(directory)
    storage.write(key, "{}")
    storage.write(progressKey, "p")
    File(directory, "$key.tmp").writeText("partial")
    assertTrue(storage.deleteAll())
    assertTrue(directory.listFiles().isNullOrEmpty())
    assertNull(TripStorage(directory).read(key))
    storage.write(key, "{}")
    assertEquals("{}", TripStorage(directory).read(key))
  }
}
