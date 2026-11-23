package org.navoss.mobile.navigation

import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt
import org.json.JSONArray
import org.json.JSONObject

/**
 * The selected route's geometry driven at each step's own average speed (its distance over its
 * duration, kept between 15 and 120 km/h): the "Simulate drive" input for devices without GPS.
 * Pure; the runtime asks for one sample a second and feeds it to the engine.
 */
class DriveSimulation private constructor(
  private val points: List<NavigationCoordinate>,
  /** Distance along the geometry at each point. */
  private val distances: DoubleArray,
  /** Speed (m/s) from a fraction of the route onward: (startFraction, speed). */
  private val speeds: List<Pair<Double, Double>>,
) {
  private var travelled = 0.0
  private var pausedAtEnd = 0

  val length: Double
    get() = distances.last()

  /**
   * The next fix after `elapsedSeconds`, or `null` once the vehicle has waited at the
   * destination for [DESTINATION_DWELL_FIXES] fixes without the core ending the trip.
   */
  fun next(elapsedSeconds: Double, timestampMs: Long): String? {
    val atEnd = travelled >= length
    if (atEnd) {
      pausedAtEnd += 1
      if (pausedAtEnd > DESTINATION_DWELL_FIXES) return null
    }
    val speed = if (atEnd) 0.0 else speedAt(travelled / length)
    travelled = minOf(length, travelled + speed * elapsedSeconds)
    val (coordinate, course) = positionAt(travelled)
    return LocationFixFilter.sampleJson(
      RawFix(
        latitude = coordinate.latitude,
        longitude = coordinate.longitude,
        timeMs = timestampMs,
        horizontalAccuracyMeters = SIMULATED_ACCURACY_METERS,
        speedMetersPerSecond = speed.toFloat(),
        bearingDegrees = course.toFloat(),
        isMock = false,
      ),
    )
  }

  private fun speedAt(fraction: Double): Double =
    speeds.lastOrNull { it.first <= fraction }?.second ?: DEFAULT_SPEED

  private fun positionAt(distance: Double): Pair<NavigationCoordinate, Double> {
    var index = distances.indexOfFirst { it >= distance }.coerceAtLeast(1)
    if (index >= points.size) index = points.size - 1
    val start = points[index - 1]
    val end = points[index]
    val segment = distances[index] - distances[index - 1]
    val t = if (segment <= 0) 1.0 else ((distance - distances[index - 1]) / segment).coerceIn(0.0, 1.0)
    val coordinate = NavigationCoordinate(
      start.latitude + (end.latitude - start.latitude) * t,
      start.longitude + (end.longitude - start.longitude) * t,
    )
    return coordinate to bearing(start, end)
  }

  companion object {
    const val DEFAULT_SPEED = 13.9
    const val MIN_SPEED = 15 / 3.6
    const val MAX_SPEED = 120 / 3.6
    const val DESTINATION_DWELL_FIXES = 30
    const val SIMULATED_ACCURACY_METERS = 5f

    /** `null` when the trip has no drivable geometry. */
    fun fromTrip(tripJson: String): DriveSimulation? {
      val trip = JSONObject(tripJson)
      val points = coordinates(trip.optJSONArray("geometry"))
      if (points.size < 2) return null
      val distances = DoubleArray(points.size)
      for (i in 1 until points.size) distances[i] = distances[i - 1] + meters(points[i - 1], points[i])
      if (distances.last() <= 0) return null
      val steps = trip.optJSONArray("steps") ?: JSONArray()
      var stepTotal = 0.0
      for (i in 0 until steps.length()) stepTotal += steps.optJSONObject(i)?.optDouble("distanceMeters", 0.0) ?: 0.0
      val speeds = mutableListOf<Pair<Double, Double>>()
      var covered = 0.0
      val tripSpeed = speed(trip.optDouble("distanceMeters", 0.0), trip.optDouble("durationSeconds", 0.0))
      for (i in 0 until steps.length()) {
        val step = steps.optJSONObject(i) ?: continue
        val distance = step.optDouble("distanceMeters", 0.0)
        if (stepTotal > 0 && distance > 0) {
          speeds += covered / stepTotal to (speed(distance, step.optDouble("durationSeconds", 0.0)) ?: tripSpeed ?: DEFAULT_SPEED)
          covered += distance
        }
      }
      if (speeds.isEmpty()) speeds += 0.0 to (tripSpeed ?: DEFAULT_SPEED)
      return DriveSimulation(points, distances, speeds)
    }

    private fun speed(distance: Double, duration: Double): Double? =
      if (distance.isFinite() && duration.isFinite() && distance > 0 && duration > 0) {
        (distance / duration).coerceIn(MIN_SPEED, MAX_SPEED)
      } else {
        null
      }

    private fun coordinates(array: JSONArray?): List<NavigationCoordinate> {
      if (array == null) return emptyList()
      return (0 until array.length()).mapNotNull { index ->
        val point = array.optJSONObject(index) ?: return@mapNotNull null
        NavigationCoordinate(point.optDouble("latitude"), point.optDouble("longitude")).takeIf { it.isValid }
      }
    }

    private fun meters(a: NavigationCoordinate, b: NavigationCoordinate): Double {
      val radius = 6_371_008.8
      val dLat = Math.toRadians(b.latitude - a.latitude)
      val dLon = Math.toRadians(b.longitude - a.longitude)
      val h = sin(dLat / 2) * sin(dLat / 2) +
        cos(Math.toRadians(a.latitude)) * cos(Math.toRadians(b.latitude)) * sin(dLon / 2) * sin(dLon / 2)
      return 2 * radius * atan2(sqrt(h), sqrt(1 - h))
    }

    private fun bearing(a: NavigationCoordinate, b: NavigationCoordinate): Double {
      val lat1 = Math.toRadians(a.latitude)
      val lat2 = Math.toRadians(b.latitude)
      val dLon = Math.toRadians(b.longitude - a.longitude)
      val y = sin(dLon) * cos(lat2)
      val x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dLon)
      return (Math.toDegrees(atan2(y, x)) + 360) % 360
    }
  }
}
