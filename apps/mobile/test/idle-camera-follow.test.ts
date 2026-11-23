import { describe, expect, it } from 'vitest';

import {
  idleCameraCenterForFollow,
  idleCameraFollowIntentAfterRegionChange,
  automaticLocationOptions,
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

  it('runs the foreground phone watch only for a visible map with no route or a preview', () => {
    const visiblePhoneMap = {
      appIsActive: true,
      carPlayConnected: false,
      locationIsVisible: true,
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
    expect(shouldWatchPhoneIdleLocation({ ...visiblePhoneMap, routeStatus: 'preview' })).toBe(true);
    // A trip (and its arrival) belongs to the navigation core's own location request; a route
    // being requested or one that failed leaves nothing to draw a vehicle for.
    for (const routeStatus of ['navigating', 'arrived', 'loading', 'error'] as const) {
      expect(shouldWatchPhoneIdleLocation({ ...visiblePhoneMap, routeStatus })).toBe(false);
    }
  });
});
