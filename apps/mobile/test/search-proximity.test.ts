import { describe, expect, it } from 'vitest';

import { approximateSearchCoordinate } from '../src/features/map/search-proximity.js';

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
});
