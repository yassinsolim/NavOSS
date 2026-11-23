package org.navoss.mobile.updater

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build

/**
 * Receives the installer session's status. A pending confirmation opens the system's own install
 * prompt; every other status goes to the module as a code.
 */
class InstallResultReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
    if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
      val confirm: Intent? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        } else {
          @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
        }
      if (confirm == null) {
        listener?.invoke("failed")
        return
      }
      confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        context.startActivity(confirm)
        listener?.invoke("pending-user-action")
      } catch (_: RuntimeException) {
        listener?.invoke("failed")
      }
      return
    }
    listener?.invoke(installStatusCode(status))
  }

  companion object {
    const val ACTION = "org.navoss.mobile.updater.INSTALL_STATUS"

    /** Set by the module while JavaScript is running. */
    @Volatile var listener: ((String) -> Unit)? = null
  }
}
