package org.navoss.mobile.updater

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.MalformedURLException
import java.net.URL

/**
 * The most the releases list may be. Ten small NavOSS releases are a few tens of kilobytes; even
 * ten of `cli/cli`'s, with long notes and dozens of assets each, are about 0.5 MB.
 */
const val MAX_FEED_BYTES = 1_048_576

/** One answer from the releases list: the status and, for a 200, the body as text. */
class FeedResponse(val status: Int, val body: String?)

/**
 * The update check's single GET. React Native's `fetch` buffers a whole response before
 * JavaScript sees it, so the size ceiling is enforced here: a `Content-Length` above
 * [maxBytes] is refused before reading, and reading stops at the first byte past it.
 *
 * Plain JVM code so the limits run in unit tests against a local server.
 */
class FeedFetcher(
  private val openConnection: (URL) -> HttpURLConnection = { url ->
    url.openConnection() as HttpURLConnection
  },
  private val maxBytes: Int = MAX_FEED_BYTES,
  private val deadlineMillis: Long = 30_000,
  /** Monotonic milliseconds; wall-clock changes cannot stretch or cut the deadline. */
  private val clock: () -> Long = { System.nanoTime() / 1_000_000 },
  private val policy: HostPolicy = HostPolicy.FEED,
) {
  /** Throws [DownloadException] with `invalid`, `network`, `redirect` or `too-large`. */
  fun fetch(url: String): FeedResponse {
    // One deadline for every redirect hop, connect, headers and body.
    val deadline = clock() + deadlineMillis
    fun remaining(): Int {
      val left = deadline - clock()
      if (left <= 0) throw DownloadException("network", "Too slow")
      return left.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
    }
    val parsed =
      try {
        URL(url)
      } catch (_: MalformedURLException) {
        throw DownloadException("invalid", "Bad URL")
      }
    val connection =
      UpdateHttp.open(parsed, policy, openConnection) { hop ->
        val left = remaining()
        hop.connectTimeout = left
        hop.readTimeout = left
        hop.useCaches = false
        hop.setRequestProperty("Accept", "application/vnd.github+json")
      }
    try {
      val status = connection.responseCode
      remaining()
      if (status != HttpURLConnection.HTTP_OK) return FeedResponse(status, null)
      if (connection.contentLengthLong > maxBytes) {
        throw DownloadException("too-large", "Announced too large")
      }
      val body = ByteArrayOutputStream()
      connection.inputStream.use { input ->
        val buffer = ByteArray(16 * 1024)
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          if (body.size() + read > maxBytes) throw DownloadException("too-large", "Too large")
          body.write(buffer, 0, read)
          remaining()
        }
      }
      remaining()
      return FeedResponse(status, body.toString(Charsets.UTF_8.name()))
    } catch (error: DownloadException) {
      throw error
    } catch (error: IOException) {
      throw DownloadException("network", error.javaClass.simpleName)
    } finally {
      connection.disconnect()
    }
  }
}
