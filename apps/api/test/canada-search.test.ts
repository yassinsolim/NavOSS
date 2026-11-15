import { describe, expect, it } from 'vitest';
import { SearchResponseSchema, type SearchResult } from '@navoss/contracts';

import { searchRecordedCanada } from './support/search-response-fixture.js';

const TORONTO = { latitude: 43.653, longitude: -79.383 };
const VANCOUVER = { latitude: 49.283, longitude: -123.121 };
const CALGARY = { latitude: 51.045, longitude: -114.072 };

function rows(results: readonly SearchResult[]) {
  return results.map(({ category, details, label, name }) => ({
    category,
    kind: details?.category,
    label,
    name,
  }));
}

describe('Canadian civic address search (recorded raw Nominatim)', () => {
  it('titles "100 Queen St W" from Toronto with the street address, nearest first', async () => {
    const { response } = await searchRecordedCanada('100 Queen St W', TORONTO);

    expect(SearchResponseSchema.parse(response)).toEqual(response);
    expect(response.results.some(({ name }) => name === '100')).toBe(false);
    expect(rows(response.results.slice(0, 3))).toEqual([
      {
        category: 'address',
        kind: undefined,
        label: '100 Queen Street West, Toronto, Ontario',
        name: '100 Queen Street West',
      },
      {
        category: 'address',
        kind: undefined,
        label: '100 Queen Street West, Brampton, Ontario',
        name: '100 Queen Street West',
      },
      {
        category: 'address',
        kind: undefined,
        label: '100 Queen Street West, Cambridge, Ontario',
        name: '100 Queen Street West',
      },
    ]);
    const addresses = response.results.filter(({ category }) => category === 'address');
    // Far same-named addresses stay below the near one and each names its municipality.
    expect(new Set(addresses.map(({ label }) => label)).size).toBe(addresses.length);
    expect(addresses.map(({ distanceMeters }) => distanceMeters)).toEqual(
      addresses.map(({ distanceMeters }) => distanceMeters).sort((a, b) => (a ?? 0) - (b ?? 0)),
    );
    // Named places at the address (City Hall, its library) follow the address itself.
    const firstNamedPlace = response.results.findIndex(({ category }) => category !== 'address');
    expect(firstNamedPlace).toBeGreaterThan(0);
    expect(response.results[0]?.confidence).toBeGreaterThan(
      response.results[firstNamedPlace]?.confidence ?? 1,
    );
  });

  it('collapses two unnamed points of one Toronto address and keeps the city distinct', async () => {
    const { response } = await searchRecordedCanada('1 Dundas St W', TORONTO);

    const toronto = response.results.filter(
      ({ label }) => label === '1 Dundas Street West, Toronto, Ontario',
    );
    expect(toronto).toHaveLength(1);
    expect(response.results[0]).toMatchObject({
      category: 'address',
      label: '1 Dundas Street West, Toronto, Ontario',
      name: '1 Dundas Street West',
    });
  });

  it('presents an unnamed object found by its address as that address, not as the object', async () => {
    const { response } = await searchRecordedCanada('1055 Canada Pl', VANCOUVER);

    expect(rows(response.results.slice(0, 2))).toEqual([
      {
        category: 'address',
        kind: undefined,
        label: '1055 Canada Place, Vancouver, British Columbia',
        name: '1055 Canada Place',
      },
      {
        category: 'poi',
        kind: 'conference centre',
        label: 'Vancouver Convention Centre West, 1055 Canada Place, Vancouver',
        name: 'Vancouver Convention Centre West',
      },
    ]);
    expect(response.results.some(({ details }) => details?.category === 'toilets')).toBe(false);
  });

  it('types a numbered street ("17 Avenue SW") as a street, not an address', async () => {
    const { response } = await searchRecordedCanada('17 Avenue SW', CALGARY);

    expect(response.results[0]).toMatchObject({ category: 'street', name: '17 Avenue SW' });
    expect(
      response.results
        .filter(({ name }) => name === '17 Avenue SW')
        .map(({ category }) => category),
    ).not.toContain('address');
  });
});
