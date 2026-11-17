import type { RouteAlternativeV2 } from '@navoss/contracts';
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
  routeTrafficLabel,
  getUpcomingManeuvers,
  routeViaLabel,
} from '../src/features/navigation/route-progress.js';

const route: RouteAlternativeV2 = {
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
    const routeWithSegments: RouteAlternativeV2 = {
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
    expect(formatDistance(19_660)).toBe('20 km');
    expect(formatArrivalTime(1_200, new Date(2026, 6, 15, 12, 0, 0))).toContain('12:20');
  });

  describe('long trips (Toronto to Vancouver: 4,392.3 km, 46 hr 4 min)', () => {
    const departure = new Date(2026, 10, 15, 10, 49, 0); // a Sunday morning, local time

    it('shows whole kilometres with a thousands separator from 10 km, one decimal below', () => {
      expect(formatDistance(4_392_300)).toBe('4,392 km');
      expect(formatDistance(1_000_000)).toBe('1,000 km');
      expect(formatDistance(10_000)).toBe('10 km');
      expect(formatDistance(9_960)).toBe('10 km');
      expect(formatDistance(9_440)).toBe('9.4 km');
      expect(formatDistance(1_000)).toBe('1.0 km');
      expect(formatDistance(640)).toBe('640 m');
    });

    it('formats in en-CA whatever the device locale: comma groups, point decimals', () => {
      expect(formatDistance(12_345_678)).toBe('12,346 km');
      expect(formatDistance(2_550)).toBe('2.5 km');
    });

    it('states durations beyond a day in days and hours', () => {
      expect(formatDuration(46 * 3_600 + 4 * 60)).toBe('1 day 22 hr');
      expect(formatDuration(24 * 3_600)).toBe('1 day');
      expect(formatDuration(49 * 3_600 + 20 * 60)).toBe('2 days 1 hr');
      expect(formatDuration(23 * 3_600 + 59 * 60)).toBe('23 hr 59 min');
      expect(formatDuration(23 * 3_600 + 59 * 60 + 50)).toBe('1 day');
    });

    it('names the arrival day when it is not today', () => {
      expect(formatArrivalTime(46 * 3_600 + 4 * 60, departure)).toMatch(/^Tue 8:53\s?a\.?m\.?$/iu);
      expect(formatArrivalTime(13 * 3_600 + 11 * 60, departure)).toMatch(/^Mon 12:00\s?a\.?m\.?/iu);
      expect(formatArrivalTime(13 * 3_600 + 10 * 60, departure)).toMatch(/^11:59\s?p\.?m\.?$/iu);
      expect(formatArrivalTime(10 * 24 * 3_600, departure)).toMatch(/^Nov 25 10:49\s?a\.?m\.?$/iu);
    });

    it('reads bare highway numbers in the via summary as highways', () => {
      const highway = (roadName: string, distanceMeters: number) => ({
        ...route.steps[0],
        distanceMeters,
        roadName,
      });
      expect(
        routeViaLabel({ ...route, steps: [highway('17', 900_000), highway('1', 2_400_000)] }),
      ).toBe('via Highway 1 / Highway 17');
      expect(
        routeViaLabel({
          ...route,
          steps: [highway('Highway 401 Express', 9_000), highway('17A', 800)],
        }),
      ).toBe('via Highway 401 Express / Highway 17A');
    });
  });

  it('shows meaningful live traffic delay without sub-minute noise', () => {
    expect(formatTrafficDelay(300)).toBe('+5 min traffic');
    expect(formatTrafficDelay(29)).toBeUndefined();
  });

  it('shares one readable sentence with the arrival time, duration and distance', () => {
    const message = buildEtaShareMessage(
      'Calgary Tower',
      1_200,
      19_660,
      new Date(2026, 6, 15, 12, 0, 0),
    );

    expect(message).toBe(
      `I'm heading to Calgary Tower. ETA ${formatArrivalTime(1_200, new Date(2026, 6, 15, 12, 0, 0))} (20 min, 20 km).`,
    );
    expect(message).toMatch(/ETA 12:20/);
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
    ): RouteAlternativeV2['steps'][number] => ({
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
    const cityRoute: RouteAlternativeV2 = {
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

describe('route traffic label', () => {
  const valhalla = {
    attribution: 'Routing by Valhalla using OpenStreetMap data' as const,
    id: 'valhalla-self-hosted' as const,
    mode: 'production' as const,
    traffic: 'unavailable' as const,
  };
  const community = {
    ...valhalla,
    traffic: 'live' as const,
    trafficSource: {
      attribution: 'Traffic from opted-in NavOSS drivers' as const,
      id: 'navoss-community' as const,
    },
  };

  it('says there is no live traffic unless a source provides it', () => {
    expect(routeTrafficLabel(valhalla, {})).toBe('No live traffic');
    expect(routeTrafficLabel(undefined, undefined)).toBe('No live traffic');
  });

  it('credits community traffic only on a route it observed', () => {
    expect(
      routeTrafficLabel(community, {
        congestion: ['slow'],
        traffic: { delaySeconds: 60, observedFraction: 0.4, typicalDurationSeconds: 600 },
      }),
    ).toBe('Traffic from opted-in NavOSS drivers');
    expect(routeTrafficLabel(community, {})).toBe('No live traffic on this route');
  });

  it('says when community traffic was updated, from the oldest release it used, not the request', () => {
    const observed = new Date(2026, 10, 13, 18, 0, 0);
    const label = routeTrafficLabel(community, {
      congestion: ['slow'],
      traffic: {
        delaySeconds: 60,
        observedFraction: 0.4,
        oldestObservedAt: observed.toISOString(),
        snapshotAt: new Date(observed.getTime() + 300_000).toISOString(),
        typicalDurationSeconds: 600,
      },
    });
    // The oldest publication boundary used, said as an update time, not as when anyone drove.
    expect(label).toMatch(/^Traffic from opted-in NavOSS drivers · updated 6:00/);
    expect(label).not.toContain('6:05');
    expect(label).not.toContain('as of');
    // An unobserved alternative claims no traffic, so no freshness either.
    expect(routeTrafficLabel(community, {})).toBe('No live traffic on this route');
  });

  it('keeps the provider traffic wording', () => {
    const mapbox = {
      attribution: 'Routing and traffic by Mapbox' as const,
      id: 'mapbox-traffic' as const,
      mode: 'production' as const,
      traffic: 'live' as const,
    };
    expect(
      routeTrafficLabel(mapbox, { traffic: { delaySeconds: 300, typicalDurationSeconds: 600 } }),
    ).toBe('+5 min traffic');
    expect(
      routeTrafficLabel(mapbox, { traffic: { delaySeconds: 0, typicalDurationSeconds: 600 } }),
    ).toBe('Live traffic');
  });
});
