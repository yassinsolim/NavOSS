package org.navoss.mobile.navigation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NavigationClockTest {
  private var current = 1L
  private var starts = 0
  private var stops = 0
  private var ticks = 0
  private var tickAction: (() -> Unit)? = null
  private val ticker = object : Ticker {
    override fun start(intervalMs: Long, tick: () -> Unit) {
      assertEquals(1_000L, intervalMs)
      starts += 1
      tickAction = tick
    }

    override fun stop() {
      stops += 1
      tickAction = null
    }
  }
  private val clock = NavigationClock(ticker, { it == current }) { ticks += 1 }

  @Test
  fun `ticks the core while running`() {
    clock.start(1)
    tickAction!!()
    tickAction!!()
    assertEquals(2, ticks)
  }

  @Test
  fun `a stale start or a second start does nothing`() {
    clock.start(0)
    assertFalse(clock.isRunning)
    clock.start(1)
    clock.start(1)
    assertEquals(1, starts)
  }

  @Test
  fun `a stop queued by an earlier trip cannot stop the new trip's clock`() {
    clock.start(1)
    current = 2
    clock.stop(1)
    assertTrue(clock.isRunning)
    assertEquals(0, stops)
    clock.stop(2)
    assertFalse(clock.isRunning)
    assertEquals(1, stops)
  }
}
