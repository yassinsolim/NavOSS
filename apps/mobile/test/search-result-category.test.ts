import { describe, expect, it } from 'vitest';
import type { SearchResult } from '@navoss/contracts';

import { categoryLabel, searchResultSubtitle } from '../src/features/map/search-result-category.js';

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

describe('compact search result subtitles', () => {
  it.each([
    [
      'Costco',
      'Costco, 99, 6 Street SE, East Fairview Industrial, Calgary, Alberta, T2H 3A7, Canada',
      '99 6 Street SE, Calgary',
    ],
    [
      'University of Calgary',
      'University of Calgary, 2500, University Drive NW, University of Calgary, Calgary, Alberta, T2N 1N4, Canada',
      '2500 University Drive NW, Calgary',
    ],
    [
      'University',
      'University, Crowchild Trail NW, Banff Trail, Calgary, Alberta, T2M 4K6, Canada',
      'Crowchild Trail NW, Calgary',
    ],
    [
      'Costco',
      'Costco, Baron Road, Midtown, Kelowna, Westbank First Nation #9, Regional District of Central Okanagan, British Columbia, V1X 4H9, Canada',
      'Baron Road, Kelowna',
    ],
    ['Test Place', 'Test Place, Beltline, Calgary, AB', 'Beltline, Calgary'],
    ['2500 University Drive NW', '2500 University Drive NW, Calgary, AB', 'Calgary'],
    ['Costco', 'Costco, #101 100 Test Road, Calgary', '#101 100 Test Road, Calgary'],
    ['Test Place', 'Test Place', ''],
  ])('formats %s without the Nominatim breadcrumb', (name, label, expected) => {
    expect(searchResultSubtitle({ ...poi(), name, label })).toBe(expected);
  });

  it('preserves the sourced LRT acronym and human warehouse category', () => {
    expect(categoryLabel(poi({ category: 'lrt station' }), undefined)).toBe('LRT station');
    expect(categoryLabel(poi({ category: 'warehouse store' }), undefined)).toBe('Warehouse store');
    expect(categoryLabel(poi({ category: 'university' }), undefined)).toBe('University');
  });
});
