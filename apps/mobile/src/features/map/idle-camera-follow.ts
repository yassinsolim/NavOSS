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

/** What the phone map knows of its own position. */
export type LocationState = 'denied' | 'error' | 'idle' | 'locating' | 'visible';

/** Foreground location permission as the map last learned it; `'unknown'` until it has asked. */
export type LocationPermission = 'denied' | 'granted' | 'unknown';

export interface PhoneIdleLocationWatchInput {
  /** Android follows on permission alone; iOS only once a position is shown (see the gate). */
  android: boolean;
  appIsActive: boolean;
  carPlayConnected: boolean;
  locationPermission: LocationPermission;
  locationState: LocationState;
  mapTabIsVisible: boolean;
  /**
   * Watched with no route and in preview (the vehicle needs live fixes there). A trip and its
   * arrival belong to the navigation core's own location request. iOS samples nothing while a
   * route is loading or after one failed. Android keeps watching then: a destination chosen
   * before the first fix leaves the route origin's 15 s lookup as the only request, and once it
   * expired nothing asked for a position until Cancel or Retry.
   */
  routeStatus: 'arrived' | 'error' | 'idle' | 'loading' | 'navigating' | 'preview';
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

/**
 * Whether the location state lets the phone watch run. iOS: only while a position is shown, so a
 * Center lookup (`'locating'`) or a failed one (`'error'`) stops it until a lookup succeeds.
 * Android: whenever permission is granted, whatever the last lookup did. The watch is the map's
 * only continuous request there, so a lookup that timed out (the normal case indoors on a handheld
 * without GPS) or found Location off must not end following; it also finds the first fix beside
 * the one-shot lookup, which waits 30 s and fails when the provider it asked has nothing. Nothing
 * is watched before permission is known, and `'denied'` stops it.
 */
function locationAllowsPhoneWatch(
  android: boolean,
  locationPermission: LocationPermission,
  locationState: LocationState,
): boolean {
  if (!android) return locationState === 'visible';
  return locationPermission === 'granted' && locationState !== 'denied';
}

/** The Expo watch is a foreground, phone-map concern; CarPlay owns its own location path. */
export function shouldWatchPhoneIdleLocation({
  android,
  appIsActive,
  carPlayConnected,
  locationPermission,
  locationState,
  mapTabIsVisible,
  routeStatus,
}: PhoneIdleLocationWatchInput): boolean {
  return (
    appIsActive &&
    !carPlayConnected &&
    locationAllowsPhoneWatch(android, locationPermission, locationState) &&
    mapTabIsVisible &&
    (routeStatus === 'idle' ||
      routeStatus === 'preview' ||
      (android && (routeStatus === 'loading' || routeStatus === 'error')))
  );
}
