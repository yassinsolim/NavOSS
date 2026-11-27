import { describe, expect, it } from 'vitest';

import {
  CALGARY_TRAVEL_TIMES_ATTRIBUTION,
  CALGARY_TRAVEL_TIMES_SOURCE_ID,
  DECLARABLE_ROUTE_TRAFFIC_SOURCES,
  RouteRequestV2Schema,
  RouteResponseV2Schema,
} from '../src/index.js';
import { FrozenRouteResponseV2Schema } from './frozen-route-v2-response.js';

const geometry = [
  [-114.06309, 51.04427],
  [-114.062, 51.045],
  [-114.061, 51.046],
];
const route = {
  distanceMeters: 300,
  durationSeconds: 60,
  geometry,
  id: 'base',
  label: 'fastest',
  steps: [
    {
      distanceMeters: 300,
      durationSeconds: 60,
      geometry,
      instruction: 'Continue.',
      maneuverType: 'continue',
      roadName: 'Crowchild Trail NW',
    },
  ],
};
const source = {
  attribution: 'Routing by Valhalla using OpenStreetMap data',
  id: 'valhalla-self-hosted',
  mode: 'production',
  traffic: 'unavailable',
};
const city = {
  attribution: 'Traffic on main roads from The City of Calgary',
  id: 'calgary-travel-times',
};
const cityRoute = {
  ...route,
  congestion: ['heavy', 'unknown'],
  durationSeconds: 240,
  steps: route.steps.map((step) => ({ ...step, durationSeconds: 240 })),
  traffic: {
    delaySeconds: 180,
    observedFraction: 0.5,
    oldestObservedAt: '2026-11-27T15:43:43.000Z',
    snapshotAt: '2026-11-27T15:43:43.000Z',
    typicalDurationSeconds: 60,
  },
};
const request = {
  destination: { latitude: 51.0447, longitude: -114.0719 },
  origin: { latitude: 51.1, longitude: -114.2 },
};

describe('City of Calgary travel times on the v2 route contract', () => {
  it('exports the source id and the attribution the City requires', () => {
    expect(CALGARY_TRAVEL_TIMES_SOURCE_ID).toBe('calgary-travel-times');
    expect(CALGARY_TRAVEL_TIMES_ATTRIBUTION).toBe('Traffic on main roads from The City of Calgary');
    expect(DECLARABLE_ROUTE_TRAFFIC_SOURCES).toEqual(['calgary-travel-times']);
  });

  it('accepts a declared source list, including ids this server does not know', () => {
    expect(
      RouteRequestV2Schema.parse({ ...request, trafficSources: ['calgary-travel-times'] })
        .trafficSources,
    ).toEqual(['calgary-travel-times']);
    expect(
      RouteRequestV2Schema.safeParse({
        ...request,
        trafficSources: ['calgary-travel-times', 'a-source-from-2027'],
      }).success,
    ).toBe(true);
    expect(RouteRequestV2Schema.parse(request).trafficSources).toBeUndefined();
    expect(RouteRequestV2Schema.safeParse({ ...request, trafficSources: [''] }).success).toBe(
      false,
    );
    expect(
      RouteRequestV2Schema.safeParse({ ...request, trafficSources: Array(9).fill('x') }).success,
    ).toBe(false);
  });

  it('accepts a City-sourced response with the community annotation shape', () => {
    const parsed = RouteResponseV2Schema.parse({
      degraded: false,
      generatedAt: '2026-11-27T16:00:00Z',
      routes: [cityRoute, { ...route, id: 'clear', label: 'alternative' }],
      source: { ...source, traffic: 'live', trafficSource: city },
    });
    expect(parsed.source.trafficSource).toEqual(city);
    expect(parsed.routes[0]?.traffic?.delaySeconds).toBe(180);
  });

  it('rejects a City response without its live flag, a wrong attribution or a misaligned annotation', () => {
    const response = {
      degraded: false,
      generatedAt: '2026-11-27T16:00:00Z',
      routes: [cityRoute],
      source: { ...source, traffic: 'live', trafficSource: city },
    };
    expect(RouteResponseV2Schema.safeParse(response).success).toBe(true);
    expect(
      RouteResponseV2Schema.safeParse({
        ...response,
        source: { ...source, trafficSource: city },
      }).success,
    ).toBe(false);
    expect(
      RouteResponseV2Schema.safeParse({
        ...response,
        source: {
          ...source,
          traffic: 'live',
          trafficSource: { ...city, attribution: 'Traffic from The City of Calgary' },
        },
      }).success,
    ).toBe(false);
    expect(
      RouteResponseV2Schema.safeParse({
        ...response,
        routes: [{ ...cityRoute, congestion: ['heavy'] }],
      }).success,
    ).toBe(false);
  });

  it('is invisible to shipped builds: the City source fails the frozen origin/main schema', () => {
    const cityResponse = {
      degraded: false,
      generatedAt: '2026-11-27T16:00:00Z',
      routes: [cityRoute],
      source: { ...source, traffic: 'live', trafficSource: city },
    };
    // Which is why it is sent only to clients that declared it.
    expect(FrozenRouteResponseV2Schema.safeParse(cityResponse).success).toBe(false);
  });

  it('parses every response shape a client without the declaration can receive with the frozen schema', () => {
    const plain = {
      degraded: false,
      generatedAt: '2026-11-27T16:00:00Z',
      routes: [route],
      source,
    };
    const community = {
      ...plain,
      routes: [{ ...cityRoute, traffic: { ...cityRoute.traffic } }],
      source: {
        ...source,
        traffic: 'live',
        trafficSource: {
          attribution: 'Traffic from opted-in NavOSS drivers',
          id: 'navoss-community',
        },
      },
    };
    for (const response of [plain, community]) {
      const current = RouteResponseV2Schema.parse(response);
      expect(FrozenRouteResponseV2Schema.parse(response)).toEqual(current);
    }
  });
});
