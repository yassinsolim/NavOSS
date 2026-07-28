import { describe, expect, it } from 'vitest';

import {
  approximateSearchCoordinate,
  formatSearchDistance,
  rankCategoryResults,
  rankSearchResults,
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
});
