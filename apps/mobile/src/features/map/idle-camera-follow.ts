export interface IdleCameraFollowInput {
  appIsActive: boolean;
  hasTransientDestination: boolean;
  hasUserCoordinate: boolean;
  intent: boolean;
  phoneMapVisible: boolean;
  routeIsIdle: boolean;
}

/**
 * Idle following belongs only to the visible phone map. Search and route-selection camera moves
 * deliberately retain control until the driver explicitly returns to the map or recenters.
 */
export function shouldFollowIdleCamera({
  appIsActive,
  hasTransientDestination,
  hasUserCoordinate,
  intent,
  phoneMapVisible,
  routeIsIdle,
}: IdleCameraFollowInput): boolean {
  return (
    appIsActive &&
    hasUserCoordinate &&
    intent &&
    phoneMapVisible &&
    routeIsIdle &&
    !hasTransientDestination
  );
}

export function idleCameraFollowIntentAfterRegionChange(
  intent: boolean,
  userInteraction: boolean,
): boolean {
  return userInteraction ? false : intent;
}

export interface IdleCameraCoordinate {
  latitude: number;
  longitude: number;
}

export function idleCameraCenterForFollow(
  coordinate: IdleCameraCoordinate | undefined,
  shouldFollow: boolean,
): [longitude: number, latitude: number] | undefined {
  if (!shouldFollow || coordinate === undefined) {
    return undefined;
  }
  return [coordinate.longitude, coordinate.latitude];
}

export interface PhoneIdleLocationWatchInput {
  appIsActive: boolean;
  carPlayConnected: boolean;
  locationIsVisible: boolean;
  mapTabIsVisible: boolean;
  routeIsIdle: boolean;
}
export function phoneIdleLocationWatchOptions<Accuracy>(accuracy: Accuracy): {
  accuracy: Accuracy;
  distanceInterval: 0;
} {
  return { accuracy, distanceInterval: 0 };
}

/** The Expo watch is a foreground, phone-map concern; CarPlay owns its own location path. */
export function shouldWatchPhoneIdleLocation({
  appIsActive,
  carPlayConnected,
  locationIsVisible,
  mapTabIsVisible,
  routeIsIdle,
}: PhoneIdleLocationWatchInput): boolean {
  return appIsActive && !carPlayConnected && locationIsVisible && mapTabIsVisible && routeIsIdle;
}
