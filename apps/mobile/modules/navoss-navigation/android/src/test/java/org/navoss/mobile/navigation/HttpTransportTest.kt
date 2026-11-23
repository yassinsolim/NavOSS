package org.navoss.mobile.navigation

import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

class HttpTransportTest {
  private val server = ServerSocket(0)
  private val completions = LinkedBlockingQueue<Pair<Long, String>>()
  private val release = CountDownLatch(1)
  private val received = LinkedBlockingQueue<String>()
  private val transport = HttpTransport(
    Executors.newCachedThreadPool(),
    Executors.newSingleThreadScheduledExecutor(),
    { id, response -> completions += id to response },
  )

  /** A minimal HTTP/1.1 server: the JVM test classpath is android.jar, without com.sun's. */
  @Before
  fun setUp() {
    Thread {
      while (!server.isClosed) {
        val socket = try {
          server.accept()
        } catch (_: java.io.IOException) {
          return@Thread
        }
        Thread { serve(socket) }.start()
      }
    }.start()
  }

  private fun serve(socket: Socket) = socket.use {
    val input = socket.getInputStream().bufferedReader(Charsets.UTF_8)
    val (method, path) = input.readLine().split(" ")
    var length = 0
    var contentType: String? = null
    while (true) {
      val line = input.readLine()
      if (line.isNullOrEmpty()) break
      val (name, value) = line.split(":", limit = 2).map(String::trim)
      if (name.equals("content-length", true)) length = value.toInt()
      if (name.equals("content-type", true)) contentType = value
    }
    val body = CharArray(length).also { input.read(it) }.concatToString()
    val (status, answer) = when (path) {
      "/v2/routes" -> {
        received += "$method $contentType $body"
        200 to """{"routes":["é"]}"""
      }
      "/v2/missing" -> 404 to """{"title":"Not found"}"""
      else -> {
        release.await(10, TimeUnit.SECONDS)
        200 to ""
      }
    }
    val bytes = answer.toByteArray(Charsets.UTF_8)
    val output = socket.getOutputStream()
    output.write("HTTP/1.1 $status X\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
    output.write(bytes)
    output.flush()
  }

  @After
  fun tearDown() {
    release.countDown()
    server.close()
  }

  private fun url(path: String) = "http://127.0.0.1:${server.localPort}$path"

  private fun request(path: String, method: String = "GET", body: String? = null, timeoutMs: Long = 5_000) =
    JSONObject()
      .put("method", method)
      .put("url", url(path))
      .put("headers", JSONObject().put("content-type", "application/json"))
      .put("timeoutMs", timeoutMs)
      .apply { body?.let { put("body", it) } }
      .toString()

  private fun nextCompletion(): Pair<Long, String> = completions.poll(10, TimeUnit.SECONDS)!!

  @Test
  fun `posts the body and answers status and body`() {
    transport.request(7, request("/v2/routes", "POST", """{"origin":1}"""))
    val (id, response) = nextCompletion()
    assertEquals(7L, id)
    assertEquals("POST application/json {\"origin\":1}", received.poll(1, TimeUnit.SECONDS))
    val json = JSONObject(response)
    assertEquals(200, json.getInt("status"))
    assertEquals("""{"routes":["é"]}""", json.getString("body"))
  }

  @Test
  fun `an error status still carries the problem body`() {
    transport.request(1, request("/v2/missing"))
    val json = JSONObject(nextCompletion().second)
    assertEquals(404, json.getInt("status"))
    assertEquals("""{"title":"Not found"}""", json.getString("body"))
  }

  @Test
  fun `an unreachable host is unreachable`() {
    server.close()
    transport.request(2, request("/v2/routes"))
    assertEquals(HttpTransport.ERROR_UNREACHABLE, nextCompletion().second)
  }

  @Test
  fun `the timeout bounds the whole exchange and completes once`() {
    transport.request(3, request("/slow", timeoutMs = 300))
    assertEquals(3L to HttpTransport.ERROR_TIMEOUT, nextCompletion())
    release.countDown()
    assertNull(completions.poll(1, TimeUnit.SECONDS))
  }

  @Test
  fun `a cancelled request is never completed`() {
    transport.request(4, request("/slow", timeoutMs = 500))
    transport.cancel(4)
    release.countDown()
    assertNull(completions.poll(1_500, TimeUnit.MILLISECONDS))
  }

  @Test
  fun `a malformed request is unreachable`() {
    transport.request(5, "not json")
    assertEquals(5L to HttpTransport.ERROR_UNREACHABLE, nextCompletion())
  }
}
