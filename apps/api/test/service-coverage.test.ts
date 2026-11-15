import {
  AppConfigResponseSchema,
  createServiceCoverage,
  LegacyAppConfigResponseSchema,
  ProblemDetailsSchema,
  ReadinessResponseSchema,
  REGISTERED_SERVICE_AREAS,
  type RouteAlternative,
} from '@navoss/contracts';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { createCoverageReadiness } from '../src/coverage-readiness.js';
import { createFixtureSearchProvider } from '../src/search-provider.js';
import { serviceCoverageFromEnvironment } from '../src/service-coverage.js';
import locate from './fixtures/coverage-readiness/valhalla-locate-toronto-sample.json' with { type: 'json' };
import reverse from './fixtures/coverage-readiness/nominatim-reverse-toronto-sample.json' with { type: 'json' };

const FIXED_DATE = new Date('2026-11-15T12:00:00Z');
const CALGARY = { latitude: 51.04427, longitude: -114.06309 };
const VANCOUVER = { latitude: 49.2827, longitude: -123.1207 };
const TORONTO = { latitude: 43.6532, longitude: -79.3832 };
const OTTAWA = { latitude: 45.4236, longitude: -75.7009 };
const MONTREAL = { latitude: 45.5019, longitude: -73.5674 };
const ST_JOHNS = { latitude: 47.5615, longitude: -52.7126 };
const IQALUIT = { latitude: 63.7467, longitude: -68.517 };
const WESTERN_ONTARIO = createServiceCoverage(['alberta', 'british-columbia', 'ontario']);
const CANADA = createServiceCoverage(REGISTERED_SERVICE_AREAS.map(({ id }) => id));

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

// A structurally valid route; these tests check eligibility, not routing.
const routeResult: RouteAlternative[] = [
  {
    distanceMeters: 1000,
    durationSeconds: 60,
    geometry: [
      [-79.3832, 43.6532],
      [-79.3832, 43.6622],
    ],
    id: 'route-0',
    label: 'fastest',
    steps: [
      {
        distanceMeters: 1000,
        durationSeconds: 60,
        geometry: [
          [-79.3832, 43.6532],
          [-79.3832, 43.6622],
        ],
        instruction: 'Drive north.',
        maneuverType: 'depart',
        roadName: 'Bay Street',
      },
    ],
  },
];
function routeProvider() {
  const route = vi.fn(() => Promise.resolve(routeResult));
  return { getEnrichedRoutes: route, getRoutes: route, route };
}

async function createApp(options: Parameters<typeof buildApp>[0] = {}) {
  const app = await buildApp({
    clock: () => FIXED_DATE,
    coverageReadiness: null,
    searchProvider: createFixtureSearchProvider([]),
    ...options,
  });
  apps.push(app);
  return app;
}

describe('NAVOSS_SERVICE_AREAS', () => {
  it('declares the deployed Alberta+BC coverage when unset', () => {
    expect(serviceCoverageFromEnvironment({}).id).toBe('alberta-british-columbia');
    expect(
      serviceCoverageFromEnvironment({
        NOMINATIM_DATASET_VERSION: 'alberta-british-columbia-geofabrik-2026-07-30',
        NOMINATIM_URL: 'http://nominatim:8080/',
      }).displayName,
    ).toBe('Alberta and British Columbia');
  });

  it.each([
    [{ NAVOSS_SERVICE_AREAS: '' }, /not in the province registry/],
    [{ NAVOSS_SERVICE_AREAS: 'alberta,saskatchewan,mars' }, /mars is not in the province registry/],
    [{ NAVOSS_SERVICE_AREAS: 'ontario,ontario' }, /declared twice/],
    [{ NOMINATIM_URL: 'http://nominatim:8080/' }, /NOMINATIM_DATASET_VERSION must be/],
    [
      {
        NAVOSS_SERVICE_AREAS: 'alberta,british-columbia,ontario',
        NOMINATIM_DATASET_VERSION: 'alberta-british-columbia-geofabrik-2026-07-30',
        NOMINATIM_URL: 'http://nominatim:8080/',
      },
      /does not include ontario/,
    ],
    [
      {
        NAVOSS_SERVICE_AREAS: 'british-columbia',
        NOMINATIM_DATASET_VERSION: 'alberta-geofabrik-2026-07-30',
        NOMINATIM_URL: 'http://nominatim:8080/',
      },
      /does not include british-columbia/,
    ],
  ])('refuses to start with %j', (environment, message) => {
    expect(() => serviceCoverageFromEnvironment(environment)).toThrow(message);
  });

  it('accepts a search index imported with every declared province', () => {
    expect(
      serviceCoverageFromEnvironment({
        NAVOSS_SERVICE_AREAS: 'ontario,alberta,british-columbia',
        NOMINATIM_DATASET_VERSION: 'alberta-british-columbia-ontario-geofabrik-2026-11-14',
        NOMINATIM_URL: 'http://nominatim:8080/',
      }).id,
    ).toBe('alberta-british-columbia-ontario');
    // Fewer provinces than the index holds is safe: results outside them are dropped.
    expect(
      serviceCoverageFromEnvironment({
        NOMINATIM_DATASET_VERSION: 'canada-geofabrik-2026-11-14',
        NOMINATIM_URL: 'http://nominatim:8080/',
      }).id,
    ).toBe('alberta-british-columbia');
    expect(
      serviceCoverageFromEnvironment({
        NAVOSS_SERVICE_AREAS: REGISTERED_SERVICE_AREAS.map(({ id }) => id).join(','),
        NOMINATIM_DATASET_VERSION: 'canada-geofabrik-2026-11-14',
        NOMINATIM_URL: 'http://nominatim:8080/',
      }).displayName,
    ).toBe('Canada');
  });
});

