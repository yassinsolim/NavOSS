import {
  AppConfigResponseSchema,
  HealthResponseSchema,
  ProblemDetailsSchema,
  ReadinessResponseSchema,
  RouteResponseSchema,
  SearchResponseSchema,
  type RouteAlternative,
} from '@navoss/contracts';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { CALGARY_SEARCH_FIXTURES } from '../src/fixtures.js';
import { createFixtureSearchProvider } from '../src/search-provider.js';

const FIXED_DATE = new Date('2026-07-15T12:00:00Z');
const apps: FastifyInstance[] = [];

async function createTestApp(
  options: Parameters<typeof buildApp>[0] = {},
): Promise<FastifyInstance> {
  const app = await buildApp({
    clock: () => FIXED_DATE,
    searchProvider: createFixtureSearchProvider(CALGARY_SEARCH_FIXTURES),
    ...options,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('system routes', () => {
  it('reports liveness with a contract-valid timestamp', async () => {
    const app = await createTestApp();
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(HealthResponseSchema.parse(response.json())).toEqual({
      service: 'navoss-api',
      status: 'ok',
      timestamp: '2026-07-15T12:00:00.000Z',
      version: '0.0.0',
    });
  });

  it('fails readiness when no search dataset is loaded', async () => {
    const app = await createTestApp({ searchFixtures: [] });
    const response = await app.inject({ method: 'GET', url: '/ready' });
    const body = ReadinessResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(503);
    expect(body.status).toBe('not_ready');
  });
});

describe('client configuration', () => {
  it('returns Calgary technical-alpha capabilities', async () => {
    const app = await createTestApp();
    const response = await app.inject({ method: 'GET', url: '/v1/config' });
    const body = AppConfigResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(200);
    expect(body.coverage.id).toBe('calgary-ab');
    expect(body.features).toEqual({
      communityReports: false,
      liveTraffic: false,
      productionSearch: false,
    });
  });
});

describe('search', () => {
  it('returns deterministic fixture results and provenance', async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/search?q=tower&latitude=51.0447&longitude=-114.0719',
    });
    const body = SearchResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(200);
    expect(body.results[0]?.id).toBe('landmark:calgary-tower');
    expect(body.source).toEqual({
      datasetVersion: 'fixture-v1',
      freshness: 'static',
      id: 'calgary-alpha-fixtures',
      updatedAt: '2026-07-15T12:00:00Z',
    });
    expect(body.degraded).toBe(true);
  });

  it('returns a stable problem document for invalid input', async () => {
    const app = await createTestApp();
    const response = await app.inject({ method: 'GET', url: '/v1/search?q=x' });
    const body = ProblemDetailsSchema.parse(response.json());

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(body).toMatchObject({
      code: 'invalid_request',
      detail: 'The request does not match the API contract.',
      status: 400,
      title: 'Invalid request',
    });
  });
});

describe('routes', () => {
  const route: RouteAlternative = {
    distanceMeters: 19_660.564,
    durationSeconds: 1_215.354,
    geometry: [
      [-114.071903, 51.044666],
      [-114.01055, 51.13157],
    ],
    id: 'route-1',
    label: 'fastest',
    steps: [
      {
        distanceMeters: 57.692,
        durationSeconds: 18.881,
        geometry: [
          [-114.071903, 51.044666],
          [-114.072726, 51.044691],
        ],
        instruction: 'Drive west.',
        maneuverType: 'depart',
        roadName: '',
        spokenInstruction: 'Drive west. Then turn right.',
      },
    ],
  };

  it('returns normalized route alternatives from the injected provider', async () => {
    const app = await createTestApp({
      routeProvider: { getRoutes: () => Promise.resolve([route]) },
    });
    const response = await app.inject({
      method: 'POST',
      payload: {
        destination: { latitude: 51.13157, longitude: -114.01055 },
        origin: { latitude: 51.0447, longitude: -114.0719 },
      },
      url: '/v1/routes',
    });
    const body = RouteResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(200);
    expect(body.routes[0]).toEqual(route);
    expect(body.source.id).toBe('valhalla-development');
  });

  it('returns a stable problem when the route provider is unavailable', async () => {
    const { RouteProviderError } = await import('../src/route-provider.js');
    const app = await createTestApp({
      routeProvider: {
        getRoutes: () => Promise.reject(new RouteProviderError('offline')),
      },
    });
    const response = await app.inject({
      method: 'POST',
      payload: {
        destination: { latitude: 51.13157, longitude: -114.01055 },
        origin: { latitude: 51.0447, longitude: -114.0719 },
      },
      url: '/v1/routes',
    });
    const body = ProblemDetailsSchema.parse(response.json());

    expect(response.statusCode).toBe(503);
    expect(body).toMatchObject({
      code: 'service_unavailable',
      status: 503,
      title: 'Routing unavailable',
    });
  });
});

describe('OpenAPI', () => {
  it('publishes the typed routes without documenting itself', async () => {
    const app = await createTestApp();
    const response = await app.inject({ method: 'GET', url: '/openapi.json' });
    const document = response.json<{ openapi: string; paths: Record<string, unknown> }>();

    expect(response.statusCode).toBe(200);
    expect(document.openapi).toBe('3.1.0');
    expect(document.paths).toHaveProperty('/health');
    expect(document.paths).toHaveProperty('/ready');
    expect(document.paths).toHaveProperty('/v1/config');
    expect(document.paths).toHaveProperty('/v1/routes');
    expect(document.paths).toHaveProperty('/v1/search');
    expect(document.paths).not.toHaveProperty('/openapi.json');
  });
});
