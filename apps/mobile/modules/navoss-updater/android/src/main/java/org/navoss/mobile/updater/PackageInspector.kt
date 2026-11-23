package org.navoss.mobile.updater

import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.os.Build
import java.io.File
import java.security.MessageDigest

/** Reads package name, version code and signing certificates through the package manager. */
class PackageInspector(private val packageManager: PackageManager) {
  fun installed(packageName: String): PackageFacts =
    facts(packageManager.getPackageInfo(packageName, signingFlags()))
      ?: throw IllegalStateException("Installed package has no signing information")

  /** Null when the file is not an APK the package manager can parse. */
  fun archive(file: File): PackageFacts? {
    val info =
      try {
        packageManager.getPackageArchiveInfo(file.path, signingFlags())
      } catch (_: RuntimeException) {
        null
      } ?: return null
    return facts(info)
  }

  @Suppress("DEPRECATION")
  private fun signingFlags(): Int =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      PackageManager.GET_SIGNING_CERTIFICATES
    } else {
      PackageManager.GET_SIGNATURES
    }

  @Suppress("DEPRECATION")
  private fun facts(info: PackageInfo): PackageFacts? {
    val signatures: Array<Signature>? =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        // The current signer(s); key rotation history is not accepted as a substitute.
        info.signingInfo?.apkContentsSigners
      } else {
        info.signatures
      }
    if (signatures.isNullOrEmpty()) return null
    val versionCode =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode
      else info.versionCode.toLong()
    return PackageFacts(
      packageName = info.packageName,
      versionCode = versionCode,
      signerSha256 =
        signatures
          .map { UpdateVerifier.hex(MessageDigest.getInstance("SHA-256").digest(it.toByteArray())) }
          .toSet(),
    )
  }
}
