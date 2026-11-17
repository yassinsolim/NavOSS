import { expect, it, vi } from 'vitest';

import type * as CoverageDataModule from '../../../packages/contracts/dist/coverage-data.js';

type CoverageData = typeof CoverageDataModule;

// The app resolves @navoss/contracts to its build; count evaluations of the boundary data there.
const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../../packages/contracts/dist/coverage-data.js', async (importOriginal) => {
  const original = await importOriginal<CoverageData>();
  return {
    ...original,
    loadServiceAreaData: () => {
      loads.count += 1;
      return original.loadServiceAreaData();
    },
  };
});

// Cold-imports app modules to measure load count, not time; static imports would run before this test.
it(
  'loads the app modules that use coverage without evaluating the boundary registry',
  async () => {
    await import('@navoss/contracts');
    await import('../src/lib/api');
    await import('../src/features/map/map-place');
    await import('../src/features/map/road-events');
    const { mapRegionForCoordinate } = await import('../src/features/map/map-region');
    expect(loads.count).toBe(0);

    expect(mapRegionForCoordinate({ latitude: 43.6525, longitude: -79.3832 })).toBe('ontario');
    expect(mapRegionForCoordinate({ latitude: 53.5461, longitude: -113.4938 })).toBe('alberta');
    expect(loads.count).toBe(1);
  },
  20_000,
);
