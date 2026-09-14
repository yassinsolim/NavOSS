import { describe, expect, it } from 'vitest';

import {
  idleCameraCenterForFollow,
  idleCameraFollowIntentAfterRegionChange,
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

  it('stops the foreground phone watch when the map is hidden, backgrounded, or CarPlay owns it', () => {
    const visiblePhoneMap = {
      appIsActive: true,
      carPlayConnected: false,
      locationIsVisible: true,
      mapTabIsVisible: true,
      routeIsIdle: true,
    };

    expect(shouldWatchPhoneIdleLocation(visiblePhoneMap)).toBe(true);
    expect(shouldWatchPhoneIdleLocation({ ...visiblePhoneMap, appIsActive: false })).toBe(false);
    expect(shouldWatchPhoneIdleLocation({ ...visiblePhoneMap, mapTabIsVisible: false })).toBe(
      false,
    );
    expect(shouldWatchPhoneIdleLocation({ ...visiblePhoneMap, carPlayConnected: true })).toBe(
      false,
    );
  });
});
