package org.navoss.mobile.navigation

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * Keeps a trip alive with the screen off and the app in the background: a `location` foreground
 * service started from the foreground when a trip starts and stopped when it ends or arrives. It
 * holds no state of its own; [NavigationRuntime] owns location, speech and the engine. Not
 * restarted by the system after the process dies: the next launch restores the trip instead.
 */
class NavigationForegroundService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val runtime = NavigationRuntime.get(this)
    try {
      val notification = runtime.notification.build(runtime.notificationContent())
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(TripNotification.NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
      } else {
        startForeground(TripNotification.NOTIFICATION_ID, notification)
      }
    } catch (error: RuntimeException) {
      // Location permission was withdrawn, or Android refused a start it considers background.
      Log.w(LOG_TAG, "foreground service refused: ${error.javaClass.simpleName}")
      stopSelf()
      return START_NOT_STICKY
    }
    if (intent?.action == ACTION_END) runtime.endTripFromNotification()
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    NavigationRuntime.get(this).notification.reset()
    super.onDestroy()
  }

  companion object {
    const val ACTION_END = "org.navoss.mobile.navigation.END_TRIP"
    internal const val LOG_TAG = "NavOSSNavigation"
  }
}
