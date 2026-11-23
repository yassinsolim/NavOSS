package org.navoss.mobile.updater

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/** Why a download stopped. The partial file is kept only where a later attempt can resume it. */
class DownloadException(val code: String, message: String) : IOException(message)

/**
 * Downloads one APK into a private directory. Bytes go to `<target>.part`, which a later attempt
 * resumes with an HTTP `Range` request (after a dropped connection, the app being closed, or a
 * reboot); the finished file is renamed to `<target>` only once its length is exactly
 * [expectedSize]. A server that ignores the range restarts the file from zero.
 *
 * Plain JVM code so the resume rules run in unit tests against a local server.
 */
class ApkDownloader(
  private val openConnection: (URL) -> HttpURLConnection = { url ->
    url.openConnection() as HttpURLConnection
  },
) {
  fun download(
    url: String,
    target: File,
    expectedSize: Long,
    cancelled: AtomicBoolean,
    onProgress: (received: Long, total: Long) -> Unit,
  ): File {
    if (expectedSize <= 0) throw DownloadException("invalid", "No size")
    if (target.isFile && target.length() == expectedSize) {
      onProgress(expectedSize, expectedSize)
      return target
    }
    target.parentFile?.mkdirs()
    val part = File(target.path + ".part")
    if (part.length() > expectedSize) part.delete()
    // One restart is allowed when the server refuses the saved range.
    for (attempt in 0..1) {
      val result = attempt(url, part, expectedSize, cancelled, onProgress)
      if (result) {
        if (!part.renameTo(target)) throw DownloadException("storage", "Rename failed")
        return target
      }
    }
    part.delete()
    throw DownloadException("invalid", "Range refused twice")
  }

  /** Returns true when [part] is complete, false when it must start again from zero. */
  private fun attempt(
    url: String,
    part: File,
    expectedSize: Long,
    cancelled: AtomicBoolean,
    onProgress: (Long, Long) -> Unit,
  ): Boolean {
    val offset = if (part.isFile) part.length() else 0L
    if (offset == expectedSize) return true
    val connection =
      try {
        openConnection(URL(url))
      } catch (error: IOException) {
        throw DownloadException("network", error.javaClass.simpleName)
      }
    try {
      connection.connectTimeout = 15_000
      connection.readTimeout = 30_000
      connection.instanceFollowRedirects = true
      if (offset > 0) connection.setRequestProperty("Range", "bytes=$offset-")
      val status =
        try {
          connection.responseCode
        } catch (error: IOException) {
          throw DownloadException("network", error.javaClass.simpleName)
        }
      val append =
        when {
          status == HttpURLConnection.HTTP_PARTIAL && offset > 0 -> {
            val range = connection.getHeaderField("Content-Range") ?: ""
            if (!range.startsWith("bytes $offset-")) {
              part.delete()
              return false
            }
            true
          }
          status == HttpURLConnection.HTTP_OK -> false
          status == 416 -> {
            part.delete()
            return false
          }
          else -> throw DownloadException("http", "HTTP $status")
        }
      var received = if (append) offset else 0L
      onProgress(received, expectedSize)
      try {
        connection.inputStream.use { input ->
          FileOutputStream(part, append).use { output ->
            val buffer = ByteArray(64 * 1024)
            var lastReport = 0L
            while (true) {
              if (cancelled.get()) {
                throw DownloadException("cancelled", "Cancelled")
              }
              val read = input.read(buffer)
              if (read < 0) break
              received += read
              if (received > expectedSize) {
                throw DownloadException("size", "Larger than announced")
              }
              output.write(buffer, 0, read)
              if (received - lastReport >= 256 * 1024 || received == expectedSize) {
                lastReport = received
                onProgress(received, expectedSize)
              }
            }
          }
        }
      } catch (error: DownloadException) {
        if (error.code != "network") part.delete()
        throw error
      } catch (error: IOException) {
        // A dropped connection keeps the partial file for the next attempt.
        throw DownloadException("network", error.javaClass.simpleName)
      }
      if (received != expectedSize) {
        throw DownloadException("network", "Ended early")
      }
      return true
    } finally {
      connection.disconnect()
    }
  }
}
