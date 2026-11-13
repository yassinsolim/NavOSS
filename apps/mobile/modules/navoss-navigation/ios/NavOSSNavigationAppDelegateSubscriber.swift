import ExpoModulesCore

public final class NavOSSNavigationAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    NavOSSGooglePlacesConfiguration.configure()
    NavOSSNavigationService.shared.resumePersistedNavigation()
    #if DEBUG && targetEnvironment(simulator)
      NavOSSCommunitySimulatorHarness.runIfRequested()
    #endif
    return true
  }
}
