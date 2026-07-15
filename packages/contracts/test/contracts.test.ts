import { describe, expect, it } from 'vitest';

import {
  AppConfigResponseSchema,
  GeographicBoundsSchema,
  RouteRequestSchema,
  RouteResponseSchema,
  SearchQuerySchema,
  SearchResponseSchema,
} from '../src/index.js';

describe('GeographicBoundsSchema', () => {
  it('rejects inverted bounds', () => {
    const result = GeographicBoundsSchema.safeParse({
      northEast: { latitude: 50.8, longitude: -114.2 },
      southWest: { latitude: 51.2, longitude: -113.8 },
    });

    expect(result.success).toBe(false);
  });
});

describe('SearchQuerySchema', () => {
  it('coerces bounded query values', () => {
    const result = SearchQuerySchema.parse({
      latitude: '51.0447',
      limit: '5',
      longitude: '-114.0719',
      q: '  Calgary Tower  ',
    });

    expect(result).toEqual({
      latitude: 51.0447,
      limit: 5,
      longitude: -114.0719,
      q: 'Calgary Tower',
    });
  });

  it('requires latitude and longitude together', () => {
    const result = SearchQuerySchema.safeParse({ latitude: '51.0447', q: 'library' });

    expect(result.success).toBe(false);
  });
});

describe('SearchResponseSchema', () => {
  it('makes fixture freshness explicit', () => {
    const result = SearchResponseSchema.safeParse({
      degraded: true,
      results: [],
      source: {
        datasetVersion: 'fixture-v1',
        freshness: 'static',
        id: 'calgary-alpha-fixtures',
        updatedAt: '2026-07-15T12:00:00Z',
      },
    });

    expect(result.success).toBe(true);
  });
});

describe('route contracts', () => {
  it('applies safe driving defaults to a route request', () => {
    const request = RouteRequestSchema.parse({
      destination: { latitude: 51.13157, longitude: -114.01055 },
      origin: { latitude: 51.0447, longitude: -114.0719 },
    });

    expect(request).toEqual({
      alternatives: 1,
      destination: { latitude: 51.13157, longitude: -114.01055 },
      origin: { latitude: 51.0447, longitude: -114.0719 },
      preferences: {
        avoidFerries: false,
        avoidHighways: false,
        avoidTolls: false,
        avoidUnpaved: false,
      },
    });
  });

  it('accepts normalized route geometry and guidance', () => {
    const result = RouteResponseSchema.safeParse({
      degraded: true,
      generatedAt: '2026-07-15T12:00:00Z',
      routes: [
        {
          distanceMeters: 19660.564,
          durationSeconds: 1215.354,
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
              spokenInstruction: 'Drive west. Then turn right.',
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
    });

    expect(result.success).toBe(true);
  });

  it('rejects a route whose origin and destination are identical', () => {
    const result = RouteRequestSchema.safeParse({
      destination: { latitude: 51.0447, longitude: -114.0719 },
      origin: { latitude: 51.0447, longitude: -114.0719 },
    });

    expect(result.success).toBe(false);
  });
});

describe('AppConfigResponseSchema', () => {
  it('accepts the technical-alpha feature posture', () => {
    const result = AppConfigResponseSchema.safeParse({
      apiVersion: 'v1',
      attribution: [
        { label: 'OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' },
      ],
      coverage: {
        bounds: {
          northEast: { latitude: 51.212, longitude: -113.859 },
          southWest: { latitude: 50.842, longitude: -114.316 },
        },
        displayName: 'Calgary, Alberta',
        id: 'calgary-ab',
        modes: ['driving'],
      },
      endpoints: {
        events: '/v1/events',
        routes: '/v1/routes',
        search: '/v1/search',
      },
      features: {
        communityReports: false,
        liveTraffic: false,
        productionSearch: false,
      },
      generatedAt: '2026-07-15T12:00:00Z',
      minimumAppVersion: '0.0.0',
      style: { id: 'navoss-alpha', version: 'fixture-v1' },
    });

    expect(result.success).toBe(true);
  });
});
