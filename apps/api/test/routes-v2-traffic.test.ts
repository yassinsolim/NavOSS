import {
  RouteAlternativeV2Schema,
  RouteResponseV2Schema,
  type RouteAlternativeV2,
} from '@navoss/contracts';
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
import {
  credentialFor,
  DRIVE,
  driveBatch,
  fakeAttestation,
  FIXTURE_SETTINGS,
  isFixtureTrafficCoordinate,
  JAMMED_GAPS,
  NOW,
  stubbedMatcher,
} from './traffic-fixture.js';
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

  describe('with traffic replayed through the probe endpoint', () => {
    const driven = RouteAlternativeV2Schema.parse({ ...DRIVE.route, label: 'fastest' });
    // A slower engine alternative that cannot be walked: it is never promoted.
    const unwalkable = RouteAlternativeV2Schema.parse({
      ...DRIVE.route,
      durationSeconds: DRIVE.route.durationSeconds + 10,
      geometry: DRIVE.route.geometry.slice(0, -1),
      id: 'unwalkable',
      label: 'alternative',
    });

    async function replayed(mode: TrafficMode) {
      let nowMs = NOW.getTime();
      const clock = (): Date => new Date(nowMs);
      const stub = stubbedMatcher();
      const service = createTrafficService({
        attestation: fakeAttestation(),
        clock,
        // The recorded drive is in Liechtenstein, outside the provincial service coverage.
        isInCoverage: isFixtureTrafficCoordinate,
        mapMatcher: stub.matcher,
        settings: { ...FIXTURE_SETTINGS, mode, routeMinCoverage: 0.35 },
      });
      const app = await buildApp({
        clock,
        communityReports: null,
        searchProvider: createFixtureSearchProvider(),
        trafficService: service,
        routeProvider: {
          source,
          getRoutes: () => Promise.resolve([]),
          getEnrichedRoutes: () => Promise.resolve([driven, unwalkable]),
        },
      });
      apps.push(app);
      if (mode !== 'off') {
        for (const [index, device] of ['phone-1', 'phone-2', 'phone-3'].entries()) {
          const capturedAt = new Date(Math.floor(nowMs / 60_000) * 60_000 - 300_000).toISOString();
          const upload = await app.inject({
            headers: { 'x-forwarded-for': `198.51.${String(100 + index)}.1` },
            method: 'POST',
            payload: driveBatch(await credentialFor(service, device), JAMMED_GAPS, capturedAt),
            url: '/v2/traffic/probes',
          });
          expect(upload.statusCode).toBe(202);
        }
      }
      // Just after the boundary; nothing calls runEpoch(): the route request reads that epoch.
      nowMs = Date.parse('2026-11-12T18:05:00.500Z');
      const response = await app.inject({
        method: 'POST',
        url: '/v2/routes',
        payload: calgary.request,
      });
      expect(response.statusCode).toBe(200);
      return RouteResponseV2Schema.parse(response.json());
    }

    it('returns no traffic fields while traffic is off', async () => {
      const result = await replayed('off');
      expect(result.routes).toEqual([driven, unwalkable]);
      for (const route of result.routes) {
        expect(route.traffic).toBeUndefined();
        expect(route.congestion).toBeUndefined();
      }
      expect(result.source.traffic).toBe('unavailable');
      expect(result.source.trafficSource).toBeUndefined();
    });

    it('returns congestion aligned to each route geometry, in the returned order, when live', async () => {
      const result = await replayed('live');
      expect(result.source.traffic).toBe('live');
      expect(result.source.trafficSource).toEqual(COMMUNITY_TRAFFIC_SOURCE);
      expect(result.routes.map((route) => route.id)).toEqual([driven.id, 'unwalkable']);
      const [first, second] = result.routes;
      expect(first?.congestion).toHaveLength(driven.geometry.length - 1);
      expect(new Set(first?.congestion)).toEqual(new Set(['unknown', 'free', 'slow', 'heavy']));
      expect(first?.traffic?.observedFraction).toBeGreaterThanOrEqual(0.35);
      expect(first?.traffic?.delaySeconds).toBeGreaterThan(20);
      expect(second?.congestion).toBeUndefined();
      expect(second?.traffic).toBeUndefined();
    });
  });
});