describe('declared coverage in the configuration', () => {
  it('keeps /v2/config at Alberta+BC unless more is declared, and /v1/config strictly v1', async () => {
    const western = await createApp();
    const withOntario = await createApp({ coverage: WESTERN_ONTARIO });
    const canada = await createApp({ coverage: CANADA });

    const v2 = AppConfigResponseSchema.parse(
      (await western.inject({ method: 'GET', url: '/v2/config' })).json(),
    );
    expect(v2.coverage.id).toBe('alberta-british-columbia');
    expect(v2.coverage.serviceAreas.map(({ id }) => id)).toEqual(['alberta', 'british-columbia']);
    expect(v2.coverage.overlays.map(({ id }) => id)).toEqual(['calgary-ab', 'kelowna-bc']);

    const v2Ontario = AppConfigResponseSchema.parse(
      (await withOntario.inject({ method: 'GET', url: '/v2/config' })).json(),
    );
    expect(v2Ontario.coverage.displayName).toBe('Alberta, British Columbia and Ontario');
    expect(v2Ontario.coverage.serviceAreas.map(({ id }) => id)).toEqual([
      'alberta',
      'british-columbia',
      'ontario',
    ]);
    // The first two areas are byte-for-byte what the Alberta+BC server sends.
    expect(v2Ontario.coverage.serviceAreas.slice(0, 2)).toEqual(v2.coverage.serviceAreas);

    const v2Canada = AppConfigResponseSchema.parse(
      (await canada.inject({ method: 'GET', url: '/v2/config' })).json(),
    );
    expect(v2Canada.coverage).toMatchObject({ displayName: 'Canada', id: 'canada' });
    expect(v2Canada.coverage.serviceAreas).toHaveLength(13);

    const legacy = await Promise.all(
      [western, withOntario, canada].map(
        async (app) => (await app.inject({ method: 'GET', url: '/v1/config' })).json() as unknown,
      ),
    );
    for (const payload of legacy) {
      const parsed = LegacyAppConfigResponseSchema.parse(payload);
      expect(parsed.coverage).toMatchObject({ displayName: 'Calgary, Alberta', id: 'calgary-ab' });
      expect(parsed.endpoints.routes).toBe('/v1/routes');
      expect(payload).toEqual(legacy[0]);
    }
  });

  it('only searches and routes in Ontario when Ontario is declared', async () => {
    const western = await createApp({ routeProvider: routeProvider() });
    const ontarioProvider = routeProvider();
    const withOntario = await createApp({
      coverage: WESTERN_ONTARIO,
      routeProvider: ontarioProvider,
    });
    const trip = { destination: OTTAWA, origin: TORONTO };

    const refused = await western.inject({ method: 'POST', payload: trip, url: '/v2/routes' });
    expect(refused.statusCode).toBe(400);
    expect(ProblemDetailsSchema.parse(refused.json()).detail).toBe(
      'Driving route origins, waypoints and destinations must be within Alberta and British Columbia.',
    );
    const nearby = { category: 'cafe', q: 'cafe', ...TORONTO };
    expect(
      (await western.inject({ method: 'POST', payload: nearby, url: '/v1/search' })).statusCode,
    ).toBe(400);

    for (const version of ['v1', 'v2']) {
      const response = await withOntario.inject({
        method: 'POST',
        payload: trip,
        url: `/${version}/routes`,
      });
      expect(response.statusCode, version).toBe(200);
    }
    expect(ontarioProvider.route).toHaveBeenCalledTimes(2);
    expect(
      (await withOntario.inject({ method: 'POST', payload: nearby, url: '/v1/search' })).statusCode,
    ).toBe(200);
    const montreal = await withOntario.inject({
      method: 'POST',
      payload: { destination: MONTREAL, origin: TORONTO },
      url: '/v2/routes',
    });
    expect(ProblemDetailsSchema.parse(montreal.json()).title).toBe('Route outside coverage');
  });

  it('says no road connects provinces the declared coverage cannot join', async () => {
    const provider = routeProvider();
    const app = await createApp({ coverage: WESTERN_ONTARIO, routeProvider: provider });
    for (const payload of [
      { destination: TORONTO, origin: VANCOUVER },
      { destination: CALGARY, origin: TORONTO },
      { destination: VANCOUVER, origin: CALGARY, waypoints: [TORONTO] },
    ]) {
      const response = await app.inject({ method: 'POST', payload, url: '/v2/routes' });
      expect(response.statusCode).toBe(400);
      const problem = ProblemDetailsSchema.parse(response.json());
      expect(problem.title).toBe('No route between these provinces');
      expect(problem.detail).toMatch(
        /^NavOSS can't plan a drive between (British Columbia and Ontario|Ontario and Alberta|Alberta and Ontario): no road it covers connects them\.$/u,
      );
    }
    expect(provider.route).not.toHaveBeenCalled();

    const canadaProvider = routeProvider();
    const canada = await createApp({ coverage: CANADA, routeProvider: canadaProvider });
    const crossCountry = await canada.inject({
      method: 'POST',
      payload: { destination: ST_JOHNS, origin: VANCOUVER },
      url: '/v2/routes',
    });
    expect(crossCountry.statusCode).toBe(200);
    const nunavut = await canada.inject({
      method: 'POST',
      payload: { destination: IQALUIT, origin: MONTREAL },
      url: '/v2/routes',
    });
    expect(ProblemDetailsSchema.parse(nunavut.json()).detail).toBe(
      "NavOSS can't plan a drive between Quebec and Nunavut: no road it covers connects them.",
    );
    expect(canadaProvider.route).toHaveBeenCalledTimes(1);
  });
});

