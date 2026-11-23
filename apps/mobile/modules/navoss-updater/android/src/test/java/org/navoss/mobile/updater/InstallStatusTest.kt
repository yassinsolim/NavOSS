package org.navoss.mobile.updater

import android.content.pm.PackageInstaller
import org.junit.Assert.assertEquals
import org.junit.Test

class InstallStatusTest {
  @Test
  fun mapsEveryInstallerOutcomeToACode() {
    assertEquals("pending-user-action", installStatusCode(PackageInstaller.STATUS_PENDING_USER_ACTION))
    assertEquals("success", installStatusCode(PackageInstaller.STATUS_SUCCESS))
    assertEquals("cancelled", installStatusCode(PackageInstaller.STATUS_FAILURE_ABORTED))
    assertEquals("cancelled", installStatusCode(8))
    assertEquals("blocked", installStatusCode(PackageInstaller.STATUS_FAILURE_BLOCKED))
    assertEquals("conflict", installStatusCode(PackageInstaller.STATUS_FAILURE_CONFLICT))
    assertEquals("incompatible", installStatusCode(PackageInstaller.STATUS_FAILURE_INCOMPATIBLE))
    assertEquals("invalid", installStatusCode(PackageInstaller.STATUS_FAILURE_INVALID))
    assertEquals("storage", installStatusCode(PackageInstaller.STATUS_FAILURE_STORAGE))
    assertEquals("failed", installStatusCode(PackageInstaller.STATUS_FAILURE))
    assertEquals("failed", installStatusCode(42))
  }
}
