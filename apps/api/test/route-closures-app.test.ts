import {
  createServiceCoverage,
  RouteResponseSchema,
  RouteResponseV2Schema,
} from '@navoss/contracts';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fixtureValue } from '../../../packages/contracts/test/fixture-value.js';
import { buildApp } from '../src/app.js';
import { createFixtureSearchProvider } from '../src/search-provider.js';
import { CALGARY_SEARCH_FIXTURES } from '../src/fixtures.js';
import official from './fixtures/road-events/official-closures-2026-11-27.json' with { type: 'json' };
import {
  closureFixture,
  recordedClosureProvider,
  recordedClosureSources,
} from './support/closure-routing-fixture.js';

const pointCase = fixtureValue(
  closureFixture.cases.find((example) => example.name === 'drivebc-mckay-point-current'),
);
const jingle = fixtureValue(
  closureFixture.cases.find((example) => example.name === 'nanaimo-jingle-pot-current'),
);
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllEnvs();
});

async function testApp(
  clock: () => number,
  sources = recordedClosureSources(clock),
  replay = recordedClosureProvider(),
  mode: 'off' | 'shadow' | 'on' = 'on',
) {
  vi.stubEnv('ROUTE_AVOID_CLOSURES', mode);
  vi.stubEnv('COMMUNITY_TRAFFIC_MODE', 'off');
  if (mode !== 'off') await sources.ready();
  const app = await buildApp({
    clock: () => new Date(clock()),
    communityReports: null,
    coverage: createServiceCoverage(['alberta', 'british-columbia']),
    coverageReadiness: null,
    databaseReadiness: null,
    enrichRoutes: (routes) => ({ routes }),
    provincialRoadEvents: sources.service,
    routeProvider: replay.provider,
    searchProvider: createFixtureSearchProvider(CALGARY_SEARCH_FIXTURES),
  });
  apps.push(app);
  return { app, sources, replay };
}

async function assertActiveControl() {
  const { app } = await testApp(() => pointCase.now);
  const response = await app.inject({
    method: 'POST',
    url: '/v2/routes',
    payload: pointCase.request,
  });
  expect(response.statusCode).toBe(200);
  expect(RouteResponseV2Schema.parse(response.json()).routes).toEqual(pointCase.after);
}

