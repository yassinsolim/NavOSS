import { describe, expect, it } from 'vitest';

import {
  NAVIGATION_CAMERA_TRANSITION,
  navigationCameraBearing,
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
