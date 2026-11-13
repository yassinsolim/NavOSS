import { Pool } from 'pg';

/** Whether the configured PostgreSQL answers. Feeds `/ready`; carries no data. */
export interface DatabaseReadiness {
  close(): Promise<void>;
  isReady(): Promise<boolean>;
}

/**
 * A one-connection probe of the database the reports, contributions, traffic and Google budget
 * providers use. Undefined when no database is configured. The API keeps serving while the
 * database is down: database-backed routes answer 503 and `/ready` reports `not_ready`.
 */
export function createConfiguredDatabaseReadiness(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DatabaseReadiness | undefined {
  if (environment.PGHOST === undefined || environment.PGHOST === '') return undefined;
  const pool = new Pool({
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 10_000,
    max: 1,
    query_timeout: 3_000,
    statement_timeout: 2_000,
  });
  // An idle connection the server drops is reported here; unheard, it would end the process.
  pool.on('error', () => undefined);
  return {
    close: () => pool.end(),
    async isReady() {
      try {
        await pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
  };
}
