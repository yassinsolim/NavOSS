package org.navoss.mobile.navigation

import org.junit.Assert.assertEquals
import org.junit.Test

class LocationAvailabilityTest {
  @Test
  fun `a device without GPS says so whatever the permission and the setting`() {
    // Simulate drive is offered for no GPS, not for a denial: a GPS-less handheld whose driver
    // declined location must still be told it has no GPS.
    for (permission in listOf(true, false)) {
      for (enabled in listOf(true, false)) {
        assertEquals(LocationAvailability.NO_GPS, LocationAvailability.of(hasGps = false, permissionGranted = permission, locationEnabled = enabled))
      }
    }
  }

  @Test
  fun `with GPS a denial comes before Location off`() {
    assertEquals(LocationAvailability.PERMISSION_DENIED, LocationAvailability.of(hasGps = true, permissionGranted = false, locationEnabled = false))
    assertEquals(LocationAvailability.LOCATION_OFF, LocationAvailability.of(hasGps = true, permissionGranted = true, locationEnabled = false))
    assertEquals(LocationAvailability.AVAILABLE, LocationAvailability.of(hasGps = true, permissionGranted = true, locationEnabled = true))
  }
}
