import { describe, expect, it } from 'vitest';

import {
  idleCameraCenterForFollow,
  idleCameraFollowIntentAfterRegionChange,
  automaticLocationOptions,
  fixArrivedDuringLookup,
  type LocationPermission,
  type LocationState,
  locationStateAfterLookupFailure,
  locationStateAfterWatchFix,
  phoneIdleLocationWatchOptions,
  shouldFollowIdleCamera,
  shouldWatchPhoneIdleLocation,
} from '../src/features/map/idle-camera-follow.js';

describe('idle camera follow policy', () => {
  const visibleIdleMap = {
    appIsActive: true,
    hasTransientDestination: false,
    hasUserCoordinate: true,
    intent: true,
    phoneMapVisible: true,
    routeIsIdle: true,
  };

  it('keeps moving the camera target for each fresh idle location while the phone map is visible', () => {
    const followsIdleLocation = shouldFollowIdleCamera(visibleIdleMap);
    const firstCameraCenter = idleCameraCenterForFollow(
      { latitude: 51.0447, longitude: -114.0719 },
      followsIdleLocation,
    );
    const secondCameraCenter = idleCameraCenterForFollow(
      { latitude: 51.0452, longitude: -114.0708 },
      followsIdleLocation,
    );

    expect(firstCameraCenter).toEqual([-114.0719, 51.0447]);
    expect(secondCameraCenter).toEqual([-114.0708, 51.0452]);
  });

  it('does not treat a programmatic camera animation as a user pan', () => {
    expect(idleCameraFollowIntentAfterRegionChange(true, false)).toBe(true);
  });

  it('pauses for a user pan and resumes when the driver recenters', () => {
    const pausedIntent = idleCameraFollowIntentAfterRegionChange(true, true);

    expect(shouldFollowIdleCamera({ ...visibleIdleMap, intent: pausedIntent })).toBe(false);
    expect(shouldFollowIdleCamera({ ...visibleIdleMap, intent: true })).toBe(true);
  });

  it('does not move the camera away from search, destination, or route-choice UI', () => {
    expect(shouldFollowIdleCamera({ ...visibleIdleMap, hasTransientDestination: true })).toBe(
      false,
    );
    expect(shouldFollowIdleCamera({ ...visibleIdleMap, routeIsIdle: false })).toBe(false);
  });

  it('requests every idle phone location update instead of throttling by distance', () => {
    expect(phoneIdleLocationWatchOptions('high-accuracy')).toEqual({
      accuracy: 'high-accuracy',
      distanceInterval: 0,
      mayShowUserSettingsDialog: false,
    });
  });

  it('never asks to turn Location on from a request the driver did not make', () => {
    // Android: with Location off, each automatic request opened Google's "turn on device
    // location" dialog; dismissing it returned to the app, which asked again, without end.
    // Only an explicit tap (Center, directions) may lead to the system settings.
    expect(automaticLocationOptions('balanced')).toEqual({
      accuracy: 'balanced',
      mayShowUserSettingsDialog: false,
    });
  });

  for (const android of [false, true]) {
    it(`runs the foreground phone watch only for a visible map with no route or a preview (${android ? 'Android' : 'iOS'})`, () => {
      const visiblePhoneMap = {
        android,
        appIsActive: true,
        carPlayConnected: false,
        locationPermission: 'granted',
        locationState: 'visible',
        mapTabIsVisible: true,
        routeStatus: 'idle',
      } as const;

      expect(shouldWatchPhoneIdleLocation(visiblePhoneMap)).toBe(true);
      expect(shouldWatchPhoneIdleLocation({ ...visiblePhoneMap, appIsActive: false })).toBe(false);
      expect(shouldWatchPhoneIdleLocation({ ...visiblePhoneMap, mapTabIsVisible: false })).toBe(
        false,
      );
      expect(shouldWatchPhoneIdleLocation({ ...visiblePhoneMap, carPlayConnected: true })).toBe(
        false,
      );
      // The vehicle needs live fixes in preview.
      expect(shouldWatchPhoneIdleLocation({ ...visiblePhoneMap, routeStatus: 'preview' })).toBe(
        true,
      );
      // A trip (and its arrival) belongs to the navigation core's own location request; a route
      // being requested or one that failed leaves nothing to draw a vehicle for.
      for (const routeStatus of ['navigating', 'arrived', 'loading', 'error'] as const) {
        expect(shouldWatchPhoneIdleLocation({ ...visiblePhoneMap, routeStatus })).toBe(false);
      }
    });
  }
});

