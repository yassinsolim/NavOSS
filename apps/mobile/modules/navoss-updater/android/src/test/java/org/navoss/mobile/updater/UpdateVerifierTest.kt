package org.navoss.mobile.updater

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class UpdateVerifierTest {
  @get:Rule val folder = TemporaryFolder()

  private val release = NAVOSS_RELEASE_CERTIFICATE_SHA256
  private val debugKey = "A".repeat(64)
  private val installed = PackageFacts(NAVOSS_PACKAGE_NAME, 101, setOf(release))

  private fun apk(bytes: ByteArray = "navoss release 102".toByteArray()): Pair<File, String> {
    val file = folder.newFile()
    file.writeBytes(bytes)
    return file to UpdateVerifier.sha256Hex(file)
  }

  private fun verify(
    file: File,
    sha256: String,
    candidate: PackageFacts?,
    installedFacts: PackageFacts = installed,
  ) = UpdateVerifier.verify(file, sha256, installedFacts, { candidate })

  @Test
  fun acceptsANewerReleaseSignedNavOSSApk() {
    val (file, sha) = apk()
    assertNull(verify(file, sha, PackageFacts(NAVOSS_PACKAGE_NAME, 102, setOf(release))))
  }

  @Test
  fun acceptsTheDigestFormatsGitHubAndSha256sumPublish() {
    val (file, sha) = apk()
    val candidate = PackageFacts(NAVOSS_PACKAGE_NAME, 102, setOf(release))
    assertNull(verify(file, "sha256:${sha.lowercase()}", candidate))
    assertNull(verify(file, sha.chunked(2).joinToString(":"), candidate))
  }

  @Test
  fun rejectsTamperedBytesBeforeReadingThePackage() {
    val (file, sha) = apk()
    file.appendBytes(byteArrayOf(0))
    var inspected = false
    val result =
      UpdateVerifier.verify(file, sha, installed, {
        inspected = true
        PackageFacts(NAVOSS_PACKAGE_NAME, 102, setOf(release))
      })
    assertEquals(Rejection.DIGEST_MISMATCH, result)
    assertEquals(false, inspected)
  }

  @Test
  fun rejectsAMalformedPublishedDigest() {
    val (file, _) = apk()
    assertEquals(
      Rejection.DIGEST_MISMATCH,
      verify(file, "not-a-digest", PackageFacts(NAVOSS_PACKAGE_NAME, 102, setOf(release))),
    )
  }

  @Test
  fun rejectsAFileThePackageManagerCannotRead() {
    val (file, sha) = apk()
    assertEquals(Rejection.NOT_AN_APK, verify(file, sha, null))
  }

  @Test
  fun rejectsAnotherPackage() {
    val (file, sha) = apk()
    assertEquals(
      Rejection.WRONG_PACKAGE,
      verify(file, sha, PackageFacts("org.example.navoss", 102, setOf(release))),
    )
  }

  @Test
  fun rejectsADebugSignedBuild() {
    val (file, sha) = apk()
    assertEquals(
      Rejection.WRONG_SIGNER,
      verify(file, sha, PackageFacts(NAVOSS_PACKAGE_NAME, 102, setOf(debugKey))),
    )
  }

  @Test
  fun rejectsAnExtraSignerAndAnUnsignedApk() {
    val (file, sha) = apk()
    assertEquals(
      Rejection.WRONG_SIGNER,
      verify(file, sha, PackageFacts(NAVOSS_PACKAGE_NAME, 102, setOf(release, debugKey))),
    )
    assertEquals(
      Rejection.WRONG_SIGNER,
      verify(file, sha, PackageFacts(NAVOSS_PACKAGE_NAME, 102, emptySet())),
    )
  }

  @Test
  fun rejectsAnUpdateWhenTheInstalledAppIsNotReleaseSigned() {
    // A debug build would accept its own key; the pinned release certificate still refuses it.
    val (file, sha) = apk()
    val debugInstalled = PackageFacts(NAVOSS_PACKAGE_NAME, 101, setOf(debugKey))
    assertEquals(
      Rejection.WRONG_SIGNER,
      verify(file, sha, PackageFacts(NAVOSS_PACKAGE_NAME, 102, setOf(debugKey)), debugInstalled),
    )
  }

  @Test
  fun rejectsTheSameAndAnOlderVersion() {
    val (file, sha) = apk()
    assertEquals(
      Rejection.NOT_NEWER,
      verify(file, sha, PackageFacts(NAVOSS_PACKAGE_NAME, 101, setOf(release))),
    )
    assertEquals(
      Rejection.NOT_NEWER,
      verify(file, sha, PackageFacts(NAVOSS_PACKAGE_NAME, 100, setOf(release))),
    )
  }
}
