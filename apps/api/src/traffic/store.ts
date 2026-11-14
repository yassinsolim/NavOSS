import type { TrafficFlowBounds } from '@navoss/contracts';
import type { Pool, PoolConfig } from 'pg';

import { BOUNDED_POOL_LIMITS, createBoundedPool, rollbackOrDiscard } from '../bounded-pool.js';
import { pendingMigrations } from '../migrations.js';
import type { TrafficRelease } from './cohorts.js';
import type { Position } from './geo.js';

/**
 * The store does not hold the published snapshot of the epoch a read asked for: it was never
 * published in this store, a newer one replaced it, or storage lost it (an API restart, or a
 * database crash that emptied the unlogged tables).
 */
export class TrafficEpochNotStoredError extends Error {
  public constructor() {
    super('The requested community traffic epoch is not stored.');
    this.name = 'TrafficEpochNotStoredError';
  }
}

/**
 * Storage for published releases only. Nothing below the contributor threshold is ever passed to
 * a store, and every read is as of an epoch boundary: a release is visible from the boundary that
 * produced it until the boundary at which it expires, whether or not cleanup has run. Reads reject
 * with `TrafficEpochNotStoredError` unless the store still holds exactly the snapshot that
 * `publishEpoch` wrote for that boundary.
 */
export interface TrafficReleaseStore {
  byKeys(keys: readonly string[], epochStartMs: number): Promise<TrafficRelease[]>;
  close(): Promise<void>;
  inBounds(
    bounds: TrafficFlowBounds,
    epochStartMs: number,
    limit: number,
  ): Promise<{ releases: TrafficRelease[]; truncated: boolean }>;
  /**
   * Applies one epoch boundary atomically: removes everything that expired at or before it,
   * writes that epoch's releases, replacing an older value for the same segment, and records
   * that the stored rows are that epoch's snapshot.
   */
  publishEpoch(epochStartMs: number, releases: readonly TrafficRelease[]): Promise<void>;
  /** Erases every stored release and the snapshot record. Succeeds without a schema. */
  purge(): Promise<void>;
  /** Rejects unless the storage schema is current. */
  ready(): Promise<void>;
}

const ROAD_CLASS_RANK: Readonly<Record<string, number>> = {
  motorway: 0,
  primary: 2,
  secondary: 3,
  trunk: 1,
};

export function createInMemoryTrafficReleaseStore(): TrafficReleaseStore {
  const releases = new Map<string, TrafficRelease>();
  let publishedEpochMs: number | undefined;
  const visible = (release: TrafficRelease, epochStartMs: number): boolean =>
    release.releasedAtMs <= epochStartMs && release.expiresAtMs > epochStartMs;
  const stored = (epochStartMs: number): void => {
    if (publishedEpochMs !== epochStartMs) throw new TrafficEpochNotStoredError();
  };

  return {
    // Async so that a missing epoch is a rejection, like the database store's.
    // eslint-disable-next-line @typescript-eslint/require-await
    async byKeys(keys, epochStartMs) {
      stored(epochStartMs);
      return keys.flatMap((key) => {
        const release = releases.get(key);
        return release !== undefined && visible(release, epochStartMs) ? [release] : [];
      });
    },
    close: () => Promise.resolve(),
    // eslint-disable-next-line @typescript-eslint/require-await
    async inBounds(bounds, epochStartMs, limit) {
      stored(epochStartMs);
      const matches = [...releases.values()]
        .filter(
          (release) =>
            visible(release, epochStartMs) &&
            release.line.some(
              ([longitude, latitude]) =>
                longitude >= bounds.west &&
                longitude <= bounds.east &&
                latitude >= bounds.south &&
                latitude <= bounds.north,
            ),
        )
        .sort(
          (left, right) =>
            (ROAD_CLASS_RANK[left.roadClass] ?? 9) - (ROAD_CLASS_RANK[right.roadClass] ?? 9) ||
            left.segmentKey.localeCompare(right.segmentKey),
        );
      return { releases: matches.slice(0, limit), truncated: matches.length > limit };
    },
    publishEpoch(epochStartMs, epochReleases) {
      for (const [key, release] of releases) {
        if (release.expiresAtMs <= epochStartMs) releases.delete(key);
      }
      for (const release of epochReleases) releases.set(release.segmentKey, release);
      publishedEpochMs = epochStartMs;
      return Promise.resolve();
    },
    purge() {
      releases.clear();
      publishedEpochMs = undefined;
      return Promise.resolve();
    },
    ready: () => Promise.resolve(),
  };
}

