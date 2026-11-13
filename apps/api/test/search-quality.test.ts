/// <reference lib="es2024.promise" />

import { describe, expect, it } from 'vitest';
import { SearchResponseSchema, type SearchQuery, type SearchResult } from '@navoss/contracts';

import {
  buildNominatimSearchUrl,
  createDevelopmentSearchProvider,
  createNominatimSearchProvider,
  createPhotonSearchProvider,
  createProductionSearchProvider,
  type SearchProvider,
} from '../src/search-provider.js';
import {
  createRecordedSearchProvider,
  nominatimShapeFromPhoton,
  PHOTON_RESPONSE_RECORDING,
  recordedSearchCase,
  SEARCH_RESPONSE_RECORDING,
} from './support/search-response-fixture.js';

const CALGARY = { latitude: 51.0447, longitude: -114.0719 };
const SOURCE = {
  datasetVersion: 'test-vectors',
  freshness: 'fresh' as const,
  id: 'test-vectors',
  updatedAt: '2026-11-12T00:00:00Z',
};

function providerForResults(results: SearchResult[]): SearchProvider {
  return createProductionSearchProvider([], {
    search: () => Promise.resolve({ degraded: false, results, source: SOURCE }),
  });
}

// Synthetic geometry vectors are deliberately not destination fixtures or user-facing data.
function vector(id: string, name: string, label: string, category?: string): SearchResult {
  return {
    category: 'poi',
    center: { ...CALGARY },
    confidence: 0.9,
    ...(category === undefined ? {} : { details: { category } }),
    id,
    label,
    name,
  };
}

function nominatimProvider(payload: unknown[]): SearchProvider {
  return createNominatimSearchProvider({
    endpoint: 'http://recorded-nominatim.test/',
    fetchImplementation: () => Promise.resolve(new Response(JSON.stringify(payload))),
  });
}

describe('recorded production search quality', () => {
  it('merges all five University station components but not the university campus', async () => {
    const recorded = recordedSearchCase('University');
    expect(recorded.response.results.filter(({ name }) => name === 'University')).toHaveLength(5);
    const response = await createRecordedSearchProvider(recorded).search(recorded.query);

    expect(response.results[0]).toMatchObject({
      details: { category: 'university' },
      name: 'University of Calgary',
    });
    expect(response.results.filter(({ name }) => name === 'University')).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({ category: 'train station' }),
        id: 'nominatim:way:197609299',
        label: 'University, Crowchild Trail NW, Calgary',
      }),
    ]);
    expect(SearchResponseSchema.parse(response)).toEqual(response);
  });

  it('merges the fixture, administrative relation, campus node and campus way', async () => {
    const recorded = recordedSearchCase('University of Calgary');
    expect(
      recorded.response.results.filter(({ name }) => name === 'University of Calgary'),
    ).toHaveLength(4);
    const response = await createRecordedSearchProvider(recorded).search(recorded.query);

    expect(response.results.filter(({ name }) => name === 'University of Calgary')).toEqual([
      expect.objectContaining({
        center: { latitude: 51.07795, longitude: -114.13073 },
        details: expect.objectContaining({
          category: 'university',
          address: expect.stringContaining('2500'),
        }),
        id: 'poi:university-of-calgary',
        label: 'University of Calgary, 2500 University Drive NW, Calgary',
      }),
    ]);
    expect(response.results.some(({ name }) => name === 'Bookstore U Of C')).toBe(true);
  });

  it('keeps all recorded Costco warehouses and separate departments, removing source variants', async () => {
    const recorded = recordedSearchCase('Costco');
    const response = await createRecordedSearchProvider(recorded).search(recorded.query);
    const warehouses = response.results.filter(
      ({ details }) => details?.category === 'warehouse store',
    );

    // The wider 20-row recording includes Okotoks as well as the five reported warehouses.
    expect(warehouses.map(({ id }) => id)).toEqual([
      'nominatim:way:123813629',
      'nominatim:way:489111304',
      'nominatim:way:480637908',
      'nominatim:way:151473662',
      'nominatim:way:727403934',
      'nominatim:way:1136603092',
    ]);
    expect(
      response.results.some(({ id }) =>
        [
          'calgary-business:185298',
          'calgary-business:14231039',
          'calgary-business:12471371',
        ].includes(id),
      ),
    ).toBe(false);
    expect(response.results.some(({ name }) => name === 'Costco Liquor')).toBe(true);
    expect(response.results.some(({ name }) => name === 'Costco Pharmacy')).toBe(true);
    expect(response.results.some(({ name }) => name === 'Costco Food Court')).toBe(true);
    expect(response.results.at(-1)?.id).toBe('nominatim:way:1136603092');
    expect(response.results.map(({ distanceMeters }) => distanceMeters)).toEqual(
      response.results
        .map(({ distanceMeters }) => distanceMeters)
        .sort((left, right) => (left ?? 0) - (right ?? 0)),
    );
  });

  it('puts the explicitly named Kelowna warehouse above its nearby departments', async () => {
    const recorded = recordedSearchCase('Costco Kelowna');
    const response = await createRecordedSearchProvider(recorded).search(recorded.query);
    expect(response.results[0]).toMatchObject({
      details: { category: 'warehouse store' },
      id: 'nominatim:way:1136603092',
      label: 'Costco, Baron Road, Kelowna',
    });
  });

  it('preserves adjacent same-name civic addresses in the recorded business index', async () => {
    const recorded = recordedSearchCase('Calgary Tower');
    const original = recorded.response.results.filter(({ name }) => name === 'Richmond Towers');
    expect(original.length).toBeGreaterThan(1);
    const response = await createRecordedSearchProvider(recorded).search(recorded.query);
    expect(
      response.results
        .filter(({ name }) => name === 'Richmond Towers')
        .map(({ id }) => id)
        .sort(),
    ).toEqual(original.map(({ id }) => id).sort());
  });

  it.each(SEARCH_RESPONSE_RECORDING.cases)(
    'keeps $query.q ($query.latitude) contract-valid and compact',
    async (recorded) => {
      const response = await createRecordedSearchProvider(recorded).search(recorded.query);
      expect(SearchResponseSchema.parse(response)).toEqual(response);
      for (const result of response.results) {
        expect(result.label).not.toMatch(/, (?:Canada|Alberta|British Columbia)(?:,|$)/u);
        expect(result.label).not.toContain('Regional District of');
        expect(result.distanceMeters).toBeTypeOf('number');
      }
      if (recorded.query.category !== undefined) {
        expect(response.results.map(({ distanceMeters }) => distanceMeters)).toEqual(
          response.results
            .map(({ distanceMeters }) => distanceMeters)
            .sort((left, right) => (left ?? 0) - (right ?? 0)),
        );
      }
    },
  );
});

