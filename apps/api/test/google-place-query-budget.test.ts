import { describe, expect, it } from 'vitest';

import { createInMemoryGooglePlaceQueryBudget } from '../src/google-place-query-budget.js';

describe('Google place query budget', () => {
  it('denies grants at the monthly cap and resets in the next UTC month', async () => {
    let now = new Date('2026-07-31T23:59:00Z');
    const budget = createInMemoryGooglePlaceQueryBudget({
      clock: () => now,
      limit: 2,
    });

    expect(await budget.reserve()).toMatchObject({
      granted: true,
      period: '2026-07',
      remaining: 1,
    });
    expect(await budget.reserve()).toMatchObject({
      granted: true,
      period: '2026-07',
      remaining: 0,
    });
    expect(await budget.reserve()).toMatchObject({
      granted: false,
      period: '2026-07',
      remaining: 0,
    });

    now = new Date('2026-08-01T00:00:00Z');
    expect(await budget.reserve()).toMatchObject({
      granted: true,
      period: '2026-08',
      remaining: 1,
      resetsAt: '2026-09-01T00:00:00.000Z',
    });
  });
});