interface ReleaseRow {
  expires_at_ms: string;
  free_flow_kph: number;
  line: Position[];
  released_at_ms: string;
  road_class: string;
  segment_key: string;
  speed_kph: number;
}

/** A snapshot read: one row with null release columns when the snapshot has no match. */
type SnapshotRow = { stored: boolean } & (ReleaseRow | { [Key in keyof ReleaseRow]: null });

/**
 * Reads the releases `matching` selects as of epoch $1, in one statement, so it sees one
 * database snapshot: `stored` is true only when the publication record names epoch $1 and the
 * table still has the row count that publication left. Every row of the result carries it.
 */
const snapshotQuery = (matching: string): string => `
  WITH publication AS (
    SELECT 1 FROM traffic_publication
    WHERE epoch_at = $1 AND release_rows = (SELECT count(*) FROM traffic_releases)
  ),
  matching AS (
    SELECT segment_key, road_class, speed_kph, free_flow_kph,
           (extract(epoch FROM released_at) * 1000)::bigint::text AS released_at_ms,
           (extract(epoch FROM expires_at) * 1000)::bigint::text AS expires_at_ms,
           (ST_AsGeoJSON(geom, 6)::json -> 'coordinates') AS line
    FROM (
      SELECT * FROM traffic_releases
      WHERE released_at <= $1 AND expires_at > $1 AND EXISTS (SELECT 1 FROM publication)
      ${matching}
    ) visible
  )
  SELECT EXISTS (SELECT 1 FROM publication) AS stored, matching.*
  FROM (SELECT 1) AS one LEFT JOIN matching ON true`;

function storedReleases(rows: readonly SnapshotRow[]): ReleaseRow[] {
  if (rows[0]?.stored !== true) throw new TrafficEpochNotStoredError();
  return rows.filter((row): row is SnapshotRow & ReleaseRow => row.segment_key !== null);
}

function toRelease(row: ReleaseRow): TrafficRelease {
  return {
    expiresAtMs: Number(row.expires_at_ms),
    freeFlowKph: row.free_flow_kph,
    line: row.line,
    releasedAtMs: Number(row.released_at_ms),
    roadClass: row.road_class,
    segmentKey: row.segment_key,
    speedKph: row.speed_kph,
  };
}

/** The traffic pool: the shared server-side bounds (`BOUNDED_POOL_LIMITS`), four connections. */
export const TRAFFIC_POOL_CONFIG = { ...BOUNDED_POOL_LIMITS, max: 4 } as const satisfies PoolConfig;

