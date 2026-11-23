package org.navoss.mobile.navigation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SnapshotVersionTest {
  @Test
  fun `reads the top-level state version of a sorted snapshot`() {
    val snapshot = """{"guidance":{"stepIndex":2},"phase":"tracking","speedingState":"unknown","stateVersion":41,"trip":{"id":"t"}}"""
    assertEquals(41L, NavigationRuntime.stateVersionOf(snapshot))
  }

  @Test
  fun `a snapshot without a version has none`() {
    assertNull(NavigationRuntime.stateVersionOf("""{"phase":"idle"}"""))
  }
}
