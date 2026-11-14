import { Pool, type PoolClient, type PoolConfig } from 'pg';

/**
 * Bounded waits, enforced by PostgreSQL itself: the server cancels a statement or a lock wait that
 * runs too long and aborts its transaction, and ends a session left idle inside a transaction, so
 * a stuck request cannot hold locks or a backend beyond these limits. `connectionTimeoutMillis`
 * bounds waiting for a pooled connection. `query_timeout` is only a client-side margin for a
 * server that stops answering; on its own it would abandon the wait without cancelling anything
 * on the server. Every checked-out client is therefore released within these bounds, which also
 * bounds `pool.end()` at shutdown.
 */
export const BOUNDED_POOL_LIMITS = {
  connectionTimeoutMillis: 5_000,
  idle_in_transaction_session_timeout: 15_000,
  lock_timeout: 5_000,
  query_timeout: 15_000,
  statement_timeout: 10_000,
} as const satisfies PoolConfig;

/** A pool with `BOUNDED_POOL_LIMITS` that survives the server dropping an idle connection. */
export function createBoundedPool(max: number): Pool {
  const pool = new Pool({ ...BOUNDED_POOL_LIMITS, max });
  // An idle connection that the server closes (a restart, a terminated backend) is reported here;
  // without a listener it would be an uncaught error that ends the process.
  pool.on('error', () => undefined);
  return pool;
}

/**
 * Rolls back the client's failed transaction. Returns undefined once the rollback is confirmed,
 * or the error to release the client with when it is not: the connection may still be inside the
 * transaction, or still running the statement that failed, and must be destroyed rather than
 * returned to the pool.
 */
export async function rollbackOrDiscard(client: PoolClient): Promise<Error | undefined> {
  try {
    await client.query('ROLLBACK');
    return undefined;
  } catch (rollbackError: unknown) {
    return rollbackError instanceof Error ? rollbackError : new Error('Rollback failed.');
  }
}
