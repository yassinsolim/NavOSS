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

    const response = await provider.search({ limit: 8, q: 'Calgary Tower' });

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

  it('keeps distinct nearby branches from the same source', async () => {
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
              center: { latitude: 51.05, longitude: -114.08 },
              confidence: 0.99,
              id: 'calgary-business:1',
              label: 'Coffee Shop, Unit 1, Calgary, AB',
              name: 'Coffee Shop',
            },
            {
              category: 'poi' as const,
              center: { latitude: 51.0501, longitude: -114.0801 },
              confidence: 0.99,
              id: 'calgary-business:2',
              label: 'Coffee Shop, Unit 2, Calgary, AB',
              name: 'Coffee Shop',
            },
          ],
          source,
        }),
    };
    const provider = createProductionSearchProvider([], calgaryProvider);

    const response = await provider.search({ limit: 8, q: 'Coffee Shop' });

    expect(response.results.map((result) => result.id)).toEqual([
      'calgary-business:1',
      'calgary-business:2',
    ]);
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