describe('conservative duplicate identity and representative selection', () => {
  it('keeps different businesses and different functions at the same address', async () => {
    const response = await providerForResults([
      vector('nominatim:way:1', 'Test Market', 'Test Market, 100 Test Road, Calgary', 'wholesale'),
      vector(
        'calgary-business:2',
        'Test Market Liquor',
        'Test Market Liquor, 100 Test Road, Calgary',
        'alcohol',
      ),
      vector('nominatim:node:3', 'Test Market', 'Test Market, 100 Test Road, Calgary', 'pharmacy'),
    ]).search({ ...CALGARY, limit: 20, q: 'Test Market' });
    expect(response.results).toHaveLength(3);
  });

  it('keeps very close branches with different civic numbers or units, including across sources', async () => {
    const response = await providerForResults([
      vector('nominatim:way:1', 'Test Chain', 'Test Chain, 100 Test Road, Calgary', 'cafe'),
      vector('calgary-business:2', 'Test Chain', 'Test Chain, 102 Test Road, Calgary', 'cafe'),
      vector('calgary-business:3', 'Test Chain', 'Test Chain, #101 100 Test Road, Calgary', 'cafe'),
      vector('nominatim:node:4', 'Test Chain', 'Test Chain, #102 100 Test Road, Calgary', 'cafe'),
    ]).search({ ...CALGARY, limit: 20, q: 'Test Chain' });
    // The unqualified 100-address record may enrich one unit; it must never connect two units.
    expect(response.results.some(({ id }) => id === 'calgary-business:2')).toBe(true);
    expect(response.results).toHaveLength(3);
  });

  it('does not collapse two same-provider complete footprints on name and proximity alone', async () => {
    const response = await providerForResults([
      vector('nominatim:way:1', 'Test Warehouse', 'Test Warehouse, Calgary', 'wholesale'),
      vector('nominatim:way:2', 'Test Warehouse', 'Test Warehouse, Calgary', 'wholesale'),
    ]).search({ ...CALGARY, limit: 8, q: 'Test Warehouse' });
    expect(response.results).toHaveLength(2);
  });

  it('uses a physical way over an equally addressed node, never an administrative boundary', async () => {
    const response = await nominatimProvider([
      {
        osm_type: 'relation',
        osm_id: 1,
        class: 'boundary',
        type: 'administrative',
        name: 'Test Campus',
        display_name: 'Test Campus, Calgary, Alberta, Canada',
        lat: 51.0447,
        lon: -114.0719,
      },
      {
        osm_type: 'node',
        osm_id: 2,
        class: 'amenity',
        type: 'university',
        name: 'Test Campus',
        display_name: 'Test Campus, 100, Test Road, Calgary, Alberta, Canada',
        lat: 51.0448,
        lon: -114.0719,
      },
      {
        osm_type: 'way',
        osm_id: 3,
        class: 'amenity',
        type: 'university',
        name: 'Test Campus',
        display_name: 'Test Campus, 100, Test Road, Calgary, Alberta, Canada',
        lat: 51.0449,
        lon: -114.0719,
      },
    ]).search({ ...CALGARY, includeDetails: true, limit: 8, q: 'Test Campus' });
    expect(response.results).toHaveLength(1);
    expect(response.results[0]?.id).toBe('nominatim:way:3');
  });

  it.each(['yes', 'private'])(
    'prefers an explicitly public main entrance, not access=%s',
    async (access) => {
      const response = await nominatimProvider([
        {
          osm_type: 'way',
          osm_id: 1,
          class: 'shop',
          type: 'wholesale',
          name: 'Test Store',
          display_name: 'Test Store, 100, Test Road, Calgary',
          lat: 51.0447,
          lon: -114.0719,
        },
        {
          osm_type: 'node',
          osm_id: 2,
          class: 'shop',
          type: 'wholesale',
          name: 'Test Store',
          display_name: 'Test Store, 100, Test Road, Calgary',
          lat: 51.0448,
          lon: -114.0719,
          extratags: { entrance: 'main', access },
        },
      ]).search({ ...CALGARY, includeDetails: true, limit: 8, q: 'Test Store' });
      expect(response.results).toHaveLength(1);
      expect(response.results[0]?.id).toBe(
        access === 'yes' ? 'nominatim:node:2' : 'nominatim:way:1',
      );
    },
  );

  it('does not chain station components beyond the radius through a better middle representative', async () => {
    const north = (meters: number) => CALGARY.latitude + meters / 111_195;
    const middleProvider = nominatimProvider([
      {
        osm_type: 'node',
        osm_id: 1,
        class: 'railway',
        type: 'platform',
        name: 'Test Station',
        display_name: 'Test Station, Test Road, Calgary',
        lat: north(0),
        lon: CALGARY.longitude,
      },
      {
        osm_type: 'way',
        osm_id: 2,
        class: 'railway',
        type: 'station',
        name: 'Test Station',
        display_name: 'Test Station, Test Road, Calgary',
        lat: north(140),
        lon: CALGARY.longitude,
      },
    ]);
    const far = vector(
      'calgary-business:3',
      'Test Station',
      'Test Station, Test Road, Calgary',
      'platform',
    );
    far.center.latitude = north(280);
    const response = await createProductionSearchProvider([], middleProvider, {
      search: () => Promise.resolve({ degraded: false, results: [far], source: SOURCE }),
    }).search({ ...CALGARY, includeDetails: true, limit: 8, q: 'Test Station' });
    expect(response.results).toHaveLength(2);
  });

  it('requires reliable class/type metadata for LRT and suppresses road/boundary jargon', async () => {
    const response = await createProductionSearchProvider(
      [],
      nominatimProvider([
        {
          osm_type: 'node',
          osm_id: 1,
          class: 'railway',
          type: 'station',
          name: 'Test LRT',
          display_name: 'Test LRT, Test Road, Calgary',
          lat: 51.0447,
          lon: -114.0719,
          extratags: { station: 'light_rail' },
        },
        {
          osm_type: 'way',
          osm_id: 2,
          class: 'highway',
          type: 'primary',
          name: 'Test Road',
          display_name: 'Test Road, Calgary',
          lat: 51.0448,
          lon: -114.0719,
        },
        {
          osm_type: 'relation',
          osm_id: 3,
          class: 'boundary',
          type: 'administrative',
          name: 'Test District',
          display_name: 'Test District, Calgary',
          lat: 51.0449,
          lon: -114.0719,
        },
      ]),
    ).search({ ...CALGARY, includeDetails: true, limit: 8, q: 'Test' });
    expect(response.results.find(({ id }) => id === 'nominatim:node:1')?.details?.category).toBe(
      'LRT station',
    );
    expect(
      response.results.find(({ id }) => id === 'nominatim:way:2')?.details?.category,
    ).toBeUndefined();
    expect(
      response.results.find(({ id }) => id === 'nominatim:relation:3')?.details?.category,
    ).toBeUndefined();
  });
});

