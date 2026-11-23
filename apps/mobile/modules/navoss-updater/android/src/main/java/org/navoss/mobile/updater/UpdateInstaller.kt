package org.navoss.mobile.updater

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import java.io.File
import java.security.MessageDigest

/** Hands a verified APK to the system through a `PackageInstaller` session. */
class UpdateInstaller(private val context: Context) {
  /**
   * Streams [file] into a new session while hashing it again, so the bytes the installer gets are
   * the verified bytes, then commits. The result arrives at [InstallResultReceiver].
   */
  fun install(file: File, expectedSha256: String) {
    val installer = context.packageManager.packageInstaller
    for (stale in installer.mySessions) {
      runCatching { installer.abandonSession(stale.sessionId) }
    }
    val params =
      PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
        setAppPackageName(NAVOSS_PACKAGE_NAME)
        setSize(file.length())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          setInstallReason(PackageManager.INSTALL_REASON_USER)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          // Android may skip its prompt only when NavOSS is already its own installer of record.
          // An Android 15 emulator still prompted in that case; see docs/release/android.md.
          setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          setPackageSource(PackageInstaller.PACKAGE_SOURCE_DOWNLOADED_FILE)
        }
      }
    val sessionId = installer.createSession(params)
    val session = installer.openSession(sessionId)
    try {
      val digest = MessageDigest.getInstance("SHA-256")
      file.inputStream().use { input ->
        session.openWrite("navoss.apk", 0, file.length()).use { output ->
          val buffer = ByteArray(64 * 1024)
          while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            digest.update(buffer, 0, read)
            output.write(buffer, 0, read)
          }
          session.fsync(output)
        }
      }
      if (UpdateVerifier.hex(digest.digest()) != UpdateVerifier.normalizeSha256(expectedSha256)) {
        session.abandon()
        throw DownloadException(Rejection.DIGEST_MISMATCH.code, "Changed after verification")
      }
      val intent =
        Intent(context, InstallResultReceiver::class.java).setAction(InstallResultReceiver.ACTION)
      val flags =
        PendingIntent.FLAG_UPDATE_CURRENT or
          (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
      val pending = PendingIntent.getBroadcast(context, sessionId, intent, flags)
      session.commit(pending.intentSender)
    } catch (error: Exception) {
      runCatching { session.abandon() }
      throw error
    } finally {
      session.close()
    }
  }
}
