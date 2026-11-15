import { expect, it, vi } from 'vitest';

import type * as CoverageDataModule from '../src/coverage-data.js';

type CoverageData = typeof CoverageDataModule;

// Counts how often the 1.1 MB boundary data is evaluated, through the one function that builds it.
const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/coverage-data.js', async (importOriginal) => {
  const original = await importOriginal<CoverageData>();
  return {
    ...original,
    loadServiceAreaData: () => {
      loads.count += 1;
      return original.loadServiceAreaData();
    },
  };
});

it('evaluates the boundary registry on the first eligibility check, once, not on import', async () => {
  const contracts = await import('../src/index.js');
  expect(loads.count).toBe(0);

  const calgary = { latitude: 51.04427, longitude: -114.06309 };
  expect(contracts.provinceForCoordinate(calgary)?.area.id).toBe('alberta');
  expect(contracts.createServiceCoverage(['ontario']).contains(calgary)).toBe(false);
  expect(contracts.registeredServiceAreas()).toHaveLength(13);
  expect(loads.count).toBe(1);
});
