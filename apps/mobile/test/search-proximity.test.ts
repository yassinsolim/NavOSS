import { describe, expect, it } from 'vitest';
import { SearchResponseSchema } from '@navoss/contracts';

import elboyaRecording from './fixtures/elboya-search-response.json';

import {
  approximateSearchCoordinate,
  formatSearchDistance,
  groupRecentSearchResults,
  planPlaceSearch,
  promoteExactNameMatches,
  rankCategoryResults,
  rankSearchResults,
  rankTypedSearchResults,
  searchProximityKey,
  searchProximityOptions,
  searchResultBounds,
  searchResultContext,
} from '../src/features/map/search-proximity.js';

describe('search proximity', () => {
  it('rounds precise user location before typed place search', () => {
    expect(approximateSearchCoordinate({ latitude: 51.0447312, longitude: -114.0719234 })).toEqual({
      latitude: 51.045,
      longitude: -114.072,
    });
  });

  it('preserves an unavailable search origin', () => {
    expect(approximateSearchCoordinate(undefined)).toBeUndefined();
  });

  it('requests a wider relevance-ranked pool whenever location is available', () => {
    expect(searchProximityOptions({ latitude: 51.0447312, longitude: -114.0719234 })).toEqual({
      latitude: 51.045,
      limit: 20,
      longitude: -114.072,
      sort: 'relevance',
    });
    expect(searchProximityOptions(undefined)).toEqual({ limit: 8 });
  });

  it('formats proximity for compact result rows', () => {
    expect(formatSearchDistance(34)).toBe('30 m');
    expect(formatSearchDistance(1_480)).toBe('1.5 km');
    expect(formatSearchDistance(undefined)).toBeUndefined();
  });

  it('removes the repeated place name from branch context', () => {
    expect(
      searchResultContext({
        category: 'poi',
        center: { latitude: 51.045, longitude: -114.072 },
        confidence: 0.99,
        distanceMeters: 34,
        id: 'calgary-business:2',
        label: 'Starbucks Coffee, 315 8 Avenue SW, Calgary, AB',
        name: 'Starbucks Coffee',
      }),
    ).toBe('315 8 Avenue SW, Calgary, AB');
  });

  it('bounds all matching branches for map framing', () => {
    const result = (id: string, latitude: number, longitude: number) => ({
      category: 'poi' as const,
      center: { latitude, longitude },
      confidence: 0.99,
      id,
      label: `Starbucks Coffee, ${id}`,
      name: 'Starbucks Coffee',
    });

    expect(
      searchResultBounds([
        result('west', 51.045, -114.08),
        result('north', 51.06, -114.07),
        result('south-east', 51.04, -114.06),
      ]),
    ).toEqual([-114.08, 51.04, -114.06, 51.06]);
    expect(searchResultBounds([])).toBeUndefined();
  });

  it('promotes recently routed branches and preserves distance order otherwise', () => {
    const result = (id: string, distanceMeters: number) => ({
      category: 'poi' as const,
      center: { latitude: 51.045, longitude: -114.072 },
      confidence: 0.99,
      distanceMeters,
      id,
      label: `Starbucks Coffee, ${id}`,
      name: 'Starbucks Coffee',
    });
    const distanceRanked = [result('nearest', 100), result('recent', 500), result('far', 1_000)];

    expect(rankSearchResults(distanceRanked, ['recent']).map(({ id }) => id)).toEqual([
      'recent',
      'nearest',
      'far',
    ]);
    expect(rankSearchResults(distanceRanked, []).map(({ id }) => id)).toEqual([
      'nearest',
      'recent',
      'far',
    ]);
  });

  it('orders typed results by exact distance before recent destinations', () => {
    const result = (id: string, longitude: number, distanceMeters: number) => ({
      category: 'poi' as const,
      center: { latitude: 51.045, longitude },
      confidence: 0.99,
      distanceMeters,
      id,
      label: `Shell, ${id}`,
      name: 'Shell',
    });

    expect(
      rankSearchResults(
        [result('recent-far', -114.08, 20), result('closest', -114.0721, 500)],
        ['recent-far'],
        { latitude: 51.045, longitude: -114.072 },
      ).map(({ id }) => id),
    ).toEqual(['closest', 'recent-far']);
  });

  it('orders category results by closest distance and leaves unknown distances last', () => {
    const result = (id: string, distanceMeters?: number) => ({
      category: 'poi' as const,
      center: { latitude: 51.045, longitude: -114.072 },
      confidence: 0.99,
      ...(distanceMeters === undefined ? {} : { distanceMeters }),
      id,
      label: `Restaurant, ${id}`,
      name: id,
    });

    expect(
      rankCategoryResults(
        [result('far', 2_000), result('unknown'), result('nearest', 80), result('middle', 600)],
        undefined,
        3,
      ).map(({ id }) => id),
    ).toEqual(['nearest', 'middle', 'far']);
  });

  it('uses exact on-device geometry instead of approximate server distances', () => {
    const result = (id: string, longitude: number, distanceMeters: number) => ({
      category: 'poi' as const,
      center: { latitude: 51.045, longitude },
      confidence: 0.99,
      distanceMeters,
      id,
      label: `Cafe, ${id}`,
      name: id,
    });

    const ranked = rankCategoryResults(
      [result('server-nearest', -114.074, 20), result('actually-nearest', -114.0721, 200)],
      { latitude: 51.045, longitude: -114.072 },
    );

    expect(ranked.map(({ id }) => id)).toEqual(['actually-nearest', 'server-nearest']);
    expect(ranked[0]?.distanceMeters).toBeLessThan(ranked[1]?.distanceMeters ?? 0);
  });

  describe('recent search matches', () => {
    const result = (id: string, distanceMeters: number) => ({
      category: 'poi' as const,
      center: { latitude: 51.045, longitude: -114.072 },
      confidence: 0.99,
      distanceMeters,
      id,
      label: `Cafe, ${id}`,
      name: 'Cafe',
    });

    it('shortlists only returned matches in history order, with at most three recents', () => {
      const results = [
        result('nearest', 100),
        result('older', 200),
        result('newest', 400),
        result('previous', 600),
        result('fourth-recent', 800),
      ];
      const grouped = groupRecentSearchResults(results, [
        'unmatched-history',
        'newest',
        'previous',
        'older',
        'fourth-recent',
      ]);

      expect(grouped.recentMatches.map(({ id }) => id)).toEqual(['newest', 'previous', 'older']);
      expect(grouped.recentMatches[0]).toBe(results[2]);
      expect(grouped.remainingResults.map(({ id }) => id)).toEqual(['nearest', 'fourth-recent']);
      expect(grouped.remainingResults.map(({ distanceMeters }) => distanceMeters)).toEqual([
        100, 800,
      ]);
    });

    it('never repeats a destination within or between the two groups', () => {
      const results = [result('nearest', 100), result('middle', 200), result('far', 800)];
      const grouped = groupRecentSearchResults(results, ['far', 'far', 'nearest', 'nearest']);

      expect(grouped.recentMatches.map(({ id }) => id)).toEqual(['far', 'nearest']);
      expect(grouped.remainingResults.map(({ id }) => id)).toEqual(['middle']);
      const displayedIds = [...grouped.recentMatches, ...grouped.remainingResults].map(
        ({ id }) => id,
      );
      expect(new Set(displayedIds).size).toBe(results.length);
    });

    it('leaves the ordinary result order and objects unchanged without matching history', () => {
      const results = [result('nearest', 100), result('middle', 200), result('far', 800)];

      for (const history of [[], ['unmatched-history']]) {
        const grouped = groupRecentSearchResults(results, history);
        expect(grouped.recentMatches).toEqual([]);
        expect(grouped.remainingResults).toBe(results);
      }
    });

    it('does not restore history IDs excluded from the current result pool', () => {
      const pool = [
        result('nearest', 100),
        result('excluded-branch', 200),
        result('matching-recent', 600),
      ];
      const results = pool.filter(({ id }) => id !== 'excluded-branch');
      const grouped = groupRecentSearchResults(results, ['excluded-branch', 'matching-recent']);

      expect(grouped.recentMatches.map(({ id }) => id)).toEqual(['matching-recent']);
      expect(grouped.remainingResults.map(({ id }) => id)).toEqual(['nearest']);
    });
  });

  describe('typed search settling while location updates arrive', () => {
    const here = { latitude: 51.0447312, longitude: -114.0719234 };
    const sameCell = { latitude: 51.0451, longitude: -114.0716 };
    const nextCell = { latitude: 51.0512, longitude: -114.0719 };

    it('keys requests by the rounded cell actually sent, not the raw fix', () => {
      expect(searchProximityKey(sameCell)).toBe(searchProximityKey(here));
      expect(searchProximityKey(nextCell)).not.toBe(searchProximityKey(here));
      expect(searchProximityKey(undefined)).toBe(searchProximityKey(undefined));
    });

    it('announces loading for the first search and for any different query', () => {
      const key = searchProximityKey(here);
      expect(planPlaceSearch('coffee', key, undefined)).toBe('search');
      expect(planPlaceSearch('coffee shop', key, { proximityKey: key, query: 'coffee' })).toBe(
        'search',
      );
    });

    it('settles on displayed results when a fix stays within the same cell', () => {
      const displayed = { proximityKey: searchProximityKey(here), query: 'Coffee' };
      expect(planPlaceSearch('coffee', searchProximityKey(sameCell), displayed)).toBe('skip');
    });

    it('refreshes the displayed query quietly when the driver enters a new cell', () => {
      const displayed = { proximityKey: searchProximityKey(here), query: 'coffee' };
      expect(planPlaceSearch('coffee', searchProximityKey(nextCell), displayed)).toBe('refresh');
    });

    it('converges back to the current cell when a late refresh settles results for another', () => {
      const hereKey = searchProximityKey(here);
      const nextKey = searchProximityKey(nextCell);
      // Settled here, refreshed toward the next cell, then the fix returned before that landed.
      expect(planPlaceSearch('coffee', hereKey, { proximityKey: hereKey, query: 'coffee' })).toBe(
        'skip',
      );
      const lateRefresh = { proximityKey: nextKey, query: 'coffee' };
      expect(planPlaceSearch('coffee', hereKey, lateRefresh)).toBe('refresh');
      expect(planPlaceSearch('coffee', hereKey, { proximityKey: hereKey, query: 'coffee' })).toBe(
        'skip',
      );
    });
  });
});

