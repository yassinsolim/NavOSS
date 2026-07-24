import { describe, expect, it } from 'vitest';

import {
  buildNominatimSearchUrl,
  buildPhotonSearchUrl,
  createDevelopmentSearchProvider,
  createNominatimSearchProvider,
  createPhotonSearchProvider,
  createProductionSearchProvider,
  type SearchProvider,
} from '../src/search-provider.js';

describe('Photon search provider', () => {
  it('builds a Calgary-bounded, proximity-biased query', () => {
    const url = new URL(
      buildPhotonSearchUrl({
        latitude: 51.0447,
        limit: 8,
        longitude: -114.0719,
        q: 'University of Calgary',
      }),
    );

    expect(url.hostname).toBe('photon.komoot.io');
    expect(url.searchParams.get('bbox')).toBe('-114.316,50.842,-113.859,51.212');
    expect(url.searchParams.get('lat')).toBe('51.0447');
    expect(url.searchParams.get('lon')).toBe('-114.0719');
    expect(url.searchParams.get('q')).toBe('University of Calgary');
  });

  it('normalizes OSM addresses and POIs into NavOSS search results', async () => {
    const provider = createPhotonSearchProvider({
      fetchImplementation: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              features: [
                {
                  geometry: { coordinates: [-114.138805, 51.075054], type: 'Point' },
                  properties: {
                    city: 'Calgary',
                    country: 'Canada',
                    housenumber: '2500',
                    name: 'University of Calgary',
                    osm_id: 4_814_074,
                    osm_key: 'amenity',
                    osm_type: 'W',
                    postcode: 'T2N 1N4',
                    state: 'Alberta',
                    street: 'University Drive NW',
                    type: 'house',
                  },
                  type: 'Feature',
                },
              ],
              type: 'FeatureCollection',
            }),
            { status: 200 },
          ),
        ),
      now: () => new Date('2026-07-15T12:00:00Z'),
    });

    const response = await provider.search({ limit: 8, q: 'University of Calgary' });

    expect(response.results[0]).toMatchObject({
      category: 'address',
      center: { latitude: 51.075054, longitude: -114.138805 },
      label: 'University of Calgary, 2500 University Drive NW, Calgary, Alberta, T2N 1N4',
      name: 'University of Calgary',
    });
    expect(response.source.id).toBe('photon-development');
  });

  it('falls back to deterministic fixtures when Photon is unavailable', async () => {
    const unavailableProvider: SearchProvider = {
      search: () => Promise.reject(new Error('offline')),
    };
    const provider = createDevelopmentSearchProvider(undefined, unavailableProvider);

    const response = await provider.search({ limit: 8, q: 'airport' });

    expect(response.results[0]?.id).toBe('poi:yyc-airport');
    expect(response.source.id).toBe('calgary-alpha-fixtures');
  });

  it('keeps major Calgary destinations ahead of ambiguous Photon results', async () => {
    const photonProvider: SearchProvider = {
      search: () =>
        Promise.resolve({
          degraded: true,
          results: [
            {
              category: 'neighborhood',
              center: { latitude: 51.1548141, longitude: -114.0645792 },
              confidence: 0.9,
              id: 'photon:wrong-result',
              label: 'Northpointe Shopping Centre, Calgary',
              name: 'Northpointe Shopping Centre',
            },
          ],
          source: {
            datasetVersion: 'openstreetmap-continuous',
            freshness: 'fresh',
            id: 'photon-development',
            updatedAt: '2026-07-19T12:00:00Z',
          },
        }),
    };
    const provider = createDevelopmentSearchProvider(undefined, photonProvider);

    const eastHills = await provider.search({ limit: 8, q: 'East Hills Shopping Centre' });
    const saddletowne = await provider.search({ limit: 8, q: 'Saddletowne LRT' });

    expect(eastHills.results[0]?.id).toBe('poi:east-hills-shopping-centre');
    expect(saddletowne.results[0]?.id).toBe('poi:saddletowne-lrt');
  });
});

