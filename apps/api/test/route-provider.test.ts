import type { RouteRequest } from '@navoss/contracts';
import { describe, expect, it } from 'vitest';

import {
  createConfiguredRouteProvider,
  createMapboxTrafficRouteProvider,
  createValhallaRouteProvider,
} from '../src/route-provider.js';

function valhallaRoute(
  distance: number,
  duration: number,
  offset: number,
  voiceInstructions?: { announcement: string }[],
) {
  const geometry = {
    coordinates: [
      [-114.0719, 51.0447],
      [-114.01 + offset, 51.13 + offset],
    ],
    type: 'LineString',
  } as const;
  return {
    distance,
    duration,
    geometry,
    legs: [
      {
        steps: [
          {
            distance,
            duration,
            geometry,
            maneuver: { instruction: 'Drive to the destination.', type: 'depart' },
            name: 'Test Road',
            ...(voiceInstructions === undefined ? {} : { voiceInstructions }),
          },
        ],
      },
    ],
  };
}

describe('Valhalla route provider', () => {
  it('requests alternates and ranks ETA before distance', async () => {
    let requestPayload: unknown;
    const provider = createValhallaRouteProvider({
      endpoint: 'https://valhalla.test/route',
      fetchImplementation: (_input, init) => {
        if (typeof init?.body !== 'string') {
          throw new Error('Expected a JSON request body.');
        }
        requestPayload = JSON.parse(init.body);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              code: 'Ok',
              routes: [
                valhallaRoute(9_000, 600, 0),
                valhallaRoute(12_000, 540, 0.01),
                valhallaRoute(8_000, 600, 0.02),
              ],
            }),
            { status: 200 },
          ),
        );
      },
    });
    const request: RouteRequest = {
      alternatives: 2,
      destination: { latitude: 51.13157, longitude: -114.01055 },
      origin: { latitude: 51.0447, longitude: -114.0719 },
      preferences: {
        avoidFerries: false,
        avoidHighways: false,
        avoidTolls: false,
        avoidUnpaved: false,
      },
    };

    const routes = await provider.getRoutes(request);

    expect(requestPayload).toMatchObject({ alternates: 2, costing: 'auto' });
    expect(provider.source).toEqual({
      attribution: 'Routing by Valhalla using OpenStreetMap data',
      degraded: false,
      id: 'valhalla-self-hosted',
      mode: 'production',
      traffic: 'unavailable',
    });
    expect(new Set(routes.map((route) => route.id)).size).toBe(3);
    expect(routes.every((route) => /^valhalla-\d+-[0-9a-f]{16}$/.test(route.id))).toBe(true);
    expect(
      routes.map(({ distanceMeters, durationSeconds, label }) => ({
        distanceMeters,
        durationSeconds,
        label,
      })),
    ).toEqual([
      { distanceMeters: 12_000, durationSeconds: 540, label: 'fastest' },
      { distanceMeters: 8_000, durationSeconds: 600, label: 'alternative' },
      { distanceMeters: 9_000, durationSeconds: 600, label: 'alternative' },
    ]);
  });

  it('keeps the final voice instruction for the maneuver at the end of a step', async () => {
    const route = valhallaRoute(1_000, 120, 0, [
      { announcement: 'Continue for 1 kilometer.' },
      { announcement: 'In 200 meters, Turn right onto Aspen Glen Way SW.' },
      { announcement: 'Turn right onto Aspen Glen Way SW.' },
    ]);
    const provider = createValhallaRouteProvider({
      endpoint: 'https://valhalla.test/route',
      fetchImplementation: () =>
        Promise.resolve(new Response(JSON.stringify({ code: 'Ok', routes: [route] }))),
    });

    const routes = await provider.getRoutes({
      alternatives: 0,
      destination: { latitude: 51.13157, longitude: -114.01055 },
      origin: { latitude: 51.0447, longitude: -114.0719 },
      preferences: {
        avoidFerries: false,
        avoidHighways: false,
        avoidTolls: false,
        avoidUnpaved: false,
      },
    });

    expect(routes[0]?.steps[0]?.spokenInstruction).toBe('Turn right onto Aspen Glen Way SW.');
  });

  it('changes route identity when provider route content changes', async () => {
    const request: RouteRequest = {
      alternatives: 0,
      destination: { latitude: 51.13157, longitude: -114.01055 },
      origin: { latitude: 51.0447, longitude: -114.0719 },
      preferences: {
        avoidFerries: false,
        avoidHighways: false,
        avoidTolls: false,
        avoidUnpaved: false,
      },
    };
    const routeIds = await Promise.all(
      [0, 0.01].map(async (offset) => {
        const provider = createValhallaRouteProvider({
          endpoint: 'https://valhalla.test/route',
          fetchImplementation: () =>
            Promise.resolve(
              new Response(
                JSON.stringify({ code: 'Ok', routes: [valhallaRoute(9_000, 600, offset)] }),
                { status: 200 },
              ),
            ),
        });
        return (await provider.getRoutes(request))[0]?.id;
      }),
    );

    expect(routeIds[0]).toBeDefined();
    expect(routeIds[1]).toBeDefined();
    expect(routeIds[0]).not.toBe(routeIds[1]);
  });
});