describe('official closure routing HTTP acceptance', () => {
  it('off returns byte-for-byte the ordinary response and makes no closure/feed requests', async () => {
    const { app, sources, replay } = await testApp(
      () => pointCase.now,
      undefined,
      undefined,
      'off',
    );
    const response = await app.inject({
      method: 'POST',
      url: '/v2/routes',
      payload: pointCase.request,
    });
    const expected = RouteResponseV2Schema.parse({
      degraded: false,
      generatedAt: new Date(pointCase.now).toISOString(),
      routes: pointCase.before,
      source: {
        attribution: 'Routing by Valhalla using OpenStreetMap data',
        id: 'valhalla-self-hosted',
        mode: 'production',
        traffic: 'unavailable',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(JSON.stringify(expected));
    expect(sources.cityFetch).not.toHaveBeenCalled();
    expect(sources.bcFetch).not.toHaveBeenCalled();
    expect(replay.calls).toHaveLength(1);
    expect(replay.calls[0]?.excluded).toBe(false);
  });

  it.each([
    ['a named closed edge on the natural route', pointCase],
    ['a current official line, including its large real diversion', jingle],
  ] as const)('avoids %s without adding client contract fields', async (_name, example) => {
    const { app, replay } = await testApp(() => example.now);
    const response = await app.inject({
      method: 'POST',
      url: '/v2/routes',
      payload: example.request,
    });
    expect(response.statusCode).toBe(200);
    const result = RouteResponseV2Schema.parse(response.json());
    expect(result.routes).toEqual(example.after);
    expect(result.routes).not.toEqual(example.before);
    expect(result.source.traffic).toBe('unavailable');
    expect(result.source.trafficSource).toBeUndefined();
    expect(replay.calls.some((call) => call.excluded)).toBe(true);
  });

  it('keeps avoiding a full closure but never excludes a lane closure or an advisory', async () => {
    await assertActiveControl(); // This control makes the regression fail on the pre-feature handler.
    const lane = fixtureValue(
      official.calgaryConstruction.rows.find(
        (row) => row.construction_info === 'Edmonton Trail at 1 Avenue NE',
      ),
    );
    const advisory = fixtureValue(
      official.driveBc.rows.find((row) => row.id === 'drivebc.ca/RIDE-100481'),
    );
    const sources = recordedClosureSources(() => pointCase.now, {
      cityRows: [lane],
      bcRows: [advisory],
    });
    const { app, replay } = await testApp(() => pointCase.now, sources);
    const response = await app.inject({
      method: 'POST',
      url: '/v2/routes',
      payload: pointCase.request,
    });
    expect(RouteResponseV2Schema.parse(response.json()).routes).toEqual(pointCase.before);
    expect(replay.calls.some((call) => call.excluded)).toBe(false);
  });

  it('keeps avoiding current closures but ignores an expired source interval', async () => {
    await assertActiveControl();
    const row = fixtureValue(
      official.driveBc.rows.find((event) => event.id === 'drivebc.ca/RIDE-108168'),
    );
    // A changed time bound on recorded geometry tests expiry; it is not a live-feed assertion.
    const expired = { ...row, schedule: { intervals: ['2026-11-26T00:00/2026-11-27T00:00'] } };
    const sources = recordedClosureSources(() => jingle.now, { cityRows: [], bcRows: [expired] });
    const { app, replay } = await testApp(() => jingle.now, sources);
    const response = await app.inject({
      method: 'POST',
      url: '/v2/routes',
      payload: jingle.request,
    });
    expect(RouteResponseV2Schema.parse(response.json()).routes).toEqual(jingle.before);
    expect(replay.calls.some((call) => call.excluded)).toBe(false);
  });

  it('returns the ordinary route after the shared provider retains a stale closure copy', async () => {
    let clock = jingle.now;
    const sources = recordedClosureSources(() => clock);
    const { app, replay } = await testApp(() => clock, sources);
    const current = await app.inject({
      method: 'POST',
      url: '/v2/routes',
      payload: jingle.request,
    });
    expect(RouteResponseV2Schema.parse(current.json()).routes).toEqual(jingle.after);
    const excludedBefore = replay.calls.filter((call) => call.excluded).length;
    clock += 301_000;
    sources.bcFetch.mockRejectedValue(new Error('official source offline'));
    await sources.service.getRoadEvents('british-columbia');
    const stale = await app.inject({ method: 'POST', url: '/v2/routes', payload: jingle.request });
    expect(stale.statusCode).toBe(200);
    expect(RouteResponseV2Schema.parse(stale.json()).routes).toEqual(jingle.before);
    expect(replay.calls.filter((call) => call.excluded)).toHaveLength(excludedBefore);
  });

  it('does not use a point whose road name disagrees with the graph', async () => {
    await assertActiveControl();
    const point = closureFixture.boundaries.pointOnly.row;
    const advisory = fixtureValue(
      official.driveBc.rows.find((row) => row.id === 'drivebc.ca/RIDE-100481'),
    );
    const highway = fixtureValue(advisory.roads[0]);
    const original = fixtureValue(point.roads[0]);
    // Deliberately mismatched recorded fields model a publisher point-placement error.
    const mismatch = { ...point, roads: [{ ...original, name: highway.name, from: highway.from }] };
    const sources = recordedClosureSources(() => jingle.now, { cityRows: [], bcRows: [mismatch] });
    const { app, replay } = await testApp(() => jingle.now, sources);
    const response = await app.inject({
      method: 'POST',
      url: '/v2/routes',
      payload: jingle.request,
    });
    expect(response.statusCode).toBe(200);
    expect(RouteResponseV2Schema.parse(response.json()).routes).toEqual(jingle.before);
    expect(replay.calls.some((call) => call.action === 'locate')).toBe(true);
    expect(replay.calls.some((call) => call.excluded)).toBe(false);
  });

  it.each(closureFixture.boundaries.endpoints.cases)(
    'still routes with $name at the published closure',
    async (example) => {
      await assertActiveControl();
      const { app, replay } = await testApp(() => closureFixture.boundaries.endpoints.now);
      const response = await app.inject({
        method: 'POST',
        url: '/v2/routes',
        payload: example.request,
      });
      expect(response.statusCode).toBe(200);
      expect(RouteResponseV2Schema.parse(response.json()).routes).toEqual(example.after);
      expect(replay.calls.some((call) => call.excluded)).toBe(
        example.counters.exclusionsComputed > 0,
      );
    },
  );

  it.each(['http', 'no-route', 'ignored'] as const)(
    'falls back to today after an avoiding provider %s failure',
    async (failure) => {
      const options: { failure?: 'http' | 'no-route' | 'ignored' } = {};
      const replay = recordedClosureProvider(options);
      const { app } = await testApp(() => pointCase.now, undefined, replay);
      const healthy = await app.inject({
        method: 'POST',
        url: '/v2/routes',
        payload: pointCase.request,
      });
      expect(RouteResponseV2Schema.parse(healthy.json()).routes).toEqual(pointCase.after);
      options.failure = failure;
      const failed = await app.inject({
        method: 'POST',
        url: '/v2/routes',
        payload: pointCase.request,
      });
      expect(failed.statusCode).toBe(200);
      expect(RouteResponseV2Schema.parse(failed.json()).routes).toEqual(pointCase.before);
      expect(replay.calls.filter((call) => call.excluded)).toHaveLength(2);
    },
  );

  it('shadow computes the avoiding request but returns the ordinary strict v2 response', async () => {
    const { app, replay } = await testApp(() => pointCase.now, undefined, undefined, 'shadow');
    const response = await app.inject({
      method: 'POST',
      url: '/v2/routes',
      payload: pointCase.request,
    });
    expect(RouteResponseV2Schema.parse(response.json()).routes).toEqual(pointCase.before);
    await vi.waitFor(() => {
      expect(replay.calls.some((call) => call.excluded)).toBe(true);
    });
  });

  it('keeps v1 byte-for-byte frozen even after the same provider avoided a v2 closure', async () => {
    const { app, replay } = await testApp(() => pointCase.now);
    const enriched = await app.inject({
      method: 'POST',
      url: '/v2/routes',
      payload: pointCase.request,
    });
    expect(RouteResponseV2Schema.parse(enriched.json()).routes).toEqual(pointCase.after);
    const compatible = await app.inject({
      method: 'POST',
      url: '/v1/routes',
      payload: pointCase.request,
    });
    const expected = RouteResponseSchema.parse({
      degraded: false,
      generatedAt: new Date(pointCase.now).toISOString(),
      routes: pointCase.legacy,
      source: {
        attribution: 'Routing by Valhalla using OpenStreetMap data',
        id: 'valhalla-self-hosted',
        mode: 'production',
        traffic: 'unavailable',
      },
    });
    expect(compatible.statusCode).toBe(200);
    expect(compatible.body).toBe(JSON.stringify(expected));
    expect(replay.calls.at(-1)?.excluded).toBe(false);
  });

  it('uses the map feed cache for routes without another public feed poller', async () => {
    const sources = recordedClosureSources(() => jingle.now);
    await sources.service.getRoadEvents('british-columbia');
    expect(sources.bcFetch).toHaveBeenCalledOnce();
    const { app } = await testApp(() => jingle.now, sources);
    const response = await app.inject({
      method: 'POST',
      url: '/v2/routes',
      payload: jingle.request,
    });
    expect(RouteResponseV2Schema.parse(response.json()).routes).toEqual(jingle.after);
    expect(sources.bcFetch).toHaveBeenCalledOnce();
    const events = await app.inject({ method: 'GET', url: '/v2/events?region=british-columbia' });
    expect(events.statusCode).toBe(200);
    expect(events.body).not.toContain('routingRows');
  });

  it('rejects a large point-only diversion but accepts the same measured line-backed diversion', async () => {
    const healthy = await testApp(() => jingle.now);
    const line = await healthy.app.inject({
      method: 'POST',
      url: '/v2/routes',
      payload: jingle.request,
    });
    expect(RouteResponseV2Schema.parse(line.json()).routes).toEqual(jingle.after);
    const point = closureFixture.boundaries.pointOnly;
    const sources = recordedClosureSources(() => point.now, { cityRows: [], bcRows: [point.row] });
    const { app, replay } = await testApp(() => point.now, sources);
    const response = await app.inject({
      method: 'POST',
      url: '/v2/routes',
      payload: point.request,
    });
    expect(response.statusCode).toBe(200);
    expect(RouteResponseV2Schema.parse(response.json()).routes).toEqual(point.before);
    expect(replay.calls.some((call) => call.excluded)).toBe(true);
  });
});
