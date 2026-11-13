import { describe, expect, it } from 'vitest';

import {
  NAVIGATION_CAMERA_TRANSITION,
  navigationCameraBearing,
  navigationCameraCenter,
  toggleNavigationMapOrientation,
} from '../src/features/navigation/navigation-camera.js';

describe('navigation camera', () => {
  it('interpolates linearly across the normal GPS sample interval', () => {
    expect(NAVIGATION_CAMERA_TRANSITION).toEqual({ duration: 1_000, easing: 'linear' });
  });

  it('faces up along the matched road instead of raw device course', () => {
    expect(navigationCameraBearing('heading-up', 92, 78)).toBe(92);
  });

  it('uses travel course until a road match is available', () => {
    expect(navigationCameraBearing('heading-up', undefined, 275)).toBe(275);
  });

  it('faces north until any travel course is available', () => {
    expect(navigationCameraBearing('heading-up', undefined, undefined)).toBe(0);
  });

  it('forces geographic north up when selected', () => {
    expect(navigationCameraBearing('north-up', 92, 78)).toBe(0);
  });

  it('toggles between heading-up and north-up', () => {
    expect(toggleNavigationMapOrientation('heading-up')).toBe('north-up');
    expect(toggleNavigationMapOrientation('north-up')).toBe('heading-up');
  });
});

describe('navigation camera centre', () => {
  it('follows the vehicle, and falls back to the route start before the first fix', () => {
    const vehicle = { latitude: 51.05, longitude: -114.07 };
    const geometry = [
      [-114.0719, 51.0447],
      [-114.06, 51.05],
    ];
    expect(navigationCameraCenter(vehicle, geometry)).toBe(vehicle);
    expect(navigationCameraCenter(undefined, geometry)).toEqual({
      latitude: 51.0447,
      longitude: -114.0719,
    });
    expect(navigationCameraCenter(undefined, undefined)).toBeUndefined();
  });
});
