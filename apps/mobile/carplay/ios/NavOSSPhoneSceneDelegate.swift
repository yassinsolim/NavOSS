import UIKit

#if targetEnvironment(simulator)
/// A simulator-only view controller that replaces the React Native root at launch. The CarPlay
/// visual harness provides one; builds without CarPlay do not compile it, so the phone scene finds
/// it by its Objective-C name instead of naming the class.
@MainActor
@objc protocol NavOSSSimulatorLaunchRoot {
  static func launchRootViewController(environment: [String: String]) -> UIViewController?
}
#endif

/// The phone's window scene, declared for every build: apps linked against the iOS 27 SDK must
/// adopt the scene life cycle or UIKit stops them at launch.
@objc(NavOSSPhoneSceneDelegate)
final class NavOSSPhoneSceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  private var appDelegate: AppDelegate? {
    UIApplication.shared.delegate as? AppDelegate
  }

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene, let appWindow = appDelegate?.window else {
      return
    }
    #if targetEnvironment(simulator)
    if let launchRoot = NSClassFromString("NavOSSCarPlayVisualHarnessViewController")
      as? NavOSSSimulatorLaunchRoot.Type,
      let rootViewController = launchRoot.launchRootViewController(
        environment: ProcessInfo.processInfo.environment
      )
    {
      appWindow.rootViewController = rootViewController
    }
    #endif
    // The generated `AppDelegate` builds its window with `UIWindow(frame:)` before any scene
    // exists, and attaching that window to the scene afterwards is not enough: on iOS 26 the
    // system share sheet presented from it appears as a small panel in the bottom-right corner
    // (reproduced on the 26.5 simulator). Host the React Native root in a window created for this
    // scene instead.
    let sceneWindow = UIWindow(windowScene: windowScene)
    sceneWindow.backgroundColor = appWindow.backgroundColor
    let rootViewController = appWindow.rootViewController
    appWindow.rootViewController = nil
    appWindow.isHidden = true
    sceneWindow.rootViewController = rootViewController
    appDelegate?.window = sceneWindow
    window = sceneWindow
    sceneWindow.makeKeyAndVisible()
    open(connectionOptions.urlContexts)
    continueActivities(connectionOptions.userActivities)
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    appDelegate?.applicationDidBecomeActive(UIApplication.shared)
  }

  func sceneWillResignActive(_ scene: UIScene) {
    appDelegate?.applicationWillResignActive(UIApplication.shared)
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    appDelegate?.applicationDidEnterBackground(UIApplication.shared)
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    appDelegate?.applicationWillEnterForeground(UIApplication.shared)
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    open(URLContexts)
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    continueActivities([userActivity])
  }

  private func open(_ urlContexts: Set<UIOpenURLContext>) {
    for context in urlContexts {
      var options: [UIApplication.OpenURLOptionsKey: Any] = [:]
      if let sourceApplication = context.options.sourceApplication {
        options[.sourceApplication] = sourceApplication
      }
      if let annotation = context.options.annotation {
        options[.annotation] = annotation
      }
      _ = appDelegate?.application(
        UIApplication.shared,
        open: context.url,
        options: options
      )
    }
  }

  private func continueActivities(_ userActivities: Set<NSUserActivity>) {
    for userActivity in userActivities {
      _ = appDelegate?.application(
        UIApplication.shared,
        continue: userActivity,
        restorationHandler: { _ in }
      )
    }
  }
}
