import { describe, expect, it } from 'vitest';

import {
  normalizeSearchText,
  placeSearchQueryVariants,
  prefixTsQuery,
  streetDirectionVariants,
} from '../src/search-text.js';
import { searchNameConfidence } from '../src/search-presentation.js';

describe('Calgary search text', () => {
  it('normalizes long and abbreviated Calgary addresses to the same key', () => {
    expect(normalizeSearchText('800 Macleod Trail Southeast')).toBe('800 macleod tr se');
    expect(normalizeSearchText('800 MACLEOD TR SE')).toBe('800 macleod tr se');
  });

  it('normalizes punctuation in business names for autocomplete', () => {
    expect(normalizeSearchText('Cosmos Collision')).toBe('cosmos collision');
    expect(normalizeSearchText('Co-op Wine, Spirits & Beer')).toBe('co op wine spirits and beer');
  });

  it('builds a prefix query from normalized words', () => {
    expect(prefixTsQuery('800 Macleod Trail SE')).toBe('800:* & macleod:* & tr:* & se:*');
  });

  it('expands Canadian theatre spelling and cinema-brand queries', () => {
    expect(placeSearchQueryVariants('chinook theater')).toEqual([
      'chinook theater',
      'chinook theatre',
    ]);
    expect(placeSearchQueryVariants('cineplex chinook')).toEqual([
      'cineplex chinook',
      'theatre chinook',
    ]);
  });
});

describe('street names given without their direction', () => {
  it('looks up French streets with French directions, accented or not', () => {
    for (const query of ['rue Sainte-Catherine', 'rue Ste-Catherine', 'Côte Saint-Antoine']) {
      expect(streetDirectionVariants(query)).toEqual(
        ['Ouest', 'Est', 'Nord', 'Sud'].map((direction) => `${query} ${direction}`),
      );
    }
    expect(streetDirectionVariants('cote Saint-Antoine')).toHaveLength(4);
    expect(normalizeSearchText('rue Ste-Catherine')).toBe(
      normalizeSearchText('Rue Sainte-Catherine'),
    );
    expect(normalizeSearchText('Sainte-Catherine Montréal')).toBe(
      normalizeSearchText('Sainte-Catherine Montreal'),
    );
  });

  it('looks up English streets and civic addresses with English directions', () => {
    expect(streetDirectionVariants('Yonge Street')).toEqual([
      'Yonge Street West',
      'Yonge Street East',
      'Yonge Street North',
      'Yonge Street South',
    ]);
    expect(streetDirectionVariants('100 Queen St')).toHaveLength(4);
  });

  it('adds nothing when the direction is given or the query is not a street', () => {
    for (const query of [
      '100 Queen St W',
      'Rue Sainte-Catherine Ouest',
      '17 Avenue SW',
      'Macleod Trail SE',
      'Costco',
      'Sainte-Catherine Montréal',
    ]) {
      expect(streetDirectionVariants(query)).toEqual([]);
    }
  });

  it('ranks the directional street with the exact name, not below it', () => {
    const query = 'rue Sainte-Catherine';
    expect(searchNameConfidence('Rue Sainte-Catherine Ouest', '', query, 0.5)).toBe(
      searchNameConfidence('Rue Sainte-Catherine', '', query, 0.5),
    );
    expect(searchNameConfidence('Rue Sainte-Catherine Ouest', '', query, 0.5)).toBe(0.98);
    expect(searchNameConfidence('Rue Sainte-Catherine Plaza', '', query, 0.5)).toBe(0.94);
  });
});
