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
  /**
   * The navigation core owns location during a trip (and after arrival until End). Before then,
   * including route preview, the watch keeps the free-drive vehicle on a live fix.
   */
  tripIsActive: boolean;
}
export function phoneIdleLocationWatchOptions<Accuracy>(accuracy: Accuracy): {
  accuracy: Accuracy;
  distanceInterval: 0;
  mayShowUserSettingsDialog: false;
} {
  return { ...automaticLocationOptions(accuracy), distanceInterval: 0 };
}

/**
 * Options for a location request the driver did not ask for (the map's first fix and its watches).
 * Android: never open Google's "turn on device location" dialog from one. With Location off,
 * dismissing it returns to the app, the map asks again, and the dialog came back without end.
 * iOS ignores the option.
 */
export function automaticLocationOptions<Accuracy>(accuracy: Accuracy): {
  accuracy: Accuracy;
  mayShowUserSettingsDialog: false;
} {
  return { accuracy, mayShowUserSettingsDialog: false };
}

/** The Expo watch is a foreground, phone-map concern; CarPlay owns its own location path. */
export function shouldWatchPhoneIdleLocation({
  appIsActive,
  carPlayConnected,
  locationIsVisible,
  mapTabIsVisible,
  tripIsActive,
}: PhoneIdleLocationWatchInput): boolean {
  return appIsActive && !carPlayConnected && locationIsVisible && mapTabIsVisible && !tripIsActive;
}
