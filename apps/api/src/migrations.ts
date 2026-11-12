import { createHash } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

/**
 * Explicit, ordered, append-only SQL migrations. Applied by `node dist/migrate.js` (deploy step),
 * never implicitly by the API process. The API only checks that the schema is current.
 *
 * Tables created at runtime before this mechanism existed (contribution, search, and Google budget
 * tables) are intentionally left to their providers.
 *
 * Never edit an applied migration: the runner refuses to continue when a checksum changes.
 */
export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001_community_reports',
    sql: `
      CREATE EXTENSION IF NOT EXISTS postgis;

      CREATE TABLE community_challenges (
        challenge_hash bytea PRIMARY KEY CHECK (octet_length(challenge_hash) = 32),
        expires_at timestamptz NOT NULL
      );
      CREATE INDEX community_challenges_expires_at_idx ON community_challenges (expires_at);

      CREATE TABLE community_installations (
        id uuid PRIMARY KEY,
        key_id_hash bytea NOT NULL UNIQUE CHECK (octet_length(key_id_hash) = 32),
        sealed_public_key bytea NOT NULL,
        trust text NOT NULL CHECK (trust IN ('attested', 'untrusted')),
        sign_count bigint NOT NULL CHECK (sign_count >= 0),
        evidence_support double precision NOT NULL DEFAULT 0 CHECK (evidence_support >= 0),
        evidence_contradict double precision NOT NULL DEFAULT 0 CHECK (evidence_contradict >= 0),
        evidence_updated_at timestamptz NOT NULL,
        last_write_position geography(Point, 4326),
        last_write_at timestamptz,
        registered_at timestamptz NOT NULL,
        last_active_at timestamptz NOT NULL
      );
      CREATE INDEX community_installations_last_active_at_idx
        ON community_installations (last_active_at);

      CREATE TABLE community_reports (
        id uuid PRIMARY KEY,
        installation_id uuid NOT NULL
          REFERENCES community_installations (id) ON DELETE CASCADE,
        type text NOT NULL CHECK (type IN (
          'collision', 'road-closure', 'slow-traffic', 'construction',
          'pothole', 'object-on-road', 'road-hazard', 'stalled-vehicle'
        )),
        position geography(Point, 4326) NOT NULL,
        heading smallint CHECK (heading BETWEEN 0 AND 359),
        cell text NOT NULL,
        reporter_trust text NOT NULL CHECK (reporter_trust IN ('attested', 'untrusted')),
        reporter_weight double precision NOT NULL CHECK (reporter_weight > 0 AND reporter_weight <= 1),
        created_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL CHECK (expires_at >= created_at)
      );
      CREATE INDEX community_reports_position_idx ON community_reports USING gist (position);
      CREATE INDEX community_reports_expires_at_idx ON community_reports (expires_at);
      CREATE INDEX community_reports_installation_idx
        ON community_reports (installation_id, created_at);
      CREATE INDEX community_reports_cell_idx ON community_reports (cell, created_at);

      CREATE TABLE community_report_votes (
        report_id uuid NOT NULL REFERENCES community_reports (id) ON DELETE CASCADE,
        installation_id uuid NOT NULL
          REFERENCES community_installations (id) ON DELETE CASCADE,
        vote text NOT NULL CHECK (vote IN ('present', 'not-present')),
        weight double precision NOT NULL CHECK (weight > 0 AND weight <= 1),
        created_at timestamptz NOT NULL,
        PRIMARY KEY (report_id, installation_id)
      );
      CREATE INDEX community_report_votes_installation_idx
        ON community_report_votes (installation_id, created_at);
    `,
  },
];

const MIGRATIONS_TABLE = 'navoss_schema_migrations';

function checksum(migration: Migration): string {
  return createHash('sha256').update(migration.sql).digest('hex');
}

async function ensureMigrationsTable(pool: Pool | PoolClient): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function appliedChecksums(pool: Pool | PoolClient): Promise<Map<string, string>> {
  const result = await pool.query<{ checksum: string; id: string }>(
    `SELECT id, checksum FROM ${MIGRATIONS_TABLE}`,
  );
  return new Map(result.rows.map((row) => [row.id, row.checksum]));
}

export class MigrationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

/** Applies pending migrations in order, each in its own transaction, under an advisory lock. */
export async function runMigrations(
  pool: Pool,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('navoss_schema_migrations'))");
    await ensureMigrationsTable(client);
    const existing = await appliedChecksums(client);
    for (const migration of migrations) {
      const recorded = existing.get(migration.id);
      if (recorded !== undefined) {
        if (recorded !== checksum(migration)) {
          throw new MigrationError(`Applied migration ${migration.id} was modified.`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (id, checksum) VALUES ($1, $2)`, [
          migration.id,
          checksum(migration),
        ]);
        await client.query('COMMIT');
      } catch (error: unknown) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
      applied.push(migration.id);
    }
    return applied;
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext('navoss_schema_migrations'))")
      .catch(() => undefined);
    client.release();
  }
}

/** Ids of migrations not yet applied (or modified), without changing anything. */
export async function pendingMigrations(
  pool: Pool,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<string[]> {
  const table = await pool.query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [MIGRATIONS_TABLE],
  );
  if (table.rows[0]?.present !== true) return migrations.map((migration) => migration.id);
  const existing = await appliedChecksums(pool);
  return migrations
    .filter((migration) => existing.get(migration.id) !== checksum(migration))
    .map((migration) => migration.id);
}
