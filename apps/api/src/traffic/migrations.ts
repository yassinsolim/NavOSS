import type { PoolClient } from 'pg';

/**
 * Ordered, append-only schema migrations for the community-traffic tables. Never edit a released
 * entry; add a new one. Applied ids are tracked in `traffic_schema_migrations`.
 */
export const TRAFFIC_MIGRATIONS: readonly { id: string; sql: string }[] = [
  {
    id: '0001_community_traffic',
    sql: `
      CREATE EXTENSION IF NOT EXISTS postgis;

      -- One row per road segment (OSM way + direction) that currently has live samples.
      -- geom is OpenStreetMap road geometry from the routing graph, never an uploaded position.
      CREATE TABLE traffic_segments (
        segment_key text PRIMARY KEY CHECK (segment_key ~ '^w[0-9]+[fb]$'),
        way_id bigint NOT NULL,
        forward boolean NOT NULL,
        road_class text NOT NULL,
        free_flow_kph smallint NOT NULL CHECK (free_flow_kph BETWEEN 1 AND 200),
        speed_limit_kph smallint CHECK (speed_limit_kph BETWEEN 1 AND 200),
        geom geometry(MultiLineString, 4326)
      );
      CREATE INDEX traffic_segments_geom_idx ON traffic_segments USING gist (geom);

      -- Aggregates only: a speed histogram and per-segment contributor tokens per time bucket.
      -- There is no position, no trace, no device or trip identifier, and no time finer than
      -- the bucket. Tokens are keyed hashes whose key never leaves API process memory.
      CREATE TABLE traffic_flow_buckets (
        segment_key text NOT NULL REFERENCES traffic_segments (segment_key) ON DELETE CASCADE,
        bucket_start timestamptz NOT NULL,
        sample_count integer NOT NULL CHECK (sample_count > 0),
        speed_histogram integer[] NOT NULL,
        contributor_tokens bigint[] NOT NULL,
        PRIMARY KEY (segment_key, bucket_start)
      );
      CREATE INDEX traffic_flow_buckets_bucket_start_idx ON traffic_flow_buckets (bucket_start);
    `,
  },
];

export async function applyTrafficMigrations(client: PoolClient): Promise<string[]> {
  const applied: string[] = [];
  await client.query('BEGIN');
  try {
    // Serialises concurrent starters; the key is arbitrary but fixed for this migration set.
    await client.query('SELECT pg_advisory_xact_lock(7426110534)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS traffic_schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const existing = await client.query<{ id: string }>('SELECT id FROM traffic_schema_migrations');
    const done = new Set(existing.rows.map(({ id }) => id));
    for (const migration of TRAFFIC_MIGRATIONS) {
      if (done.has(migration.id)) continue;
      await client.query(migration.sql);
      await client.query('INSERT INTO traffic_schema_migrations (id) VALUES ($1)', [migration.id]);
      applied.push(migration.id);
    }
    await client.query('COMMIT');
    return applied;
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
