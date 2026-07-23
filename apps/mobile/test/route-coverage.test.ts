import { describe, expect, it } from 'vitest';

import { isCoordinateInCoverage } from '../src/features/navigation/route-coverage';

const calgaryBounds = {
  northEast: { latitude: 51.212, longitude: -113.859 },
  southWest: { latitude: 50.842, longitude: -114.316 },
};

describe('route coverage', () => {
  it('accepts Calgary coordinates including the boundary', () => {
    expect(
      isCoordinateInCoverage({ latitude: 51.04427, longitude: -114.06309 }, calgaryBounds),
    ).toBe(true);
    expect(isCoordinateInCoverage(calgaryBounds.northEast, calgaryBounds)).toBe(true);
    expect(isCoordinateInCoverage(calgaryBounds.southWest, calgaryBounds)).toBe(true);
  });

  it('rejects coordinates outside the configured coverage', () => {
    expect(isCoordinateInCoverage({ latitude: 37.7749, longitude: -122.4194 }, calgaryBounds)).toBe(
      false,
    );
    expect(isCoordinateInCoverage({ latitude: 51.04427, longitude: -113.8 }, calgaryBounds)).toBe(
      false,
    );
  });
});
