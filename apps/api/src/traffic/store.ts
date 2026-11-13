import type { TrafficFlowBounds } from '@navoss/contracts';
import { Pool } from 'pg';

import { pendingMigrations } from '../migrations.js';
import type { TrafficRelease } from './cohorts.js';
import type { Position } from './geo.js';

/**
 * Storage for published releases only. Nothing below the contributor threshold is ever passed to
 * a store, and every read is as of an epoch boundary: a release is visible from the boundary that
 * produced it until the boundary at which it expires, whether or not cleanup has run.
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
   * Applies one epoch boundary atomically: removes everything that expired at or before it, then
   * writes that epoch's releases, replacing an older value for the same segment.
   */
  publishEpoch(epochStartMs: number, releases: readonly TrafficRelease[]): Promise<void>;
  /** Erases every stored release. Succeeds when the schema was never created. */
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
  const visible = (release: TrafficRelease, epochStartMs: number): boolean =>
    release.releasedAtMs <= epochStartMs && release.expiresAtMs > epochStartMs;

  return {
    byKeys(keys, epochStartMs) {
      return Promise.resolve(
        keys.flatMap((key) => {
          const release = releases.get(key);
          return release !== undefined && visible(release, epochStartMs) ? [release] : [];
        }),
      );
    },
    close: () => Promise.resolve(),
    inBounds(bounds, epochStartMs, limit) {
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
      return Promise.resolve({
        releases: matches.slice(0, limit),
        truncated: matches.length > limit,
      });
    },
    publishEpoch(epochStartMs, epochReleases) {
      for (const [key, release] of releases) {
        if (release.expiresAtMs <= epochStartMs) releases.delete(key);
      }
      for (const release of epochReleases) releases.set(release.segmentKey, release);
      return Promise.resolve();
    },
    purge() {
      releases.clear();
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

const RELEASE_SELECT = `
  SELECT segment_key, road_class, speed_kph, free_flow_kph,
         (extract(epoch FROM released_at) * 1000)::bigint::text AS released_at_ms,
         (extract(epoch FROM expires_at) * 1000)::bigint::text AS expires_at_ms,
         (ST_AsGeoJSON(geom, 6)::json -> 'coordinates') AS line
  FROM traffic_releases
  WHERE released_at <= $1 AND expires_at > $1`;

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

export function createPostgresTrafficReleaseStore(
  // Bounded waits: an unreachable or stuck database becomes an error the caller reports, never a
  // request or a startup that hangs.
  pool: Pool = new Pool({ connectionTimeoutMillis: 5_000, max: 4, query_timeout: 10_000 }),
): TrafficReleaseStore {
  return {
    async byKeys(keys, epochStartMs) {
      if (keys.length === 0) return [];
      const result = await pool.query<ReleaseRow>(
        `${RELEASE_SELECT} AND segment_key = ANY($2::text[])`,
        [new Date(epochStartMs), keys],
      );
      return result.rows.map(toRelease);
    },
    close: () => pool.end(),
    async inBounds(bounds, epochStartMs, limit) {
      const result = await pool.query<ReleaseRow>(
        `${RELEASE_SELECT} AND geom && ST_MakeEnvelope($2, $3, $4, $5, 4326)
         ORDER BY
           CASE road_class
             WHEN 'motorway' THEN 0 WHEN 'trunk' THEN 1 WHEN 'primary' THEN 2 ELSE 3
           END,
           segment_key
         LIMIT $6`,
        [new Date(epochStartMs), bounds.west, bounds.south, bounds.east, bounds.north, limit + 1],
      );
      return {
        releases: result.rows.slice(0, limit).map(toRelease),
        truncated: result.rows.length > limit,
      };
    },
    async publishEpoch(epochStartMs, releases) {
      const client = await pool.connect();
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
        await client.query('COMMIT');
      } catch (error: unknown) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async purge() {
      const table = await pool.query<{ present: boolean }>(
        "SELECT to_regclass('traffic_releases') IS NOT NULL AS present",
      );
      if (table.rows[0]?.present === true) await pool.query('TRUNCATE traffic_releases');
    },
    async ready() {
      if ((await pendingMigrations(pool)).length > 0) {
        throw new Error('Database migrations are pending. Run `node dist/migrate.js`.');
      }
    },
  };
}