describe('the phone watch across location states', () => {
  const states: LocationState[] = ['idle', 'locating', 'visible', 'error', 'denied'];
  const permissions: LocationPermission[] = ['unknown', 'granted', 'denied'];
  const watches = (
    android: boolean,
    locationPermission: LocationPermission,
    locationState: LocationState,
  ) =>
    shouldWatchPhoneIdleLocation({
      android,
      appIsActive: true,
      carPlayConnected: false,
      locationPermission,
      locationState,
      mapTabIsVisible: true,
      routeStatus: 'idle',
    });

  it('iOS watches only while a position is shown, whatever the permission says', () => {
    for (const permission of permissions) {
      for (const state of states) {
        expect(watches(false, permission, state), `${permission} ${state}`).toBe(
          state === 'visible',
        );
      }
    }
  });

  it('Android keeps watching through a Center lookup and after one failed', () => {
    // A timed-out Center (no fix in 15 s, the normal case indoors on a handheld without GPS) or
    // one that found Location off left the map unfollowed until Center was tapped again.
    expect(watches(true, 'granted', 'locating')).toBe(true);
    expect(watches(true, 'granted', 'error')).toBe(true);
    expect(watches(true, 'granted', 'visible')).toBe(true);
  });

  it('Android never watches before permission is known, without it, or once denied', () => {
    for (const state of states) {
      expect(watches(true, 'unknown', state), state).toBe(false);
      expect(watches(true, 'denied', state), state).toBe(false);
    }
    expect(watches(true, 'granted', 'denied')).toBe(false);
  });

  it('Android leaves a trip and CarPlay to their own location requests, as iOS does', () => {
    const base = {
      android: true,
      appIsActive: true,
      carPlayConnected: false,
      locationPermission: 'granted',
      locationState: 'error',
      mapTabIsVisible: true,
    } as const;
    expect(shouldWatchPhoneIdleLocation({ ...base, routeStatus: 'navigating' })).toBe(false);
    expect(shouldWatchPhoneIdleLocation({ ...base, routeStatus: 'arrived' })).toBe(false);
    expect(
      shouldWatchPhoneIdleLocation({ ...base, carPlayConnected: true, routeStatus: 'idle' }),
    ).toBe(false);
    expect(shouldWatchPhoneIdleLocation({ ...base, appIsActive: false, routeStatus: 'idle' })).toBe(
      false,
    );
  });
});

describe('a fix from the Android phone watch', () => {
  it('shows the position again after a failed lookup, clearing its label', () => {
    // "Location is off" and "Current location unavailable" are drawn from `'error'`.
    expect(locationStateAfterWatchFix('error')).toBe('visible');
  });

  it('ends the search while the first fix or Center is still looking', () => {
    expect(locationStateAfterWatchFix('locating')).toBe('visible');
    expect(locationStateAfterWatchFix('idle')).toBe('visible');
    expect(locationStateAfterWatchFix('visible')).toBe('visible');
  });

  it('does not undo a denial', () => {
    expect(locationStateAfterWatchFix('denied')).toBe('denied');
  });
});

describe('a lookup that finds nothing', () => {
  const failedLookup = (android: boolean, fixesAtStart: number, fixesNow: number) =>
    locationStateAfterLookupFailure(fixArrivedDuringLookup({ android, fixesAtStart, fixesNow }));

  it('on Android, stays visible when the watch put a fix on the map meanwhile', () => {
    // Center timed out after 15 s, but the watch delivered a fix during that time: the map shows a
    // current position, so it is neither `'error'` nor "Current location unavailable".
    expect(failedLookup(true, 3, 4)).toBe('visible');
  });

  it('on Android, is an error when nothing arrived during the lookup', () => {
    // A fix from before the lookup proves nothing about now (Location may have been switched off).
    expect(failedLookup(true, 3, 3)).toBe('error');
  });

  it('on iOS, is always the lookup’s own failure', () => {
    expect(failedLookup(false, 3, 3)).toBe('error');
    expect(failedLookup(false, 3, 4)).toBe('error');
  });

  it('counts only a fix that arrived after the lookup started', () => {
    expect(fixArrivedDuringLookup({ android: true, fixesAtStart: 0, fixesNow: 1 })).toBe(true);
    expect(fixArrivedDuringLookup({ android: true, fixesAtStart: 1, fixesNow: 1 })).toBe(false);
  });
});
