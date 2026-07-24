import { describe, expect, it } from 'vitest';

import {
  approximateSearchCoordinate,
  formatSearchDistance,
  rankSearchResults,
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
});
