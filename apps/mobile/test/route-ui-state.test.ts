import type { RouteAlternativeV2, SearchResult } from '@navoss/contracts';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../modules/navoss-navigation/index.js', () => ({ default: {} }));

import {
  routeFromNativeTrip,
  routeSourceForNativeTrip,
  selectedRouteOf,
} from '../src/features/navigation/route-ui-state.js';

const destination: SearchResult = {
  category: 'landmark',
  center: { latitude: 51.13, longitude: -114.01 },
  confidence: 1,
  id: 'airport',
  label: 'YYC',
  name: 'Calgary International Airport',
};
const fastest = { id: 'fastest', label: 'fastest' } as RouteAlternativeV2;
const scenic = { id: 'scenic', label: 'alternative' } as RouteAlternativeV2;

describe('selected route', () => {
  it('follows the preview selection and the active trip, and has none while planning', () => {
    expect(selectedRouteOf({ type: 'idle' })).toBeUndefined();
    expect(selectedRouteOf({ destination, type: 'loading', waypoints: [] })).toBeUndefined();
    expect(
      selectedRouteOf({
        destination,
        routes: [fastest, scenic],
        selectedRouteId: 'scenic',
        type: 'preview',
        waypoints: [],
      }),
    ).toBe(scenic);
    expect(
      selectedRouteOf({
        destination,
        route: fastest,
        routes: [fastest],
        type: 'navigating',
        waypoints: [],
      }),
    ).toBe(fastest);
  });
});

describe('route from a native trip', () => {
  const trip = {
    destination: {
      id: 'airport',
      label: 'YYC',
      latitude: 51.13,
      longitude: -114.01,
      name: 'Airport',
    },
    distanceMeters: 19_700,
    durationSeconds: 1_200,
    geometry: [
      { latitude: 51.04, longitude: -114.08 },
      { latitude: 51.13, longitude: -114.01 },
    ],
    id: 'trip-1',
    preferences: {
      avoidFerries: false,
      avoidHighways: false,
      avoidTolls: false,
      avoidUnpaved: false,
    },
    source: 'valhalla-self-hosted',
    speedLimitsKph: [50],
    steps: [
      {
        distanceMeters: 19_700,
        durationSeconds: 1_200,
        geometry: [
          { latitude: 51.04, longitude: -114.08 },
          { latitude: 51.13, longitude: -114.01 },
        ],
        instruction: 'Drive north.',
        maneuverType: 'depart',
        roadName: 'Deerfoot Trail NE',
      },
    ],
    waypoints: [
      {
        category: 'poi' as const,
        id: 'cafe',
        label: 'Cafe',
        latitude: 51.05,
        longitude: -114.06,
        name: 'Cafe',
      },
    ],
  };

  it('renders exactly the trip the navigation core reports, in map coordinate order', () => {
    const rebuilt = routeFromNativeTrip(trip);
    expect(rebuilt.route.id).toBe('trip-1');
    expect(rebuilt.route.geometry).toEqual([
      [-114.08, 51.04],
      [-114.01, 51.13],
    ]);
    expect(rebuilt.route.steps[0]?.geometry[1]).toEqual([-114.01, 51.13]);
    expect(rebuilt.route.speedLimitsKph).toEqual([50]);
    expect(rebuilt.destination.center).toEqual({ latitude: 51.13, longitude: -114.01 });
    expect(rebuilt.waypoints.map((waypoint) => waypoint.id)).toEqual(['cafe']);
  });

  it('does not invent traffic, speed limits or spoken text the core did not report', () => {
    const { route } = routeFromNativeTrip({ ...trip, speedLimitsKph: undefined });
    expect(route).not.toHaveProperty('speedLimitsKph');
    expect(route).not.toHaveProperty('traffic');
    expect(route.steps[0]).not.toHaveProperty('spokenInstruction');
  });

  it('reports live traffic only for the provider that has it', () => {
    expect(routeSourceForNativeTrip('valhalla-self-hosted')?.traffic).toBe('unavailable');
    expect(routeSourceForNativeTrip('valhalla-development')).toMatchObject({
      mode: 'development',
      traffic: 'unavailable',
    });
    expect(routeSourceForNativeTrip('mapbox-traffic')?.traffic).toBe('live');
    expect(routeSourceForNativeTrip('something-new')).toBeUndefined();
    expect(routeSourceForNativeTrip(undefined)).toBeUndefined();
  });

  it('keeps the route detail native carries, so a rerouted trip keeps its lanes', () => {
    const [step] = trip.steps;
    const { route, routeSource } = routeFromNativeTrip({
      ...trip,
      congestion: ['slow'],
      steps: [
        {
          ...step!,
          exitNumber: '248',
          lanes: [
            { active: false, indications: ['straight'], valid: false },
            { active: true, indications: ['right'], valid: true, validIndication: 'right' },
          ],
          maneuverModifier: 'slight right',
          signpostToward: ['Glenmore Trail'],
          spokenInstruction: 'Take exit 248 toward Glenmore Trail.',
        },
      ],
      traffic: { delaySeconds: 60, typicalDurationSeconds: 1_140 },
      trafficSource: 'navoss-community',
    });
    expect(route.steps[0]).toMatchObject({
      exitNumber: '248',
      maneuverModifier: 'slight right',
      signpostToward: ['Glenmore Trail'],
    });
    expect(route.steps[0]?.lanes?.[1]).toEqual({
      active: true,
      indications: ['right'],
      valid: true,
      validIndication: 'right',
    });
    expect(route.congestion).toEqual(['slow']);
    expect(routeSource).toMatchObject({
      traffic: 'live',
      trafficSource: { id: 'navoss-community' },
    });
  });

  it('drops step detail outside the route contract instead of drawing it', () => {
    const [step] = trip.steps;
    const { route } = routeFromNativeTrip({
      ...trip,
      congestion: ['gridlock' as 'slow'],
      steps: [{ ...step!, lanes: [{ indications: ['hover'], valid: true }], exitNumber: '12' }],
    });
    expect(route.steps[0]).not.toHaveProperty('lanes');
    expect(route.steps[0]).not.toHaveProperty('exitNumber');
    expect(route.steps[0]?.instruction).toBe('Drive north.');
    expect(route).not.toHaveProperty('congestion');
  });
});
