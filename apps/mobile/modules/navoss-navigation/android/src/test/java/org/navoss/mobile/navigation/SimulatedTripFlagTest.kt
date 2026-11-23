package org.navoss.mobile.navigation

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SimulatedTripFlagTest {
  @Test
  fun `a simulated trip stays simulated after its simulation stops, until End, Done or a live route`() {
    val flag = SimulatedTripFlag()
    assertFalse(flag.isSet)
    flag.simulationStarted()
    // The simulation stopping at arrival does not touch the flag: only the route does.
    assertTrue(flag.isSet)
    flag.routeEnded()
    assertFalse(flag.isSet)

    flag.simulationStarted()
    flag.liveRouteSet()
    assertFalse(flag.isSet)
  }
}
