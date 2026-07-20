import { describe, expect, it } from 'vitest';

import {
  assertDatasetSnapshotStable,
  normalizeAddressRow,
  normalizeBusinessRow,
  validateDatasetSnapshot,
} from '../src/calgary-search-indexer.js';
import { normalizeSearchText } from '../src/search-text.js';

describe('Calgary search index normalization', () => {
  it('rejects incomplete or implausibly reduced source snapshots', () => {
    const updatedAt = new Date('2026-07-20T12:00:00Z');

    expect(() => {
      validateDatasetSnapshot('business', { count: 0, updatedAt });
    }).toThrow('implausible record count');
    expect(() => {
      validateDatasetSnapshot('address', { count: 350_000, updatedAt }, 418_471);
    }).toThrow('dropped from 418471 to 350000');
    expect(() => {
      assertDatasetSnapshotStable(
        'address',
        { count: 418_471, updatedAt },
        { count: 418_470, updatedAt },
      );
    }).toThrow('changed during indexing');
  });

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

  it.each([
    ['GR', 'Green', 'green', 'gr'],
    ['GV', 'Grove', 'grove', 'gv'],
    ['HE', 'Heath', 'heath', 'he'],
    ['HT', 'Heights', 'heights', 'ht'],
    ['AV', 'Avenue', 'avenue', 'av'],
    ['HI', 'Highway', 'highway', 'hi'],
  ])('keeps City street code %s distinct as %s', (code, label, longForm, normalized) => {
    const result = normalizeAddressRow({
      house_number: '100',
      latitude: '51.05',
      longitude: '-114.08',
      street_name: 'EXAMPLE',
      street_quad: 'SW',
      street_type: code,
    });

    expect(result.name).toBe(`100 Example ${label} SW`);
    expect(result.normalizedName).toBe(`100 example ${normalized} sw`);
    expect(normalizeSearchText(`100 Example ${longForm} Southwest`)).toBe(
      `100 example ${normalized} sw`,
    );
  });
});
