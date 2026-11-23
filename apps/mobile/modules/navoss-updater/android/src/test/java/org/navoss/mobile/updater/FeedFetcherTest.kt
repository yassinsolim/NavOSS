package org.navoss.mobile.updater

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class FeedFetcherTest {
  private val feed = "https://api.github.com/repos/yassinsolim/NavOSS/releases?per_page=10"
  private val path = "/repos/yassinsolim/NavOSS/releases?per_page=10"
  private var server: FakeHttpServer? = null

  @After
  fun stop() {
    server?.close()
  }

  private fun serve(response: FakeResponse): FakeHttpServer =
    FakeHttpServer(mapOf("api.github.com$path" to response)).also { server = it }

  private fun fetchError(fetcher: FeedFetcher): String =
    try {
      fetcher.fetch(feed)
      fail("expected the feed to be refused")
      ""
    } catch (error: DownloadException) {
      error.code
    }

  @Test
  fun returnsTheReleasesListAsText() {
    val fake = serve(FakeResponse(body = "[{\"tag_name\":\"android-v0.2.0-102\"}]".toByteArray()))
    val response = FeedFetcher(fake::connect, maxBytes = 1_000).fetch(feed)
    assertEquals(200, response.status)
    assertEquals("[{\"tag_name\":\"android-v0.2.0-102\"}]", response.body)
  }

  @Test
  fun returnsOtherStatusesWithoutReadingTheBody() {
    val fake = serve(FakeResponse(status = 403, body = ByteArray(5_000)))
    val response = FeedFetcher(fake::connect, maxBytes = 1_000).fetch(feed)
    assertEquals(403, response.status)
    assertNull(response.body)
  }

  @Test
  fun refusesAnAnnouncedLengthAboveTheCeiling() {
    // Announces 5 MB and sends 10 bytes: refused on the header alone, before reading.
    val fake =
      serve(
        FakeResponse(
          headers = listOf("Content-Length: 5000000"),
          body = ByteArray(10),
          sendLength = false,
        ),
      )
    assertEquals("too-large", fetchError(FeedFetcher(fake::connect, maxBytes = 1_000)))
  }

  @Test
  fun stopsReadingPastTheCeilingWhenNoLengthIsAnnounced() {
    val fake = serve(FakeResponse(body = ByteArray(200_000) { ' '.code.toByte() }, sendLength = false))
    assertEquals("too-large", fetchError(FeedFetcher(fake::connect, maxBytes = 1_000)))
    // Exactly at the ceiling is fine.
    fake.close()
    val exact = serve(FakeResponse(body = ByteArray(1_000) { ' '.code.toByte() }, sendLength = false))
    assertEquals(1_000, FeedFetcher(exact::connect, maxBytes = 1_000).fetch(feed).body?.length)
  }

  @Test
  fun stopsASlowAnswerAtTheDeadline() {
    val fake = serve(FakeResponse(body = ByteArray(100), sendLength = false))
    var now = 0L
    val fetcher = FeedFetcher(fake::connect, deadlineMillis = 10, clock = { now.also { now += 20 } })
    assertEquals("network", fetchError(fetcher))
  }

  @Test
  fun aRefusedConnectionIsANetworkFailure() {
    val fake = serve(FakeResponse())
    val port = fake.port
    fake.close()
    val fetcher = FeedFetcher({ url -> java.net.URL("http", "127.0.0.1", port, url.file).openConnection() as java.net.HttpURLConnection })
    assertEquals("network", fetchError(fetcher))
  }

  private fun elapsedMillis(block: () -> Unit): Long {
    val start = System.nanoTime()
    block()
    return (System.nanoTime() - start) / 1_000_000
  }

  @Test
  fun aTricklingBodyFailsAtTheDeadline() {
    val fake = serve(FakeResponse(body = ByteArray(200) { ' '.code.toByte() }, trickleMillis = 20))
    val took = elapsedMillis {
      assertEquals("network", fetchError(FeedFetcher(fake::connect, deadlineMillis = 300)))
    }
    assertTrue("took $took ms", took < 1_500)
  }

  @Test
  fun headersThatNeverComeFailAtTheDeadline() {
    val fake = serve(FakeResponse(body = "[]".toByteArray(), delayMillis = 3_000))
    val took = elapsedMillis {
      assertEquals("network", fetchError(FeedFetcher(fake::connect, deadlineMillis = 300)))
    }
    assertTrue("took $took ms", took < 1_500)
  }

  @Test
  fun oneDeadlineCoversASlowRedirectChain() {
    // Each hop answers quickly enough on its own; together they pass the deadline.
    val fake =
      FakeHttpServer(
        mapOf(
          "api.github.com$path" to
            FakeResponse(
              status = 301,
              headers = listOf("Location: https://api.github.com/a"),
              delayMillis = 150,
            ),
          "api.github.com/a" to
            FakeResponse(
              status = 301,
              headers = listOf("Location: https://api.github.com/b"),
              delayMillis = 150,
            ),
          // An empty body: nothing to read, so only a deadline checked per hop and at EOF catches it.
          "api.github.com/b" to FakeResponse(delayMillis = 150),
        ),
      ).also { server = it }
    assertEquals("network", fetchError(FeedFetcher(fake::connect, deadlineMillis = 350)))
    assertEquals("", FeedFetcher(fake::connect, deadlineMillis = 5_000).fetch(feed).body)
  }

  @Test
  fun aBodyThatStallsEndsWithinTheDeadlinePlusOneStall() {
    // Bytes arrive every 100 ms until 0.9 s, then nothing for 5 s; with and without a known
    // length (with one, closing the stream can wait behind a blocked read).
    for (sendLength in listOf(true, false)) {
      val fake =
        serve(
          FakeResponse(
            body = ByteArray(20) { ' '.code.toByte() },
            sendLength = sendLength,
            trickleMillis = 100,
            stallAtByte = 10,
            stallMillis = 5_000,
          ),
        )
      val fetcher = FeedFetcher(fake::connect, deadlineMillis = 1_000, stallMillis = 300)
      val took = elapsedMillis { assertEquals("network", fetchError(fetcher)) }
      assertTrue("sendLength=$sendLength took $took ms", took < 1_000 + 300 + 400)
      fake.close()
    }
  }
}
