package org.navoss.mobile.updater

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import java.io.File
import java.io.OutputStream
import java.security.MessageDigest

/** The code for an install held back because a trip is active; the verified file is kept. */
const val DEFERRED = "deferred"

/** The parts of a `PackageInstaller.Session` the copy-and-commit step uses (a fake in tests). */
interface InstallSession {
  fun openWrite(length: Long): OutputStream

  fun fsync(output: OutputStream)

  fun commit()

  fun abandon()
}

/** Hands a verified APK to the system through a `PackageInstaller` session. */
class UpdateInstaller(private val context: Context) {
  /**
   * Streams [file] into a new session and commits it unless a trip is active (see
   * [copyAndCommit]). The result arrives at [InstallResultReceiver].
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
      val intent =
        Intent(context, InstallResultReceiver::class.java).setAction(InstallResultReceiver.ACTION)
      val flags =
        PendingIntent.FLAG_UPDATE_CURRENT or
          (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
      val pending = PendingIntent.getBroadcast(context, sessionId, intent, flags)
      copyAndCommit(
        file,
        expectedSha256,
        object : InstallSession {
          override fun openWrite(length: Long) = session.openWrite("navoss.apk", 0, length)

          override fun fsync(output: OutputStream) = session.fsync(output)

          override fun commit() = session.commit(pending.intentSender)

          override fun abandon() = session.abandon()
        },
        InstallGate.shared,
      )
    } finally {
      session.close()
    }
  }

  companion object {
    /**
     * Streams [file] into [session] while hashing it again, so the installer gets the verified
     * bytes, then commits through [gate]: a trip that became active during the copy abandons the
     * session (`deferred`) instead of committing it.
     */
    fun copyAndCommit(file: File, expectedSha256: String, session: InstallSession, gate: InstallGate) {
      try {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
          session.openWrite(file.length()).use { output ->
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
          throw DownloadException(Rejection.DIGEST_MISMATCH.code, "Changed after verification")
        }
        if (!gate.commitUnlessTrip { session.commit() }) {
          throw DownloadException(DEFERRED, "A trip started")
        }
      } catch (error: Exception) {
        runCatching { session.abandon() }
        throw error
      }
    }
  }
}
