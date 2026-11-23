package org.navoss.mobile.navigation

/**
 * Whether the current trip, or the arrival it ended in, came from Simulate drive. Unlike
 * [NavigationRuntime.isSimulating] (a simulation is feeding the trip right now) it outlives the
 * simulation, which stops at arrival, until End or Done clears the route or a live route replaces
 * it, so a screen mounted after the arrival still says it was a simulation.
 */
internal class SimulatedTripFlag {
  @Volatile var isSet = false
    private set

  fun simulationStarted() {
    isSet = true
  }

  fun liveRouteSet() {
    isSet = false
  }

  fun routeEnded() {
    isSet = false
  }
}
