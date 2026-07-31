import { describe, expect, it } from 'vitest';

import { mapRegionForCoordinate, mapRegionLabel } from '../src/features/map/map-region.js';

describe('map region', () => {
  it('selects regional context without a Calgary default', () => {
    expect(mapRegionForCoordinate({ latitude: 49.888, longitude: -119.496 })).toBe('kelowna-bc');
    expect(mapRegionForCoordinate({ latitude: 43.6532, longitude: -79.3832 })).toBe('ontario');
    expect(mapRegionForCoordinate({ latitude: 45.4215, longitude: -75.6972 })).toBe('ontario');
    expect(mapRegionForCoordinate({ latitude: 48.3809, longitude: -89.2477 })).toBe('ontario');
    expect(mapRegionForCoordinate({ latitude: 42.3149, longitude: -83.0364 })).toBe('ontario');
    expect(mapRegionForCoordinate({ latitude: 46.5219, longitude: -84.3461 })).toBe('ontario');
    expect(mapRegionForCoordinate({ latitude: 51.0447, longitude: -114.0719 })).toBe('calgary-ab');
    expect(mapRegionForCoordinate({ latitude: 41.8781, longitude: -87.6298 })).toBe('other');
    expect(mapRegionForCoordinate({ latitude: 46.7867, longitude: -92.1005 })).toBe('other');
    expect(mapRegionForCoordinate({ latitude: 42.8864, longitude: -78.8784 })).toBe('other');
    expect(mapRegionForCoordinate({ latitude: 42.3314, longitude: -83.0458 })).toBe('other');
    expect(mapRegionForCoordinate({ latitude: 46.4953, longitude: -84.3453 })).toBe('other');
    expect(mapRegionForCoordinate(undefined)).toBe('other');
    expect(mapRegionLabel('kelowna-bc')).toBe('Kelowna');
  });
});
