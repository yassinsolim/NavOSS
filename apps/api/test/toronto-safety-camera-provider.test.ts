import { describe, expect, it } from 'vitest';

import {
  createTorontoSafetyCameraProvider,
  TorontoCameraProviderError,
} from '../src/toronto-safety-camera-provider.js';

const metadata = {
  result: {
    id: '9fcff3e1-3737-43cf-b410-05acd615e27b',
    last_refreshed: '2026-07-25 05:03:56.013898',
    refresh_rate: 'Daily',
    state: 'active',
  },
  success: true,
};

const collection = {
  features: [
    {
      geometry: { coordinates: [[-79.3840989922877, 43.6463830046885]], type: 'MultiPoint' },
      properties: {
        DISTRICT: 'Toronto and East York',
        NAME: 'University Ave And Wellington St W',
        RLC: '6098',
      },
      type: 'Feature',
    },
  ],
  type: 'FeatureCollection',
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.toString() : input.url;
}

describe('Toronto safety camera provider', () => {
  it('normalizes active red-light intersections without inventing a direction', async () => {
    const provider = createTorontoSafetyCameraProvider({
      clock: () => Date.parse('2026-07-27T12:00:00.000Z'),
      fetchImplementation: (input) =>
        Promise.resolve(
          requestUrl(input).includes('package_show')
            ? jsonResponse(metadata)
            : jsonResponse(collection),
        ),
    });

    const response = await provider.getCameras();

    expect(response.cameras).toEqual([
      {
        coordinate: { latitude: 43.6463830046885, longitude: -79.3840989922877 },
        enforcement: ['red-light'],
        id: 'toronto-rlc:6098',
        jurisdiction: 'City of Toronto',
        location: 'University Ave And Wellington St W',
        regionId: 'toronto-on',
      },
    ]);
    expect(response.source).toMatchObject({
      attribution: 'City of Toronto',
      updateFrequency: 'daily',
      updatedAt: '2026-07-25T05:03:56.013Z',
    });
  });

  it('caches a successful Toronto snapshot', async () => {
    let requestCount = 0;
    const provider = createTorontoSafetyCameraProvider({
      fetchImplementation: (input) => {
        requestCount += 1;
        return Promise.resolve(
          requestUrl(input).includes('package_show')
            ? jsonResponse(metadata)
            : jsonResponse(collection),
        );
      },
    });

    await provider.getCameras();
    await provider.getCameras();
    expect(requestCount).toBe(2);
  });

  it('fails closed when the official dataset shape changes', async () => {
    const provider = createTorontoSafetyCameraProvider({
      fetchImplementation: (input) =>
        Promise.resolve(
          requestUrl(input).includes('package_show')
            ? jsonResponse(metadata)
            : jsonResponse({ ...collection, features: [{ unexpected: true }] }),
        ),
    });

    await expect(provider.getCameras()).rejects.toBeInstanceOf(TorontoCameraProviderError);
  });
});
