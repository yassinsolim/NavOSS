package org.navoss.mobile.navigation

import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Future
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import org.json.JSONException
import org.json.JSONObject

/**
 * The core's HTTP transport (`httpRequest` / `cancelHttpRequest`). The core builds every request
 * and reads every answer; this only moves bytes over `HttpURLConnection`, which uses Android's
 * certificate store, proxy and network security config.
 *
 * Every request is completed exactly once through [complete] — `{"status","body"}` or
 * `{"error": "unreachable" | "timeout"}` — unless [cancel] arrives first, after which it is never
 * completed and never sent, even when the cancel overtakes the request itself. `timeoutMs` bounds
 * the whole exchange. Nothing is logged: URLs carry coordinates.
 *
 * Only [apiOrigin] is contacted (scheme, host and port; HTTPS except on the loopback interface,
 * see [originOf]); redirects are not followed, and a body over [MAX_RESPONSE_BYTES] after
 * decompression fails the request as unreachable.
 */
class HttpTransport(
  apiOrigin: String,
  private val executor: ExecutorService,
  private val timer: ScheduledExecutorService,
  private val complete: (requestId: Long, responseJson: String) -> Unit,
  private val open: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
) {
  private class Call {
    @Volatile var connection: HttpURLConnection? = null
    var task: Future<*>? = null
    var deadline: ScheduledFuture<*>? = null
  }

  private val origin: String? = originOf(apiOrigin)
  private val calls = ConcurrentHashMap<Long, Call>()

  /** Ids cancelled before their request was registered, oldest first; bounded. */
  private val cancelledEarly = LinkedHashSet<Long>()

  /** Returns at once; the exchange runs on [executor]. */
  fun request(requestId: Long, requestJson: String) {
    val request = try {
      JSONObject(requestJson).also { require(origin != null && originOf(it.getString("url")) == origin) }
    } catch (_: JSONException) {
      null
    } catch (_: IllegalArgumentException) {
      null
    }
    val call = Call()
    synchronized(cancelledEarly) {
      if (cancelledEarly.remove(requestId)) return
      if (request != null) calls[requestId] = call
    }
    if (request == null) {
      complete(requestId, ERROR_UNREACHABLE)
      return
    }
    val timeoutMs = request.optLong("timeoutMs", DEFAULT_TIMEOUT_MS).takeIf { it > 0 } ?: DEFAULT_TIMEOUT_MS
    synchronized(call) {
      call.deadline = timer.schedule({
        finish(requestId, ERROR_TIMEOUT)?.connection?.disconnect()
      }, timeoutMs, TimeUnit.MILLISECONDS)
      call.task = executor.submit { perform(requestId, call, request, timeoutMs) }
    }
  }

  /** The trip was cleared or replaced: abandon the exchange and never complete it. */
  fun cancel(requestId: Long) {
    val call = synchronized(cancelledEarly) {
      calls.remove(requestId) ?: run {
        // Not registered yet (or already completed): remember it so it is never sent.
        cancelledEarly += requestId
        if (cancelledEarly.size > MAX_EARLY_CANCELS) cancelledEarly.remove(cancelledEarly.first())
        null
      }
    } ?: return
    stop(call)
  }

  /** Cancels everything in flight (the engine is closing). */
  fun cancelAll() {
    calls.keys.toList().forEach(::cancel)
  }

  private fun perform(requestId: Long, call: Call, request: JSONObject, timeoutMs: Long) {
    val response = try {
      val connection = open(URL(request.getString("url")))
      call.connection = connection
      if (!calls.containsKey(requestId)) {
        connection.disconnect()
        return
      }
      connection.connectTimeout = timeoutMs.toInt()
      connection.readTimeout = timeoutMs.toInt()
      connection.instanceFollowRedirects = false
      connection.useCaches = false
      connection.requestMethod = request.optString("method", "GET")
      request.optJSONObject("headers")?.let { headers ->
        for (name in headers.keys()) connection.setRequestProperty(name, headers.getString(name))
      }
      val body = if (request.has("body") && !request.isNull("body")) request.getString("body") else null
      if (body != null) {
        connection.doOutput = true
        val bytes = body.toByteArray(Charsets.UTF_8)
        connection.setFixedLengthStreamingMode(bytes.size)
        connection.outputStream.use { it.write(bytes) }
      }
      val status = connection.responseCode
      val stream: InputStream? = if (status >= 400) connection.errorStream else connection.inputStream
      val text = stream?.use { readCapped(it) }?.toString(Charsets.UTF_8) ?: ""
      connection.disconnect()
      JSONObject().put("status", status).put("body", text).toString()
    } catch (_: SocketTimeoutException) {
      ERROR_TIMEOUT
    } catch (_: IOException) {
      ERROR_UNREACHABLE
    } catch (_: JSONException) {
      ERROR_UNREACHABLE
    } catch (_: IllegalArgumentException) {
      ERROR_UNREACHABLE
    } catch (_: SecurityException) {
      ERROR_UNREACHABLE
    }
    finish(requestId, response)
  }

  /** Completes `requestId` if nobody did yet; returns its call when this completion won. */
  private fun finish(requestId: Long, responseJson: String): Call? {
    val call = calls.remove(requestId) ?: return null
    synchronized(call) { call.deadline?.cancel(false) }
    complete(requestId, responseJson)
    return call
  }

  private fun stop(call: Call) {
    synchronized(call) {
      call.deadline?.cancel(false)
      call.task?.cancel(true)
    }
    call.connection?.disconnect()
  }

  private fun readCapped(stream: InputStream): ByteArray {
    val output = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(16 * 1024)
    while (true) {
      val count = stream.read(buffer)
      if (count < 0) return output.toByteArray()
      if (output.size() + count > MAX_RESPONSE_BYTES) throw IOException("response too large")
      output.write(buffer, 0, count)
    }
  }

  companion object {
    /** Larger than any route answer (a long trip with alternatives is a few hundred KB). */
    const val MAX_RESPONSE_BYTES = 8 * 1024 * 1024
    private const val MAX_EARLY_CANCELS = 64
    private val LOOPBACK_HOSTS = setOf("127.0.0.1", "localhost", "::1", "[::1]", "10.0.2.2")

    /**
     * `scheme://host:port` of [url], or `null` when it may not be contacted: anything but HTTPS,
     * except plain HTTP to the loopback interface (or the emulator's alias for the host) for a
     * local development API.
     */
    fun originOf(url: String): String? {
      val parsed = try {
        URL(url)
      } catch (_: java.net.MalformedURLException) {
        return null
      }
      val host = parsed.host.lowercase().takeIf { it.isNotEmpty() } ?: return null
      val allowed = parsed.protocol == "https" || (parsed.protocol == "http" && host in LOOPBACK_HOSTS)
      if (!allowed) return null
      val port = if (parsed.port == -1) parsed.defaultPort else parsed.port
      return "${parsed.protocol}://$host:$port"
    }

    const val DEFAULT_TIMEOUT_MS = 20_000L
    const val ERROR_UNREACHABLE = """{"error":"unreachable"}"""
    const val ERROR_TIMEOUT = """{"error":"timeout"}"""
  }
}
