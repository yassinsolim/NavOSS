import { createHash } from 'node:crypto';

import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import type { AppAttestVerifier } from '../src/app-attest.js';
import { BOUNDED_POOL_LIMITS } from '../src/bounded-pool.js';
import { CommunityReportError, createCommunityReportService } from '../src/community-reports.js';
import { MIGRATIONS } from '../src/migrations.js';

/**
 * A community database whose schema is current and whose installation lookup fails the way a
 * lock wait cancelled by `lock_timeout` does; ROLLBACK then succeeds or cannot be confirmed.
 */
function lockedDatabase(rollback: 'fails' | 'succeeds') {
  const released: unknown[] = [];
  const client = {
    query: (sql: string) => {
      if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
      if (sql === 'ROLLBACK') {
        return rollback === 'fails'
          ? Promise.reject(new Error('Query read timeout'))
          : Promise.resolve({ rows: [] });
      }
      return Promise.reject(
        Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
      );
    },
    release: (error?: unknown) => {
      released.push(error);
    },
  };
  const pool = {
    connect: () => Promise.resolve(client),
    query: (sql: string) => {
      if (sql.includes('to_regclass')) return Promise.resolve({ rows: [{ present: true }] });
      if (sql.includes('SELECT id, checksum')) {
        return Promise.resolve({
          rows: MIGRATIONS.map((migration) => ({
            checksum: createHash('sha256').update(migration.sql).digest('hex'),
            id: migration.id,
          })),
        });
      }
      // The one-use challenge is consumed.
      return Promise.resolve({ rowCount: 1, rows: [] });
    },
  } as unknown as Pool;
  const service = createCommunityReportService({
    attestationMode: 'enforce',
    installationSecret: Buffer.alloc(32, 7),
    isInCoverage: () => true,
    pool,
    publication: 'shadow',
    verifier: { rpIdHash: Buffer.alloc(32) } as unknown as AppAttestVerifier,
  });
  const assert = () =>
    service.assertTrafficContributor({
      assertion: Buffer.from('assertion').toString('base64'),
      challenge: Buffer.alloc(32, 1).toString('base64url'),
      keyId: Buffer.from('key').toString('base64'),
    });
  return { assert, released };
}

describe('community report transactions', () => {
  it('reports a lock wait cancelled by the server as busy and reuses the rolled-back connection', async () => {
    const { assert, released } = lockedDatabase('succeeds');
    await expect(assert()).rejects.toMatchObject({ reason: 'busy' });
    expect(released).toEqual([undefined]);
  });

  it('destroys a connection whose rollback cannot be confirmed', async () => {
    const { assert, released } = lockedDatabase('fails');
    const failure = await assert().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CommunityReportError);
    expect(failure).toMatchObject({ reason: 'unavailable' });
    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error);
  });

  it('bounds statements, lock waits and idle transactions on the server', () => {
    expect(BOUNDED_POOL_LIMITS.lock_timeout).toBeLessThan(BOUNDED_POOL_LIMITS.statement_timeout);
    expect(BOUNDED_POOL_LIMITS.statement_timeout).toBeLessThan(BOUNDED_POOL_LIMITS.query_timeout);
    expect(BOUNDED_POOL_LIMITS.idle_in_transaction_session_timeout).toBeGreaterThan(0);
    expect(BOUNDED_POOL_LIMITS.connectionTimeoutMillis).toBeGreaterThan(0);
  });
});
