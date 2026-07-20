import { describe, expect, it } from 'vitest';

import {
  buildSearchUrl,
  fetchRoutes,
  fetchSafetyCameras,
  NavOssApiError,
  resolveApiBaseUrl,
} from '../src/lib/api.js';

describe('resolveApiBaseUrl', () => {
  it('uses the simulator API only for development', () => {
    expect(resolveApiBaseUrl(undefined, true)).toBe('http://127.0.0.1:3001');
  });

  it('requires an explicit API URL for release builds', () => {
    expect(() => resolveApiBaseUrl(undefined, false)).toThrow(
      'This NavOSS build is missing its API configuration.',
    );
  });

  it('requires HTTPS for release builds', () => {
    expect(() => resolveApiBaseUrl('http://api.navoss.example/', false)).toThrow(
      'Release builds require an HTTPS NavOSS API URL.',
    );
  });

  it('normalizes a configured HTTPS API URL', () => {
    expect(resolveApiBaseUrl(' https://api.navoss.example/// ', false)).toBe(
      'https://api.navoss.example',
    );
  });
});

describe('buildSearchUrl', () => {
  it('encodes the query and optional Calgary proximity', () => {
    const url = buildSearchUrl('Calgary Tower', {
      baseUrl: 'http://192.168.1.20:3000/',
      latitude: 51.0447,
      limit: 8,
      longitude: -114.0719,
    });

    expect(url).toBe(
      'http://192.168.1.20:3000/v1/search?q=Calgary+Tower&latitude=51.0447&longitude=-114.0719&limit=8',
    );
  });

  it('omits an incomplete proximity pair', () => {
    const url = buildSearchUrl('library', {
      baseUrl: 'http://127.0.0.1:3000',
      latitude: 51.0447,
    });

    expect(url).toBe('http://127.0.0.1:3000/v1/search?q=library');
  });
});

describe('NavOssApiError', () => {
  it('retains the HTTP status without exposing response payloads', () => {
    const error = new NavOssApiError('Request failed.', 503);

    expect(error).toMatchObject({
      message: 'Request failed.',
      name: 'NavOssApiError',
      status: 503,
    });
  });
});

describe('fetchRoutes', () => {
  it('posts coordinates and validates the normalized response', async () => {
    let capturedRequest: RequestInit | undefined;
    const response = await fetchRoutes(
      {
        alternatives: 1,
        destination: { latitude: 51.13157, longitude: -114.01055 },
        origin: { latitude: 51.0447, longitude: -114.0719 },
        preferences: {
          avoidFerries: false,
          avoidHighways: false,
          avoidTolls: false,
          avoidUnpaved: false,
        },
      },
      {
        baseUrl: 'http://127.0.0.1:3001/',
        fetchImplementation: async (input, init) => {
          expect(input).toBe('http://127.0.0.1:3001/v1/routes');
          capturedRequest = init;
          return new Response(
            JSON.stringify({
              degraded: true,
              generatedAt: '2026-07-15T12:00:00Z',
              routes: [
                {
                  distanceMeters: 19_660.564,
                  durationSeconds: 1_215.354,
                  geometry: [
                    [-114.071903, 51.044666],
                    [-114.01055, 51.13157],
                  ],
                  id: 'route-1',
                  label: 'fastest',
                  steps: [
                    {
                      distanceMeters: 57.692,
                      durationSeconds: 18.881,
                      geometry: [
                        [-114.071903, 51.044666],
                        [-114.072726, 51.044691],
                      ],
                      instruction: 'Drive west.',
                      maneuverType: 'depart',
                      roadName: '',
                    },
                  ],
                },
              ],
              source: {
                attribution: 'Routing by Valhalla using OpenStreetMap data',
                id: 'valhalla-development',
                mode: 'development',
                traffic: 'unavailable',
              },
            }),
            { headers: { 'content-type': 'application/json' }, status: 200 },
          );
        },
      },
    );

    expect(capturedRequest).toMatchObject({ method: 'POST' });
    expect(response.routes[0]?.durationSeconds).toBe(1_215.354);
  });
});

describe('fetchSafetyCameras', () => {
  it('validates official camera locations and source freshness', async () => {
    const response = await fetchSafetyCameras({
      baseUrl: 'http://127.0.0.1:3001/',
      fetchImplementation: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              cameras: [
                {
                  community: 'BELTLINE',
                  coordinate: { latitude: 51.0412867, longitude: -114.0584045 },
                  direction: 'northbound',
                  enforcement: ['red-light', 'speed-on-green'],
                  id: 'calgary-isc:51.0412867:-114.0584045',
                  location: 'Macleod Trail and 12 Avenue S.E.',
                  quadrant: 'SE',
                  ward: 11,
                },
              ],
              source: {
                attribution: 'The City of Calgary',
                datasetId: 'dv2f-necx',
                datasetUrl:
                  'https://data.calgary.ca/Health-and-Safety/Intersection-Safety-Cameras/dv2f-necx',
                updateFrequency: 'monthly',
                updatedAt: '2026-07-01T08:33:43.000Z',
              },
            }),
            { headers: { 'content-type': 'application/json' }, status: 200 },
          ),
        ),
    });

    expect(response.cameras[0]?.direction).toBe('northbound');
    expect(response.source.updatedAt).toBe('2026-07-01T08:33:43.000Z');
  });
});
