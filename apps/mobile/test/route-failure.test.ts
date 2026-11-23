import { describe, expect, it, vi } from 'vitest';

vi.mock('../modules/navoss-navigation/index.js', () => ({ default: {} }));

import { fetchRoutes } from '../src/lib/api.js';
import {
  RouteOriginUnavailableError,
  routeErrorFrom,
} from '../src/features/navigation/route-ui-state.js';
import disconnectedProvinces from './fixtures/routes-v2/disconnected-provinces-400.json' with { type: 'json' };
import noRoadRoute from './fixtures/routes-v2/no-road-route-422.json' with { type: 'json' };

const PREFERENCES = {
  avoidFerries: false,
  avoidHighways: false,
  avoidTolls: false,
  avoidUnpaved: false,
};

/** What the route planner records for a failed request answered with `status` and `body`. */
async function plannedError(status: number, body: string, contentType = 'application/json') {
  try {
    await fetchRoutes(
      { ...disconnectedProvinces.request, preferences: PREFERENCES },
      {
        baseUrl: 'https://api.example.test',
        fetchImplementation: async () =>
          new Response(body, { headers: { 'content-type': contentType }, status }),
        routesV2: true,
      },
    );
  } catch (error: unknown) {
    return routeErrorFrom(error);
  }
  throw new Error('expected the route request to fail');
}

describe('route failures the phone presents', () => {
  it("shows the server's title and detail for a route with no road (recorded 422)", async () => {
    expect(await plannedError(noRoadRoute.status, noRoadRoute.body)).toEqual({
      message:
        'No road connects these places. Some are reached only by air, by water or by a winter road.',
      refusalTitle: 'No road route',
    });
  });

  it("shows the server's title and detail for provinces no road joins (recorded 400)", async () => {
    expect(await plannedError(disconnectedProvinces.status, disconnectedProvinces.body)).toEqual({
      message:
        "NavOSS can't plan a drive between Quebec and Nunavut: no road it covers connects them.",
      refusalTitle: 'No route between these provinces',
    });
  });

  it('keeps an outage retryable', async () => {
    const outage = JSON.stringify({
      code: 'service_unavailable',
      detail: 'Routing is temporarily unavailable. Try again shortly.',
      requestId: 'req-1',
      status: 503,
      title: 'Routing unavailable',
    });
    expect(await plannedError(503, outage)).toEqual({
      message: 'Routing is temporarily unavailable. Try again shortly.',
    });
    expect(await plannedError(502, '<html>Bad gateway</html>', 'text/html')).toEqual({
      message: 'NavOSS API request failed with 502.',
    });
    expect(routeErrorFrom(new TypeError('Network request failed'))).toEqual({
      message: 'A route could not be calculated. Check the connection and try again.',
    });
  });

  it('never presents the contract rejection as a reason', async () => {
    const rejection = JSON.stringify({
      code: 'invalid_request',
      detail: 'The request does not match the API contract.',
      requestId: 'req-1',
      status: 400,
      title: 'Invalid request',
    });
    expect((await plannedError(400, rejection)).refusalTitle).toBeUndefined();
  });

  it('marks a route that failed for want of a location, so the sheet can offer another start', () => {
    expect(
      routeErrorFrom(
        new RouteOriginUnavailableError(
          'This device has not found your location, so NavOSS cannot route from where you are.',
        ),
      ),
    ).toEqual({
      message:
        'This device has not found your location, so NavOSS cannot route from where you are.',
      originUnavailable: true,
    });
    expect(routeErrorFrom(new TypeError('Network request failed')).originUnavailable).toBe(
      undefined,
    );
  });
});
