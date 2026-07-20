import type { RouteAlternative, SafetyCamera } from '@navoss/contracts';
import { describe, expect, it } from 'vitest';

import { findUpcomingSafetyCamera } from '../src/features/navigation/safety-camera-alert.js';

const route: RouteAlternative = {
  distanceMeters: 1_112,
  durationSeconds: 90,
  geometry: [
    [-114.08, 51.04],
    [-114.08, 51.05],
  ],
  id: 'northbound-route',
  label: 'fastest',
  steps: [
    {
      distanceMeters: 1_112,
      durationSeconds: 90,
      geometry: [
        [-114.08, 51.04],
        [-114.08, 51.05],
      ],
      instruction: 'Drive north.',
      maneuverType: 'depart',
      roadName: '14 Street NW',
    },
  ],
};

function camera(
  id: string,
  latitude: number,
  longitude: number,
  direction: SafetyCamera['direction'] = 'northbound',
): SafetyCamera {
  return {
    community: 'HILLHURST',
    coordinate: { latitude, longitude },
    direction,
    enforcement: ['red-light', 'speed-on-green'],
    id: `calgary-isc:${id}`,
    location: '14 Street and Example Avenue N.W.',
    quadrant: 'NW',
    ward: 7,
  };
}

describe('findUpcomingSafetyCamera', () => {
  it('selects the nearest direction-aligned camera ahead on the route', () => {
    const result = findUpcomingSafetyCamera(
      [camera('far', 51.047, -114.08), camera('near', 51.045, -114.08)],
      route,
      0.2,
      new Set(),
    );

    expect(result?.camera.id).toBe('calgary-isc:near');
    expect(result?.distanceAheadMeters).toBeGreaterThan(300);
    expect(result?.distanceAheadMeters).toBeLessThan(400);
  });

  it('ignores opposite-direction and off-route cameras', () => {
    const result = findUpcomingSafetyCamera(
      [camera('opposite', 51.045, -114.08, 'southbound'), camera('off-route', 51.045, -114.078)],
      route,
      0.2,
      new Set(),
    );

    expect(result).toBeUndefined();
  });

  it('ignores cameras behind the current route progress', () => {
    const result = findUpcomingSafetyCamera(
      [camera('behind', 51.042, -114.08)],
      route,
      0.5,
      new Set(),
    );

    expect(result).toBeUndefined();
  });

  it('does not return a camera that was already announced', () => {
    const cameraId = 'calgary-isc:announced';
    const result = findUpcomingSafetyCamera(
      [camera('announced', 51.045, -114.08)],
      route,
      0.2,
      new Set([cameraId]),
    );

    expect(result).toBeUndefined();
  });
});
