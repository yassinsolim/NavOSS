import { describe, expect, it } from 'vitest';

import {
  createDriveBcTrafficCameraProvider,
  DriveBcTrafficCameraProviderError,
} from '../src/drivebc-traffic-camera-provider.js';

// Rows recorded from the live DriveBC HighwayCams catalogue CSV on 2026-11-15.
const header =
  '"id","cam_group","camName","links_camDetailsPage","links_imageURL","highway_number","caption","credit","region_name","orientation","latitude","longitude","elevation"';
const north =
  '"532","532","Lake Country - N","https://www.drivebc.ca/cameras/532","https://www.drivebc.ca/images/532.jpg","97","Highway 97 in Lake Country by Wood Lake, looking north.","","Southern Interior","N","50.057111","-119.407653","399"';
const south =
  '"533","532","Lake Country - S","https://www.drivebc.ca/cameras/533","https://www.drivebc.ca/images/533.jpg","97","Highway 97 in Lake Country by Wood Lake, looking south.","","Southern Interior","S","50.057111","-119.407653","399"';
const outside =
  '"20","18","LGB North End 2","https://www.drivebc.ca/cameras/20","https://www.drivebc.ca/images/20.jpg","99","Lions Gate Bridge north end, looking north.","Counterflow operations in effect for Lions Gate Bridge -<a href=""https://www2.gov.bc.ca/gov/content?id=859F1B6A4CD74BBFA27C67A438A3B899"" target=""_blank"">read more here</a>.<br>","Lower Mainland","N","49.324198","-123.130153","20"';

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
    expect(response.cameras[0]).toMatchObject({
      imageUrl: 'https://www.drivebc.ca/images/532.jpg',
      pageUrl: 'https://www.drivebc.ca/cameras/532',
      thumbnailUrl: 'https://www.drivebc.ca/images/532.jpg',
    });
    expect(response.source).toMatchObject({
      sourceId: 'drivebc-highwaycams',
      updatedAt: '2026-06-05T16:31:00.000Z',
    });
  });

  it('accepts the official feed credit field with embedded HTML quotes', async () => {
    const credit = outside.slice(outside.indexOf('"Counterflow'), outside.indexOf(',"Lower'));
    const row = north.replace('"","Southern', `${credit},"Southern`);
    const provider = createDriveBcTrafficCameraProvider({
      fetchImplementation: () => Promise.resolve(csvResponse([header, row].join('\n'))),
    });

    expect((await provider.getCameras()).cameras).toHaveLength(1);
  });

  it('fails closed on invalid URLs, coordinates, or CSV columns', async () => {
    for (const row of [
      north.replace('https://www.drivebc.ca/images/532.jpg', 'not-a-url'),
      north.replace('50.057111', 'north'),
      `${north},unexpected`,
    ]) {
      const provider = createDriveBcTrafficCameraProvider({
        fetchImplementation: () => Promise.resolve(csvResponse([header, row].join('\n'))),
      });
      await expect(provider.getCameras()).rejects.toBeInstanceOf(DriveBcTrafficCameraProviderError);
    }
  });

  it('tolerates added columns but fails closed when the image link column disappears', async () => {
    const added = createDriveBcTrafficCameraProvider({
      fetchImplementation: () =>
        Promise.resolve(csvResponse([`${header},"new_column"`, `${north},"x"`].join('\n'))),
    });
    expect((await added.getCameras()).cameras).toHaveLength(1);

    const withoutImages = createDriveBcTrafficCameraProvider({
      fetchImplementation: () =>
        Promise.resolve(
          csvResponse(
            [
              header.replace('"links_imageURL"', '"links_image"'),
              north,
            ].join('\n'),
          ),
        ),
    });
    await expect(withoutImages.getCameras()).rejects.toBeInstanceOf(
      DriveBcTrafficCameraProviderError,
    );
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
