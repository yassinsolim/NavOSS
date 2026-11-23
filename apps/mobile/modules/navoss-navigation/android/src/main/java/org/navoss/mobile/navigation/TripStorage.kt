package org.navoss.mobile.navigation

import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * The core's trip blobs (`storageRead` / `storageWrite`): one file per key in an app-private
 * directory the caller places under `noBackupFilesDir`, so a restored backup never resurrects a
 * trip. Writes are atomic (temporary file, sync, rename) and values come back byte for byte.
 * Called with the engine lock held, so it never calls into the core; a write that fails is
 * dropped (the core rewrites the trip on the next checkpoint) and never throws into Swift.
 */
class TripStorage(private val directory: File) {
  private val lock = Any()
  private val cache = HashMap<String, String?>()

  fun read(key: String): String? = synchronized(lock) {
    cache.getOrPut(key) {
      val file = fileFor(key)
      try {
        if (file.isFile) file.readText(Charsets.UTF_8) else null
      } catch (_: IOException) {
        null
      }
    }
  }

  fun write(key: String, value: String?) = synchronized(lock) {
    cache[key] = value
    val file = fileFor(key)
    try {
      if (value == null) {
        file.delete()
        return@synchronized
      }
      directory.mkdirs()
      val temporary = File(directory, "${file.name}.tmp")
      FileOutputStream(temporary).use { stream ->
        stream.write(value.toByteArray(Charsets.UTF_8))
        stream.fd.sync()
      }
      if (!temporary.renameTo(file)) {
        temporary.delete()
      }
    } catch (_: IOException) {
      // Kept in memory for this process; the next checkpoint writes again.
    }
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
}
