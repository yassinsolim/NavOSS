import { describe, expect, it } from 'vitest';

import { normalizeAddressRow, normalizeBusinessRow } from '../src/calgary-search-indexer.js';

describe('Calgary search index normalization', () => {
  it('normalizes Cosmos Collision from the official business dataset', () => {
    expect(
      normalizeBusinessRow({
        address: '9298 HORTON RD SW',
        comdistnm: 'HAYSBORO',
        getbusid: '40592',
        licencetypes: 'AUTO BODY SHOP',
        point: { coordinates: [-114.074147, 50.9722075], type: 'Point' },
        tradename: 'COSMOS COLLISION',
      }),
    ).toMatchObject({
      id: 'calgary-business:40592',
      label: 'Cosmos Collision, 9298 Horton Rd SW, Haysboro, Calgary, AB',
      latitude: 50.9722075,
      longitude: -114.074147,
      name: 'Cosmos Collision',
      normalizedKeywords: 'auto body shop',
    });
  });

  it('normalizes a public Calgary parcel address', () => {
    expect(
      normalizeAddressRow({
        house_number: '800',
        latitude: '51.04539715854496',
        longitude: '-114.05792721246195',
        street_name: 'MACLEOD',
        street_quad: 'SE',
        street_type: 'TR',
      }),
    ).toMatchObject({
      category: 'address',
      label: '800 Macleod Trail SE, Calgary, AB',
      latitude: 51.04539715854496,
      longitude: -114.05792721246195,
      name: '800 Macleod Trail SE',
      normalizedName: '800 macleod tr se',
    });
  });
});
