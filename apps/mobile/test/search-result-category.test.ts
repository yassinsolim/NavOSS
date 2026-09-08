import { describe, expect, it } from 'vitest';
import type { SearchResult } from '@navoss/contracts';

import { categoryLabel } from '../src/features/map/search-result-category.js';

function poi(details?: SearchResult['details']): SearchResult {
  return {
    category: 'poi',
    center: { latitude: 51.0447, longitude: -114.0719 },
    confidence: 0.9,
    id: 'poi:test',
    label: 'Test Place, Calgary, AB',
    name: 'Test Place',
    ...(details === undefined ? {} : { details }),
  };
}

describe('categoryLabel', () => {
  it('prefers the provider-supplied detail category for a POI', () => {
    expect(categoryLabel(poi({ category: 'gas station' }), undefined)).toBe('Gas station');
    expect(categoryLabel(poi({ category: 'italian restaurant' }), undefined)).toBe(
      'Italian restaurant',
    );
  });

  it('formats raw metadata from an already deployed API', () => {
    expect(categoryLabel(poi({ category: 'fuel' }), undefined)).toBe('Gas station');
    expect(categoryLabel(poi({ category: 'fast_food' }), undefined)).toBe('Fast Food');
  });

  it('shows business metadata even when the search result uses address precision', () => {
    const cafe: SearchResult = { ...poi({ category: 'café' }), category: 'address' };
    expect(categoryLabel(cafe, undefined)).toBe('Café');
  });

  it.each([
    { category: 'street', metadata: 'residential' },
    { category: 'neighborhood', metadata: 'suburb' },
    { category: 'address', metadata: 'house' },
  ] as const)(
    'keeps $category labels instead of road or house jargon',
    ({ category, metadata }) => {
      expect(categoryLabel({ ...poi({ category: metadata }), category }, undefined)).toBe(category);
    },
  );
  it.each(['yes', 'no', 'unknown', 'point of interest', 'point_of_interest', 'shop'])(
    'does not display the placeholder %s as a description',
    (category) => {
      expect(categoryLabel(poi({ category }), undefined)).toBe('');
      expect(categoryLabel(poi({ category }), 'Restaurants')).toBe('Restaurants');
    },
  );

  it('bounds an unexpectedly long detail category to three words', () => {
    expect(categoryLabel(poi({ category: 'one two three four five' }), undefined)).toBe(
      'One two three',
    );
  });

  it('ignores a blank or whitespace-only detail category', () => {
    expect(categoryLabel(poi({ category: '   ' }), 'Restaurants')).toBe('Restaurants');
    expect(categoryLabel(poi(undefined), undefined)).toBe('');
  });

  it('falls back to the active browse category when no detail is available', () => {
    expect(categoryLabel(poi(undefined), 'Restaurants')).toBe('Restaurants');
  });

  it('omits the badge for a POI with neither detail nor active category', () => {
    expect(categoryLabel(poi(undefined), undefined)).toBe('');
  });

  it('never falls back to the generic "Point of interest" label', () => {
    expect(categoryLabel(poi(undefined), undefined)).not.toMatch(/point of interest/i);
    expect(categoryLabel(poi({ category: 'cafe' }), undefined)).not.toMatch(/point of interest/i);
  });

  it('formats non-POI enum categories without the raw enum casing', () => {
    expect(
      categoryLabel(
        {
          category: 'address',
          center: { latitude: 51.0447, longitude: -114.0719 },
          confidence: 0.9,
          id: 'address:test',
          label: '123 Test Street SW, Calgary, AB',
          name: '123 Test Street SW',
        },
        undefined,
      ),
    ).toBe('address');
    expect(
      categoryLabel(
        {
          category: 'street',
          center: { latitude: 51.0447, longitude: -114.0719 },
          confidence: 0.9,
          id: 'street:test',
          label: '17 Avenue SW, Calgary',
          name: '17 Avenue SW',
        },
        undefined,
      ),
    ).toBe('street');
  });
});
