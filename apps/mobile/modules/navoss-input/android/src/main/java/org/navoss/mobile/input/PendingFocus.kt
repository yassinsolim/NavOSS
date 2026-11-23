package org.navoss.mobile.input

import android.view.View
import android.view.ViewTreeObserver

/**
 * Focus requests waiting for their window to gain focus (a modal sheet still opening). Each is
 * removed through the observer it was registered on, when it fires, when its view leaves the
 * window (the sheet closed first, a trip ended under a permission dialog) or when the module is
 * destroyed, so nothing keeps a dead view or fires on a later focus gain. Main thread only.
 */
internal class PendingFocus {
  private val requests = mutableSetOf<Request>()

  fun defer(view: View) {
    requests += Request(view).also { it.register() }
  }

  fun cancelAll() {
    requests.toList().forEach { it.cancel() }
  }

  private inner class Request(private val view: View) :
    ViewTreeObserver.OnWindowFocusChangeListener, View.OnAttachStateChangeListener {
    private val observer: ViewTreeObserver = view.viewTreeObserver

    fun register() {
      observer.addOnWindowFocusChangeListener(this)
      view.addOnAttachStateChangeListener(this)
    }

    fun cancel() {
      if (observer.isAlive) observer.removeOnWindowFocusChangeListener(this)
      view.removeOnAttachStateChangeListener(this)
      requests -= this
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
      if (!hasFocus) return
      cancel()
      if (view.isAttachedToWindow && !view.isInTouchMode) view.requestFocus()
    }

    override fun onViewAttachedToWindow(v: View) = Unit

    override fun onViewDetachedFromWindow(v: View) = cancel()
  }
}
