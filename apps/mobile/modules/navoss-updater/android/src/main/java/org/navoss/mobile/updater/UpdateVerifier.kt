package org.navoss.mobile.updater

import java.io.File
import java.io.InputStream
import java.security.MessageDigest

/** The package this updater installs; nothing else is ever handed to the system installer. */
const val NAVOSS_PACKAGE_NAME = "org.navoss.mobile"

/**
 * SHA-256 of the NavOSS release signing certificate (alias `navoss-release`), upper-case hex
 * without separators. Published in `docs/release/android.md`. An update must be signed by this
 * certificate and by the certificate the installed app carries.
 */
const val NAVOSS_RELEASE_CERTIFICATE_SHA256 =
  "B863F22E50BC259C5650C5838C7AE06CACFF74DAF0AC36668983A49C776C9FB7"

/** What the package manager reports about a package: installed, or an APK on disk. */
data class PackageFacts(
  val packageName: String,
  val versionCode: Long,
  /** SHA-256 of each signing certificate, upper-case hex without separators. */
  val signerSha256: Set<String>,
)

/** Why a downloaded file is refused. Each maps to one plain message in the app. */
enum class Rejection(val code: String) {
  DIGEST_MISMATCH("digest-mismatch"),
  NOT_AN_APK("not-an-apk"),
  WRONG_PACKAGE("wrong-package"),
  WRONG_SIGNER("wrong-signer"),
  NOT_NEWER("not-newer"),
}

object UpdateVerifier {
  fun sha256Hex(file: File): String = file.inputStream().use(::sha256Hex)

  fun sha256Hex(input: InputStream): String {
    val digest = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(64 * 1024)
    while (true) {
      val read = input.read(buffer)
      if (read < 0) break
      digest.update(buffer, 0, read)
    }
    return hex(digest.digest())
  }

  fun hex(bytes: ByteArray): String =
    bytes.joinToString("") { "%02X".format(it.toInt() and 0xFF) }

  /** Accepts `sha256:<hex>`, `<hex>` and colon-separated hex in either case. */
  fun normalizeSha256(value: String): String? {
    val bare = value.trim().removePrefix("sha256:").replace(":", "").uppercase()
    return if (bare.length == 64 && bare.all { it in '0'..'9' || it in 'A'..'F' }) bare else null
  }

  /**
   * All four checks, in order, before an APK may reach the installer: the bytes are the ones the
   * release published, the file is an APK of NavOSS, it is signed by the installed app's own
   * certificate (which must be the pinned release certificate), and it is newer.
   *
   * [inspect] reads the APK through the package manager in the app and through a fake in tests;
   * it returns null for a file the package manager cannot parse.
   */
  fun verify(
    file: File,
    expectedSha256: String,
    installed: PackageFacts,
    inspect: (File) -> PackageFacts?,
    pinnedSignerSha256: String = NAVOSS_RELEASE_CERTIFICATE_SHA256,
  ): Rejection? {
    val expected = normalizeSha256(expectedSha256) ?: return Rejection.DIGEST_MISMATCH
    if (sha256Hex(file) != expected) return Rejection.DIGEST_MISMATCH
    val candidate = inspect(file) ?: return Rejection.NOT_AN_APK
    if (candidate.packageName != NAVOSS_PACKAGE_NAME || installed.packageName != NAVOSS_PACKAGE_NAME) {
      return Rejection.WRONG_PACKAGE
    }
    if (
      candidate.signerSha256.isEmpty() ||
      candidate.signerSha256 != installed.signerSha256 ||
      pinnedSignerSha256 !in candidate.signerSha256
    ) {
      return Rejection.WRONG_SIGNER
    }
    if (candidate.versionCode <= installed.versionCode) return Rejection.NOT_NEWER
    return null
  }
}