describe('Nominatim search provider', () => {
  it('builds a Calgary-bounded production query', () => {
    const url = new URL(
      buildNominatimSearchUrl({ limit: 8, q: 'Calgary Tower' }, 'http://nominatim:8080/'),
    );

    expect(url.pathname).toBe('/search');
    expect(url.searchParams.get('bounded')).toBe('1');
    expect(url.searchParams.get('extratags')).toBe('1');
    expect(url.searchParams.get('format')).toBe('jsonv2');
    expect(url.searchParams.get('viewbox')).toBe('-114.316,51.212,-113.859,50.842');
  });

  it('normalizes self-hosted results as production search', async () => {
    const provider = createNominatimSearchProvider({
      datasetVersion: 'alberta-2026-07-20',
      endpoint: 'http://nominatim:8080/',
      fetchImplementation: () =>
        Promise.resolve(
          new Response(
            JSON.stringify([
              {
                addresstype: 'attraction',
                category: 'tourism',
                display_name: 'Calgary Tower, 101 9 Avenue SW, Calgary, Alberta, Canada',
                extratags: {
                  'contact:phone': '+1 403 266 7171',
                  opening_hours: 'Mo-Su 10:00-21:00',
                  website: 'https://www.calgarytower.com',
                  wheelchair: 'yes',
                },
                importance: 0.8,
                lat: '51.04427',
                lon: '-114.06309',
                name: 'Calgary Tower',
                osm_id: 2_359_239_747,
                osm_type: 'node',
                type: 'attraction',
              },
            ]),
            { status: 200 },
          ),
        ),
      now: () => new Date('2026-07-20T12:00:00Z'),
    });

    const response = await provider.search({ includeDetails: true, limit: 8, q: 'Calgary Tower' });

    expect(response.degraded).toBe(false);
    expect(response.source).toEqual({
      datasetVersion: 'alberta-2026-07-20',
      freshness: 'fresh',
      id: 'nominatim-self-hosted',
      updatedAt: '2026-07-20T12:00:00.000Z',
    });
    expect(response.results[0]).toMatchObject({
      category: 'poi',
      center: { latitude: 51.04427, longitude: -114.06309 },
      details: {
        address: 'Calgary Tower, 101 9 Avenue SW, Calgary, Alberta, Canada',
        category: 'attraction',
        openingHours: 'Mo-Su 10:00-21:00',
        phone: '+1 403 266 7171',
        website: 'https://www.calgarytower.com',
        wheelchair: 'yes',
      },
      name: 'Calgary Tower',
    });
  });

  it('falls back to fixtures when self-hosted search is unavailable', async () => {
    const provider = createProductionSearchProvider(undefined, {
      search: () => Promise.reject(new Error('offline')),
    });

    const response = await provider.search({ limit: 8, q: 'airport' });

    expect(response.degraded).toBe(true);
    expect(response.results[0]?.id).toBe('poi:yyc-airport');
    expect(response.source.id).toBe('calgary-alpha-fixtures');
  });

  it('keeps the original result shape unless details are requested', async () => {
    const provider = createNominatimSearchProvider({
      endpoint: 'http://nominatim:8080/',
      fetchImplementation: () =>
        Promise.resolve(
          new Response(
            JSON.stringify([
              {
                display_name: 'Test Cafe, Calgary, Alberta',
                extratags: { phone: '+1 403 555 0100' },
                lat: '51.0447',
                lon: '-114.0719',
                name: 'Test Cafe',
                osm_id: 1,
                osm_type: 'node',
                type: 'cafe',
              },
            ]),
            { status: 200 },
          ),
        ),
    });

    const response = await provider.search({ includeDetails: false, limit: 8, q: 'Test Cafe' });

    expect(response.results[0]).not.toHaveProperty('details');
  });

  it('keeps open-data details when a higher-ranked local result is deduplicated', async () => {
    const nominatimProvider = {
      search: () =>
        Promise.resolve({
          degraded: false,
          results: [
            {
              category: 'poi' as const,
              center: { latitude: 51.04427, longitude: -114.06309 },
              confidence: 0.98,
              details: {
                address: '101 9 Avenue SW, Calgary, Alberta',
                openingHours: 'Mo-Su 10:00-21:00',
              },
              id: 'nominatim:node:2359239747',
              label: 'Calgary Tower, 101 9 Avenue SW, Calgary, Alberta',
              name: 'Calgary Tower',
            },
          ],
          source: {
            datasetVersion: 'alberta',
            freshness: 'fresh' as const,
            id: 'nominatim-self-hosted',
            updatedAt: '2026-07-20T12:00:00Z',
          },
        }),
    };
    const provider = createProductionSearchProvider(undefined, nominatimProvider);

    const response = await provider.search({ includeDetails: true, limit: 8, q: 'Calgary Tower' });

    expect(response.results[0]).toMatchObject({
      details: {
        address: '101 9 Avenue SW, Calgary, Alberta',
        openingHours: 'Mo-Su 10:00-21:00',
      },
      id: 'landmark:calgary-tower',
    });
  });

  it('enriches visible Calgary results with details found beyond the result limit', async () => {
    const source = {
      datasetVersion: 'test',
      freshness: 'fresh' as const,
      id: 'test',
      updatedAt: '2026-07-20T12:00:00Z',
    };
    const calgaryProvider = {
      search: () =>
        Promise.resolve({
          degraded: false,
          results: Array.from({ length: 8 }, (_, index) => ({
            category: 'poi' as const,
            center: { latitude: 51.0447 + index * 0.001, longitude: -114.0719 },
            confidence: 0.97,
            id: `calgary-business:${String(index)}`,
            label: `${index === 0 ? 'Test Cafe' : `Result ${String(index)}`}, Calgary, AB`,
            name: index === 0 ? 'Test Cafe' : `Result ${String(index)}`,
          })),
          source,
        }),
    };
    const nominatimProvider = {
      search: () =>
        Promise.resolve({
          degraded: false,
          results: [
            {
              category: 'poi' as const,
              center: { latitude: 51.0447, longitude: -114.0719 },
              confidence: 0.86,
              details: {
                openingHours: 'Mo-Su 07:00-20:00',
                phone: '+1 403 555 0100',
              },
              id: 'nominatim:node:1',
              label: 'Test Cafe, Calgary, Alberta',
              name: 'Test Cafe',
            },
          ],
          source,
        }),
    };
    const provider = createProductionSearchProvider([], nominatimProvider, calgaryProvider);

    const response = await provider.search({ includeDetails: true, limit: 8, q: 'Test Cafe' });

    expect(response.results).toHaveLength(8);
    expect(response.results.find((result) => result.id === 'calgary-business:0')).toMatchObject({
      details: {
        openingHours: 'Mo-Su 07:00-20:00',
        phone: '+1 403 555 0100',
      },
      id: 'calgary-business:0',
    });
  });

  it('ranks an exact official Calgary address above a nearby OSM substitute', async () => {
    const nominatimProvider = {
      search: () =>
        Promise.resolve({
          degraded: false,
          results: [
            {
              category: 'address' as const,
              center: { latitude: 51.0452, longitude: -114.058 },
              confidence: 0.55,
              id: 'nominatim:way:200',
              label: '750 Macleod Trail SE, Calgary, Alberta, Canada',
              name: '750 Macleod Trail SE',
            },
          ],
          source: {
            datasetVersion: 'alberta',
            freshness: 'fresh' as const,
            id: 'nominatim-self-hosted',
            updatedAt: '2026-07-20T12:00:00Z',
          },
        }),
    };
    const calgaryProvider = {
      search: () =>
        Promise.resolve({
          degraded: false,
          results: [
            {
              category: 'address' as const,
              center: { latitude: 51.04539715854496, longitude: -114.05792721246195 },
              confidence: 1,
              id: 'calgary-address:800',
              label: '800 Macleod Trail SE, Calgary, AB',
              name: '800 Macleod Trail SE',
            },
          ],
          source: {
            datasetVersion: 's8b3-j88p',
            freshness: 'fresh' as const,
            id: 'calgary-open-data-index',
            updatedAt: '2026-07-20T12:00:00Z',
          },
        }),
    };
    const provider = createProductionSearchProvider([], nominatimProvider, calgaryProvider);

    const response = await provider.search({ limit: 8, q: '800 Macleod Trail Southeast' });

    expect(response.results.map((result) => result.name)).toEqual([
      '800 Macleod Trail SE',
      '750 Macleod Trail SE',
    ]);
    expect(response.source.id).toBe('calgary-hybrid-search');
  });

  it('keeps distinct branches, cleans store numbers, and ranks equal matches by distance', async () => {
    const source = {
      datasetVersion: 'vdjc-pybd',
      freshness: 'fresh' as const,
      id: 'calgary-open-data-index',
      updatedAt: '2026-07-20T12:00:00Z',
    };
    const calgaryProvider = {
      search: () =>
        Promise.resolve({
          degraded: false,
          results: [
            {
              category: 'poi' as const,
              center: { latitude: 51.06, longitude: -114.09 },
              confidence: 0.99,
              id: 'calgary-business:1',
              label: 'Starbucks Coffee #22865, 555 8 Avenue SW, Calgary, AB',
              name: 'Starbucks Coffee #22865',
            },
            {
              category: 'poi' as const,
              center: { latitude: 51.045, longitude: -114.072 },
              confidence: 0.99,
              id: 'calgary-business:2',
              label: 'Starbucks Coffee #4412, 315 8 Avenue SW, Calgary, AB',
              name: 'Starbucks Coffee #4412',
            },
          ],
          source,
        }),
    };
    const provider = createProductionSearchProvider([], calgaryProvider);

    const response = await provider.search({
      latitude: 51.0447,
      limit: 8,
      longitude: -114.0719,
      q: 'Starbucks',
    });

    expect(response.results.map((result) => result.id)).toEqual([
      'calgary-business:2',
      'calgary-business:1',
    ]);
    expect(response.results[0]).toMatchObject({
      distanceMeters: 34,
      label: 'Starbucks Coffee, 315 8 Avenue SW, Calgary, AB',
      name: 'Starbucks Coffee',
    });
    expect(response.results[1]?.distanceMeters).toBeGreaterThan(1_000);
  });

  it('degrades to Nominatim when the Calgary index is unavailable', async () => {
    const source = {
      datasetVersion: 'alberta',
      freshness: 'fresh' as const,
      id: 'nominatim-self-hosted',
      updatedAt: '2026-07-20T12:00:00Z',
    };
    const nominatimProvider = {
      search: () =>
        Promise.resolve({
          degraded: false,
          results: [
            {
              category: 'landmark' as const,
              center: { latitude: 51.04427, longitude: -114.06309 },
              confidence: 0.98,
              id: 'nominatim:node:2359239747',
              label: 'Calgary Tower, Calgary, Alberta, Canada',
              name: 'Calgary Tower',
            },
          ],
          source,
        }),
    };
    const calgaryProvider = {
      search: () => Promise.reject(new Error('metadata unavailable')),
    };
    const provider = createProductionSearchProvider([], nominatimProvider, calgaryProvider);

    const response = await provider.search({ limit: 8, q: 'Calgary Tower' });

    expect(response.degraded).toBe(true);
    expect(response.results[0]?.id).toBe('nominatim:node:2359239747');
    expect(response.source.id).toBe('nominatim-self-hosted');
  });
});
