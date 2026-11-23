package org.navoss.mobile.navigation

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.location.LocationRequest
import android.os.Build
import android.os.Handler
import java.util.concurrent.Executor

/** Whether this device can give driving-grade fixes right now (the JS `getLocationAvailability`). */
enum class LocationAvailability(val raw: String) {
  AVAILABLE("available"),
  /** No GPS receiver (`FEATURE_LOCATION_GPS`): Wi-Fi positions cannot follow a moving car. */
  NO_GPS("no-gps"),
  /** Location is turned off in system settings. */
  LOCATION_OFF("location-off"),
  /** Precise location permission is not granted. */
  PERMISSION_DENIED("permission-denied"),
}

/**
 * Trip location from the platform `LocationManager`, about once a second: the fused provider on
 * Android 12+ (AOSP's, no Google Play services), GPS otherwise. Fixes arrive on [handler]'s thread.
 */
internal class NavigationLocationProvider(
  private val context: Context,
  private val handler: Handler,
  private val onFix: (RawFix) -> Unit,
) {
  private val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
  private val listener = LocationListener { location -> onFix(location.toRawFix()) }
  private var running = false

  fun availability(): LocationAvailability {
    if (context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
      return LocationAvailability.PERMISSION_DENIED
    }
    if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_LOCATION_GPS) || provider() == null) {
      return LocationAvailability.NO_GPS
    }
    val enabled = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      manager.isLocationEnabled
    } else {
      manager.isProviderEnabled(LocationManager.GPS_PROVIDER)
    }
    return if (enabled) LocationAvailability.AVAILABLE else LocationAvailability.LOCATION_OFF
  }

  /** Starts updates; `false` when [availability] is not [LocationAvailability.AVAILABLE]. */
  @SuppressLint("MissingPermission")
  fun start(): Boolean {
    if (running) return true
    if (availability() != LocationAvailability.AVAILABLE) return false
    val provider = provider() ?: return false
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val request = LocationRequest.Builder(UPDATE_INTERVAL_MS)
          .setQuality(LocationRequest.QUALITY_HIGH_ACCURACY)
          .setMinUpdateDistanceMeters(0f)
          .setMinUpdateIntervalMillis(UPDATE_INTERVAL_MS / 2)
          .build()
        manager.requestLocationUpdates(provider, request, Executor { handler.post(it) }, listener)
      } else {
        manager.requestLocationUpdates(provider, UPDATE_INTERVAL_MS, 0f, listener, handler.looper)
      }
    } catch (_: SecurityException) {
      return false
    } catch (_: IllegalArgumentException) {
      return false
    }
    running = true
    return true
  }

  fun stop() {
    if (!running) return
    running = false
    manager.removeUpdates(listener)
  }

  private fun provider(): String? {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && manager.hasProvider(LocationManager.FUSED_PROVIDER)) {
      return LocationManager.FUSED_PROVIDER
    }
    return LocationManager.GPS_PROVIDER.takeIf { it in manager.allProviders }
  }

  companion object {
    const val UPDATE_INTERVAL_MS = 1_000L
  }
}

internal fun Location.toRawFix(): RawFix = RawFix(
  latitude = latitude,
  longitude = longitude,
  timeMs = time,
  horizontalAccuracyMeters = if (hasAccuracy()) accuracy else null,
  speedMetersPerSecond = if (hasSpeed()) speed else null,
  bearingDegrees = if (hasBearing()) bearing else null,
  isMock = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) isMock else {
    @Suppress("DEPRECATION")
    isFromMockProvider
  },
)
