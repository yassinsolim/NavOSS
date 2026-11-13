import { fixtureValue } from '../../../packages/contracts/test/fixture-value.js';
import { SERVICE_AREAS } from '@navoss/contracts';
import { describe, expect, it } from 'vitest';
import borderPoints from '../../../packages/contracts/test/fixtures/coverage-border-points.json' with { type: 'json' };
import {
  isSearchCoverageRegion,
  mapRegionForCoordinate,
  mapRegionLabel,
  searchCoverageBoundsForRegion,
} from '../src/features/map/map-region.js';
import { isCoordinateInCoverage } from '../src/features/navigation/route-coverage.js';
describe('phone provincial coverage', () => {
  it.each(borderPoints.cases)(
    '$id agrees with the shared route/search service boundary',
    ({ coordinate, serviceAreaId }) => {
      const region = mapRegionForCoordinate(coordinate);
      expect(isCoordinateInCoverage(coordinate)).toBe(serviceAreaId !== null);
      expect(isSearchCoverageRegion(region)).toBe(serviceAreaId !== null);
      expect(searchCoverageBoundsForRegion(region)).toEqual(
        SERVICE_AREAS.find(({ id }) => id === serviceAreaId)?.bounds,
      );
    },
  );
  it('shows provincial context outside the local overlays without claiming province-wide overlays', () => {
    expect(mapRegionForCoordinate({ latitude: 53.5461, longitude: -113.4938 })).toBe('alberta');
    expect(mapRegionForCoordinate({ latitude: 49.2827, longitude: -123.1207 })).toBe(
      'british-columbia',
    );
    expect(mapRegionForCoordinate({ latitude: 48.4284, longitude: -123.3656 })).toBe(
      'british-columbia',
    );
    expect(mapRegionForCoordinate({ latitude: 51.04427, longitude: -114.06309 })).toBe(
      'calgary-ab',
    );
    expect(mapRegionForCoordinate({ latitude: 49.8879, longitude: -119.496 })).toBe('kelowna-bc');
    expect(mapRegionLabel('alberta')).toBe('Alberta');
    expect(mapRegionLabel('british-columbia')).toBe('British Columbia');
  });
  it('uses configured service-area polygons, not envelopes containing Washington or Alaska', () => {
    const bc = fixtureValue(SERVICE_AREAS.find(({ id }) => id === 'british-columbia'));
    expect(isCoordinateInCoverage({ latitude: 49.2827, longitude: -123.1207 }, bc)).toBe(true);
    expect(isCoordinateInCoverage({ latitude: 48.985, longitude: -123.052 }, bc)).toBe(false);
    expect(isCoordinateInCoverage({ latitude: 55.9177, longitude: -130.0241 }, bc)).toBe(false);
  });
});
