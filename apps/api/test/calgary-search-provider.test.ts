import { describe, expect, it, vi } from 'vitest';

import { createPostgresCalgarySearchProvider } from '../src/calgary-search-provider.js';

const metadataRows = [
  {
    dataset_id: 'vdjc-pybd',
    dataset_updated_at: new Date('2026-07-20T00:00:00Z'),
    indexed_at: new Date('2026-07-20T12:00:00Z'),
    row_count: 18_861,
    source: 'business',
  },
  {
    dataset_id: 's8b3-j88p',
    dataset_updated_at: new Date('2026-07-20T00:00:00Z'),
    indexed_at: new Date('2026-07-20T12:00:00Z'),
    row_count: 418_471,
    source: 'address',
  },
];

type DatabaseQuery = (queryText: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;

describe('Calgary indexed search provider', () => {
  it('rejects metadata failures before starting a place query', async () => {
    const query = vi.fn<DatabaseQuery>().mockRejectedValueOnce(new Error('metadata unavailable'));
    const provider = createPostgresCalgarySearchProvider({ database: { query } });

    await expect(provider.search({ limit: 8, q: 'Calgary Tower' })).rejects.toThrow(
      'metadata unavailable',
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns authoritative business autocomplete results', async () => {
    const query = vi
      .fn<DatabaseQuery>()
      .mockResolvedValueOnce({ rows: metadataRows })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            category: 'poi',
            confidence: 0.99,
            id: 'calgary-business:40592',
            label: 'Cosmos Collision, 9298 Horton Rd SW, Haysboro, Calgary, AB',
            latitude: 50.9722075,
            longitude: -114.074147,
            name: 'Cosmos Collision',
          },
        ],
      });
    const provider = createPostgresCalgarySearchProvider({
      clock: () => Date.parse('2026-07-20T13:00:00Z'),
      database: { query },
    });

    const response = await provider.search({ limit: 8, q: 'Cosmos Collisions' });

    expect(query.mock.calls[1]?.[1]).toEqual([
      'cosmos collisions',
      'cosmos:* & collisions:*',
      8,
      null,
      null,
    ]);
    expect(query.mock.calls[2]?.[1]).toEqual(['cosmos collisions', 8, null, null, 0.58]);
    expect(response.results[0]).toMatchObject({
      center: { latitude: 50.9722075, longitude: -114.074147 },
      name: 'Cosmos Collision',
    });
    expect(response.source.id).toBe('calgary-open-data-index');
  });

  it('normalizes an exact long-form public address before querying', async () => {
    const query = vi
      .fn<DatabaseQuery>()
      .mockResolvedValueOnce({ rows: metadataRows })
      .mockResolvedValueOnce({
        rows: [
          {
            category: 'address',
            confidence: 1,
            id: 'calgary-address:800-macleod-tr-se',
            label: '800 Macleod Trail SE, Calgary, AB',
            latitude: 51.04539715854496,
            longitude: -114.05792721246195,
            name: '800 Macleod Trail SE',
          },
        ],
      });
    const provider = createPostgresCalgarySearchProvider({
      clock: () => Date.parse('2026-07-20T13:00:00Z'),
      database: { query },
    });

    const response = await provider.search({ limit: 8, q: '800 Macleod Trail Southeast' });

    expect(query.mock.calls[1]?.[1]?.[0]).toBe('800 macleod tr se');
    expect(response.results[0]).toMatchObject({
      category: 'address',
      confidence: 1,
      name: '800 Macleod Trail SE',
    });
  });
});
