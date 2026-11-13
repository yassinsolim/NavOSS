import type { RouteAlternative } from '@navoss/contracts';
import { describe, expect, it } from 'vitest';

import {
  buildEtaShareMessage,
  distinctRoadName,
  findNearestStepIndex,
  formatArrivalTime,
  formatDistance,
  formatDuration,
  formatTrafficDelay,
  getRemainingRouteGeometry,
  getRemainingRouteSummary,
  getRemainingStepSummary,
  getUpcomingGuidanceStep,
  getUpcomingManeuvers,
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

  it('reports live distance to the next maneuver', () => {
    const summary = getRemainingStepSummary(route, 0, {
      latitude: 51.045,
      longitude: -114.075,
    });

    expect(summary.distanceMeters).toBeCloseTo(250, 0);
    expect(summary.durationSeconds).toBeCloseTo(30, 0);
  });

  it('pairs the traversed leg countdown with the upcoming maneuver', () => {
    expect(getUpcomingGuidanceStep(route, 0)).toMatchObject({
      instruction: 'Continue to the airport.',
      roadName: 'Airport Trail NE',
    });
    expect(getUpcomingGuidanceStep(route, 1)).toBe(route.steps[1]);
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

  it('shows meaningful live traffic delay without sub-minute noise', () => {
    expect(formatTrafficDelay(300)).toBe('+5 min traffic');
    expect(formatTrafficDelay(29)).toBeUndefined();
  });

  it('shares an ETA without coordinates or live tracking', () => {
    const message = buildEtaShareMessage(
      'Calgary Tower',
      1_200,
      19_660,
      new Date(2026, 6, 15, 12, 0, 0),
    );

    expect(message).toContain('Calgary Tower');
    expect(message).toContain('12:20');
    expect(message).toContain('20 min');
    expect(message).toContain('19.7 km');
    expect(message).not.toMatch(/-114|51\.0|track/i);
  });

  it('summarizes the major roads used by an alternative', () => {
    expect(routeViaLabel(route)).toBe('via Airport Trail NE / Centre Street');
  });

  describe('companion directions list', () => {
    const step = (
      distanceMeters: number,
      instruction: string,
      maneuverType: string,
      roadName: string,
    ): RouteAlternative['steps'][number] => ({
      distanceMeters,
      durationSeconds: distanceMeters / 10,
      geometry: [
        [-114.08, 51.04],
        [-114.07, 51.05],
      ],
      instruction,
      maneuverType,
      roadName,
    });
    const cityRoute: RouteAlternative = {
      ...route,
      steps: [
        step(400, 'Head north on Centre Street.', 'depart', 'Centre Street'),
        step(1_200, 'Turn right onto 16 Avenue NE.', 'turn', '16 Avenue NE'),
        step(3_000, 'Keep left.', 'fork', 'Deerfoot Trail'),
        step(0, 'You have arrived at your destination.', 'arrive', ''),
      ],
    };

    it('lists every maneuver ahead with live distance first and leg lengths after', () => {
      expect(getUpcomingManeuvers(cityRoute, 0, 260)).toEqual([
        {
          distanceMeters: 260,
          instruction: 'Turn right onto 16 Avenue NE.',
          maneuverType: 'turn',
          roadName: '',
          stepIndex: 1,
        },
        {
          distanceMeters: 1_200,
          instruction: 'Keep left.',
          maneuverType: 'fork',
          roadName: 'Deerfoot Trail',
          stepIndex: 2,
        },
        {
          distanceMeters: 3_000,
          instruction: 'You have arrived at your destination.',
          maneuverType: 'arrive',
          roadName: '',
          stepIndex: 3,
        },
      ]);
    });

    it('starts at the same maneuver the guidance banner announces', () => {
      for (const traversed of [0, 1, 2, 3]) {
        expect(getUpcomingManeuvers(cityRoute, traversed, 100)[0].instruction).toBe(
          getUpcomingGuidanceStep(cityRoute, traversed)?.instruction,
        );
      }
    });

    it('drops passed maneuvers and keeps only arrival on the final leg', () => {
      expect(getUpcomingManeuvers(cityRoute, 2, 900).map(({ stepIndex }) => stepIndex)).toEqual([
        3,
      ]);
      expect(getUpcomingManeuvers(cityRoute, 9, 0).map(({ stepIndex }) => stepIndex)).toEqual([3]);
      expect(getUpcomingManeuvers({ ...cityRoute, steps: [] }, 0, 0)).toEqual([]);
    });

    it('never reports a negative live distance', () => {
      expect(getUpcomingManeuvers(cityRoute, 0, -5)[0].distanceMeters).toBe(0);
    });

    it('omits a road name the instruction already states', () => {
      expect(distinctRoadName('Turn right onto 16 Avenue NE.', '16 avenue ne')).toBe('');
      expect(distinctRoadName('Keep left.', ' Deerfoot Trail ')).toBe('Deerfoot Trail');
      expect(distinctRoadName('Keep left.', '   ')).toBe('');
    });
  });
});
