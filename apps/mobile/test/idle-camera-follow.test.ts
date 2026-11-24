import { describe, expect, it } from 'vitest';

import {
  idleCameraCenterForFollow,
  idleCameraFollowIntentAfterRegionChange,
  automaticLocationOptions,
  type LocationPermission,
  type LocationState,
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
      // A trip (and its arrival) belongs to the navigation core's own location request.
      for (const routeStatus of ['navigating', 'arrived'] as const) {
        expect(shouldWatchPhoneIdleLocation({ ...visiblePhoneMap, routeStatus })).toBe(false);
      }
    });
  }

  it('iOS samples nothing while a route is being requested or after one failed', () => {
    for (const routeStatus of ['loading', 'error'] as const) {
      expect(
        shouldWatchPhoneIdleLocation({
          android: false,
          appIsActive: true,
          carPlayConnected: false,
          locationPermission: 'granted',
          locationState: 'visible',
          mapTabIsVisible: true,
          routeStatus,
        }),
        routeStatus,
      ).toBe(false);
    }
  });

  it('Android keeps watching while a route is requested and after it failed', () => {
    // Cold start without a position: a destination chosen before the first fix put the route in
    // `loading` and, once the route origin's 15 s lookup expired, `error`. Nothing then asked
    // for a position until Cancel or Retry.
    for (const routeStatus of ['loading', 'error'] as const) {
      for (const locationState of ['locating', 'error', 'visible'] as const) {
        expect(
          shouldWatchPhoneIdleLocation({
            android: true,
            appIsActive: true,
            carPlayConnected: false,
            locationPermission: 'granted',
            locationState,
            mapTabIsVisible: true,
            routeStatus,
          }),
          `${routeStatus} ${locationState}`,
        ).toBe(true);
      }
    }
  });

  it('a preview is watched on both platforms; Android without waiting for a position', () => {
    const preview = {
      appIsActive: true,
      carPlayConnected: false,
      locationPermission: 'granted',
      mapTabIsVisible: true,
      routeStatus: 'preview',
    } as const;
    expect(
      shouldWatchPhoneIdleLocation({ ...preview, android: false, locationState: 'error' }),
    ).toBe(false);
    expect(
      shouldWatchPhoneIdleLocation({ ...preview, android: true, locationState: 'error' }),
    ).toBe(true);
  });
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