describe('per-province readiness', () => {
  function recordedFetch(options: { iso?: string; locateStatus?: number } = {}) {
    return vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/locate')) {
        const body = JSON.parse(String(init?.body)) as { locations: { lat: number }[] };
        const answer =
          body.locations[0]?.lat === 43.6525 ? locate.torontoCityHall : locate.calgaryOutsideGraph;
        return Promise.resolve(
          new Response(JSON.stringify([answer]), { status: options.locateStatus ?? 200 }),
        );
      }
      const lat = new URL(url).searchParams.get('lat');
      const answer = structuredClone(
        lat === '43.6525' ? reverse.torontoCityHall : reverse.calgaryOutsideIndex,
      );
      if (options.iso !== undefined) {
        (answer.address as Record<string, string>)['ISO3166-2-lvl4'] = options.iso;
      }
      return Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }));
    });
  }
  const endpoints = {
    locateUrl: 'http://valhalla:8002/locate',
    nominatimUrl: 'http://nominatim:8080/',
  };

  it('names the declared provinces whose recorded data does not answer', async () => {
    const fetchImplementation = recordedFetch();
    const readiness = createCoverageReadiness(WESTERN_ONTARIO, {
      ...endpoints,
      fetchImplementation: fetchImplementation as typeof fetch,
    });
    // The recorded graph and index are a Toronto sample: Ontario answers, Alberta and BC do not.
    expect(await readiness.missingAreas()).toEqual(['Alberta', 'British Columbia']);
    expect(
      await createCoverageReadiness(createServiceCoverage(['ontario']), {
        ...endpoints,
        fetchImplementation: fetchImplementation as typeof fetch,
      }).missingAreas(),
    ).toEqual([]);
  });

  it.each([
    ['the search index places the probe in another province', { iso: 'CA-QC' }],
    ['the graph does not answer', { locateStatus: 503 }],
  ])('treats Ontario as missing when %s', async (_, options) => {
    const readiness = createCoverageReadiness(createServiceCoverage(['ontario']), {
      ...endpoints,
      fetchImplementation: recordedFetch(options) as typeof fetch,
    });
    expect(await readiness.missingAreas()).toEqual(['Ontario']);
  });

  it('fails /ready when a declared province has no data, without leaking anything else', async () => {
    const app = await createApp({
      coverage: WESTERN_ONTARIO,
      coverageReadiness: { missingAreas: () => Promise.resolve(['Ontario']) },
    });
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    expect(ReadinessResponseSchema.parse(response.json()).checks.coverage).toEqual({
      detail: 'Routing or search data do not answer for Ontario.',
      status: 'not_ready',
    });
    const ready = await createApp({
      coverage: WESTERN_ONTARIO,
      coverageReadiness: { missingAreas: () => Promise.resolve([]) },
    });
    const readyResponse = await ready.inject({ method: 'GET', url: '/ready' });
    expect(readyResponse.statusCode).toBe(200);
    expect(ReadinessResponseSchema.parse(readyResponse.json()).checks.coverage?.detail).toBe(
      'Routing and search data answer for Alberta, British Columbia and Ontario.',
    );
  });
});