describe('development aliases and province-wide proximity retrieval', () => {
  it('keeps University of Calgary first with the recorded live Photon response', async () => {
    const recorded = PHOTON_RESPONSE_RECORDING.cases.find(({ query }) => query.q === 'University');
    expect(recorded).toBeDefined();
    const provider = createDevelopmentSearchProvider(
      undefined,
      createPhotonSearchProvider({
        fetchImplementation: () =>
          Promise.resolve(new Response(JSON.stringify(recorded?.response))),
      }),
    );
    const response = await provider.search({
      ...CALGARY,
      includeDetails: true,
      limit: 8,
      q: 'University',
    });
    expect(response.results[0]).toMatchObject({
      confidence: 1,
      details: { category: 'university' },
      id: 'poi:university-of-calgary',
      name: 'University of Calgary',
    });
    expect(response.results.filter(({ name }) => name === 'University')).toHaveLength(1);
    expect(response.results.filter(({ name }) => name === 'University of Calgary')).toHaveLength(1);
  });

  it.each(PHOTON_RESPONSE_RECORDING.cases.filter(({ query }) => query.q !== 'University'))(
    'keeps Calgary fixtures/index out of $query.q ($query.latitude)',
    async (recorded) => {
      let calgaryCalls = 0;
      const nominatim = nominatimProvider(recorded.response.features.map(nominatimShapeFromPhoton));
      const provider = createProductionSearchProvider(undefined, nominatim, {
        search: () => {
          calgaryCalls += 1;
          return Promise.reject(new Error('Calgary index must not run outside its overlay area.'));
        },
      });
      const response = await provider.search({
        ...recorded.query,
        includeDetails: true,
        limit: 20,
      });
      expect(calgaryCalls).toBe(0);
      expect(response.results[0]?.label).toContain(
        recorded.query.q === 'Costco' ? 'Edmonton' : 'Vancouver',
      );
      expect(
        response.results.some(({ id }) => id.startsWith('poi:') || id.startsWith('calgary-')),
      ).toBe(false);
      expect(response.results[0]?.distanceMeters).toBeLessThan(10_000);
    },
  );

  it('starts local and provincial lookups concurrently with one shared timeout, merging both pools', async () => {
    const recorded = PHOTON_RESPONSE_RECORDING.cases.find(({ query }) => query.q === 'Costco');
    expect(recorded).toBeDefined();
    const query: SearchQuery = { ...recorded!.query, includeDetails: true, limit: 20 };
    const provinceViewbox = new URL(
      buildNominatimSearchUrl(query, 'http://recorded-nominatim.test/'),
    ).searchParams.get('viewbox');
    const calls: {
      viewbox: string | null;
      signal: AbortSignal | null | undefined;
      finish: (value: Response) => void;
    }[] = [];
    const provider = createNominatimSearchProvider({
      endpoint: 'http://recorded-nominatim.test/',
      fetchImplementation: (input, init) => {
        const { promise, resolve } = Promise.withResolvers<Response>();
        const url = new URL(String(input));
        calls.push({
          viewbox: url.searchParams.get('viewbox'),
          signal: init?.signal,
          finish: resolve,
        });
        return promise;
      },
    });
    const pending = provider.search(query);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.signal).toBe(calls[1]?.signal);
    expect(calls[0]?.viewbox).not.toBe(provinceViewbox);
    expect(calls[1]?.viewbox).toBe(provinceViewbox);
    const local = recorded!.response.features.slice(0, 3).map(nominatimShapeFromPhoton);
    const distant = PHOTON_RESPONSE_RECORDING.cases
      .find(({ query }) => query.q === 'University')!
      .response.features.filter(({ properties }) => properties.name === 'University of Calgary')
      .map(nominatimShapeFromPhoton);
    calls[0]?.finish(new Response(JSON.stringify(local)));
    calls[1]?.finish(new Response(JSON.stringify([...local, ...distant])));
    const response = await pending;
    expect(response.results[0]?.label).toContain('Edmonton');
    expect(response.results.filter(({ name }) => name === 'Costco')).toHaveLength(3);
    expect(response.results.some(({ name }) => name === 'University of Calgary')).toBe(true);
  });

  it('keeps categories nearest-first even if a farther result has the exact category name', async () => {
    const far = vector('nominatim:node:1', 'Cafe', 'Cafe, Test Road, Calgary', 'cafe');
    far.center.latitude += 0.05;
    const near = vector(
      'nominatim:node:2',
      'Test Coffee',
      'Test Coffee, Test Road, Calgary',
      'cafe',
    );
    const response = await providerForResults([far, near]).search({
      ...CALGARY,
      category: 'cafe',
      includeDetails: true,
      limit: 8,
      q: 'Cafe',
      sort: 'relevance',
    });
    expect(response.results.map(({ id }) => id)).toEqual(['nominatim:node:2', 'nominatim:node:1']);
  });

  it('puts unique exact and prefix name matches ahead of closer incidental matches', async () => {
    const exact = vector('nominatim:way:1', 'Test Landmark', 'Test Landmark, Test Road, Calgary');
    exact.center.latitude += 0.04;
    const prefix = vector(
      'nominatim:way:2',
      'Test Landmark Museum',
      'Test Landmark Museum, Test Road, Calgary',
    );
    prefix.center.latitude += 0.03;
    const incidental = vector(
      'nominatim:way:3',
      'Other Test Landmark',
      'Other Test Landmark, Test Road, Calgary',
    );
    const response = await providerForResults([incidental, prefix, exact]).search({
      ...CALGARY,
      limit: 8,
      q: 'Test Landmark',
      sort: 'relevance',
    });
    expect(response.results.map(({ id }) => id)).toEqual([
      'nominatim:way:1',
      'nominatim:way:2',
      'nominatim:way:3',
    ]);
  });
});

