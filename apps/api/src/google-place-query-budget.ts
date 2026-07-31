import type { GooglePlaceQueryGrantResponse } from '@navoss/contracts';
import { Pool } from 'pg';

export const GOOGLE_PLACE_QUERY_MONTHLY_LIMIT = 8_000;

export interface GooglePlaceQueryBudget {
  close?(): Promise<void>;
  reserve(): Promise<GooglePlaceQueryGrantResponse>;
}

interface GooglePlaceQueryBudgetOptions {
  clock?: () => Date;
  limit?: number;
}

function periodFor(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function resetFor(date: Date): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString();
}

function responseFor(
  date: Date,
  limit: number,
  used: number,
  granted: boolean,
): GooglePlaceQueryGrantResponse {
  return {
    granted,
    limit,
    period: periodFor(date),
    remaining: Math.max(0, limit - used),
    resetsAt: resetFor(date),
  };
}

export function createInMemoryGooglePlaceQueryBudget(
  options: GooglePlaceQueryBudgetOptions = {},
): GooglePlaceQueryBudget {
  const clock = options.clock ?? (() => new Date());
  const limit = options.limit ?? GOOGLE_PLACE_QUERY_MONTHLY_LIMIT;
  const usage = new Map<string, number>();

  return {
    reserve: () => {
      const now = clock();
      const period = periodFor(now);
      const used = usage.get(period) ?? 0;
      if (used >= limit) {
        return Promise.resolve(responseFor(now, limit, used, false));
      }

      const nextUsed = used + 1;
      usage.set(period, nextUsed);
      return Promise.resolve(responseFor(now, limit, nextUsed, true));
    },
  };
}

export function createPostgresGooglePlaceQueryBudget(
  options: GooglePlaceQueryBudgetOptions = {},
): GooglePlaceQueryBudget {
  const clock = options.clock ?? (() => new Date());
  const limit = options.limit ?? GOOGLE_PLACE_QUERY_MONTHLY_LIMIT;
  const pool = new Pool();
  const initialized = pool.query(`
    CREATE TABLE IF NOT EXISTS google_place_query_budget (
      period text PRIMARY KEY CHECK (period ~ '^\\d{4}-\\d{2}$'),
      used integer NOT NULL CHECK (used >= 0),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  return {
    close: () => pool.end(),
    reserve: async () => {
      await initialized;
      const now = clock();
      const period = periodFor(now);
      const reservation = await pool.query<{ used: number }>(
        `
          INSERT INTO google_place_query_budget (period, used)
          VALUES ($1, 1)
          ON CONFLICT (period) DO UPDATE
          SET used = google_place_query_budget.used + 1, updated_at = now()
          WHERE google_place_query_budget.used < $2
          RETURNING used
        `,
        [period, limit],
      );
      const reservedUsage = reservation.rows[0]?.used;
      if (reservedUsage !== undefined) {
        return responseFor(now, limit, reservedUsage, true);
      }

      const current = await pool.query<{ used: number }>(
        'SELECT used FROM google_place_query_budget WHERE period = $1',
        [period],
      );
      return responseFor(now, limit, current.rows[0]?.used ?? limit, false);
    },
  };
}

export function createConfiguredGooglePlaceQueryBudget(
  options: GooglePlaceQueryBudgetOptions = {},
): GooglePlaceQueryBudget {
  return process.env.PGHOST === undefined
    ? createInMemoryGooglePlaceQueryBudget(options)
    : createPostgresGooglePlaceQueryBudget(options);
}
