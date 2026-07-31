import { describe, expect, it } from 'vitest';

import {
  createDriveBcTrafficCameraProvider,
  DriveBcTrafficCameraProviderError,
} from '../src/drivebc-traffic-camera-provider.js';

const header =
  'links_bchighwaycam,links_imageDisplay,links_imageThumbnail,links_replayTheDay,id,highway_number,highway_locationDescription,camName,caption,credit,orientation,latitude,longitude';
const north =
  'https://images.drivebc.ca/bchighwaycam/pub/html/www/532.html,https://images.drivebc.ca/bchighwaycam/pub/cameras/532.jpg,https://images.drivebc.ca/bchighwaycam/pub/cameras/tn/532.jpg,https://images.drivebc.ca/ReplayTheDay/player.html?cam=532,532,97,Southern Interior Region,Lake Country - N,"Highway 97 in Lake Country by Wood Lake, looking north.",,N,50.057111,-119.407653';
const south =
  'https://images.drivebc.ca/bchighwaycam/pub/html/www/533.html,https://images.drivebc.ca/bchighwaycam/pub/cameras/533.jpg,https://images.drivebc.ca/bchighwaycam/pub/cameras/tn/533.jpg,https://images.drivebc.ca/ReplayTheDay/player.html?cam=533,533,97,Southern Interior Region,Lake Country - S,"Highway 97 in Lake Country by Wood Lake, looking south.",,S,50.057111,-119.407653';
const outside =
  'https://images.drivebc.ca/bchighwaycam/pub/html/www/999.html,https://images.drivebc.ca/bchighwaycam/pub/cameras/999.jpg,https://images.drivebc.ca/bchighwaycam/pub/cameras/tn/999.jpg,https://images.drivebc.ca/ReplayTheDay/player.html?cam=999,999,1,,Outside,"Outside the region.",,E,49.0,-119.4';

function csvResponse(body: string, status = 200): Response {
  return new Response(body, {
    headers: { 'content-type': 'text/csv', 'last-modified': 'Fri, 05 Jun 2026 16:31:00 GMT' },
    status,
  });
}

describe('DriveBC traffic camera provider', () => {
  it('keeps multiple orientations at one coordinate and filters explicit bounds', async () => {
    const provider = createDriveBcTrafficCameraProvider({
      clock: () => Date.parse('2026-07-30T20:30:00Z'),
      fetchImplementation: () =>
        Promise.resolve(csvResponse([header, north, south, outside].join('\n'))),
    });

    const response = await provider.getCameras();

    expect(response.cameras).toHaveLength(2);
    expect(response.cameras.map((camera) => [camera.id, camera.orientation])).toEqual([
      ['drivebc-highwaycam:532', 'N'],
      ['drivebc-highwaycam:533', 'S'],
    ]);
    expect(response.cameras.map((camera) => camera.enforcement)).toEqual([false, false]);
    expect(response.source).toMatchObject({
      sourceId: 'drivebc-highwaycams',
      updatedAt: '2026-06-05T16:31:00.000Z',
    });
  });

  it('accepts the official feed credit field with embedded HTML quotes', async () => {
    const row = north.replace(',,N,', ',View <a href="https://example.com">details</a>,N,');
    const provider = createDriveBcTrafficCameraProvider({
      fetchImplementation: () => Promise.resolve(csvResponse([header, row].join('\n'))),
    });

    expect((await provider.getCameras()).cameras).toHaveLength(1);
  });

  it('fails closed on invalid URLs, coordinates, or CSV columns', async () => {
    for (const row of [
      north.replace('https://images.drivebc.ca/bchighwaycam/pub/html/www/532.html', 'not-a-url'),
      north.replace('50.057111', 'north'),
      `${north},unexpected`,
    ]) {
      const provider = createDriveBcTrafficCameraProvider({
        fetchImplementation: () => Promise.resolve(csvResponse([header, row].join('\n'))),
      });
      await expect(provider.getCameras()).rejects.toBeInstanceOf(DriveBcTrafficCameraProviderError);
    }
  });

  it('returns no more than 24 hours of marked stale fallback', async () => {
    let now = Date.parse('2026-07-30T20:30:00Z');
    let offline = false;
    const provider = createDriveBcTrafficCameraProvider({
      cacheTtlMs: 1_000,
      clock: () => now,
      fetchImplementation: () =>
        Promise.resolve(offline ? csvResponse('', 503) : csvResponse([header, north].join('\n'))),
      maximumStaleMs: 10_000,
    });

    await provider.getCameras();
    now += 1_001;
    offline = true;
    expect(await provider.getCameras()).toMatchObject({ degraded: true, stale: true });
    now += 10_001;
    await expect(provider.getCameras()).rejects.toBeInstanceOf(DriveBcTrafficCameraProviderError);
  });
});
