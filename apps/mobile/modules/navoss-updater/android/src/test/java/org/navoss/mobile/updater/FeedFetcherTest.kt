package org.navoss.mobile.updater

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
}
