import { describe, expect, it } from 'vitest';

import {
  NAVIGATION_CAMERA_TRANSITION,
  navigationCameraBearing,
  navigationCameraCenter,
  toggleNavigationMapOrientation,
} from '../src/features/navigation/navigation-camera.js';
import { tripVehicleCourseDegrees } from '../src/features/navigation/vehicle-heading.js';

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

describe('heading-up camera during a trip', () => {
  // What the map controller does with each snapshot: the camera faces the trip vehicle's course,
  // and the heading it falls back to is the last one that course produced.
  function drive(snapshots: { matchedCourseDegrees?: number; rawCourseDegrees?: number }[]) {
    let heldHeading: number | undefined;
    return snapshots.map((snapshot) => {
      const course = tripVehicleCourseDegrees(snapshot);
      if (course !== undefined) heldHeading = course;
      return navigationCameraBearing('heading-up', course, heldHeading);
    });
  }

  it("turns with the fix's course off the route, not the last matched road", () => {
    // Matched south after a turn, then driven west off the route with no new route yet.
    expect(
      drive([
        { matchedCourseDegrees: 180, rawCourseDegrees: 182 },
        { rawCourseDegrees: 268 },
        { rawCourseDegrees: 271 },
      ]),
    ).toEqual([180, 268, 271]);
  });

  it('returns to the matched road once matched again', () => {
    expect(
      drive([
        { matchedCourseDegrees: 180 },
        { rawCourseDegrees: 270 },
        { matchedCourseDegrees: 90 },
      ]),
    ).toEqual([180, 270, 90]);
    expect(tripVehicleCourseDegrees({ matchedCourseDegrees: 90, rawCourseDegrees: 95 })).toBe(90);
  });

  it('holds the last heading off the route when the fix proves no course (stopped)', () => {
    expect(drive([{ matchedCourseDegrees: 180 }, { rawCourseDegrees: 270 }, {}, {}])).toEqual([
      180, 270, 270, 270,
    ]);
    expect(tripVehicleCourseDegrees({})).toBeUndefined();
    expect(tripVehicleCourseDegrees(undefined)).toBeUndefined();
  });

  it('ignores a course that is not a bearing', () => {
    expect(tripVehicleCourseDegrees({ rawCourseDegrees: 360 })).toBeUndefined();
    expect(tripVehicleCourseDegrees({ rawCourseDegrees: Number.NaN })).toBeUndefined();
    expect(tripVehicleCourseDegrees({ matchedCourseDegrees: -1, rawCourseDegrees: 10 })).toBe(10);
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
