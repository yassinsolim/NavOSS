import {
  AppConfigResponseSchema,
  LegacyAppConfigResponseSchema,
  ProblemDetailsSchema,
  RouteTrafficAnnotationSchema,
  TrafficFlowResponseSchema,
  TrafficStatusResponseSchema,
} from '@navoss/contracts';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { createContributionRateLimiter } from '../src/contribution-rate-limiter.js';
import { CALGARY_SEARCH_FIXTURES } from '../src/fixtures.js';
import { createFixtureSearchProvider } from '../src/search-provider.js';
import {
  createConfiguredTrafficService,
  createTrafficService,
  type TrafficService,
} from '../src/traffic/service.js';
import type { TrafficSettings } from '../src/traffic/settings.js';
import {
  DRIVE,
  driveBatch,
  FIXTURE_SETTINGS,
  JAMMED_GAPS,
  NOW,
  stubbedMatcher,
  type StubbedMatcher,
} from './traffic-fixture.js';

const apps: FastifyInstance[] = [];
const FLOW_URL = '/v1/traffic/flow?bbox=9.45,47.10,9.60,47.20';

async function createTrafficApp(
  settings: Partial<TrafficSettings> = {},
  options: Parameters<typeof buildApp>[0] = {},
): Promise<{ app: FastifyInstance; service: TrafficService; stub: StubbedMatcher }> {
  const stub = stubbedMatcher();
  const service = createTrafficService({
    clock: () => NOW,
    mapMatcher: stub.matcher,
    settings: { ...FIXTURE_SETTINGS, ...settings },
  });
  const app = await buildApp({
    clock: () => NOW,
    searchProvider: createFixtureSearchProvider(CALGARY_SEARCH_FIXTURES),
    trafficService: service,
    ...options,
  });
  apps.push(app);
  return { app, service, stub };
}

