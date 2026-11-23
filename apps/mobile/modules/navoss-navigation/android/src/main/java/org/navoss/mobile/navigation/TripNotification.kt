package org.navoss.mobile.navigation

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import java.util.Locale
import kotlin.math.roundToInt
import org.json.JSONException
import org.json.JSONObject

/** What the ongoing trip notification says, from a snapshot. */
data class TripNotificationContent(val title: String, val text: String) {
  companion object {
    fun from(snapshotJson: String?, simulating: Boolean): TripNotificationContent {
      val suffix = if (simulating) " (simulation)" else ""
      val fallback = TripNotificationContent("Navigating$suffix", "NavOSS is guiding your trip.")
      val snapshot = try {
        JSONObject(snapshotJson ?: return fallback)
      } catch (_: JSONException) {
        return fallback
      }
      if (snapshot.optString("phase") == "arrived") {
        return TripNotificationContent("Arrived$suffix", "You have reached your destination.")
      }
      if (snapshot.optBoolean("isAcquiringPosition")) {
        return TripNotificationContent("Finding your position$suffix", "Guidance resumes once you are on the route.")
      }
      if (snapshot.optString("routeStatus") == "rerouting") {
        return TripNotificationContent("Finding a new route$suffix", "Keep driving safely.")
      }
      val guidance = snapshot.optJSONObject("guidance") ?: return fallback
      val instruction = guidance.optString("instruction").ifBlank { return fallback }
      val distance = guidance.optDouble("distanceToManeuverMeters")
      val title = if (distance.isFinite() && distance >= 0) "In ${formatDistance(distance)}$suffix" else "Navigating$suffix"
      return TripNotificationContent(title, instruction)
    }

    fun formatDistance(meters: Double): String = when {
      meters < 100 -> "${(meters / 10).roundToInt() * 10} m"
      meters < 1_000 -> "${(meters / 50).roundToInt() * 50} m"
      else -> String.format(Locale.CANADA, "%.1f km", meters / 1_000)
    }
  }
}

/** The ongoing, silent notification a navigation foreground service must show. */
internal class TripNotification(private val context: Context) {
  private val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
  private var shown: TripNotificationContent? = null

  fun build(content: TripNotificationContent): Notification {
    ensureChannel()
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(context, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(context).setPriority(Notification.PRIORITY_LOW)
    }
    val open = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
      PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    val end = PendingIntent.getService(
      context,
      1,
      Intent(context, NavigationForegroundService::class.java).setAction(NavigationForegroundService.ACTION_END),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    builder
      .setSmallIcon(R.drawable.navoss_navigation_notification)
      .setContentTitle(content.title)
      .setContentText(content.text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setCategory(Notification.CATEGORY_NAVIGATION)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .addAction(Notification.Action.Builder(null, "End", end).build())
    open?.let(builder::setContentIntent)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
    }
    shown = content
    return builder.build()
  }

  /** Re-posts only when the words changed, so the notification does not churn every second. */
  fun update(content: TripNotificationContent) {
    if (content == shown) return
    manager.notify(NOTIFICATION_ID, build(content))
  }

  fun reset() {
    shown = null
  }

  /** Built ahead of time by [prepareStopped]: posting it needs no allocation beyond the binder call. */
  @Volatile private var stopped: Notification? = null

  /**
   * Builds the notification an out-of-memory refusal posts before the process ends, while memory
   * is fine (the guidance service is starting). Tapping it opens the app, which restores the trip.
   */
  fun prepareStopped() {
    if (stopped != null) return
    ensureChannel()
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(context, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(context).setPriority(Notification.PRIORITY_LOW)
    }
    builder
      .setSmallIcon(R.drawable.navoss_navigation_notification)
      .setContentTitle(STOPPED_TITLE)
      .setContentText(STOPPED_TEXT)
      .setAutoCancel(true)
      .setCategory(Notification.CATEGORY_NAVIGATION)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
    context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
      builder.setContentIntent(PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
    }
    stopped = builder.build()
  }

  /** Posts the prebuilt notification, if the service got as far as building it. */
  fun postStopped() {
    stopped?.let { manager.notify(STOPPED_NOTIFICATION_ID, it) }
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(CHANNEL_ID, "Navigation", NotificationManager.IMPORTANCE_LOW).apply {
      description = "Shows the next turn while NavOSS guides a trip."
      setSound(null, null)
      enableVibration(false)
      setShowBadge(false)
    }
    manager.createNotificationChannel(channel)
  }

  companion object {
    const val CHANNEL_ID = "org.navoss.mobile.navigation"
    const val NOTIFICATION_ID = 0x4e41
    internal const val STOPPED_TITLE = "Guidance stopped"
    internal const val STOPPED_TEXT = "Open NavOSS to continue your trip."
    const val STOPPED_NOTIFICATION_ID = 0x4e42
  }
}
