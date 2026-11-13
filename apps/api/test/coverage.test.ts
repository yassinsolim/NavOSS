import { ProblemDetailsSchema, SearchResponseSchema, type SearchQuery } from '@navoss/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import borderPoints from '../../../packages/contracts/test/fixtures/coverage-border-points.json' with { type: 'json' };
import { buildApp } from '../src/app.js';
import { RouteProviderError } from '../src/route-provider.js';
import {
  createFixtureSearchProvider,
  isCalgarySearchCoordinate,
  isSupportedSearchCoordinate,
} from '../src/search-provider.js';

const origin = { latitude: 51.04427, longitude: -114.06309 };
const destination = { latitude: 51.13157, longitude: -114.01055 };
const search = vi.fn((query: SearchQuery) => createFixtureSearchProvider([]).search(query));
const route = vi.fn(() =>
  Promise.reject(
    new RouteProviderError('Coverage accepted; provider unavailable in this eligibility test.'),
  ),
);
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({
    searchProvider: { search },
    routeProvider: { getRoutes: route, getEnrichedRoutes: route },
  });
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  search.mockClear();
  route.mockClear();
});

describe('AB and BC search/route eligibility', () => {
  it.each(borderPoints.cases)(
    '$id uses polygon eligibility for nearby search and both route versions',
    async ({ coordinate, serviceAreaId }) => {
      const supported = serviceAreaId !== null;
      expect(isSupportedSearchCoordinate(coordinate)).toBe(supported);
      const result = await app.inject({
        method: 'POST',
        url: '/v1/search',
        payload: { category: 'restaurant', q: 'restaurant', ...coordinate },
      });
      expect(result.statusCode).toBe(supported ? 200 : 400);
      if (supported) expect(SearchResponseSchema.parse(result.json()).results).toEqual([]);
      else expect(ProblemDetailsSchema.parse(result.json()).title).toBe('Search outside coverage');
      expect(search).toHaveBeenCalledTimes(supported ? 1 : 0);
      for (const version of ['v1', 'v2']) {
        const response = await app.inject({
          method: 'POST',
          url: `/${version}/routes`,
          payload: { origin: coordinate, destination },
        });
        // Accepted points reach the unavailable injected provider; rejected points never reach it.
        expect(response.statusCode).toBe(supported ? 503 : 400);
        expect(ProblemDetailsSchema.parse(response.json()).title).toBe(
          supported ? 'Routing unavailable' : 'Route outside coverage',
        );
      }
      expect(route).toHaveBeenCalledTimes(supported ? 2 : 0);
    },
  );

  it.each(borderPoints.cases.filter(({ serviceAreaId }) => serviceAreaId === null))(
    '$id rejects every route coordinate position, not just the destination',
    async ({ coordinate }) => {
      for (const version of ['v1', 'v2']) {
        for (const payload of [
          { origin: coordinate, destination },
          { origin, destination: coordinate },
          { origin, destination, waypoints: [coordinate] },
        ]) {
          const response = await app.inject({ method: 'POST', url: `/${version}/routes`, payload });
          expect(response.statusCode).toBe(400);
          expect(ProblemDetailsSchema.parse(response.json()).detail).toBe(
            'Driving route origins, waypoints and destinations must be within Alberta and British Columbia.',
          );
        }
      }
      expect(route).not.toHaveBeenCalled();
    },
  );

  it('keeps Calgary civic enrichment scoped to Calgary, not the new Alberta region', () => {
    expect(isCalgarySearchCoordinate(origin)).toBe(true);
    expect(isCalgarySearchCoordinate({ latitude: 53.5461, longitude: -113.4938 })).toBe(false);
    expect(isCalgarySearchCoordinate({ latitude: 49.8879, longitude: -119.496 })).toBe(false);
  });
});
