import { describe, expect, it } from 'vitest';

import {
  buildPhotonSearchUrl,
  createDevelopmentSearchProvider,
  createPhotonSearchProvider,
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
});
