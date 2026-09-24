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

function buildRoute(
  id: string,
  geometry: RouteAlternative['geometry'],
  distanceMetersValue: number,
): RouteAlternative {
  return {
    distanceMeters: distanceMetersValue,
    durationSeconds: Math.max(1, Math.round(distanceMetersValue / 12)),
    geometry,
    id,
    label: 'fastest',
    steps: [
      {
        distanceMeters: distanceMetersValue,
        durationSeconds: Math.max(1, Math.round(distanceMetersValue / 12)),
        geometry,
        instruction: 'Drive along the route.',
        maneuverType: 'depart',
        roadName: 'Test Route',
      },
    ],
  };
}

interface CardinalRouteCase {
  geometry: RouteAlternative['geometry'];
  matchDirection: SafetyCamera['direction'];
  midpoint: readonly [number, number];
  opposite: SafetyCamera['direction'];
  perpendiculars: readonly [SafetyCamera['direction'], SafetyCamera['direction']];
}

const CARDINAL_ROUTE_CASES: readonly CardinalRouteCase[] = [
  {
    geometry: [
      [-114.08, 51.04],
      [-114.08, 51.05],
    ],
    matchDirection: 'northbound',
    midpoint: [-114.08, 51.045],
    opposite: 'southbound',
    perpendiculars: ['eastbound', 'westbound'],
  },
  {
    geometry: [
      [-114.08, 51.05],
      [-114.08, 51.04],
    ],
    matchDirection: 'southbound',
    midpoint: [-114.08, 51.045],
    opposite: 'northbound',
    perpendiculars: ['eastbound', 'westbound'],
  },
  {
    geometry: [
      [-114.08, 51.04],
      [-114.064096, 51.04],
    ],
    matchDirection: 'eastbound',
    midpoint: [-114.072048, 51.04],
    opposite: 'westbound',
    perpendiculars: ['northbound', 'southbound'],
  },
  {
    geometry: [
      [-114.064096, 51.04],
      [-114.08, 51.04],
    ],
    matchDirection: 'westbound',
    midpoint: [-114.072048, 51.04],
    opposite: 'eastbound',
    perpendiculars: ['northbound', 'southbound'],
  },
];

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

  it('still alerts for a direction-aligned roadside camera within the lateral allowance', () => {
    const result = findUpcomingSafetyCamera(
      [camera('roadside', 51.045, -114.0795)],
      route,
      0.2,
      new Set(),
    );
    expect(result?.camera.id).toBe('calgary-isc:roadside');
  });

  it('keeps a direction-aligned camera outside the lookahead window silent', () => {
    expect(
      findUpcomingSafetyCamera([camera('too-far', 51.047, -114.08)], route, 0.2, new Set()),
    ).toBeUndefined();
  });
});