describe('exact name matches', () => {
  const place = (id: string, name: string) =>
    ({
      category: 'poi',
      center: { latitude: 51.04, longitude: -114.06 },
      confidence: 1,
      id,
      label: name,
      name,
    }) as const;
  const ranked = [
    place('a', 'Watermark Tower'),
    place('b', 'TD Canada Trust Tower'),
    place('c', 'Calgary Tower'),
    place('d', 'Dome Tower'),
  ];

  it('puts the place whose name was typed in full first and keeps the rest in ranked order', () => {
    expect(promoteExactNameMatches(ranked, ' calgary tower ').map((result) => result.id)).toEqual([
      'c',
      'a',
      'b',
      'd',
    ]);
  });

  it('leaves the ranking alone for a partial name', () => {
    expect(promoteExactNameMatches(ranked, 'Tower').map((result) => result.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(promoteExactNameMatches(ranked, '')).toEqual(ranked);
  });
});

describe('typed ranking before the visible cap', () => {
  const origin = { latitude: 51.0105, longitude: -114.0717 };
  const elboyaResponse = SearchResponseSchema.parse(elboyaRecording.response);

  it('keeps Calgary Tower visible using the unmodified old production response from Elboya', () => {
    const shown = rankTypedSearchResults(elboyaResponse.results, 'Calgary Tower', [], origin);
    expect(shown).toHaveLength(8);
    expect(shown[0]?.name).toBe('Calgary Tower');
  });

  it('promotes an exact name below eight higher opaque provider scores before slicing', () => {
    const tower = elboyaResponse.results.find(({ name }) => name === 'Calgary Tower');
    expect(tower).toBeDefined();
    const oldProviderPool = [
      ...Array.from({ length: 12 }, (_, index) => ({
        category: 'poi' as const,
        center: { latitude: origin.latitude + index * 0.0001, longitude: origin.longitude },
        confidence: 0.99,
        id: `test:${String(index)}`,
        label: `Other Tower ${String(index)}, Calgary`,
        name: `Other Tower ${String(index)}`,
      })),
      { ...tower!, confidence: 0.98 },
    ];
    expect(rankTypedSearchResults(oldProviderPool, 'Calgary Tower', [], origin)[0]?.name).toBe(
      'Calgary Tower',
    );
  });

  it('keeps same-name chain branches and prefix departments nearest-first', () => {
    const place = (id: string, name: string, latitude: number, longitude: number) => ({
      category: 'poi' as const,
      center: { latitude, longitude },
      confidence: 0.94,
      id,
      label: name,
      name,
    });
    const pool = [
      place('kelowna', 'Costco', 49.8799002, -119.4294067),
      place('east-hills', 'Costco', 51.0432499, -113.9174518),
      place('liquor', 'Costco Liquor', 50.9896247, -114.0463751),
      place('warehouse', 'Costco', 50.9897629, -114.0463494),
    ];
    expect(
      rankTypedSearchResults(pool, 'Costco', ['kelowna'], {
        latitude: 51.0447,
        longitude: -114.0719,
      }).map(({ id }) => id),
    ).toEqual(['warehouse', 'liquor', 'east-hills', 'kelowna']);
  });

  it('does not let a unique exact station name undo a stronger fixture alias', () => {
    const campus = {
      category: 'poi' as const,
      center: { latitude: 51.07795, longitude: -114.13073 },
      confidence: 1,
      id: 'campus',
      label: 'University of Calgary, Calgary',
      name: 'University of Calgary',
    };
    const station = {
      ...campus,
      confidence: 0.98,
      id: 'station',
      name: 'University',
      center: { latitude: 51.0799978, longitude: -114.1229561 },
    };
    expect(
      rankTypedSearchResults([station, campus], 'University', [], {
        latitude: 51.0447,
        longitude: -114.0719,
      }).map(({ id }) => id),
    ).toEqual(['campus', 'station']);
  });
});