describe('retrieval and branch edge cases', () => {
  it('keeps a surviving provider pool visible and degraded when the other lookup fails', async () => {
    let requests = 0;
    const provider = createNominatimSearchProvider({
      endpoint: 'http://recorded-nominatim.test/',
      fetchImplementation: () => {
        requests += 1;
        return Promise.resolve(
          requests === 1
            ? new Response('unavailable', { status: 503 })
            : new Response(
                JSON.stringify([
                  {
                    osm_type: 'way',
                    osm_id: 1,
                    class: 'shop',
                    type: 'wholesale',
                    name: 'Test Store',
                    display_name: 'Test Store, 100, Test Road, Calgary',
                    lat: CALGARY.latitude,
                    lon: CALGARY.longitude,
                  },
                ]),
              ),
        );
      },
    });
    const response = await provider.search({
      ...CALGARY,
      includeDetails: true,
      limit: 8,
      q: 'Test Store',
    });
    expect(requests).toBe(2);
    expect(response.degraded).toBe(true);
    expect(response.results[0]?.name).toBe('Test Store');
  });

  it('does not turn a partial unique name into a brand because a longer street has many segments', async () => {
    const street = (id: number) => ({
      ...vector(`nominatim:way:${String(id)}`, 'Test Landmark Road', 'Test Landmark Road, Calgary'),
      category: 'street' as const,
    });
    const exact = vector('nominatim:node:1', 'Test Landmark', 'Test Landmark, Calgary', 'museum');
    exact.center.latitude += 0.04;
    const response = await providerForResults([street(2), street(3), exact]).search({
      ...CALGARY,
      limit: 8,
      q: 'Test Landmark',
    });
    expect(response.results[0]?.name).toBe('Test Landmark');
  });

  it('keeps separate same-provider complete nodes even at one shared civic address', async () => {
    const response = await providerForResults([
      vector('nominatim:node:1', 'Test Chain', 'Test Chain, 100 Test Road, Calgary', 'cafe'),
      vector('nominatim:node:2', 'Test Chain', 'Test Chain, 100 Test Road, Calgary', 'cafe'),
    ]).search({ ...CALGARY, limit: 8, q: 'Test Chain' });
    expect(response.results).toHaveLength(2);
  });

  it('uses a main entrance classification for coordinates without losing the business category', async () => {
    const response = await createProductionSearchProvider(
      [],
      nominatimProvider([
        {
          osm_type: 'way',
          osm_id: 1,
          class: 'shop',
          type: 'wholesale',
          name: 'Test Store',
          display_name: 'Test Store, 100, Test Road, Calgary',
          lat: 51.0447,
          lon: -114.0719,
        },
        {
          osm_type: 'node',
          osm_id: 2,
          class: 'entrance',
          type: 'main',
          name: 'Test Store Main Entrance',
          display_name: 'Test Store Main Entrance, 100, Test Road, Calgary',
          lat: 51.0448,
          lon: -114.0719,
        },
      ]),
    ).search({ ...CALGARY, includeDetails: true, limit: 8, q: 'Test Store' });
    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({
      id: 'nominatim:node:2',
      name: 'Test Store',
      details: { category: 'warehouse store' },
    });
  });
});
