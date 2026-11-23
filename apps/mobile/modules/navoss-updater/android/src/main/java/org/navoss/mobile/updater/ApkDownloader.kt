package org.navoss.mobile.updater

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.MalformedURLException
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The largest APK the updater accepts, checked before any request. The release APK is about
 * 48 MB; the ceiling leaves room to grow and refuses a feed that announces something absurd.
 */
const val MAX_APK_BYTES = 250_000_000L

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
  private val openOutput: (File, Boolean) -> OutputStream = { file, append ->
    FileOutputStream(file, append)
  },
  private val freeSpace: (File) -> Long = { directory -> directory.usableSpace },
  private val policy: HostPolicy = HostPolicy.ASSET,
) {
  fun download(
    url: String,
    target: File,
    expectedSize: Long,
    cancelled: AtomicBoolean,
    onProgress: (received: Long, total: Long) -> Unit,
  ): File {
    if (expectedSize <= 0) throw DownloadException("invalid", "No size")
    if (expectedSize > MAX_APK_BYTES) throw DownloadException("size", "Above the ceiling")
    if (target.isFile && target.length() == expectedSize) {
      onProgress(expectedSize, expectedSize)
      return target
    }
    val directory = target.absoluteFile.parentFile
    if (directory == null || !(directory.isDirectory || directory.mkdirs())) {
      throw DownloadException("storage", "No directory")
    }
    val part = File(target.path + ".part")
    if (part.length() > expectedSize) part.delete()
    // Room for the rest of the file and for the installer's own copy of the whole APK.
    val needed = expectedSize - part.length() + expectedSize
    if (freeSpace(directory) < needed) throw DownloadException("storage", "Not enough space")
    // One restart is allowed when the server refuses the saved range.
    for (attempt in 0..1) {
      val result = attempt(url, part, expectedSize, cancelled, onProgress)
      if (result) {
        if (!part.renameTo(target)) {
          part.delete()
          throw DownloadException("storage", "Rename failed")
        }
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
    val start =
      try {
        URL(url)
      } catch (_: MalformedURLException) {
        throw DownloadException("invalid", "Bad URL")
      }
    val connection =
      UpdateHttp.open(start, policy, openConnection) { hop ->
        hop.connectTimeout = 15_000
        hop.readTimeout = 30_000
        if (offset > 0) hop.setRequestProperty("Range", "bytes=$offset-")
      }
    try {
      val status = connection.responseCode
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
      // A response that announces more than the release declared is refused before a byte is kept.
      val announced = connection.contentLengthLong
      if (announced >= 0 && received + announced > expectedSize) {
        part.delete()
        throw DownloadException("size", "Larger than announced")
      }
      onProgress(received, expectedSize)
      try {
        val input =
          try {
            connection.inputStream
          } catch (error: IOException) {
            throw DownloadException("network", error.javaClass.simpleName)
          }
        input.use {
          val output =
            try {
              openOutput(part, append)
            } catch (error: IOException) {
              throw DownloadException("storage", error.javaClass.simpleName)
            }
          output.use {
            val buffer = ByteArray(64 * 1024)
            var lastReport = 0L
            while (true) {
              if (cancelled.get()) {
                throw DownloadException("cancelled", "Cancelled")
              }
              val read =
                try {
                  input.read(buffer)
                } catch (error: IOException) {
                  // A dropped connection keeps the partial file for the next attempt.
                  throw DownloadException("network", error.javaClass.simpleName)
                }
              if (read < 0) break
              received += read
              if (received > expectedSize) {
                throw DownloadException("size", "Larger than announced")
              }
              try {
                output.write(buffer, 0, read)
              } catch (error: IOException) {
                throw DownloadException("storage", error.javaClass.simpleName)
              }
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
        // Closing the file failed (its last bytes could not be written).
        part.delete()
        throw DownloadException("storage", error.javaClass.simpleName)
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