export function createPostgresTrafficReleaseStore(
  // Bounded waits: an unreachable or stuck database becomes an error the caller reports, never a
  // request or a startup that hangs.
  pool: Pool = createBoundedPool(TRAFFIC_POOL_CONFIG.max),
): TrafficReleaseStore {
  return {
    async byKeys(keys, epochStartMs) {
      const result = await pool.query<SnapshotRow>(
        snapshotQuery('AND segment_key = ANY($2::text[])'),
        [new Date(epochStartMs), keys],
      );
      return storedReleases(result.rows).map(toRelease);
    },
    close: () => pool.end(),
    async inBounds(bounds, epochStartMs, limit) {
      const result = await pool.query<SnapshotRow>(
        snapshotQuery(`AND geom && ST_MakeEnvelope($2, $3, $4, $5, 4326)
          ORDER BY
            CASE road_class
              WHEN 'motorway' THEN 0 WHEN 'trunk' THEN 1 WHEN 'primary' THEN 2 ELSE 3
            END,
            segment_key
          LIMIT $6`),
        [new Date(epochStartMs), bounds.west, bounds.south, bounds.east, bounds.north, limit + 1],
      );
      const rows = storedReleases(result.rows)
        .map(toRelease)
        .sort(
          (left, right) =>
            (ROAD_CLASS_RANK[left.roadClass] ?? 9) - (ROAD_CLASS_RANK[right.roadClass] ?? 9) ||
            (left.segmentKey < right.segmentKey ? -1 : left.segmentKey > right.segmentKey ? 1 : 0),
        );
      return { releases: rows.slice(0, limit), truncated: rows.length > limit };
    },
    async publishEpoch(epochStartMs, releases) {
      const client = await pool.connect();
      let discard: Error | undefined;
      try {
        // One transaction and one insert per epoch for every segment released in it, in key
        // order: row versions and physical order say which epoch, never which upload.
        await client.query('BEGIN');
        await client.query('DELETE FROM traffic_releases WHERE expires_at <= $1', [
          new Date(epochStartMs),
        ]);
        if (releases.length > 0) {
          await client.query(
            `INSERT INTO traffic_releases
               (segment_key, road_class, speed_kph, free_flow_kph, released_at, expires_at, geom)
             SELECT r.segment_key, r.road_class, r.speed_kph, r.free_flow_kph,
                    to_timestamp(r.released_at_ms / 1000.0), to_timestamp(r.expires_at_ms / 1000.0),
                    ST_SetSRID(ST_GeomFromGeoJSON(r.geometry), 4326)
             FROM jsonb_to_recordset($1::jsonb) AS r (
               segment_key text, road_class text, speed_kph smallint, free_flow_kph smallint,
               released_at_ms bigint, expires_at_ms bigint, geometry text
             )
             ORDER BY r.segment_key COLLATE "C"
             ON CONFLICT (segment_key) DO UPDATE SET
               road_class = EXCLUDED.road_class,
               speed_kph = EXCLUDED.speed_kph,
               free_flow_kph = EXCLUDED.free_flow_kph,
               released_at = EXCLUDED.released_at,
               expires_at = EXCLUDED.expires_at,
               geom = EXCLUDED.geom`,
            [
              JSON.stringify(
                releases.map((release) => ({
                  expires_at_ms: release.expiresAtMs,
                  free_flow_kph: release.freeFlowKph,
                  geometry: JSON.stringify({ coordinates: release.line, type: 'LineString' }),
                  released_at_ms: release.releasedAtMs,
                  road_class: release.roadClass,
                  segment_key: release.segmentKey,
                  speed_kph: release.speedKph,
                })),
              ),
            ],
          );
        }
        await client.query(
          `INSERT INTO traffic_publication (singleton, epoch_at, release_rows)
           SELECT true, $1, count(*) FROM traffic_releases
           ON CONFLICT (singleton) DO UPDATE
             SET epoch_at = EXCLUDED.epoch_at, release_rows = EXCLUDED.release_rows`,
          [new Date(epochStartMs)],
        );
        await client.query('COMMIT');
      } catch (error: unknown) {
        discard = await rollbackOrDiscard(client);
        throw error;
      } finally {
        client.release(discard);
      }
    },
    async purge() {
      const tables = await pool.query<{ publication: boolean; releases: boolean }>(
        `SELECT to_regclass('traffic_releases') IS NOT NULL AS releases,
                to_regclass('traffic_publication') IS NOT NULL AS publication`,
      );
      const present = tables.rows[0];
      const names = [
        ...(present?.releases === true ? ['traffic_releases'] : []),
        ...(present?.publication === true ? ['traffic_publication'] : []),
      ];
      if (names.length > 0) await pool.query(`TRUNCATE ${names.join(', ')}`);
    },
    async ready() {
      if ((await pendingMigrations(pool)).length > 0) {
        throw new Error('Database migrations are pending. Run `node dist/migrate.js`.');
      }
    },
  };
}
