package org.navoss.mobile.input

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MapInputTest {
  @Test
  fun shoulderButtonsZoomAndRightStickPressRecenters() {
    assertEquals(MapInput.ZOOM_OUT, MapInput.commandFor(KeyEvent.KEYCODE_BUTTON_L1))
    assertEquals(MapInput.ZOOM_IN, MapInput.commandFor(KeyEvent.KEYCODE_BUTTON_R1))
    assertEquals(MapInput.RECENTER, MapInput.commandFor(KeyEvent.KEYCODE_BUTTON_THUMBR))
  }

  @Test
  fun focusAndTextKeysAreLeftAlone() {
    for (
      key in
        listOf(
          KeyEvent.KEYCODE_DPAD_UP,
          KeyEvent.KEYCODE_DPAD_CENTER,
          KeyEvent.KEYCODE_BUTTON_A,
          KeyEvent.KEYCODE_BUTTON_B,
          KeyEvent.KEYCODE_ENTER,
          KeyEvent.KEYCODE_R,
          KeyEvent.KEYCODE_BACK,
        )
    ) {
      assertNull(MapInput.commandFor(key))
    }
  }

  @Test
  fun restingStickIsZeroInsideTheDeadZone() {
    assertEquals(0f, MapInput.axis(0.1f, 0f), 0f)
    assertEquals(0f, MapInput.axis(-0.15f, 0f), 0f)
    assertEquals(0f, MapInput.axis(0.25f, 0.3f), 0f)
    assertEquals(0f, MapInput.axis(Float.NaN, 0f), 0f)
  }

  @Test
  fun deflectionIsRescaledFromTheDeadZoneAndRoundedToTenths() {
    assertEquals(1f, MapInput.axis(1f, 0f), 0f)
    assertEquals(-1f, MapInput.axis(-1f, 0f), 0f)
    assertEquals(1f, MapInput.axis(1.4f, 0f), 0f)
    assertEquals(0.5f, MapInput.axis(0.575f, 0f), 1e-6f)
    assertEquals(-0.5f, MapInput.axis(-0.575f, 0f), 1e-6f)
  }
}
