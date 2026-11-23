package org.navoss.mobile.updater

import java.io.BufferedReader
import java.io.Closeable
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.URL
import java.util.Collections
import kotlin.concurrent.thread

/** One canned answer: status, extra header lines, and a body (sent without length if asked). */
class FakeResponse(
  val status: Int = 200,
  val headers: List<String> = emptyList(),
  val body: ByteArray = ByteArray(0),
  val sendLength: Boolean = true,
  /** Wait this long before answering at all. */
  val delayMillis: Long = 0,
  /** Wait this long between body bytes (a server that trickles). */
  val trickleMillis: Long = 0,
)

/**
 * A minimal HTTP/1.1 server on 127.0.0.1 that answers by `host + path`. [connect] stands in for
 * the network: it sends a request for any host to this server with a `X-Original-Host` header, so
 * a redirect chain across GitHub's hosts can be followed in a unit test.
 */
class FakeHttpServer(private val routes: Map<String, FakeResponse>) : Closeable {
  private val server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
  /** Every request seen, as `host/path`. */
  val requests: MutableList<String> = Collections.synchronizedList(mutableListOf())
  /** The `User-Agent` of every request (empty when none was sent). */
  val userAgents: MutableList<String> = Collections.synchronizedList(mutableListOf())
  val port: Int get() = server.localPort

  init {
    thread(isDaemon = true) {
      while (!server.isClosed) {
        val socket = runCatching { server.accept() }.getOrNull() ?: break
        socket.use { client ->
          val reader = BufferedReader(InputStreamReader(client.getInputStream(), Charsets.US_ASCII))
          val path = reader.readLine()?.split(' ')?.getOrNull(1) ?: return@use
          var host = "127.0.0.1"
          var userAgent = ""
          while (true) {
            val line = reader.readLine() ?: return@use
            if (line.isEmpty()) break
            if (line.startsWith("X-Original-Host:", ignoreCase = true)) {
              host = line.substringAfter(':').trim()
            }
            if (line.startsWith("User-Agent:", ignoreCase = true)) {
              userAgent = line.substringAfter(':').trim()
            }
          }
          val key = host + path
          requests.add(key)
          userAgents.add(userAgent)
          val response = routes[key] ?: FakeResponse(status = 404)
          val head = StringBuilder("HTTP/1.1 ${response.status} X\r\n")
          response.headers.forEach { head.append(it).append("\r\n") }
          if (response.sendLength) head.append("Content-Length: ${response.body.size}\r\n")
          head.append("Connection: close\r\n\r\n")
          val output = client.getOutputStream()
          runCatching {
            Thread.sleep(response.delayMillis)
            output.write(head.toString().toByteArray())
            output.flush()
            if (response.trickleMillis > 0) {
              for (byte in response.body) {
                output.write(byte.toInt())
                output.flush()
                Thread.sleep(response.trickleMillis)
              }
            } else {
              output.write(response.body)
            }
            output.flush()
          }
        }
      }
    }
  }

  /** Opens [url] against this server, whatever its host, scheme and port. */
  fun connect(url: URL): HttpURLConnection {
    val local = URL("http", "127.0.0.1", port, url.file)
    val connection = local.openConnection() as HttpURLConnection
    connection.setRequestProperty("X-Original-Host", url.host)
    return connection
  }

  override fun close() = server.close()
}
