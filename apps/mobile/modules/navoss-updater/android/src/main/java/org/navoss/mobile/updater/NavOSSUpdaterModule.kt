package org.navoss.mobile.updater

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

private const val DOWNLOAD_PROGRESS_EVENT = "onDownloadProgress"
private const val INSTALL_STATUS_EVENT = "onInstallStatus"
private const val UPDATES_DIRECTORY = "navoss-updates"

/** A rejection the JavaScript side turns into plain copy; [code] is all it receives. */
private class UpdaterException(code: String) : CodedException(code, code, null)

/**
 * Android in-app updates: download a release APK into the app's private cache, verify it, and
 * hand it to the system installer. Nothing here logs; results travel to JavaScript as codes.
 */
class NavOSSUpdaterModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val updatesDirectory: File
    get() = File(context.cacheDir, UPDATES_DIRECTORY)

  private val inspector: PackageInspector
    get() = PackageInspector(context.packageManager)

  @Volatile private var cancelled = AtomicBoolean(false)
  @Volatile private var downloading = false

  private fun apkFile(versionCode: Long) = File(updatesDirectory, "navoss-$versionCode.apk")

  override fun definition() = ModuleDefinition {
    Name("NavOSSUpdater")

    Events(DOWNLOAD_PROGRESS_EVENT, INSTALL_STATUS_EVENT)

    OnCreate {
      InstallResultReceiver.listener = { status ->
        sendEvent(INSTALL_STATUS_EVENT, mapOf("status" to status))
      }
    }

    OnDestroy {
      InstallResultReceiver.listener = null
      cancelled.set(true)
    }

    Function("getInstalledVersion") {
      val facts = inspector.installed(context.packageName)
      val info = context.packageManager.getPackageInfo(context.packageName, 0)
      mapOf(
        "versionCode" to facts.versionCode.toDouble(),
        "versionName" to (info.versionName ?: ""),
        "sdkInt" to Build.VERSION.SDK_INT,
        "signedByRelease" to (NAVOSS_RELEASE_CERTIFICATE_SHA256 in facts.signerSha256),
      )
    }

    Function("canRequestPackageInstalls") {
      Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
        context.packageManager.canRequestPackageInstalls()
    }

    Function("openInstallPermissionSettings") {
      val intent =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${context.packageName}"),
          )
        } else {
          Intent(Settings.ACTION_SECURITY_SETTINGS)
        }
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }

    /** Bytes already saved for [versionCode]: a finished file's size or a partial download. */
    Function("downloadedBytes") { versionCode: Double ->
      val file = apkFile(versionCode.toLong())
      val part = File(file.path + ".part")
      when {
        file.isFile -> file.length().toDouble()
        part.isFile -> part.length().toDouble()
        else -> 0.0
      }
    }

    AsyncFunction("download") {
      url: String,
      size: Double,
      versionCode: Double,
      promise: Promise ->
      val parsed = runCatching { URL(url) }.getOrNull()
      val loopback = parsed?.host == "127.0.0.1" || parsed?.host == "localhost"
      if (parsed == null || !(parsed.protocol == "https" || (parsed.protocol == "http" && loopback))) {
        promise.reject(UpdaterException("invalid"))
        return@AsyncFunction
      }
      if (downloading) {
        promise.reject(UpdaterException("busy"))
        return@AsyncFunction
      }
      downloading = true
      val token = AtomicBoolean(false)
      cancelled = token
      val target = apkFile(versionCode.toLong())
      Thread {
          try {
            ApkDownloader().download(url, target, size.toLong(), token) { received, total ->
              sendEvent(
                DOWNLOAD_PROGRESS_EVENT,
                mapOf("received" to received.toDouble(), "total" to total.toDouble()),
              )
            }
            promise.resolve(null)
          } catch (error: DownloadException) {
            promise.reject(UpdaterException(error.code))
          } catch (_: Exception) {
            promise.reject(UpdaterException("storage"))
          } finally {
            downloading = false
          }
        }
        .apply { name = "NavOSSUpdateDownload" }
        .start()
    }

    Function("cancelDownload") { cancelled.set(true) }

    /**
     * Verifies the downloaded APK and, when it passes, commits it to the installer. A rejected
     * file is deleted. Resolves once the session is committed; the outcome arrives as
     * `onInstallStatus`.
     */
    AsyncFunction("verifyAndInstall") { versionCode: Double, sha256: String, promise: Promise ->
      val file = apkFile(versionCode.toLong())
      Thread {
          try {
            if (!file.isFile) {
              promise.reject(UpdaterException("missing"))
              return@Thread
            }
            val rejection =
              UpdateVerifier.verify(
                file = file,
                expectedSha256 = sha256,
                installed = inspector.installed(context.packageName),
                inspect = inspector::archive,
              )
            if (rejection != null) {
              file.delete()
              promise.reject(UpdaterException(rejection.code))
              return@Thread
            }
            UpdateInstaller(context).install(file, sha256)
            promise.resolve(null)
          } catch (error: DownloadException) {
            file.delete()
            promise.reject(UpdaterException(error.code))
          } catch (_: Exception) {
            promise.reject(UpdaterException("failed"))
          }
        }
        .apply { name = "NavOSSUpdateInstall" }
        .start()
    }

    /** Deletes every saved download except the one for [keepVersionCode] (pass 0 to keep none). */
    Function("cleanDownloads") { keepVersionCode: Double ->
      val keep = apkFile(keepVersionCode.toLong())
      updatesDirectory.listFiles()?.forEach { file ->
        if (keepVersionCode <= 0 || (file != keep && file.path != keep.path + ".part")) {
          file.delete()
        }
      }
    }
  }
}
