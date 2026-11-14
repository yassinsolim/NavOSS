import Foundation

public enum NavOSSNavigationRouteStatus: String, Sendable {
  case rerouteFailed = "reroute-failed"
  case rerouting
  case tracking
}

/// A trip the core ended on its own, which the phone tells the driver about.
public enum NavOSSTripEndReason: String, Sendable {
  /// A trip restored after relaunch was dropped because the first fix was off its route.
  case restoredTripOffRoute = "restored-trip-off-route"
}

/// What the navigation service tells the phone and CarPlay, on every read and every change.
struct NavOSSNavigationServiceState: Sendable {
  let guidance: NavOSSCarPlayGuidance?
  /// A trip restored after a relaunch whose position on the route is not confirmed yet. It is
  /// shown as finding its place, with End; see `acquiringRestoredTrip()`.
  var isAcquiringPosition = false
  let navigation: NavigationSnapshot
  let rerouteCount: Int
  let rerouteMode: NavOSSRerouteMode
  let rerouteProposal: NavigationRerouteProposal?
  let roadContext: NavigationRoadContext
  let routeStatus: NavOSSNavigationRouteStatus
  let safetyCameraAlert: NavigationSafetyCameraAlert?
  let speedingState: NavOSSSpeedingState
  let stateVersion: UInt64
  let trip: NavOSSCarPlayTrip?
  /// Why the last trip ended without the driver ending it; `nil` while a trip is active.
  let tripEndReason: NavOSSTripEndReason?

  /// The state of a restored trip before a fix is matched on a known pass: the trip and the
  /// latest raw position, and nothing taken from where the trip was saved or from a fix that is
  /// not matched yet. No maneuver, step, progress, matched position, road, speed limit, speeding
  /// or camera alert, so no surface can show or announce the saved step as current.
  func acquiringRestoredTrip() -> NavOSSNavigationServiceState {
    NavOSSNavigationServiceState(
      guidance: nil,
      isAcquiringPosition: true,
      navigation: NavigationSnapshot(
        distanceFromRouteMeters: nil,
        horizontalAccuracyMeters: navigation.horizontalAccuracyMeters,
        isOffRoute: false,
        matchedCoordinate: nil,
        matchedCourseDegrees: nil,
        phase: .tracking,
        rawCoordinate: navigation.rawCoordinate,
        routeProgress: 0,
        routeVersion: navigation.routeVersion,
        sequence: navigation.sequence,
        speedMetersPerSecond: navigation.speedMetersPerSecond,
        isPassConfirmed: false
      ),
      rerouteCount: rerouteCount,
      rerouteMode: rerouteMode,
      rerouteProposal: nil,
      roadContext: .unknown,
      routeStatus: .tracking,
      safetyCameraAlert: nil,
      speedingState: .unknown,
      stateVersion: stateVersion,
      trip: trip,
      tripEndReason: nil
    )
  }
}
