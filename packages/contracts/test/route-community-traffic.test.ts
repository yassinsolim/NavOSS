import { describe, expect, it } from 'vitest';

import { RouteResponseSchema, RouteResponseV2Schema } from '../src/index.js';

const geometry = [
  [-114.06309, 51.04427],
  [-114.062, 51.045],
];
const baseline = {
  distanceMeters: 100,
  durationSeconds: 20,
  geometry,
  id: 'base',
  label: 'fastest',
  steps: [
    {
      distanceMeters: 100,
      durationSeconds: 20,
      geometry,
      instruction: 'Continue.',
      maneuverType: 'continue',
      roadName: 'Test road',
    },
  ],
};
const source = {
  attribution: 'Routing by Valhalla using OpenStreetMap data',
  id: 'valhalla-self-hosted',
  mode: 'production',
  traffic: 'unavailable',
};
const trafficSource = {
  id: 'navoss-community',
  attribution: 'Traffic from opted-in NavOSS drivers',
};
const response = {
  degraded: false,
  generatedAt: '2026-11-13T00:00:00Z',
  routes: [baseline],
  source,
};
const annotated = {
  ...baseline,
  durationSeconds: 50,
  congestion: ['slow'],
  traffic: { delaySeconds: 30, observedFraction: 0.7, typicalDurationSeconds: 20 },
  steps: baseline.steps.map((step) => ({ ...step, durationSeconds: 50 })),
};

describe('community traffic on the v2 route contract only', () => {
  it('keeps the unavailable v2 response and legacy v1 shape valid without traffic fields', () => {
    expect(RouteResponseV2Schema.safeParse(response).success).toBe(true);
    expect(RouteResponseSchema.safeParse(response).success).toBe(true);
  });

  it('accepts aligned live community annotations and an unobserved alternative in the returned order', () => {
    const result = RouteResponseV2Schema.parse({
      ...response,
      routes: [annotated, { ...baseline, id: 'unobserved', label: 'alternative' }],
      source: { ...source, traffic: 'live', trafficSource },
    });
    expect(result.routes.map((route) => route.id)).toEqual(['base', 'unobserved']);
    expect(result.routes[0]?.traffic?.observedFraction).toBe(0.7);
    expect(result.routes[1]?.traffic).toBeUndefined();
    expect(RouteResponseSchema.safeParse(result).success).toBe(false);
  });

  it('requires a community source for live Valhalla traffic and its route-only fields', () => {
    expect(
      RouteResponseV2Schema.safeParse({
        ...response,
        routes: [annotated],
        source: { ...source, traffic: 'live' },
      }).success,
    ).toBe(false);
    expect(RouteResponseV2Schema.safeParse({ ...response, routes: [annotated] }).success).toBe(
      false,
    );
    expect(
      RouteResponseV2Schema.safeParse({
        ...response,
        routes: [annotated],
        source: { ...source, trafficSource },
      }).success,
    ).toBe(false);
  });

  it('rejects unaligned congestion, invalid observed fractions and inconsistent adjusted ETA', () => {
    const live = { ...response, source: { ...source, traffic: 'live', trafficSource } };
    expect(
      RouteResponseV2Schema.safeParse({
        ...live,
        routes: [{ ...annotated, congestion: ['slow', 'free'] }],
      }).success,
    ).toBe(false);
    expect(
      RouteResponseV2Schema.safeParse({
        ...live,
        routes: [{ ...annotated, traffic: { ...annotated.traffic, observedFraction: 1.1 } }],
      }).success,
    ).toBe(false);
    expect(
      RouteResponseV2Schema.safeParse({ ...live, routes: [{ ...annotated, durationSeconds: 60 }] })
        .success,
    ).toBe(false);
    expect(
      RouteResponseV2Schema.safeParse({ ...live, routes: [{ ...baseline, congestion: ['slow'] }] })
        .success,
    ).toBe(false);
  });
});
