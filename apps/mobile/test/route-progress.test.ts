import type { RouteAlternative } from '@navoss/contracts';
import { describe, expect, it } from 'vitest';

import {
  findNearestStepIndex,
  formatArrivalTime,
  formatDistance,
  formatDuration,
  getRemainingRouteGeometry,
  getRemainingRouteSummary,
  routeViaLabel,
} from '../src/features/navigation/route-progress.js';

const route: RouteAlternative = {
  distanceMeters: 2_000,
  durationSeconds: 180,
  geometry: [
    [-114.08, 51.04],
    [-114.01, 51.13],
  ],
  id: 'route-1',
  label: 'fastest',
  steps: [
    {
      distanceMeters: 500,
      durationSeconds: 60,
      geometry: [
        [-114.08, 51.04],
        [-114.07, 51.05],
      ],
      instruction: 'Head north.',
      maneuverType: 'depart',
      roadName: 'Centre Street',
    },
    {
      distanceMeters: 1_500,
      durationSeconds: 120,
      geometry: [
        [-114.03, 51.1],
        [-114.01, 51.13],
      ],
      instruction: 'Continue to the airport.',
      maneuverType: 'turn',
      roadName: 'Airport Trail NE',
    },
  ],
};

describe('route progress', () => {
  it('finds the nearest guidance step', () => {
    expect(
      findNearestStepIndex(route, {
        latitude: 51.101,
        longitude: -114.031,
      }),
    ).toBe(1);
  });

  it('sums the remaining guidance metrics', () => {
    expect(getRemainingRouteSummary(route, 1)).toEqual({
      distanceMeters: 1_500,
      durationSeconds: 120,
    });
  });

  it('reduces the current step continuously from the nearest geometry position', () => {
    const summary = getRemainingRouteSummary(route, 0, {
      latitude: 51.045,
      longitude: -114.075,
    });

    expect(summary.distanceMeters).toBeCloseTo(1_750, 0);
    expect(summary.durationSeconds).toBeCloseTo(150, 0);
  });

  it('removes completed route geometry while preserving the destination', () => {
    const routeWithSegments: RouteAlternative = {
      ...route,
      geometry: [
        [-114.08, 51.04],
        [-114.08, 51.08],
        [-114.08, 51.12],
      ],
    };

    expect(getRemainingRouteGeometry(routeWithSegments, 0).length).toBe(3);
    const remainingGeometry = getRemainingRouteGeometry(routeWithSegments, 0.75);
    expect(remainingGeometry).toHaveLength(2);
    expect(remainingGeometry[0][0]).toBeCloseTo(-114.08);
    expect(remainingGeometry[0][1]).toBeCloseTo(51.1);
    expect(remainingGeometry[1]).toEqual([-114.08, 51.12]);
  });

  it('starts the remaining route at the native matched coordinate', () => {
    expect(
      getRemainingRouteGeometry(route, 0.5, {
        latitude: 51.09,
        longitude: -114.045,
      })[0],
    ).toEqual([-114.045, 51.09]);
  });

  it('collapses a completed route at its destination', () => {
    const remainingGeometry = getRemainingRouteGeometry(route, 1);
    expect(remainingGeometry).toEqual([
      [-114.01, 51.13],
      [-114.01, 51.13],
    ]);
  });

  it('formats ETA, distance, and arrival time for driver scanning', () => {
    expect(formatDuration(1_215)).toBe('20 min');
    expect(formatDistance(19_660)).toBe('19.7 km');
    expect(formatArrivalTime(1_200, new Date(2026, 6, 15, 12, 0, 0))).toContain('12:20');
  });

  it('summarizes the major roads used by an alternative', () => {
    expect(routeViaLabel(route)).toBe('via Airport Trail NE / Centre Street');
  });
});
