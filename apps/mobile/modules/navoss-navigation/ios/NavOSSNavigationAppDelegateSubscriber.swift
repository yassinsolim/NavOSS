import ExpoModulesCore

public final class NavOSSNavigationAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    NavOSSGooglePlacesConfiguration.configure()
    // Offline regions serve phone and CarPlay alike, so they start with the app, not with JS.
    NavOSSOfflineStore.shared.start()
    NavOSSNavigationAPIClient.offlineFallback = NavOSSOfflineRouter.shared
    Task { await NavOSSOfflineStore.shared.refreshManifest() }
    NavOSSNavigationService.shared.resumePersistedNavigation()
    return true
  }
}
