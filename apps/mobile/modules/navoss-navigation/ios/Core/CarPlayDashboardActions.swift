import Foundation

/// A shortcut the CarPlay Dashboard can request while the main CarPlay scene may not exist yet.
public enum NavOSSCarPlayDashboardAction: String, Sendable {
  public static let activityType = "org.navoss.mobile.carplay-dashboard-action"

  case go
  case voice
}

/// Holds a Dashboard shortcut between the button press and the moment the main CarPlay scene is
/// able to run it.
///
/// A Dashboard press can arrive before any `CPTemplateApplicationScene` exists, and UIKit may then
/// deliver the same activity more than once while that scene connects and becomes active. Staging
/// the action separately from its delivery lets the scene drain it whenever it is ready, exactly
/// once, without the button needing to know which lifecycle callback will arrive first.
public struct NavOSSCarPlayDashboardActionQueue: Equatable, Sendable {
  /// Bounds the replay-suppression history. UIKit redelivers an activity a small number of times
  /// around a single activation, so this only has to outlive one cold start.
  private static let handledLimit = 8

  private var handledIdentifiers: [UUID] = []
  private var pendingAction: NavOSSCarPlayDashboardAction?
  private var pendingIdentifier: UUID?

  public init() {}

  public var pending: NavOSSCarPlayDashboardAction? { pendingAction }

  /// Records an action to run once the main scene is ready. Re-staging an already-drained
  /// identifier is ignored so redelivery cannot repeat a shortcut the driver pressed once.
  public mutating func stage(
    _ action: NavOSSCarPlayDashboardAction,
    identifier: UUID
  ) {
    guard !handledIdentifiers.contains(identifier) else { return }
    pendingAction = action
    pendingIdentifier = identifier
  }

  /// Returns the staged action and marks it handled, but only once the caller can actually run it.
  ///
  /// Readiness is a parameter rather than the caller's own precondition because the two must be
  /// evaluated in this order. A press that is consumed while no CarPlay scene can run it is
  /// silently lost, which is the original defect: the driver taps Go, nothing happens, and nothing
  /// remains staged for the scene that connects a moment later. Keeping the check here means the
  /// ordering is covered by tests instead of resting on how one call site is written.
  public mutating func take(isReady: Bool) -> NavOSSCarPlayDashboardAction? {
    guard isReady else { return nil }
    guard let pendingAction, let pendingIdentifier else { return nil }
    handledIdentifiers.append(pendingIdentifier)
    if handledIdentifiers.count > Self.handledLimit {
      handledIdentifiers.removeFirst(handledIdentifiers.count - Self.handledLimit)
    }
    self.pendingAction = nil
    self.pendingIdentifier = nil
    return pendingAction
  }

  /// Discards a staged action whose scene activation failed, so a dropped press cannot surface
  /// later against an unrelated activation.
  public mutating func clear(_ identifier: UUID) {
    guard pendingIdentifier == identifier else { return }
    pendingAction = nil
    pendingIdentifier = nil
  }
}
