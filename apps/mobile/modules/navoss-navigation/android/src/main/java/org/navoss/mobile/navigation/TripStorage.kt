package org.navoss.mobile.navigation

import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * The core's trip blobs (`storageRead` / `storageWrite`): one file per key in an app-private
 * directory the caller places under `noBackupFilesDir`, so a restored backup never resurrects a
 * trip. Writes are atomic (temporary file, sync, rename) and values come back byte for byte.
 * Called with the engine lock held, so it never calls into the core and never throws into Swift.
 *
 * A write that fails (a full disk, a failed rename) stays in memory for this process and is
 * retried, in order, before every later write: the core writes a progress checkpoint every
 * fifteen seconds, so that is the retry. Writes land on disk in the order they were made, so a
 * durable progress record is never newer than the durable trip it belongs to. While anything is
 * unsaved [isDurable] is false and [onDurabilityChanged] has said so: the trip would not be
 * restored if the process died. Staging files never outlive a failed write or a deleted key, and
 * any left by a process that died mid-write are swept when the storage opens.
 */
class TripStorage(
  private val directory: File,
  private val onDurabilityChanged: (Boolean) -> Unit = {},
) {
  private val lock = Any()
  private val cache = HashMap<String, String?>()
  /** Writes not yet on disk, in the order each key first waited; one entry per key holding its latest value. */
  private val pending = LinkedHashMap<String, String?>()
  /** Set by [deleteAll] with `refuseLaterWrites`: every later write is dropped. */
  private var closed = false

  init {
    directory.listFiles { file -> file.name.endsWith(STAGING_SUFFIX) }?.forEach { it.delete() }
  }

  /** Whether every write so far is on disk. */
  val isDurable: Boolean
    get() = synchronized(lock) { pending.isEmpty() }

  fun read(key: String): String? = synchronized(lock) {
    if (closed) return null
    cache.getOrPut(key) {
      val file = fileFor(key)
      try {
        if (file.isFile) file.readText(Charsets.UTF_8) else null
      } catch (_: IOException) {
        null
      }
    }
  }

  fun write(key: String, value: String?) {
    val change = synchronized(lock) {
      if (closed) return
      val wasDurable = pending.isEmpty()
      cache[key] = value
      // A key already waiting keeps its place (LinkedHashMap keeps the insertion order on
      // replacement): a reroute that replaces an unsaved trip must still land before the
      // checkpoint queued behind it, or disk would hold newer progress against older geometry.
      pending[key] = value
      flushLocked()
      val durable = pending.isEmpty()
      durable.takeIf { it != wasDurable }
    }
    change?.let(onDurabilityChanged)
  }

  /**
   * Deletes every stored key and staging file directly, dropping writes not yet on disk. With
   * [refuseLaterWrites] (the out-of-memory stop) a write the core makes afterwards, from a call
   * still in flight on another thread, is dropped too, so nothing can recreate the trip before
   * the process exits. Returns whether the directory holds no file afterwards.
   */
  fun deleteAll(refuseLaterWrites: Boolean = false): Boolean = synchronized(lock) {
    if (refuseLaterWrites) closed = true
    pending.clear()
    cache.clear()
    directory.listFiles()?.forEach { it.delete() }
    directory.listFiles().isNullOrEmpty()
  }

  /** Writes pending values in order, stopping at the first that fails. */
  private fun flushLocked() {
    val iterator = pending.entries.iterator()
    while (iterator.hasNext()) {
      val (key, value) = iterator.next()
      if (!persist(key, value)) return
      iterator.remove()
    }
  }

  private fun persist(key: String, value: String?): Boolean {
    val file = fileFor(key)
    val staging = File(directory, file.name + STAGING_SUFFIX)
    if (value == null) {
      staging.delete()
      return !file.exists() || file.delete()
    }
    try {
      directory.mkdirs()
      FileOutputStream(staging).use { stream ->
        stream.write(value.toByteArray(Charsets.UTF_8))
        stream.fd.sync()
      }
      if (staging.renameTo(file)) return true
    } catch (_: IOException) {
      // Falls through: nothing of this write may stay behind.
    }
    staging.delete()
    return false
  }

  private fun fileFor(key: String): File {
    val name = buildString {
      for (character in key) {
        if (character.isLetterOrDigit() && character.code < 128 || character == '.' || character == '-' || character == '_') {
          append(character)
        } else {
          append('%').append(character.code.toString(16))
        }
      }
    }
    return File(directory, name)
  }

  private companion object {
    const val STAGING_SUFFIX = ".tmp"
  }
}
