import { describe, expect, it } from 'vitest';

import {
  approximateSearchCoordinate,
  formatSearchDistance,
  groupRecentSearchResults,
  rankCategoryResults,
  rankSearchResults,
  searchProximityOptions,
  searchOriginWithinBounds,
  searchResultBounds,
  searchResultContext,
} from '../src/features/map/search-proximity.js';

describe('search proximity', () => {
  const calgaryBounds = {
    northEast: { latitude: 51.212, longitude: -113.859 },
    southWest: { latitude: 50.842, longitude: -114.316 },
  };

  it('uses Calgary origins but excludes Ontario origins from proximity ranking', () => {
    expect(
      searchOriginWithinBounds({ latitude: 51.0447, longitude: -114.0719 }, calgaryBounds),
    ).toEqual({ latitude: 51.0447, longitude: -114.0719 });
    expect(
      searchOriginWithinBounds({ latitude: 43.6532, longitude: -79.3832 }, calgaryBounds),
    ).toBeUndefined();
  });
  it('rounds precise user location before typed place search', () => {
    expect(approximateSearchCoordinate({ latitude: 51.0447312, longitude: -114.0719234 })).toEqual({
      latitude: 51.045,
      longitude: -114.072,
    });
  });

  it('preserves an unavailable search origin', () => {
    expect(approximateSearchCoordinate(undefined)).toBeUndefined();
  });

  it('requests a wider distance-sorted pool whenever location is available', () => {
    expect(searchProximityOptions({ latitude: 51.0447312, longitude: -114.0719234 })).toEqual({
      latitude: 51.045,
      limit: 20,
      longitude: -114.072,
      sort: 'distance',
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
});
