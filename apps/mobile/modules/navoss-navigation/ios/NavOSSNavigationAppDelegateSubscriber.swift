import ExpoModulesCore

public final class NavOSSNavigationAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    NavOSSGooglePlacesConfiguration.configure()
    NavOSSNavigationService.shared.resumePersistedNavigation()
    return true
  }

  public func applicationWillTerminate(_ application: UIApplication) {
    NavOSSNavigationService.shared.clearNavigation()
  }
}
