package org.navoss.mobile.updater

import java.io.IOException
import java.net.HttpURLConnection
import java.net.MalformedURLException
import java.net.URL

/** The only host a test build's local feed may use (plain HTTP on the device's loopback). */
const val LOOPBACK_HOST = "127.0.0.1"

/**
 * The updater's `User-Agent` (GitHub's API requires one). Without it Android sends `Dalvik/…` with
 * the device model and Android build; the update check discloses none of that.
 */
const val UPDATER_USER_AGENT = "NavOSS-Android"

/** Redirects followed per request. GitHub's asset download takes one (github.com → assets). */
const val MAX_REDIRECTS = 3

/**
 * Where updater requests may go. Every hop is HTTPS on the default port to one of [hosts]. A
 * chain that starts on [LOOPBACK_HOST] (a test build's local feed) stays there, over HTTP, and a
 * GitHub chain can never lead to the loopback address.
 */
class HostPolicy(private val hosts: Set<String>) {
  fun allows(url: URL, loopbackChain: Boolean): Boolean {
    if (loopbackChain) return url.protocol == "http" && url.host == LOOPBACK_HOST
    return url.protocol == "https" &&
      (url.port == -1 || url.port == 443) &&
      url.host.lowercase() in hosts
  }

  companion object {
    /** The releases list: GitHub's REST API. */
    val FEED = HostPolicy(setOf("api.github.com"))

    /**
     * A release asset: `browser_download_url` on github.com answers 302 to GitHub's asset host,
     * `release-assets.githubusercontent.com` (checked 2026-11-22 with `curl -sIL`);
     * `objects.githubusercontent.com` is its predecessor, still used by some releases.
     */
    val ASSET =
      HostPolicy(
        setOf("github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"),
      )
  }
}

/** Opening connections for the updater with redirects checked hop by hop. */
object UpdateHttp {
  private val REDIRECT_STATUSES = setOf(301, 302, 303, 307, 308)

  /**
   * Opens [start] and follows up to [MAX_REDIRECTS] redirects itself, checking every hop against
   * [policy] before connecting to it. [configure] runs on every hop's connection (timeouts,
   * headers). Returns the final, non-redirect connection with its status read; the caller
   * disconnects it. Throws [DownloadException]: `redirect` for a refused hop, `network` when a
   * connection fails.
   */
  fun open(
    start: URL,
    policy: HostPolicy,
    openConnection: (URL) -> HttpURLConnection,
    configure: (HttpURLConnection) -> Unit,
  ): HttpURLConnection {
    val loopbackChain = start.host == LOOPBACK_HOST
    var url = start
    var redirects = 0
    while (true) {
      if (!policy.allows(url, loopbackChain)) throw DownloadException("redirect", "Refused host")
      val connection =
        try {
          openConnection(url)
        } catch (error: IOException) {
          throw DownloadException("network", error.javaClass.simpleName)
        }
      connection.instanceFollowRedirects = false
      val status =
        try {
          connection.setRequestProperty("User-Agent", UPDATER_USER_AGENT)
          configure(connection)
          connection.responseCode
        } catch (error: IOException) {
          connection.disconnect()
          throw DownloadException("network", error.javaClass.simpleName)
        }
      if (status !in REDIRECT_STATUSES) return connection
      val location = connection.getHeaderField("Location")
      connection.disconnect()
      redirects += 1
      if (location == null || redirects > MAX_REDIRECTS) {
        throw DownloadException("redirect", "Too many redirects")
      }
      url =
        try {
          URL(url, location)
        } catch (_: MalformedURLException) {
          throw DownloadException("redirect", "Bad location")
        }
    }
  }
}
