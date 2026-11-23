package org.navoss.mobile.updater

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.OutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class InstallGateTest {
  @get:Rule val folder = TemporaryFolder()

  private class FakeSession(private val duringCopy: () -> Unit = {}) : InstallSession {
    val calls = mutableListOf<String>()
    val written = ByteArrayOutputStream()

    override fun openWrite(length: Long): OutputStream =
      object : OutputStream() {
        override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)

        override fun write(b: ByteArray, off: Int, len: Int) {
          duringCopy()
          written.write(b, off, len)
        }
      }

    override fun fsync(output: OutputStream) {
      calls.add("fsync")
    }

    override fun commit() {
      calls.add("commit")
    }

    override fun abandon() {
      calls.add("abandon")
    }
  }

  private fun apk(): Pair<File, String> {
    val file = folder.newFile()
    file.writeBytes(ByteArray(200_000) { (it % 7).toByte() })
    return file to UpdateVerifier.sha256Hex(file)
  }

  private fun copyError(file: File, sha: String, session: InstallSession, gate: InstallGate) =
    try {
      UpdateInstaller.copyAndCommit(file, sha, session, gate)
      fail("expected the install to be refused")
      ""
    } catch (error: DownloadException) {
      error.code
    }

  @Test
  fun aTripThatStartsDuringTheCopyAbandonsTheSessionInsteadOfCommitting() {
    val gate = InstallGate()
    val (file, sha) = apk()
    // The driver starts guidance while the verified bytes are being copied into the session.
    val session = FakeSession(duringCopy = { gate.beginTrip() })
    assertEquals(DEFERRED, copyError(file, sha, session, gate))
    assertEquals(listOf("fsync", "abandon"), session.calls)
    assertFalse(gate.isCommitted)
  }

  @Test
  fun commitsWithoutATripAndRefusesStartUntilTheResultArrives() {
    val gate = InstallGate()
    val (file, sha) = apk()
    val session = FakeSession()
    UpdateInstaller.copyAndCommit(file, sha, session, gate)
    assertEquals(listOf("fsync", "commit"), session.calls)
    assertEquals(file.length().toInt(), session.written.size())
    assertTrue(gate.isCommitted)
    // Android is installing: Start is refused, and the hold is not taken.
    assertFalse(gate.beginTrip())
    assertFalse(gate.isTripHeld)
    // The install failed or was cancelled: Start works again at once.
    gate.finished()
    assertTrue(gate.beginTrip())
    assertTrue(gate.isTripHeld)
  }

  @Test
  fun aHeldTripBlocksTheCommitUntilItEnds() {
    val gate = InstallGate()
    val (file, sha) = apk()
    assertTrue(gate.beginTrip())
    val held = FakeSession()
    assertEquals(DEFERRED, copyError(file, sha, held, gate))
    assertFalse(held.calls.contains("commit"))
    gate.setTripHeld(false)
    val after = FakeSession()
    UpdateInstaller.copyAndCommit(file, sha, after, gate)
    assertEquals(listOf("fsync", "commit"), after.calls)
  }

  @Test
  fun bytesThatChangedAfterVerificationAreNeverCommitted() {
    val gate = InstallGate()
    val (file, _) = apk()
    val session = FakeSession()
    assertEquals("digest-mismatch", copyError(file, "AB".repeat(32), session, gate))
    assertEquals(listOf("fsync", "abandon"), session.calls)
    assertFalse(gate.isCommitted)
  }
}
