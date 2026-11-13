import { SafetyCameraResponseSchema, SearchResponseSchema } from '@navoss/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startRoadEventRefresh } from '../src/features/map/road-event-refresh.js';
import { routeTrafficLabel } from '../src/features/navigation/route-progress.js';
import {
  fetchOfficialRoadEvents,
  fetchOfficialSafetyCameras,
  fetchRoadEvents,
  fetchRoutes,
  fetchSafetyCameras,
  fetchSafetyFacilities,
  fetchTrafficCameras,
  NavOssApiError,
} from '../src/lib/api.js';
import productionCameras from './fixtures/server-config/production-2026-11.cameras.json' with { type: 'json' };
import productionRoutes from './fixtures/server-config/production-2026-11.routes-calgary.v1.json' with { type: 'json' };
import productionCafe from './fixtures/server-config/production-2026-11.search-cafe.json' with { type: 'json' };
import productionTower from './fixtures/server-config/production-2026-11.search-calgary-tower.json' with { type: 'json' };

/*
 * What the phone does against each server generation for every endpoint it may call. The
 * deployed production API predates `/v2/routes`, community reports, community traffic and the
 * offline manifest; it answers those with a problem+json 404.
 */

const BASE_URL = 'https://api.example.test';
const ROUTE_REQUEST = {
  alternatives: 2,
  destination: { latitude: 51.04427, longitude: -114.06309 },
  origin: { latitude: 51.01428, longitude: -114.005743 },
  preferences: {
    avoidFerries: false,
    avoidHighways: false,
    avoidTolls: false,
    avoidUnpaved: false,
  },
};

function notFound(): Response {
  return new Response(
    JSON.stringify({
      code: 'not_found',
      detail: 'The requested resource does not exist.',
      requestId: 'req-1',
      status: 404,
      title: 'Not found',
    }),
    { headers: { 'content-type': 'application/problem+json' }, status: 404 },
  );
}

describe('recorded production responses', () => {
  it('parse with the current search and camera contracts', () => {
    expect(SearchResponseSchema.parse(productionTower.response).results[0]?.name).toBe(
      'Calgary Tower',
    );
    expect(SearchResponseSchema.parse(productionCafe.response).results.length).toBeGreaterThan(0);
    expect(SafetyCameraResponseSchema.parse(productionCameras.response).cameras.length).toBe(57);
  });

  it('route with one request to /v1/routes when the config declares it, and say no live traffic', async () => {
    const urls: string[] = [];
    const response = await fetchRoutes(ROUTE_REQUEST, {
      baseUrl: BASE_URL,
      fetchImplementation: async (input) => {
        urls.push(String(input));
        return new Response(JSON.stringify(productionRoutes.response));
      },
      routesV2: false,
    });
    expect(urls).toEqual([`${BASE_URL}/v1/routes`]);
    expect(response.routes).toHaveLength(3);
    // Lanes are simply absent on the old server.
    expect(response.routes.flatMap((route) => route.steps).some((step) => step.lanes)).toBe(false);
    expect(routeTrafficLabel(response.source, response.routes[0])).toBe('No live traffic');
  });

  it('fall back to /v1/routes once, on 404, when the server has not said', async () => {
    const urls: string[] = [];
    await fetchRoutes(ROUTE_REQUEST, {
      baseUrl: BASE_URL,
      fetchImplementation: async (input) => {
        urls.push(String(input));
        return String(input).endsWith('/v2/routes')
          ? notFound()
          : new Response(JSON.stringify(productionRoutes.response));
      },
    });
    expect(urls).toEqual([`${BASE_URL}/v2/routes`, `${BASE_URL}/v1/routes`]);
  });
});

describe('an overlay endpoint the server lacks', () => {
  it.each([
    ['/v1/cameras', () => fetchSafetyCameras],
    ['/v1/events', () => fetchRoadEvents],
  ] as const)('%s rejects with status 404, even behind an HTML error page', async (path, load) => {
    for (const response of [notFound(), new Response('<html>404</html>', { status: 404 })]) {
      const urls: string[] = [];
      const error = await load()({
        baseUrl: BASE_URL,
        fetchImplementation: async (input) => {
          urls.push(String(input));
          return response;
        },
      }).catch((caught: unknown) => caught);
      expect(urls).toEqual([`${BASE_URL}${path}`]);
      expect(error).toBeInstanceOf(NavOssApiError);
      expect((error as NavOssApiError).status).toBe(404);
    }
  });

  it.each([
    [
      '/v2/events?region=kelowna-bc',
      (fetchImplementation: typeof fetch) =>
        fetchOfficialRoadEvents({ baseUrl: BASE_URL, fetchImplementation, region: 'kelowna-bc' }),
    ],
    [
      '/v2/cameras?region=toronto-on',
      (fetchImplementation: typeof fetch) =>
        fetchOfficialSafetyCameras({
          baseUrl: BASE_URL,
          fetchImplementation,
          region: 'toronto-on',
        }),
    ],
    [
      '/v2/traffic-cameras?region=kelowna-bc',
      (fetchImplementation: typeof fetch) =>
        fetchTrafficCameras({ baseUrl: BASE_URL, fetchImplementation, region: 'kelowna-bc' }),
    ],
    [
      '/v2/safety-facilities?region=kelowna-bc',
      (fetchImplementation: typeof fetch) =>
        fetchSafetyFacilities({ baseUrl: BASE_URL, fetchImplementation, region: 'kelowna-bc' }),
    ],
  ] as const)('%s is asked once and rejects with status 404', async (path, load) => {
    const urls: string[] = [];
    const error: unknown = await load(async (input) => {
      urls.push(String(input));
      return notFound();
    }).catch((caught: unknown) => caught);
    expect(urls).toEqual([`${BASE_URL}${path}`]);
    expect(error).toBeInstanceOf(NavOssApiError);
    expect((error as NavOssApiError).status).toBe(404);
  });
});

describe('road-event refresh', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops for good on 404 without flagging a delay or retrying', async () => {
    vi.useFakeTimers();
    const load = vi.fn(() => Promise.reject(new NavOssApiError('Not found', 404)));
    const delayed: boolean[] = [];
    const stop = startRoadEventRefresh({
      load,
      onDelayedChange: (value) => delayed.push(value),
    });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(delayed).toEqual([false]);
    stop();
  });

  it('flags an outage and retries only on the five-minute refresh', async () => {
    vi.useFakeTimers();
    const load = vi.fn(() => Promise.reject(new NavOssApiError('Unavailable', 503)));
    const delayed: boolean[] = [];
    const stop = startRoadEventRefresh({
      load,
      onDelayedChange: (value) => delayed.push(value),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(delayed).toEqual([true]);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1_000);
    expect(load).toHaveBeenCalledTimes(4);
    stop();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);
    expect(load).toHaveBeenCalledTimes(4);
  });
});
