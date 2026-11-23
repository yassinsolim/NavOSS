package org.navoss.mobile.updater

import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** Fake redirect chains across GitHub's hosts and others, for the feed and the APK. */
class RedirectPolicyTest {
  @get:Rule val folder = TemporaryFolder()
  private var server: FakeHttpServer? = null

  @After
  fun stop() {
    server?.close()
  }

  private fun serve(vararg routes: Pair<String, FakeResponse>) =
    FakeHttpServer(routes.toMap()).also { server = it }

  private fun redirect(to: String, status: Int = 302) =
    FakeResponse(status = status, headers = listOf("Location: $to"))

  private val apk = ByteArray(5_000) { (it % 251).toByte() }
  private val assetPath = "/yassinsolim/NavOSS/releases/download/android-v0.2.0-102/navoss.apk"
  private val assetUrl = "https://github.com$assetPath"
  private val feedPath = "/repos/yassinsolim/NavOSS/releases?per_page=10"
  private val feedUrl = "https://api.github.com$feedPath"

  private fun target() = File(folder.root, "updates/navoss-102.apk")

  private fun download(fake: FakeHttpServer, url: String = assetUrl): File =
    ApkDownloader(openConnection = fake::connect)
      .download(url, target(), apk.size.toLong(), AtomicBoolean(false)) { _, _ -> }

  private fun downloadError(fake: FakeHttpServer, url: String = assetUrl): String =
    try {
      download(fake, url)
      fail("expected the download to be refused")
      ""
    } catch (error: DownloadException) {
      error.code
    }

  private fun feedError(fake: FakeHttpServer, url: String = feedUrl): String =
    try {
      FeedFetcher(fake::connect).fetch(url)
      fail("expected the feed to be refused")
      ""
    } catch (error: DownloadException) {
      error.code
    }

  @Test
  fun followsGitHubsAssetRedirect() {
    val fake =
      serve(
        "github.com$assetPath" to redirect("https://release-assets.githubusercontent.com/a/1?sig=x"),
        "release-assets.githubusercontent.com/a/1?sig=x" to FakeResponse(body = apk),
      )
    assertArrayEquals(apk, download(fake).readBytes())
    assertEquals(
      listOf("github.com$assetPath", "release-assets.githubusercontent.com/a/1?sig=x"),
      fake.requests,
    )
    // Every hop names only the app: no device model or Android version.
    assertEquals(listOf(UPDATER_USER_AGENT, UPDATER_USER_AGENT), fake.userAgents)
  }

  @Test
  fun refusesAnAssetRedirectToAnotherHostWithoutContactingIt() {
    val fake =
      serve(
        "github.com$assetPath" to redirect("https://evil.example/navoss.apk"),
        "evil.example/navoss.apk" to FakeResponse(body = apk),
      )
    assertEquals("redirect", downloadError(fake))
    assertEquals(listOf("github.com$assetPath"), fake.requests)
    assertFalse(File(target().path + ".part").exists())
  }

  @Test
  fun refusesPlainHttpAnOddPortAndALoopbackHopInAGitHubChain() {
    for (location in
      listOf(
        "http://release-assets.githubusercontent.com/a/1",
        "https://release-assets.githubusercontent.com:8443/a/1",
        "http://127.0.0.1/a/1",
      )) {
      val fake = serve("github.com$assetPath" to redirect(location))
      assertEquals(location, "redirect", downloadError(fake))
      assertEquals(1, fake.requests.size)
      fake.close()
    }
  }

  @Test
  fun refusesAStartingUrlOutsideGitHub() {
    val fake = serve()
    assertEquals("redirect", downloadError(fake, "https://evil.example/navoss.apk"))
    assertEquals("redirect", downloadError(fake, "http://localhost:8765/navoss.apk"))
    assertEquals("redirect", feedError(fake, "https://github.com/repos/x/releases"))
    assertEquals(emptyList<String>(), fake.requests)
  }

  @Test
  fun stopsAfterThreeRedirects() {
    val fake =
      serve(
        "github.com$assetPath" to redirect("https://github.com/1"),
        "github.com/1" to redirect("https://github.com/2"),
        "github.com/2" to redirect("https://github.com/3"),
        "github.com/3" to redirect("https://release-assets.githubusercontent.com/a/1"),
        "release-assets.githubusercontent.com/a/1" to FakeResponse(body = apk),
      )
    assertEquals("redirect", downloadError(fake))
    assertEquals(4, fake.requests.size)
  }

  @Test
  fun feedFollowsARedirectOnlyWithinTheApiHost() {
    val moved = "/repositories/123/releases?per_page=10"
    val fake =
      serve(
        "api.github.com$feedPath" to redirect("https://api.github.com$moved", status = 301),
        "api.github.com$moved" to FakeResponse(body = "[]".toByteArray()),
      )
    assertEquals("[]", FeedFetcher(fake::connect).fetch(feedUrl).body)
    assertEquals(listOf(UPDATER_USER_AGENT, UPDATER_USER_AGENT), fake.userAgents)
    fake.close()

    val away =
      serve(
        "api.github.com$feedPath" to redirect("https://github.com/releases.json"),
        "github.com/releases.json" to FakeResponse(body = "[]".toByteArray()),
      )
    assertEquals("redirect", feedError(away))
    assertEquals(listOf("api.github.com$feedPath"), away.requests)
  }

  @Test
  fun aLocalTestFeedStaysOnTheLoopbackAddress() {
    val fake =
      serve(
        "127.0.0.1/releases" to FakeResponse(body = "[]".toByteArray()),
        "127.0.0.1/away" to redirect("https://api.github.com$feedPath"),
      )
    val local = "http://127.0.0.1:${fake.port}"
    assertEquals("[]", FeedFetcher(fake::connect).fetch("$local/releases").body)
    assertEquals("redirect", feedError(fake, "$local/away"))
    assertEquals(listOf("127.0.0.1/releases", "127.0.0.1/away"), fake.requests)
  }
}
