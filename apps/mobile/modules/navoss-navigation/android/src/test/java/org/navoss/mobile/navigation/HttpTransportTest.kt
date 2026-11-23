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
    "http://127.0.0.1:${server.localPort}",
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
      "/v2/huge" -> 200 to "x".repeat(HttpTransport.MAX_RESPONSE_BYTES + 1)
      "/v2/redirect" -> {
        received += "redirect"
        302 to ""
      }
      else -> {
        release.await(10, TimeUnit.SECONDS)
        200 to ""
      }
    }
    val bytes = answer.toByteArray(Charsets.UTF_8)
    val output = socket.getOutputStream()
    val location = if (status == 302) "Location: http://localhost:${server.localPort}/v2/routes\r\n" else ""
    output.write("HTTP/1.1 $status X\r\n${location}Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
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

  @Test
  fun `a cancel for an answered or unknown request is ignored and remembers nothing`() {
    // ABI 2: a cancel only ever follows its request, so an id the transport does not hold was
    // answered already (the cancel crossed the answer) or never existed. Neither may be kept.
    transport.request(8, request("/v2/routes", "POST", "{}"))
    assertEquals(8L, nextCompletion().first)
    transport.cancel(8)
    transport.cancel(99)
    transport.request(99, request("/v2/routes", "POST", "{}"))
    assertEquals(99L, nextCompletion().first)
    assertEquals(0, transport.pendingCount)
  }

  @Test
  fun `a cancel racing the answer on another thread completes at most once`() {
    val ids = 100L until 140L
    for (id in ids) {
      transport.request(id, request("/v2/routes", "POST", "{}"))
      Thread { transport.cancel(id) }.start()
    }
    Thread.sleep(1_500)
    val seen = generateSequence { completions.poll() }.map { it.first }.toList()
    assertEquals(seen.size, seen.toSet().size)
    assertEquals(0, transport.pendingCount)
  }

  @Test
  fun `only the configured origin is contacted`() {
    for ((id, other) in listOf(
      10L to "http://localhost:${server.localPort}/v2/routes",
      11L to "https://127.0.0.1:${server.localPort}/v2/routes",
      12L to "http://127.0.0.1:1/v2/routes",
      13L to "file:///etc/hosts",
    )) {
      transport.request(id, JSONObject().put("url", other).toString())
      assertEquals(id to HttpTransport.ERROR_UNREACHABLE, nextCompletion())
    }
    assertNull(received.poll(100, TimeUnit.MILLISECONDS))
  }

  @Test
  fun `redirects are not followed`() {
    transport.request(14, request("/v2/redirect"))
    assertEquals(302, JSONObject(nextCompletion().second).getInt("status"))
    assertEquals("redirect", received.poll(1, TimeUnit.SECONDS))
    assertNull(received.poll(500, TimeUnit.MILLISECONDS))
  }

  @Test
  fun `a body larger than the cap fails the request`() {
    transport.request(15, request("/v2/huge"))
    assertEquals(15L to HttpTransport.ERROR_UNREACHABLE, nextCompletion())
  }

  @Test
  fun `only HTTPS origins are accepted outside the loopback interface`() {
    assertEquals(null, HttpTransport.originOf("http://navoss.example"))
    assertEquals("https://navoss.example:443", HttpTransport.originOf("https://navoss.example/"))
    assertEquals("http://10.0.2.2:3001", HttpTransport.originOf("http://10.0.2.2:3001"))
    assertEquals(null, HttpTransport.originOf("ftp://navoss.example"))
  }
}