function upload(app: FastifyInstance, address: string, gaps?: readonly number[]) {
  return app.inject({
    headers: { 'x-forwarded-for': address },
    method: 'POST',
    payload: driveBatch(gaps),
    url: '/v1/traffic/probes',
  });
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('community traffic over HTTP', () => {
  it('publishes flow only after the third independent contributor', async () => {
    const { app } = await createTrafficApp();

    for (const address of ['198.51.100.1', '198.51.100.2']) {
      const response = await upload(app, address);
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ status: 'accepted' });
    }
    const before = TrafficFlowResponseSchema.parse((await app.inject(FLOW_URL)).json());
    expect(before.features).toEqual([]);
    expect(before.coverage).toMatchObject({ minimumContributors: 3, publishedSegments: 0 });

    // The same driver again, even from a rotated address in the same IPv6 /64, changes nothing.
    await upload(app, '198.51.100.2');
    expect(TrafficFlowResponseSchema.parse((await app.inject(FLOW_URL)).json()).features).toEqual(
      [],
    );

    expect((await upload(app, '198.51.100.3')).statusCode).toBe(202);
    const response = await app.inject(FLOW_URL);
    const after = TrafficFlowResponseSchema.parse(response.json());

    expect(response.headers['cache-control']).toBe('public, max-age=30');
    expect(after.source).toEqual({
      attribution: 'Traffic from opted-in NavOSS drivers',
      id: 'navoss-community',
    });
    expect(after.features.length).toBeGreaterThan(3);
    for (const feature of after.features) {
      expect(feature.properties.sampleCount).toBe(3);
      expect(feature.properties.congestion).toBe('free');
      expect(feature.properties.speedKph).toBeGreaterThan(33);
      expect(feature.properties.speedKph).toBeLessThan(46);
      expect(feature.properties.freeFlowKph).toBe(51);
      // Freshness is the end of the five-minute bucket, not the moment of any upload.
      expect(feature.properties.observedAt).toBe('2026-11-12T18:00:00.000Z');
      expect(feature.properties.ageSeconds).toBe(30);
    }
  });

  it('shows a jam where most contributors crawled and a clear road elsewhere', async () => {
    const { app } = await createTrafficApp();
    await upload(app, '198.51.100.1');
    await upload(app, '198.51.100.2', JAMMED_GAPS);
    await upload(app, '198.51.100.3', JAMMED_GAPS);

    const flow = TrafficFlowResponseSchema.parse((await app.inject(FLOW_URL)).json());
    const levels = new Set(flow.features.map(({ properties }) => properties.congestion));

    expect(levels.has('free')).toBe(true);
    expect(levels.has('heavy')).toBe(true);
    for (const { properties } of flow.features.filter((f) => f.properties.congestion === 'heavy')) {
      expect(properties.speedKph).toBeLessThan(23);
    }
  });

  it('reports upload rules and service-wide coverage in status', async () => {
    const { app } = await createTrafficApp();
    for (const address of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
      await upload(app, address);
    }
    const response = await app.inject('/v1/traffic/status');
    const status = TrafficStatusResponseSchema.parse(response.json());

    expect(status.mode).toBe('live');
    expect(status.probes).toMatchObject({ accepting: true, tripEndTrimMeters: 400 });
    expect(status.publication).toEqual({
      bucketSeconds: 300,
      minimumContributors: 3,
      windowSeconds: 1_800,
    });
    expect(status.coverage?.publishedSegments).toBeGreaterThan(3);
    expect(status.coverage?.samples).toBe((status.coverage?.observedSegments ?? 0) * 3);
  });

  it('sends Valhalla only the trimmed batch and no identity', async () => {
    const { app, stub } = await createTrafficApp();
    await upload(app, '198.51.100.1');

    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]?.shape.length).toBeLessThan(DRIVE.batchPositions.length - 6);
    expect(JSON.stringify(stub.requests[0])).not.toContain('198.51.100');
  });

  it('rejects implausible and out-of-coverage batches without matching them', async () => {
    const { app, stub } = await createTrafficApp({
      bounds: { east: -109.9, north: 60.1, south: 48.2, west: -139.1 },
    });
    const response = await upload(app, '198.51.100.1');

    expect(response.statusCode).toBe(400);
    expect(ProblemDetailsSchema.parse(response.json()).detail).toBe(
      'The batch is outside the community-traffic coverage area.',
    );
    expect(stub.requests).toEqual([]);

    const invalid = await app.inject({
      method: 'POST',
      payload: { ...driveBatch(), deviceId: 'abc' },
      url: '/v1/traffic/probes',
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('accepts a batch too short to survive trimming but records nothing', async () => {
    const { app, service, stub } = await createTrafficApp();
    const batch = driveBatch();
    const response = await app.inject({
      method: 'POST',
      payload: { ...batch, points: batch.points.slice(0, 12) },
      url: '/v1/traffic/probes',
    });

    expect(response.statusCode).toBe(202);
    expect(stub.requests).toEqual([]);
    expect(service.metrics()).toMatchObject({ batchesDropped: 1, samplesRecorded: 0 });
  });

  it('rate limits one source without affecting another', async () => {
    const { app } = await createTrafficApp(
      {},
      { trafficRateLimiter: createContributionRateLimiter({ sourceLimit: 2 }) },
    );
    expect((await upload(app, '198.51.100.1')).statusCode).toBe(202);
    expect((await upload(app, '198.51.100.1')).statusCode).toBe(202);
    const limited = await upload(app, '198.51.100.1');

    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('600');
    expect((await upload(app, '198.51.100.2')).statusCode).toBe(202);
  });

  it('tells the client to discard the batch when map matching is down', async () => {
    const { app, stub } = await createTrafficApp();
    stub.failNext(502);
    const response = await upload(app, '198.51.100.1');

    expect(response.statusCode).toBe(503);
    expect(ProblemDetailsSchema.parse(response.json()).detail).toContain('do not retry');
  });

  it('requires grid-aligned flow bounds', async () => {
    const { app } = await createTrafficApp();
    const response = await app.inject('/v1/traffic/flow?bbox=9.4871,47.1312,9.5312,47.1689');

    expect(response.statusCode).toBe(400);
    expect(ProblemDetailsSchema.parse(response.json()).title).toBe('Invalid traffic bounds');
  });
});

describe('community traffic modes', () => {
  it('is off by default: no uploads, no flow, no live-traffic claim', async () => {
    const app = await buildApp({
      clock: () => NOW,
      searchProvider: createFixtureSearchProvider(CALGARY_SEARCH_FIXTURES),
    });
    apps.push(app);

    expect((await upload(app, '198.51.100.1')).statusCode).toBe(503);
    expect((await app.inject(FLOW_URL)).statusCode).toBe(503);
    const status = TrafficStatusResponseSchema.parse(
      (await app.inject('/v1/traffic/status')).json(),
    );
    expect(status.mode).toBe('off');
    expect(status.probes.accepting).toBe(false);
    expect(status.coverage).toBeUndefined();
    const config = AppConfigResponseSchema.parse((await app.inject('/v2/config')).json());
    expect(config.features.liveTraffic).toBe(false);
  });

  it('collects without publishing or claiming live traffic', async () => {
    const { app } = await createTrafficApp({ mode: 'collect' });
    for (const address of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
      expect((await upload(app, address)).statusCode).toBe(202);
    }

    expect((await app.inject(FLOW_URL)).statusCode).toBe(503);
    const status = TrafficStatusResponseSchema.parse(
      (await app.inject('/v1/traffic/status')).json(),
    );
    expect(status.mode).toBe('collecting');
    expect(status.probes.accepting).toBe(true);
    expect(status.coverage).toBeUndefined();
    const config = AppConfigResponseSchema.parse((await app.inject('/v2/config')).json());
    expect(config.features.liveTraffic).toBe(false);
  });

  it('claims live traffic in v2 config only, leaving the frozen v1 config unchanged', async () => {
    const { app } = await createTrafficApp();
    const v2 = AppConfigResponseSchema.parse((await app.inject('/v2/config')).json());
    const v1 = LegacyAppConfigResponseSchema.parse((await app.inject('/v1/config')).json());

    expect(v2.features.liveTraffic).toBe(true);
    expect(v1.features.liveTraffic).toBe(false);
  });

  it('refuses to start against a public or missing Valhalla', () => {
    expect(() => createConfiguredTrafficService({}, { COMMUNITY_TRAFFIC_MODE: 'live' })).toThrow(
      /self-hosted Valhalla/,
    );
    expect(() =>
      createConfiguredTrafficService(
        {},
        {
          COMMUNITY_TRAFFIC_MODE: 'collect',
          VALHALLA_URL: 'https://valhalla1.openstreetmap.de/route',
        },
      ),
    ).toThrow(/self-hosted Valhalla/);
    expect(
      createConfiguredTrafficService(
        {},
        { COMMUNITY_TRAFFIC_MODE: 'collect', VALHALLA_URL: 'http://valhalla:8002/route' },
      ).mode,
    ).toBe('collect');
  });

  it('documents the traffic endpoints in OpenAPI', async () => {
    const { app } = await createTrafficApp();
    const document = (await app.inject('/openapi.json')).json<{ paths: Record<string, unknown> }>();

    expect(document.paths).toHaveProperty('/v1/traffic/probes');
    expect(document.paths).toHaveProperty('/v1/traffic/flow');
    expect(document.paths).toHaveProperty('/v1/traffic/status');
  });
});

describe('route traffic enrichment', () => {
  const route = { ...DRIVE.route, label: 'fastest' as const };
  const detour = {
    ...DRIVE.route,
    durationSeconds: DRIVE.route.durationSeconds + 10,
    geometry: DRIVE.route.geometry.slice(0, -1),
    id: 'detour',
    label: 'alternative' as const,
  };

  async function jammedService(settings: Partial<TrafficSettings> = {}) {
    const { app, service, stub } = await createTrafficApp({ routeMinCoverage: 0.4, ...settings });
    await upload(app, '198.51.100.1', JAMMED_GAPS);
    await upload(app, '198.51.100.2', JAMMED_GAPS);
    await upload(app, '198.51.100.3', JAMMED_GAPS);
    stub.requests.length = 0;
    return { service, stub };
  }

  it('adds delay, congestion and step durations to a route crossing a published jam', async () => {
    const { service } = await jammedService();
    const result = await service.enrichRoutes([route]);
    const enriched = result.routes[0];

    expect(result.trafficSource).toEqual({
      attribution: 'Traffic from opted-in NavOSS drivers',
      id: 'navoss-community',
    });
    expect(enriched?.traffic?.typicalDurationSeconds).toBe(route.durationSeconds);
    expect(enriched?.traffic?.delaySeconds).toBeGreaterThan(20);
    expect(enriched?.traffic?.observedFraction).toBeGreaterThanOrEqual(0.4);
    expect(enriched?.durationSeconds).toBeCloseTo(
      route.durationSeconds + (enriched?.traffic?.delaySeconds ?? 0),
      3,
    );
    expect(enriched?.congestion).toHaveLength(route.geometry.length - 1);
    // Segments only partly inside the crawl come out `slow`; those fully inside it `heavy`.
    expect(new Set(enriched?.congestion)).toEqual(new Set(['unknown', 'free', 'slow', 'heavy']));
    // The first and last 400 m were never uploaded, so the route's ends stay unknown.
    expect(enriched?.congestion?.[0]).toBe('unknown');
    expect(enriched?.congestion?.at(-1)).toBe('unknown');
    const stepTotal = enriched?.steps.reduce((sum, step) => sum + step.durationSeconds, 0) ?? 0;
    expect(stepTotal).toBeCloseTo(enriched?.durationSeconds ?? 0, 0);
    expect(
      RouteTrafficAnnotationSchema.safeParse({
        congestion: enriched?.congestion,
        delaySeconds: enriched?.traffic?.delaySeconds,
        durationSeconds: enriched?.durationSeconds,
        observedFraction: enriched?.traffic?.observedFraction,
        stepDurationsSeconds: enriched?.steps.map((step) => step.durationSeconds),
        typicalDurationSeconds: enriched?.traffic?.typicalDurationSeconds,
      }).success,
    ).toBe(true);
  });

  it('re-ranks alternatives on the adjusted durations', async () => {
    const { service } = await jammedService();
    // The detour is 10 s slower in free flow and cannot be walked onto observed roads.
    const ranked = await service.enrichRoutes([route, detour]);

    expect(ranked.routes.map(({ id }) => id)).toEqual(['detour', route.id]);
    expect(ranked.routes.map(({ label }) => label)).toEqual(['fastest', 'alternative']);
    expect(ranked.routes[0]?.traffic).toBeUndefined();
    expect(ranked.routes[0]?.congestion).toBeUndefined();
    expect(ranked.routes[1]?.traffic?.delaySeconds).toBeGreaterThan(20);
  });

  it('leaves routes untouched when too little of them is observed', async () => {
    const { service } = await jammedService({ routeMinCoverage: 0.95 });
    const result = await service.enrichRoutes([route]);

    expect(result.trafficSource).toBeUndefined();
    expect(result.routes).toEqual([route]);
  });

  it('skips map matching when nothing is published near the route', async () => {
    const { service, stub } = await createTrafficApp();
    const result = await service.enrichRoutes([route]);

    expect(result.routes).toEqual([route]);
    expect(result.trafficSource).toBeUndefined();
    expect(stub.requests).toEqual([]);
  });

  it('does nothing while collecting, and survives a map-matching outage', async () => {
    const collecting = await jammedService({ mode: 'collect' });
    expect((await collecting.service.enrichRoutes([route])).routes).toEqual([route]);
    expect(collecting.stub.requests).toEqual([]);

    const live = await jammedService();
    live.stub.failNext(502);
    const result = await live.service.enrichRoutes([route]);
    expect(result.routes).toEqual([route]);
    expect(result.trafficSource).toBeUndefined();
  });
});
