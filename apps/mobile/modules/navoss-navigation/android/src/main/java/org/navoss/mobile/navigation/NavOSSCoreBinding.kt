package org.navoss.mobile.navigation

/**
 * Loads `org.navoss.navigation.core.NavOSSCore`. The binding and its `.so` set are not packaged
 * yet, so this reports the core unavailable and the module answers "guidance unavailable".
 */
internal object NavOSSCoreLoader : NavigationCoreLoader {
  override fun loadError(): Throwable = IllegalStateException("The navigation core is not packaged in this build.")

  override fun contractVersion(): Int = throw IllegalStateException("The navigation core is not packaged in this build.")

  override fun create(configJson: String, host: NavigationCoreHost): NavigationCore =
    throw IllegalStateException("The navigation core is not packaged in this build.")
}
