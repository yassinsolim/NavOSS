package org.navoss.mobile.navigation

import org.json.JSONObject

/** A platform fix reduced to what navigation reads; `null` means the provider did not report it. */
data class RawFix(
  val latitude: Double,
  val longitude: Double,
  /** `Location.getTime()`: Unix milliseconds. */
  val timeMs: Long,
  val horizontalAccuracyMeters: Float?,
  val speedMetersPerSecond: Float?,
  val bearingDegrees: Float?,
  /** Delivered by a mock-location app (`Location.isMock`). */
  val isMock: Boolean,
)

/**
 * Turns platform fixes into the core's `NativeNavigationLocationSample` JSON with the iOS rules
 * (`locationManager(_:didUpdateLocations:)` and `navOSSShouldAcceptNavigationLocation`):
 *
 * - a fix more than 15 s old, more than 5 s in the future, or older than the last accepted one
 *   is dropped;
 * - a mock-location fix is dropped: real trips never mix with injected positions (the in-app
 *   simulated drive feeds the engine directly and is labelled as such);
 * - course is sent only at 2 m/s or more and within 0–360°, speed only when known and not
 *   negative, accuracy only when known and not negative; unknown values are omitted, never `-1`.
 */
class LocationFixFilter {
  private var latestAcceptedMs: Long? = null

  /** The sample JSON to feed `updateLocation`, or `null` when the fix must be dropped. */
  fun accept(fix: RawFix, nowMs: Long): String? {
    if (fix.isMock) return null
    if (!NavigationCoordinate(fix.latitude, fix.longitude).isValid) return null
    val ageMs = nowMs - fix.timeMs
    if (ageMs < -MAX_FUTURE_MS || ageMs > MAX_AGE_MS) return null
    latestAcceptedMs?.let { if (fix.timeMs < it) return null }
    latestAcceptedMs = fix.timeMs
    return sampleJson(fix)
  }

  /** Forgets the last fix time (a new trip, or after a simulated drive). */
  fun reset() {
    latestAcceptedMs = null
  }

  companion object {
    const val MAX_AGE_MS = 15_000L
    const val MAX_FUTURE_MS = 5_000L
    const val MIN_COURSE_SPEED = 2.0

    fun sampleJson(fix: RawFix): String {
      val json = JSONObject()
        .put("latitude", fix.latitude)
        .put("longitude", fix.longitude)
        .put("timestampMs", fix.timeMs)
      val speed = fix.speedMetersPerSecond?.toDouble()?.takeIf { it.isFinite() && it >= 0 }
      speed?.let { json.put("speedMetersPerSecond", it) }
      fix.horizontalAccuracyMeters?.toDouble()?.takeIf { it.isFinite() && it >= 0 }
        ?.let { json.put("horizontalAccuracyMeters", it) }
      val course = fix.bearingDegrees?.toDouble()
      if (speed != null && speed >= MIN_COURSE_SPEED && course != null && course >= 0 && course < 360) {
        json.put("courseDegrees", course)
      }
      return json.toString()
    }
  }
}
