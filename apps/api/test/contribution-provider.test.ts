import { describe, expect, it } from 'vitest';

import { createInMemoryContributionProvider } from '../src/contribution-provider.js';
import type { ContributionProviderError } from '../src/contribution-provider.js';

const request = {
  createdAt: '2026-07-30T23:00:00.000Z',
  description: 'The place entrance is on the wrong side.',
  draftId: 'draft-1',
  locationLabel: 'Downtown Kelowna',
  type: 'place-correction' as const,
};

describe('contribution provider', () => {
  it('accepts idempotent anonymous submissions', async () => {
    const provider = createInMemoryContributionProvider({
      clock: () => new Date('2026-07-30T23:05:00.000Z'),
    });

    const first = await provider.submit(request);
    const repeated = await provider.submit(request);

    expect(first).toEqual(repeated);
    expect(first).toMatchObject({ acceptedAt: '2026-07-30T23:05:00.000Z', status: 'accepted' });
  });

  it('fails closed when the bounded pending queue is full', async () => {
    const provider = createInMemoryContributionProvider({ maximumPendingSubmissions: 1 });
    await provider.submit(request);

    await expect(provider.submit({ ...request, draftId: 'draft-2' })).rejects.toEqual(
      expect.objectContaining<Partial<ContributionProviderError>>({ reason: 'full' }),
    );
  });
});
