import { RouteResponseV2Schema, type RouteAlternativeV2 } from '@navoss/contracts';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fixtureValue } from '../../../packages/contracts/test/fixture-value.js';
import { buildApp } from '../src/app.js';
import { normalizeValhallaPbfResponse } from '../src/valhalla-pbf.js';
import { createFixtureSearchProvider } from '../src/search-provider.js';
import type { MatchedEdge } from '../src/traffic/map-matcher.js';
import { COMMUNITY_TRAFFIC_SOURCE, createTrafficService } from '../src/traffic/service.js';
import { DEFAULT_TRAFFIC_SETTINGS, type TrafficMode } from '../src/traffic/settings.js';
import { createInMemoryTrafficReleaseStore } from '../src/traffic/store.js';
import calgary from './fixtures/valhalla/calgary-deerfoot-glenmore.json' with { type: 'json' };
import stoney from './fixtures/valhalla/calgary-stoney-airport.json' with { type: 'json' };

const source = {
  attribution: 'Routing by Valhalla using OpenStreetMap data' as const,
  id: 'valhalla-self-hosted' as const,
  mode: 'production' as const,
  degraded: false,
  traffic: 'unavailable' as const,
};
const now = new Date('2026-11-13T00:05:30Z');
const epoch = Math.floor(now.getTime() / 300_000) * 300_000;
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function routes(): RouteAlternativeV2[] {
  return [
    { ...fixtureValue(normalizeValhallaPbfResponse(calgary.response)[0]), label: 'fastest' },
    { ...fixtureValue(normalizeValhallaPbfResponse(stoney.response)[0]), label: 'alternative' },
  ];
}
async function setup(mode: TrafficMode) {
  const base = routes();
  const route = fixtureValue(base[0]);
  const edge: MatchedEdge = {
    beginShapeIndex: 0,
    endShapeIndex: route.geometry.length - 1,
    forward: true,
    fromFraction: 0,
    toFraction: 1,
    lengthMeters: route.distanceMeters,
    line: route.geometry,
    roadClass: 'motorway',
    segmentKey: 'w1f-000000000000',
    speedKph: 50,
    use: 'road',
    wayId: 1,
  };
  const walkRoute = vi.fn((positions: readonly [number, number][]) =>
    Promise.resolve(
      positions[0]?.[0] === route.geometry[0]?.[0] && positions[0]?.[1] === route.geometry[0]?.[1]
        ? [edge]
        : undefined,
    ),
  );
  const store = createInMemoryTrafficReleaseStore();
  const service = createTrafficService({
    clock: () => now,
    settings: { ...DEFAULT_TRAFFIC_SETTINGS, mode },
    store,
    mapMatcher: { matchTrace: () => Promise.resolve(undefined), walkRoute },
  });
  const app = await buildApp({
    clock: () => now,
    communityReports: null,
    trafficService: service,
    searchProvider: createFixtureSearchProvider(),
    routeProvider: {
      source,
      getRoutes: () => Promise.resolve([]),
      getEnrichedRoutes: () => Promise.resolve(base),
    },
  });
  apps.push(app);
  // Explicit controlled release fixture, not a claim about observed/public traffic.
  await store.publishEpoch(epoch, [
    {
      expiresAtMs: epoch + 900_000,
      freeFlowKph: 50,
      line: edge.line,
      releasedAtMs: epoch,
      roadClass: edge.roadClass,
      segmentKey: 'w1f-000000000000',
      speedKph: 20,
    },
  ]);
  return { app, base, service, walkRoute };
}

describe('v2 community traffic routing integration', () => {
  it.each(['off', 'collect'] as const)(
    '%s mode leaves the complete v2 result unchanged',
    async (mode) => {
      const { app, base, walkRoute } = await setup(mode);
      const response = await app.inject({
        method: 'POST',
        url: '/v2/routes',
        payload: calgary.request,
      });
      expect(response.statusCode).toBe(200);
      const result = RouteResponseV2Schema.parse(response.json());
      expect(result.routes).toEqual(base);
      expect(result.source).toEqual({
        attribution: source.attribution,
        id: source.id,
        mode: source.mode,
        traffic: 'unavailable',
      });
      expect(walkRoute).not.toHaveBeenCalled();
    },
  );

  it('connects the default hook to the real traffic service and marks an unobserved alternative unavailable', async () => {
    const { app, base, service } = await setup('live');
    const expected = await service.enrichRoutes(base);
    const response = await app.inject({
      method: 'POST',
      url: '/v2/routes',
      payload: calgary.request,
    });
    expect(response.statusCode).toBe(200);
    const result = RouteResponseV2Schema.parse(response.json());
    expect(result.routes).toEqual(expected.routes);
    expect(result.routes.map((route) => route.id)).toEqual(
      expected.routes.map((route) => route.id),
    );
    expect(result.source).toEqual({
      attribution: source.attribution,
      id: source.id,
      mode: source.mode,
      traffic: 'live',
      trafficSource: COMMUNITY_TRAFFIC_SOURCE,
    });
    const annotated = result.routes.find((route) => route.id === base[0]?.id);
    const unavailable = result.routes.find((route) => route.id === base[1]?.id);
    expect(annotated?.congestion).toHaveLength(fixtureValue(annotated).geometry.length - 1);
    expect(annotated?.traffic?.observedFraction).toBe(1);
    expect(annotated?.traffic?.delaySeconds).toBeGreaterThan(0);
    expect(unavailable?.traffic).toBeUndefined();
    expect(unavailable?.congestion).toBeUndefined();
  });

  it('does not re-sort the hook result and only advertises live traffic when the result sets a source', async () => {
    const base = routes();
    const enrichRoutes = vi.fn((input: RouteAlternativeV2[]) => ({ routes: [...input].reverse() }));
    const app = await buildApp({
      clock: () => now,
      communityReports: null,
      enrichRoutes,
      searchProvider: createFixtureSearchProvider(),
      routeProvider: {
        source,
        getRoutes: () => Promise.resolve([]),
        getEnrichedRoutes: () => Promise.resolve(base),
      },
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v2/routes',
      payload: calgary.request,
    });
    expect(response.statusCode).toBe(200);
    const result = RouteResponseV2Schema.parse(response.json());
    expect(result.routes.map((route) => route.id)).toEqual(
      [...base].reverse().map((route) => route.id),
    );
    expect(result.source.traffic).toBe('unavailable');
    expect(result.source.trafficSource).toBeUndefined();
    expect(enrichRoutes).toHaveBeenCalledOnce();
  });
});
