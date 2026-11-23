package org.navoss.mobile.updater

import java.io.BufferedReader
import java.io.File
import java.io.IOException
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import kotlin.concurrent.thread

class ApkDownloaderTest {
  @get:Rule val folder = TemporaryFolder()

  private val body = ByteArray(700_000) { (it * 31 % 251).toByte() }
  private lateinit var server: ServerSocket
  private val lastRange = AtomicReference<String?>(null)
  private val requests = AtomicInteger(0)
  /** How the fake server answers: honour ranges, ignore them, or drop after N bytes. */
  @Volatile private var honourRange = true
  @Volatile private var dropAfter = -1
  @Volatile private var rangeStatus = 206

  @Before
  fun start() {
    server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    thread(isDaemon = true) {
      while (!server.isClosed) {
        val socket = runCatching { server.accept() }.getOrNull() ?: break
        socket.use { serve(it) }
      }
    }
  }

  @After
  fun stop() {
    server.close()
  }

  /** A minimal HTTP/1.1 server: enough for one GET with an optional `Range` header. */
  private fun serve(socket: Socket) {
    val reader = BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.US_ASCII))
    var range: String? = null
    while (true) {
      val line = reader.readLine() ?: return
      if (line.isEmpty()) break
      if (line.startsWith("Range:", ignoreCase = true)) range = line.substringAfter(':').trim()
    }
    lastRange.set(range)
    requests.incrementAndGet()
    val output = socket.getOutputStream()
    var start = 0
    val head =
      if (range != null && honourRange) {
        if (rangeStatus == 416) {
          output.write("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
          output.flush()
          return
        }
        start = range.removePrefix("bytes=").removeSuffix("-").toInt()
        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes $start-${body.size - 1}/${body.size}\r\n" +
          "Content-Length: ${body.size - start}\r\nConnection: close\r\n\r\n"
      } else {
        "HTTP/1.1 200 OK\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n"
      }
    output.write(head.toByteArray())
    val end = if (dropAfter >= 0) minOf(body.size, start + dropAfter) else body.size
    output.write(body, start, end - start)
    output.flush()
  }

  private val url get() = "http://127.0.0.1:${server.localPort}/navoss.apk"
  private fun target() = File(folder.root, "updates/navoss-102.apk")

  private fun download(cancelled: AtomicBoolean = AtomicBoolean(false)): File =
    ApkDownloader().download(url, target(), body.size.toLong(), cancelled) { _, _ -> }

  @Test
  fun downloadsTheWholeFileAndReportsProgress() {
    var last = 0L
    val file =
      ApkDownloader().download(url, target(), body.size.toLong(), AtomicBoolean(false)) { received, _ ->
        assertTrue(received >= last)
        last = received
      }
    assertArrayEquals(body, file.readBytes())
    assertEquals(body.size.toLong(), last)
    assertFalse(File(file.path + ".part").exists())
  }

  @Test
  fun resumesAPartialDownloadWithARangeRequest() {
    val part = File(target().path + ".part")
    part.parentFile.mkdirs()
    part.writeBytes(body.copyOfRange(0, 300_000))
    val file = download()
    assertEquals("bytes=300000-", lastRange.get())
    assertArrayEquals(body, file.readBytes())
  }

  @Test
  fun startsAgainWhenTheServerIgnoresTheRange() {
    honourRange = false
    val part = File(target().path + ".part")
    part.parentFile.mkdirs()
    part.writeBytes(ByteArray(300_000) { 9 })
    assertArrayEquals(body, download().readBytes())
  }

  @Test
  fun startsAgainWhenTheServerRefusesTheRange() {
    rangeStatus = 416
    val part = File(target().path + ".part")
    part.parentFile.mkdirs()
    part.writeBytes(ByteArray(300_000) { 9 })
    assertArrayEquals(body, download().readBytes())
  }

  @Test
  fun keepsThePartialFileWhenTheConnectionDropsAndFinishesLater() {
    dropAfter = 250_000
    try {
      download()
      fail("expected a dropped connection")
    } catch (error: DownloadException) {
      assertEquals("network", error.code)
    }
    val part = File(target().path + ".part")
    assertEquals(250_000L, part.length())
    dropAfter = -1
    assertArrayEquals(body, download().readBytes())
    assertEquals("bytes=250000-", lastRange.get())
  }

  @Test
  fun cancellingDeletesThePartialFile() {
    val cancelled = AtomicBoolean(true)
    try {
      download(cancelled)
      fail("expected cancellation")
    } catch (error: DownloadException) {
      assertEquals("cancelled", error.code)
    }
    assertFalse(File(target().path + ".part").exists())
    assertFalse(target().exists())
  }

  @Test
  fun refusesAFileLargerThanTheReleaseAnnounced() {
    try {
      ApkDownloader().download(url, target(), 1_000, AtomicBoolean(false)) { _, _ -> }
      fail("expected a size error")
    } catch (error: DownloadException) {
      assertEquals("size", error.code)
    }
    assertFalse(File(target().path + ".part").exists())
  }

  private fun downloadError(downloader: ApkDownloader, size: Long = body.size.toLong()): String =
    try {
      downloader.download(url, target(), size, AtomicBoolean(false)) { _, _ -> }
      fail("expected the download to stop")
      ""
    } catch (error: DownloadException) {
      error.code
    }

  @Test
  fun reportsAFailedWriteAsStorageAndDeletesThePartialFile() {
    // The disk fills after 200 kB: an output failure, not a network one.
    val full =
      ApkDownloader(
        openOutput = { file, append ->
          val stream = java.io.FileOutputStream(file, append)
          object : OutputStream() {
            var written = 0
            override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)
            override fun write(b: ByteArray, off: Int, len: Int) {
              if (written + len > 200_000) throw IOException("ENOSPC (No space left on device)")
              written += len
              stream.write(b, off, len)
            }
            override fun close() = stream.close()
          }
        },
      )
    assertEquals("storage", downloadError(full))
    assertFalse(File(target().path + ".part").exists())
    assertFalse(target().exists())
  }

  @Test
  fun reportsAnOutputFileThatCannotBeCreatedAsStorage() {
    // The updates directory's path is taken by a plain file.
    File(folder.root, "updates").writeText("not a directory")
    assertEquals("storage", downloadError(ApkDownloader()))
    assertEquals(0, requests.get())
  }

  @Test
  fun refusesToStartWithoutRoomForTheDownloadAndItsInstall() {
    // Room for the file but not for the installer's copy of it.
    val tight = ApkDownloader(freeSpace = { body.size.toLong() + 10 })
    assertEquals("storage", downloadError(tight))
    assertEquals(0, requests.get())
    val roomy = ApkDownloader(freeSpace = { body.size * 2L })
    assertArrayEquals(
      body,
      roomy.download(url, target(), body.size.toLong(), AtomicBoolean(false)) { _, _ -> }.readBytes(),
    )
  }

  @Test
  fun refusesAnAssetAboveTheSizeCeilingBeforeAnyRequest() {
    assertEquals("size", downloadError(ApkDownloader(), MAX_APK_BYTES + 1))
    assertEquals(0, requests.get())
  }

  @Test
  fun refusesAResponseThatAnnouncesMoreThanTheReleaseDeclared() {
    // The server announces 700 kB and sends 640 kB; the release declared 650 kB. Without the
    // Content-Length check this looks like a dropped connection and the partial file is kept.
    dropAfter = 640_000
    assertEquals("size", downloadError(ApkDownloader(), 650_000))
    assertFalse(File(target().path + ".part").exists())
  }
}
