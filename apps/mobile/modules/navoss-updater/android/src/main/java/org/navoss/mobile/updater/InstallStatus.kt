package org.navoss.mobile.updater

import android.content.pm.PackageInstaller

/**
 * The installer's result as a short code for JavaScript, which turns it into plain copy. Codes
 * only: the system's free-text status message is never forwarded or logged.
 */
fun installStatusCode(status: Int): String =
  when (status) {
    PackageInstaller.STATUS_PENDING_USER_ACTION -> "pending-user-action"
    PackageInstaller.STATUS_SUCCESS -> "success"
    PackageInstaller.STATUS_FAILURE_ABORTED -> "cancelled"
    PackageInstaller.STATUS_FAILURE_BLOCKED -> "blocked"
    PackageInstaller.STATUS_FAILURE_CONFLICT -> "conflict"
    PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> "incompatible"
    PackageInstaller.STATUS_FAILURE_INVALID -> "invalid"
    PackageInstaller.STATUS_FAILURE_STORAGE -> "storage"
    // STATUS_FAILURE_TIMEOUT (API 34): the user did not answer the system prompt in time.
    8 -> "cancelled"
    else -> "failed"
  }
