import type { RouteRequest } from '@navoss/contracts';
import { describe, expect, it } from 'vitest';

import { createValhallaRouteProvider } from '../src/route-provider.js';

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
      degraded: false,
      id: 'valhalla-self-hosted',
      mode: 'production',
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
