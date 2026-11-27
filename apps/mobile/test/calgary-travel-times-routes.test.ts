import { describe, expect, it, vi } from 'vitest';

vi.mock('../modules/navoss-navigation/index.js', () => ({ default: {} }));

import { fetchRoutes, NavOssApiError } from '../src/lib/api.js';
import {
  routeChoiceAccessibilityLabel,
  routeTrafficLabel,
} from '../src/features/navigation/route-progress.js';
import {
  routeFromNativeTrip,
  routeSourceForNativeTrip,
} from '../src/features/navigation/route-ui-state.js';
import { recordedRoutes } from './route-fixtures.js';

const REQUEST = {
  alternatives: 1,
  destination: { latitude: 51.0447, longitude: -114.0719 },
  origin: { latitude: 51.1, longitude: -114.2 },
  originHeadingDegrees: 90,
  originHorizontalAccuracyMeters: 10,
  preferences: {
    avoidFerries: false,
    avoidHighways: false,
    avoidTolls: false,
    avoidUnpaved: false,
  },
};

const CONTRACT_REJECTION = JSON.stringify({
  code: 'invalid_request',
  detail: 'The request does not match the API contract.',
  requestId: 'req-1',
  status: 400,
  title: 'Invalid request',
});

const geometry = [
  [-114.06309, 51.04427],
  [-114.062, 51.045],
  [-114.061, 51.046],
];
const plainRoute = {
  distanceMeters: 300,
  durationSeconds: 60,
  geometry,
  id: 'local',
  label: 'fastest',
  steps: [
    {
      distanceMeters: 300,
      durationSeconds: 60,
      geometry,
      instruction: 'Continue.',
      maneuverType: 'continue',
      roadName: '17 Avenue SW',
    },
  ],
};
// The shape `packages/contracts/test/route-calgary-travel-times.test.ts` gives City traffic.
const delayedRoute = {
  ...plainRoute,
  congestion: ['heavy', 'unknown'],
  durationSeconds: 240,
  id: 'crowchild',
  label: 'alternative',
  steps: plainRoute.steps.map((step) => ({
    ...step,
    durationSeconds: 240,
    roadName: 'Crowchild Trail NW',
  })),
  traffic: {
    delaySeconds: 180,
    observedFraction: 0.5,
    oldestObservedAt: '2026-11-27T15:43:43.000Z',
    snapshotAt: '2026-11-27T15:43:43.000Z',
    typicalDurationSeconds: 60,
  },
};
function sourcedResponse(trafficSource: { attribution: string; id: string }) {
  return {
    degraded: false,
    generatedAt: '2026-11-27T16:00:00Z',
    routes: [delayedRoute, plainRoute],
    source: {
      attribution: 'Routing by Valhalla using OpenStreetMap data',
      id: 'valhalla-self-hosted',
      mode: 'production',
      traffic: 'live',
      trafficSource,
    },
  };
}
const CITY = {
  attribution: 'Traffic on main roads from The City of Calgary',
  id: 'calgary-travel-times',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

interface Sent {
  body: Record<string, unknown>;
  url: string;
}

function recording(answer: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const fetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => {
    const request = {
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      url: String(input),
    };
    sent.push(request);
    return Promise.resolve(answer(request));
  };
  return { fetchImplementation, sent };
}

describe('fetchRoutes and City of Calgary traffic', () => {
  it('declares the City source on /v2/routes and presents its traffic with the City’s words', async () => {
    const { fetchImplementation, sent } = recording(() => jsonResponse(sourcedResponse(CITY)));
    const response = await fetchRoutes(REQUEST, {
      baseUrl: 'https://api.example.test',
      fetchImplementation,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({
      originHeadingDegrees: 90,
      trafficSources: ['calgary-travel-times'],
    });
    expect(response.source.trafficSource).toEqual(CITY);
    const [delayed, plain] = response.routes;
    if (delayed === undefined || plain === undefined) throw new Error('two routes');
    expect(delayed.congestion).toEqual(['heavy', 'unknown']);
    expect(routeTrafficLabel(response.source, delayed)).toMatch(
      /^Traffic on main roads from The City of Calgary · updated \d/,
    );
    expect(routeTrafficLabel(response.source, plain)).toBe(
      'No City of Calgary traffic data on this route',
    );
    expect(routeTrafficLabel(response.source, delayed)).not.toMatch(/live/i);
    const spoken = routeChoiceAccessibilityLabel(delayed, response.source.trafficSource);
    expect(spoken).toContain('+3 min traffic');
    expect(spoken).toContain('City of Calgary main-road traffic updated ');
    expect(routeChoiceAccessibilityLabel(plain, response.source.trafficSource)).not.toContain(
      'traffic',
    );
  });

  it('credits the City on a long route whose measured share rounds to zero', async () => {
    // The server rounds observedFraction to hundredths: 100 m measured on a 40 km route is 0.
    const response = await fetchRoutes(REQUEST, {
      baseUrl: 'https://api.example.test',
      fetchImplementation: () => {
        const rounded = {
          ...delayedRoute,
          traffic: { ...delayedRoute.traffic, observedFraction: 0 },
        };
        return Promise.resolve(
          jsonResponse({ ...sourcedResponse(CITY), routes: [rounded, plainRoute] }),
        );
      },
    });
    expect(routeTrafficLabel(response.source, response.routes[0])).toMatch(
      /^Traffic on main roads from The City of Calgary · updated /,
    );
  });

  it('treats a route the City measured none of as without City traffic', async () => {
    const response = await fetchRoutes(REQUEST, {
      baseUrl: 'https://api.example.test',
      fetchImplementation: () => {
        const unmeasured = {
          ...delayedRoute,
          congestion: ['unknown', 'unknown'],
          durationSeconds: 60,
          steps: plainRoute.steps,
          traffic: { ...delayedRoute.traffic, delaySeconds: 0, observedFraction: 0 },
        };
        const body = { ...sourcedResponse(CITY), routes: [unmeasured, plainRoute] };
        return Promise.resolve(jsonResponse(body));
      },
    });
    expect(routeTrafficLabel(response.source, response.routes[0])).toBe(
      'No City of Calgary traffic data on this route',
    );
  });

  it('keeps community traffic as it was', async () => {
    const response = await fetchRoutes(REQUEST, {
      baseUrl: 'https://api.example.test',
      fetchImplementation: () =>
        Promise.resolve(jsonResponse(recordedRoutes('community-protected-order.v2'))),
    });
    const [observed, unobserved] = response.routes;
    expect(routeTrafficLabel(response.source, observed)).toMatch(
      /^Traffic from opted-in NavOSS drivers · updated /,
    );
    expect(routeTrafficLabel(response.source, unobserved)).toBe('No live traffic on this route');
    if (observed === undefined) throw new Error('route');
    expect(routeChoiceAccessibilityLabel(observed, response.source.trafficSource)).toContain(
      ', traffic updated ',
    );
  });

  it('reads traffic from a source it does not know as no traffic, not as community', async () => {
    const response = await fetchRoutes(REQUEST, {
      baseUrl: 'https://api.example.test',
      fetchImplementation: () =>
        Promise.resolve(
          jsonResponse(
            sourcedResponse({ attribution: 'Traffic from someone else', id: 'someone-else' }),
          ),
        ),
    });
    expect(response.routes.map((route) => route.id)).toEqual(['crowchild', 'local']);
    expect(response.source.traffic).toBe('unavailable');
    expect(response.source).not.toHaveProperty('trafficSource');
    for (const route of response.routes) {
      expect(route).not.toHaveProperty('traffic');
      expect(route).not.toHaveProperty('congestion');
      expect(routeTrafficLabel(response.source, route)).toBe('No live traffic');
    }
  });

  it('costs the deployed API that rejects the declaration one retry, keeping the origin metadata', async () => {
    // The production API rejects `trafficSources` with its contract 400 until it learns it.
    const { fetchImplementation, sent } = recording(({ body }) =>
      'trafficSources' in body
        ? jsonResponse(CONTRACT_REJECTION, 400)
        : jsonResponse(recordedRoutes('calgary-deerfoot-glenmore.v2')),
    );
    const response = await fetchRoutes(REQUEST, {
      baseUrl: 'https://rejecting.example.test',
      fetchImplementation,
    });

    expect(sent.map(({ url }) => url)).toEqual([
      'https://rejecting.example.test/v2/routes',
      'https://rejecting.example.test/v2/routes',
    ]);
    expect(sent[0]?.body).toHaveProperty('trafficSources');
    expect(sent[1]?.body).not.toHaveProperty('trafficSources');
    expect(sent[1]?.body).toMatchObject({
      originHeadingDegrees: 90,
      originHorizontalAccuracyMeters: 10,
    });
    expect(response.source).not.toHaveProperty('trafficSource');
    expect(routeTrafficLabel(response.source, response.routes[0])).toBe('No live traffic');
  });

  it('never sends a rejected route body more than once more', async () => {
    const { fetchImplementation, sent } = recording(() => jsonResponse(CONTRACT_REJECTION, 400));
    await expect(
      fetchRoutes(REQUEST, { baseUrl: 'https://api.example.test', fetchImplementation }),
    ).rejects.toBeInstanceOf(NavOssApiError);
    expect(sent).toHaveLength(2);
  });

  it('retries a /v1-only API that rejects origin metadata without it, and never declares sources there', async () => {
    const { fetchImplementation, sent } = recording(({ body }) =>
      'originHeadingDegrees' in body
        ? jsonResponse(CONTRACT_REJECTION, 400)
        : jsonResponse(recordedRoutes('calgary-deerfoot-glenmore.v1')),
    );
    await fetchRoutes(REQUEST, {
      baseUrl: 'https://api.example.test',
      fetchImplementation,
      routesV2: false,
    });
    expect(sent.map(({ url }) => url)).toEqual([
      'https://api.example.test/v1/routes',
      'https://api.example.test/v1/routes',
    ]);
    for (const { body } of sent) expect(body).not.toHaveProperty('trafficSources');
    expect(sent[1]?.body).not.toHaveProperty('originHeadingDegrees');
    expect(sent[1]?.body).not.toHaveProperty('originHorizontalAccuracyMeters');
  });

  it('does not declare sources on the /v1/routes fallback of a server without /v2/routes', async () => {
    const { fetchImplementation, sent } = recording(({ url }) =>
      url.endsWith('/v2/routes')
        ? jsonResponse({}, 404)
        : jsonResponse(recordedRoutes('calgary-deerfoot-glenmore.v1')),
    );
    await fetchRoutes(REQUEST, { baseUrl: 'https://api.example.test', fetchImplementation });
    expect(sent.map(({ url }) => url.slice(url.lastIndexOf('/v')))).toEqual([
      '/v2/routes',
      '/v1/routes',
    ]);
    expect(sent[1]?.body).not.toHaveProperty('trafficSources');
    expect(sent[1]?.body).toMatchObject({ originHeadingDegrees: 90 });
  });
});

describe('a rejected traffic declaration', () => {
  const cured = (sent: Sent) =>
    'trafficSources' in sent.body
      ? jsonResponse(CONTRACT_REJECTION, 400)
      : jsonResponse(recordedRoutes('calgary-deerfoot-glenmore.v2'));

  it('is not declared again to that server for the rest of the session, and is on the next', async () => {
    const first = recording(cured);
    await fetchRoutes(REQUEST, {
      baseUrl: 'https://memory.example.test',
      fetchImplementation: first.fetchImplementation,
    });
    expect(first.sent).toHaveLength(2);

    const second = recording(cured);
    await fetchRoutes(REQUEST, {
      baseUrl: 'https://memory.example.test',
      fetchImplementation: second.fetchImplementation,
    });
    expect(second.sent).toHaveLength(1);
    expect(second.sent[0]?.body).not.toHaveProperty('trafficSources');
    expect(second.sent[0]?.body).toMatchObject({ originHeadingDegrees: 90 });

    // Another server is still asked with the declaration.
    const other = recording(cured);
    await fetchRoutes(REQUEST, {
      baseUrl: 'https://other.example.test',
      fetchImplementation: other.fetchImplementation,
    });
    expect(other.sent[0]?.body).toHaveProperty('trafficSources');

    // A new app session (a fresh module) declares again.
    vi.resetModules();
    const relaunched = await import('../src/lib/api.js');
    const third = recording(cured);
    await relaunched.fetchRoutes(REQUEST, {
      baseUrl: 'https://memory.example.test',
      fetchImplementation: third.fetchImplementation,
    });
    expect(third.sent[0]?.body).toHaveProperty('trafficSources');
  });

  it('is not remembered when the request without it is rejected too', async () => {
    const rejecting = () => jsonResponse(CONTRACT_REJECTION, 400);
    const first = recording(rejecting);
    await expect(
      fetchRoutes(REQUEST, {
        baseUrl: 'https://uncured.example.test',
        fetchImplementation: first.fetchImplementation,
      }),
    ).rejects.toBeInstanceOf(NavOssApiError);
    const second = recording(rejecting);
    await expect(
      fetchRoutes(REQUEST, {
        baseUrl: 'https://uncured.example.test',
        fetchImplementation: second.fetchImplementation,
      }),
    ).rejects.toBeInstanceOf(NavOssApiError);
    expect(second.sent[0]?.body).toHaveProperty('trafficSources');
  });

  it('takes four requests at most down the whole ladder to an old /v1-only API', async () => {
    const { fetchImplementation, sent } = recording(({ body, url }) => {
      if (url.endsWith('/v2/routes')) {
        return 'trafficSources' in body
          ? jsonResponse(CONTRACT_REJECTION, 400)
          : jsonResponse({}, 404);
      }
      return 'originHeadingDegrees' in body
        ? jsonResponse(CONTRACT_REJECTION, 400)
        : jsonResponse(recordedRoutes('calgary-deerfoot-glenmore.v1'));
    });
    const response = await fetchRoutes(REQUEST, {
      baseUrl: 'https://ladder.example.test',
      fetchImplementation,
    });
    expect(response.routes.length).toBeGreaterThan(0);
    expect(
      sent.map(({ body, url }) => [
        url.slice(url.lastIndexOf('/v')),
        'trafficSources' in body,
        'originHeadingDegrees' in body,
      ]),
    ).toEqual([
      ['/v2/routes', true, true],
      ['/v2/routes', false, true],
      ['/v1/routes', false, true],
      ['/v1/routes', false, false],
    ]);
  });
});

describe('a trip the navigation core restores', () => {
  const trip = {
    destination: {
      id: 'tower',
      label: 'Calgary Tower',
      latitude: 51.0444,
      longitude: -114.0631,
      name: 'Calgary Tower',
    },
    distanceMeters: 300,
    durationSeconds: 240,
    geometry: geometry.map(([longitude, latitude]) => ({
      latitude: latitude ?? 0,
      longitude: longitude ?? 0,
    })),
    id: 'crowchild',
    preferences: REQUEST.preferences,
    source: 'valhalla-self-hosted',
    steps: [
      {
        distanceMeters: 300,
        durationSeconds: 240,
        geometry: geometry.map(([longitude, latitude]) => ({
          latitude: latitude ?? 0,
          longitude: longitude ?? 0,
        })),
        instruction: 'Continue.',
        maneuverType: 'continue',
        roadName: 'Crowchild Trail NW',
      },
    ],
    traffic: {
      delaySeconds: 180,
      oldestObservedAt: '2026-11-27T15:43:43.000Z',
      typicalDurationSeconds: 60,
    },
    congestion: ['heavy' as const, 'unknown' as const],
  };

  it('keeps City of Calgary traffic credited to the City', () => {
    const { route, routeSource } = routeFromNativeTrip({
      ...trip,
      trafficSource: 'calgary-travel-times',
    });
    expect(routeSource).toMatchObject({ traffic: 'live', trafficSource: CITY });
    expect(route.congestion).toEqual(['heavy', 'unknown']);
    expect(route.traffic?.delaySeconds).toBe(180);
    if (routeSource === undefined || routeSource.id === 'offline-valhalla')
      throw new Error('source');
    expect(routeTrafficLabel(routeSource, route)).toMatch(
      /^Traffic on main roads from The City of Calgary · updated /,
    );
    expect(routeSourceForNativeTrip('valhalla-self-hosted', 'calgary-travel-times')).toEqual(
      routeSource,
    );
  });

  it('decides whether the City measured a restored trip from its congestion and delay', () => {
    const unmeasured = routeFromNativeTrip({
      ...trip,
      congestion: ['unknown', 'unknown'],
      traffic: { ...trip.traffic, delaySeconds: 0 },
      trafficSource: 'calgary-travel-times',
    });
    if (unmeasured.routeSource === undefined || unmeasured.routeSource.id === 'offline-valhalla') {
      throw new Error('source');
    }
    expect(routeTrafficLabel(unmeasured.routeSource, unmeasured.route)).toBe(
      'No City of Calgary traffic data on this route',
    );
  });

  it('drops traffic whose source it does not know instead of crediting it to anyone', () => {
    const { route, routeSource } = routeFromNativeTrip({ ...trip, trafficSource: 'someone-else' });
    expect(route).not.toHaveProperty('traffic');
    expect(route).not.toHaveProperty('congestion');
    expect(routeSource).toMatchObject({ traffic: 'unavailable' });
    expect(routeSource).not.toHaveProperty('trafficSource');
  });
});