describe('findUpcomingSafetyCamera direction and projection edge cases', () => {
  it.each(CARDINAL_ROUTE_CASES)(
    'selects the $matchDirection camera and ignores opposite/perpendicular cameras at the same point',
    ({ geometry, matchDirection, midpoint, opposite, perpendiculars }) => {
      const cardinalRoute = buildRoute(`cardinal-${matchDirection}`, geometry, 1_112);
      const result = findUpcomingSafetyCamera(
        [
          camera('aligned', midpoint[1], midpoint[0], matchDirection),
          camera('opposite', midpoint[1], midpoint[0], opposite),
          camera('perpendicular-a', midpoint[1], midpoint[0], perpendiculars[0]),
          camera('perpendicular-b', midpoint[1], midpoint[0], perpendiculars[1]),
        ],
        cardinalRoute,
        0.2,
        new Set(),
      );

      expect(result?.camera.id).toBe('calgary-isc:aligned');
      expect(result?.distanceAheadMeters).toBeGreaterThan(300);
      expect(result?.distanceAheadMeters).toBeLessThan(400);
    },
  );

  it.each(CARDINAL_ROUTE_CASES)(
    'does not alert when only opposite and perpendicular cameras are present ($matchDirection route)',
    ({ geometry, matchDirection, midpoint, opposite, perpendiculars }) => {
      const cardinalRoute = buildRoute(`cardinal-reject-${matchDirection}`, geometry, 1_112);
      const result = findUpcomingSafetyCamera(
        [
          camera('opposite', midpoint[1], midpoint[0], opposite),
          camera('perpendicular-a', midpoint[1], midpoint[0], perpendiculars[0]),
          camera('perpendicular-b', midpoint[1], midpoint[0], perpendiculars[1]),
        ],
        cardinalRoute,
        0.2,
        new Set(),
      );

      expect(result).toBeUndefined();
    },
  );

  const turnRouteProgress = 0.6813;
  const turnRoute = buildRoute(
    'north-to-east-turn',
    [
      [-114.08, 51.04],
      [-114.08, 51.05],
      [-114.075708, 51.05],
    ],
    1_412,
  );

  it('selects the incoming northbound camera at a turn vertex over the outgoing eastbound camera', () => {
    const result = findUpcomingSafetyCamera(
      [
        camera('vertex-north', 51.05, -114.08, 'northbound'),
        camera('vertex-east', 51.05, -114.08, 'eastbound'),
      ],
      turnRoute,
      turnRouteProgress,
      new Set(),
    );

    expect(result?.camera.id).toBe('calgary-isc:vertex-north');
    expect(result?.distanceAheadMeters).toBeGreaterThan(100);
    expect(result?.distanceAheadMeters).toBeLessThan(200);
  });

  it('suppresses an outgoing-leg camera sitting exactly at the shared vertex before the turn is taken', () => {
    const result = findUpcomingSafetyCamera(
      [camera('vertex-east', 51.05, -114.08, 'eastbound')],
      turnRoute,
      turnRouteProgress,
      new Set(),
    );

    expect(result).toBeUndefined();
  });

  it('still alerts for a real camera further down the road reached after the turn', () => {
    const result = findUpcomingSafetyCamera(
      [camera('east-far', 51.05, -114.077139, 'eastbound')],
      turnRoute,
      turnRouteProgress,
      new Set(),
    );

    expect(result?.camera.id).toBe('calgary-isc:east-far');
    expect(result?.distanceAheadMeters).toBeGreaterThan(300);
    expect(result?.distanceAheadMeters).toBeLessThan(400);
  });

  it('keeps the vertex selection unchanged when the route geometry repeats the shared vertex', () => {
    const duplicateVertexRoute = buildRoute(
      'north-to-east-turn-duplicate-vertex',
      [
        [-114.08, 51.04],
        [-114.08, 51.05],
        [-114.08, 51.05],
        [-114.075708, 51.05],
      ],
      1_412,
    );

    const selected = findUpcomingSafetyCamera(
      [
        camera('vertex-north', 51.05, -114.08, 'northbound'),
        camera('vertex-east', 51.05, -114.08, 'eastbound'),
      ],
      duplicateVertexRoute,
      turnRouteProgress,
      new Set(),
    );
    expect(selected?.camera.id).toBe('calgary-isc:vertex-north');

    const suppressed = findUpcomingSafetyCamera(
      [camera('vertex-east', 51.05, -114.08, 'eastbound')],
      duplicateVertexRoute,
      turnRouteProgress,
      new Set(),
    );
    expect(suppressed).toBeUndefined();
  });

  it('does not alert for a camera past the route end even though it sits within the endpoint clamp radius', () => {
    const result = findUpcomingSafetyCamera(
      [camera('beyond-end', 51.05027, -114.08, 'northbound')],
      route,
      0.95,
      new Set(),
    );

    expect(result).toBeUndefined();
  });

  it('does not alert for a camera before the route start even though it sits within the endpoint clamp radius', () => {
    const result = findUpcomingSafetyCamera(
      [camera('before-start', 51.03973, -114.08, 'northbound')],
      route,
      0.02,
      new Set(),
    );

    expect(result).toBeUndefined();
  });

  it('requires the nearest physical projection to match direction instead of falling back to a farther aligned leg', () => {
    const parallelReturnRoute = buildRoute(
      'parallel-return-leg',
      [
        [-114.09, 51.0],
        [-114.09, 51.001799],
        [-114.089714, 51.001799],
        [-114.089714, 51.0],
      ],
      420,
    );

    const result = findUpcomingSafetyCamera(
      [camera('near-wrong-direction', 51.0009, -114.09, 'southbound')],
      parallelReturnRoute,
      0,
      new Set(),
    );

    expect(result).toBeUndefined();

    // Once the closer northbound pass is behind us, the upcoming southbound pass is eligible.
    const returning = findUpcomingSafetyCamera(
      [camera('near-wrong-direction', 51.0009, -114.09, 'southbound')],
      parallelReturnRoute,
      0.6,
      new Set(),
    );
    expect(returning?.camera.id).toBe('calgary-isc:near-wrong-direction');
  });
});