describe('Mapbox live-traffic route provider', () => {
  it('keeps Valhalla when traffic configuration is absent or blank', () => {
    expect(createConfiguredRouteProvider({}).source?.id).toBe('valhalla-development');
    expect(
      createConfiguredRouteProvider({
        MAPBOX_ACCESS_TOKEN: '  ',
        MAPBOX_VEHICLE_LICENSE_CONFIRMED: '0',
      }).source?.id,
    ).toBe('valhalla-development');
  });

  it('rejects partial licensed traffic configuration', () => {
    expect(() => createConfiguredRouteProvider({ MAPBOX_ACCESS_TOKEN: 'test-token' })).toThrow(
      'vehicle-use license',
    );
    expect(() => createConfiguredRouteProvider({ MAPBOX_VEHICLE_LICENSE_CONFIRMED: '1' })).toThrow(
      'access token',
    );
  });

  it('selects Mapbox only with both licensed configuration values', () => {
    expect(
      createConfiguredRouteProvider({
        MAPBOX_ACCESS_TOKEN: 'test-token',
        MAPBOX_VEHICLE_LICENSE_CONFIRMED: '1',
      }).source?.id,
    ).toBe('mapbox-traffic');
  });

  it('requires explicit vehicle-use license confirmation', () => {
    expect(() =>
      createMapboxTrafficRouteProvider({
        accessToken: 'test-token',
        vehicleLicenseConfirmed: false,
      }),
    ).toThrow('vehicle-use license');
  });

  it('returns traffic-aware total ETA, typical ETA, and delay', async () => {
    let requestUrl: URL | undefined;
    const route = {
      ...valhallaRoute(20_000, 1_800, 0, [
        { announcement: 'Continue north.' },
        { announcement: 'Turn right onto Airport Trail NE.' },
      ]),
      duration_typical: 1_500,
    };
    const provider = createMapboxTrafficRouteProvider({
      accessToken: 'test-token',
      endpoint: 'https://api.mapbox.test/directions/v5/mapbox/driving-traffic',
      fetchImplementation: (input) => {
        requestUrl = new URL(
          input instanceof URL ? input : typeof input === 'string' ? input : input.url,
        );
        return Promise.resolve(new Response(JSON.stringify({ code: 'Ok', routes: [route] })));
      },
      now: () => new Date('2026-07-23T22:00:00Z'),
      vehicleLicenseConfirmed: true,
    });

    const routes = await provider.getRoutes({
      alternatives: 2,
      destination: { latitude: 51.13157, longitude: -114.01055 },
      origin: { latitude: 51.0447, longitude: -114.0719 },
      preferences: {
        avoidFerries: true,
        avoidHighways: true,
        avoidTolls: true,
        avoidUnpaved: true,
      },
    });

    expect(requestUrl?.pathname).toContain('-114.0719,51.0447;-114.01055,51.13157');
    expect(requestUrl?.searchParams.get('access_token')).toBe('test-token');
    expect(requestUrl?.searchParams.get('alternatives')).toBe('true');
    expect(requestUrl?.searchParams.get('depart_at')).toBe('2026-07-23T22:00:00.000Z');
    expect(requestUrl?.searchParams.get('exclude')).toBe('ferry,motorway,toll,unpaved');
    expect(routes[0]).toMatchObject({
      durationSeconds: 1_800,
      label: 'fastest',
      traffic: { delaySeconds: 300, typicalDurationSeconds: 1_500 },
    });
    expect(routes[0]?.steps[0]?.spokenInstruction).toBe('Turn right onto Airport Trail NE.');
    expect(provider.source).toEqual({
      attribution: 'Routing and traffic by Mapbox',
      degraded: false,
      id: 'mapbox-traffic',
      mode: 'production',
      traffic: 'live',
    });
  });

  it('fails readiness for rejected credentials and caches the result', async () => {
    let requestCount = 0;
    let currentTime = 1_000;
    const provider = createMapboxTrafficRouteProvider({
      accessToken: 'invalid-token',
      clock: () => currentTime,
      fetchImplementation: () => {
        requestCount += 1;
        return Promise.resolve(new Response('{}', { status: 401 }));
      },
      readinessCacheMs: 300_000,
      vehicleLicenseConfirmed: true,
    });

    await expect(provider.isReady?.()).resolves.toBe(false);
    await expect(provider.isReady?.()).resolves.toBe(false);
    expect(requestCount).toBe(1);

    currentTime += 300_001;
    await expect(provider.isReady?.()).resolves.toBe(false);
    expect(requestCount).toBe(2);
  });
});
