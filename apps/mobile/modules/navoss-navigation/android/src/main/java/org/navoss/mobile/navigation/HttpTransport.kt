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
 * completed. `timeoutMs` bounds the whole exchange. Nothing is logged: URLs carry coordinates.
 */
class HttpTransport(
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

  private val calls = ConcurrentHashMap<Long, Call>()

  /** Returns at once; the exchange runs on [executor]. */
  fun request(requestId: Long, requestJson: String) {
    val request = try {
      JSONObject(requestJson)
    } catch (_: JSONException) {
      complete(requestId, ERROR_UNREACHABLE)
      return
    }
    val timeoutMs = request.optLong("timeoutMs", DEFAULT_TIMEOUT_MS).takeIf { it > 0 } ?: DEFAULT_TIMEOUT_MS
    val call = Call()
    calls[requestId] = call
    synchronized(call) {
      call.deadline = timer.schedule({
        finish(requestId, ERROR_TIMEOUT)?.connection?.disconnect()
      }, timeoutMs, TimeUnit.MILLISECONDS)
      call.task = executor.submit { perform(requestId, call, request, timeoutMs) }
    }
  }

  /** The trip was cleared or replaced: abandon the exchange and never complete it. */
  fun cancel(requestId: Long) {
    val call = calls.remove(requestId) ?: return
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
      connection.instanceFollowRedirects = true
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
      val text = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
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

  companion object {
    const val DEFAULT_TIMEOUT_MS = 20_000L
    const val ERROR_UNREACHABLE = """{"error":"unreachable"}"""
    const val ERROR_TIMEOUT = """{"error":"timeout"}"""
  }
}
