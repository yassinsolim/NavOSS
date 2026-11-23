package org.navoss.mobile.updater

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.OutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import kotlin.concurrent.thread

class InstallGateTest {
  @get:Rule val folder = TemporaryFolder()

  private class FakeSession(
    private val duringCopy: () -> Unit = {},
    private val onCommit: () -> Unit = {},
  ) : InstallSession {
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
      onCommit()
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
    val session = FakeSession(duringCopy = { gate.setTripActive(true) })
    assertEquals(DEFERRED, copyError(file, sha, session, gate))
    assertEquals(listOf("fsync", "abandon"), session.calls)
  }

  @Test
  fun commitsWithoutATripAndCommitsAgainAfterTheTripEnds() {
    val gate = InstallGate()
    val (file, sha) = apk()
    gate.setTripActive(true)
    val held = FakeSession()
    assertEquals(DEFERRED, copyError(file, sha, held, gate))
    assertFalse(held.calls.contains("commit"))
    gate.setTripActive(false)
    val after = FakeSession()
    UpdateInstaller.copyAndCommit(file, sha, after, gate)
    assertEquals(listOf("fsync", "commit"), after.calls)
    assertEquals(file.length().toInt(), after.written.size())
  }

  @Test
  fun startingATripNeverWaitsForAStalledCommit() {
    // Android's commit is an IPC that can stall; Start (the setter) must not wait for it.
    val gate = InstallGate()
    val (file, sha) = apk()
    val committing = CountDownLatch(1)
    val release = CountDownLatch(1)
    val session =
      FakeSession(
        onCommit = {
          committing.countDown()
          release.await(5, TimeUnit.SECONDS)
        },
      )
    val installer = thread { UpdateInstaller.copyAndCommit(file, sha, session, gate) }
    assertTrue(committing.await(5, TimeUnit.SECONDS))
    val setter = thread { gate.setTripActive(true) }
    setter.join(500)
    val returned = !setter.isAlive
    release.countDown()
    installer.join(5_000)
    assertTrue("the trip setter waited for the commit", returned)
    assertTrue(gate.isTripActive)
  }

  @Test
  fun bytesThatChangedAfterVerificationAreNeverCommitted() {
    val gate = InstallGate()
    val (file, _) = apk()
    val session = FakeSession()
    assertEquals("digest-mismatch", copyError(file, "AB".repeat(32), session, gate))
    assertEquals(listOf("fsync", "abandon"), session.calls)
  }
}
