import type { RouteRequest } from '@navoss/contracts';
import { describe, expect, it } from 'vitest';

import { createValhallaRouteProvider } from '../src/route-provider.js';

function valhallaRoute(distance: number, duration: number, offset: number) {
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
});
