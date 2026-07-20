import { describe, expect, it } from 'vitest';

import {
  CameraProviderError,
  createCalgarySafetyCameraProvider,
} from '../src/safety-camera-provider.js';

const metadataResponse = {
  rowsUpdatedAt: 1_782_894_823,
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.toString() : input.url;
}

describe('Calgary safety camera provider', () => {
  it('normalizes official direction labels and abbreviations', async () => {
    const rows = [
      {
        community: 'BELTLINE',
        description: 'Macleod Trail and 12 Avenue S.E.\nDirection: Northbound',
        point: { coordinates: [-114.0584045, 51.0412867], type: 'Point' },
        quadrant: 'SE',
        ward: '11',
      },
      {
        community: 'BELTLINE',
        description: '11 Avenue & 4 Street SW Westbound',
        point: { coordinates: [-114.0715292, 51.0426344], type: 'Point' },
        quadrant: 'SW',
        ward: '8',
      },
      {
        community: 'DOVER',
        description: '52 ST & Peigan TR SE SB',
        point: { coordinates: [-113.9588965, 51.0157553], type: 'Point' },
        quadrant: 'SE',
        ward: '9',
      },
    ];
    const provider = createCalgarySafetyCameraProvider({
      fetchImplementation: (input) =>
        Promise.resolve(
          requestUrl(input).includes('/api/views/')
            ? jsonResponse(metadataResponse)
            : jsonResponse(rows),
        ),
    });

    const response = await provider.getCameras();

    expect(response.cameras).toHaveLength(3);
    expect(response.cameras.map((camera) => camera.direction).sort()).toEqual([
      'northbound',
      'southbound',
      'westbound',
    ]);
    expect(response.cameras[0]?.enforcement).toEqual(['red-light', 'speed-on-green']);
    expect(response.source).toMatchObject({
      datasetId: 'dv2f-necx',
      updateFrequency: 'monthly',
      updatedAt: '2026-07-01T08:33:43.000Z',
    });
  });

  it('caches successful upstream responses', async () => {
    let currentTime = 1_000;
    let requestCount = 0;
    const rows = [
      {
        community: 'BELTLINE',
        description: 'Macleod Trail and 12 Avenue S.E. Direction: Northbound',
        point: { coordinates: [-114.0584045, 51.0412867], type: 'Point' },
        quadrant: 'SE',
        ward: '11',
      },
    ];
    const provider = createCalgarySafetyCameraProvider({
      cacheTtlMs: 10_000,
      clock: () => currentTime,
      fetchImplementation: (input) => {
        requestCount += 1;
        return Promise.resolve(
          requestUrl(input).includes('/api/views/')
            ? jsonResponse(metadataResponse)
            : jsonResponse(rows),
        );
      },
    });

    await provider.getCameras();
    await provider.getCameras();
    expect(requestCount).toBe(2);

    currentTime += 10_001;
    await provider.getCameras();
    expect(requestCount).toBe(4);
  });

  it('rejects rows whose enforced direction cannot be determined', async () => {
    const provider = createCalgarySafetyCameraProvider({
      fetchImplementation: (input) =>
        Promise.resolve(
          requestUrl(input).includes('/api/views/')
            ? jsonResponse(metadataResponse)
            : jsonResponse([
                {
                  community: 'BELTLINE',
                  description: 'Unknown intersection',
                  point: { coordinates: [-114.0584045, 51.0412867], type: 'Point' },
                  quadrant: 'SE',
                  ward: '11',
                },
              ]),
        ),
    });

    await expect(provider.getCameras()).rejects.toBeInstanceOf(CameraProviderError);
  });
});
