import ExpoModulesCore

public final class NavOSSNavigationAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    NavOSSNavigationService.shared.resumePersistedNavigation()
    return true
  }
}
