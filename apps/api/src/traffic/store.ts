import type { TrafficFlowBounds } from '@navoss/contracts';
import { Pool } from 'pg';

import { HISTOGRAM_BINS, type FlowBucket } from './aggregation.js';
import type { Position } from './geo.js';
import { applyTrafficMigrations } from './migrations.js';
import type { SegmentObservation } from './observations.js';

export interface PublishedSegment {
  buckets: FlowBucket[];
  freeFlowKph: number;
  lines: Position[][];
  segmentKey: string;
}

export interface PublicationRule {
  /** k: distinct contributors required across the window. */
  minimumContributors: number;
  /** Buckets starting before this instant are ignored. */
  windowStartMs: number;
}

export interface TrafficCounts {
  observedSegments: number;
  publishedSegments: number;
  samples: number;
}

/**
 * Persistence for traffic aggregates. Every read applies the publication rule inside the store, so
 * a segment below the contributor threshold, or without map geometry yet, never leaves it.
 */
export interface TrafficStore {
  close(): Promise<void>;
  counts(rule: PublicationRule): Promise<TrafficCounts>;
  /** Removes buckets that started before the cutoff and segments left without any bucket. */
  expire(cutoffMs: number): Promise<void>;
  /** Prepares the schema and erases aggregates recorded under a previous contributor key. */
  initialize(): Promise<void>;
  publishedByKeys(keys: readonly string[], rule: PublicationRule): Promise<PublishedSegment[]>;
  publishedInBounds(
    bounds: TrafficFlowBounds,
    rule: PublicationRule,
    limit: number,
  ): Promise<{ segments: PublishedSegment[]; truncated: boolean }>;
  /**
   * Adds one sample per observation. A contributor token already present in a segment's bucket
   * makes that observation a no-op, so one driver cannot stack samples.
   */
  record(
    observations: readonly SegmentObservation[],
    tokenFor: (segmentKey: string) => string,
  ): Promise<void>;
}

const ROAD_CLASS_RANK: Readonly<Record<string, number>> = {
  motorway: 0,
  primary: 2,
  secondary: 3,
  tertiary: 4,
  trunk: 1,
};

interface MemorySegment {
  buckets: Map<number, { histogram: number[]; tokens: Set<string> }>;
  freeFlowKph: number;
  lines: Map<string, Position[]>;
  roadClass: string;
}

export function createInMemoryTrafficStore(): TrafficStore {
  const segments = new Map<string, MemorySegment>();

  const published = (
    segmentKey: string,
    segment: MemorySegment,
    rule: PublicationRule,
  ): PublishedSegment | undefined => {
    const live = [...segment.buckets].filter(([start]) => start >= rule.windowStartMs);
    const contributors = new Set(live.flatMap(([, bucket]) => [...bucket.tokens]));
    if (contributors.size < rule.minimumContributors || segment.lines.size === 0) return undefined;
    return {
      buckets: live.map(([bucketStartMs, bucket]) => ({
        bucketStartMs,
        histogram: bucket.histogram,
        sampleCount: bucket.tokens.size,
      })),
      freeFlowKph: segment.freeFlowKph,
      lines: [...segment.lines.values()],
      segmentKey,
    };
  };

  return {
    close: () => Promise.resolve(),
    counts(rule) {
      const live = [...segments].filter(([, segment]) =>
        [...segment.buckets.keys()].some((start) => start >= rule.windowStartMs),
      );
      return Promise.resolve({
        observedSegments: live.length,
        publishedSegments: live.filter(([key, segment]) => published(key, segment, rule)).length,
        samples: live.reduce(
          (sum, [, segment]) =>
            sum +
            [...segment.buckets]
              .filter(([start]) => start >= rule.windowStartMs)
              .reduce((count, [, bucket]) => count + bucket.tokens.size, 0),
          0,
        ),
      });
    },
    expire(cutoffMs) {
      for (const [key, segment] of segments) {
        for (const start of segment.buckets.keys()) {
          if (start < cutoffMs) segment.buckets.delete(start);
        }
        if (segment.buckets.size === 0) segments.delete(key);
      }
      return Promise.resolve();
    },
    initialize() {
      segments.clear();
      return Promise.resolve();
    },
    publishedByKeys(keys, rule) {
      return Promise.resolve(
        keys.flatMap((key) => {
          const segment = segments.get(key);
          return (segment === undefined ? undefined : published(key, segment, rule)) ?? [];
        }),
      );
    },
    publishedInBounds(bounds, rule, limit) {
      const matches = [...segments]
        .filter(([, segment]) =>
          [...segment.lines.values()].some((line) =>
            line.some(
              ([longitude, latitude]) =>
                longitude >= bounds.west &&
                longitude <= bounds.east &&
                latitude >= bounds.south &&
                latitude <= bounds.north,
            ),
          ),
        )
        .sort(
          ([leftKey, left], [rightKey, right]) =>
            (ROAD_CLASS_RANK[left.roadClass] ?? 9) - (ROAD_CLASS_RANK[right.roadClass] ?? 9) ||
            leftKey.localeCompare(rightKey),
        )
        .flatMap(([key, segment]) => published(key, segment, rule) ?? []);
      return Promise.resolve({
        segments: matches.slice(0, limit),
        truncated: matches.length > limit,
      });
    },
    record(observations, tokenFor) {
      for (const observation of observations) {
        const segment = segments.get(observation.segmentKey) ?? {
          buckets: new Map<number, { histogram: number[]; tokens: Set<string> }>(),
          freeFlowKph: observation.freeFlowKph,
          lines: new Map<string, Position[]>(),
          roadClass: observation.roadClass,
        };
        segments.set(observation.segmentKey, segment);
        segment.freeFlowKph = observation.freeFlowKph;
        segment.roadClass = observation.roadClass;
        for (const line of observation.lines) segment.lines.set(JSON.stringify(line), line);
        const bucket = segment.buckets.get(observation.bucketStartMs) ?? {
          histogram: new Array<number>(HISTOGRAM_BINS).fill(0),
          tokens: new Set<string>(),
        };
        segment.buckets.set(observation.bucketStartMs, bucket);
        const token = tokenFor(observation.segmentKey);
        if (bucket.tokens.has(token)) continue;
        bucket.tokens.add(token);
        bucket.histogram[observation.speedBin] = (bucket.histogram[observation.speedBin] ?? 0) + 1;
      }
      return Promise.resolve();
    },
  };
}

interface PublishedRow {
  buckets: FlowBucket[];
  free_flow_kph: number;
  lines: Position[][];
  segment_key: string;
}

// The contributor threshold and the geometry requirement are part of the query itself: rows that
// fail them are never returned to application code.
const PUBLISHED_SELECT = `
  SELECT s.segment_key, s.free_flow_kph, (ST_AsGeoJSON(s.geom, 6)::json -> 'coordinates') AS lines, live.buckets
  FROM traffic_segments s
  CROSS JOIN LATERAL (
    SELECT
      json_agg(
        json_build_object(
          'bucketStartMs', (extract(epoch FROM b.bucket_start) * 1000)::bigint,
          'histogram', b.speed_histogram,
          'sampleCount', b.sample_count
        )
      ) AS buckets,
      (
        SELECT count(DISTINCT token)
        FROM traffic_flow_buckets c
        CROSS JOIN LATERAL unnest(c.contributor_tokens) AS token
        WHERE c.segment_key = s.segment_key AND c.bucket_start >= $1
      ) AS contributors
    FROM traffic_flow_buckets b
    WHERE b.segment_key = s.segment_key AND b.bucket_start >= $1
  ) live
  WHERE s.geom IS NOT NULL AND live.contributors >= $2`;

function toPublished(row: PublishedRow): PublishedSegment {
  return {
    buckets: row.buckets,
    freeFlowKph: row.free_flow_kph,
    lines: row.lines,
    segmentKey: row.segment_key,
  };
}

export function createPostgresTrafficStore(pool: Pool = new Pool({ max: 4 })): TrafficStore {
  return {
    close: () => pool.end(),
    async counts(rule) {
      const result = await pool.query<{ observed: string; published: string; samples: string }>(
        `SELECT
           count(*)::text AS observed,
           count(*) FILTER (WHERE q.has_geometry AND q.contributors >= $2)::text AS published,
           coalesce(sum(q.samples), 0)::text AS samples
         FROM (
           SELECT
             s.geom IS NOT NULL AS has_geometry,
             sum(b.sample_count) AS samples,
             (
               SELECT count(DISTINCT token)
               FROM traffic_flow_buckets c
               CROSS JOIN LATERAL unnest(c.contributor_tokens) AS token
               WHERE c.segment_key = s.segment_key AND c.bucket_start >= $1
             ) AS contributors
           FROM traffic_segments s
           JOIN traffic_flow_buckets b ON b.segment_key = s.segment_key AND b.bucket_start >= $1
           GROUP BY s.segment_key
         ) q`,
        [new Date(rule.windowStartMs), rule.minimumContributors],
      );
      const row = result.rows[0];
      return {
        observedSegments: Number(row?.observed ?? 0),
        publishedSegments: Number(row?.published ?? 0),
        samples: Number(row?.samples ?? 0),
      };
    },
    async expire(cutoffMs) {
      await pool.query('DELETE FROM traffic_flow_buckets WHERE bucket_start < $1', [
        new Date(cutoffMs),
      ]);
      await pool.query(
        `DELETE FROM traffic_segments s
         WHERE NOT EXISTS (SELECT 1 FROM traffic_flow_buckets b WHERE b.segment_key = s.segment_key)`,
      );
    },
    async initialize() {
      const client = await pool.connect();
      try {
        await applyTrafficMigrations(client);
        // Contributor tokens are only comparable under the key of the process that wrote them.
        // A new process has a new key, so it starts from nothing rather than risk counting one
        // driver twice toward the publication threshold.
        await client.query('TRUNCATE traffic_flow_buckets, traffic_segments');
      } finally {
        client.release();
      }
    },
    async publishedByKeys(keys, rule) {
      if (keys.length === 0) return [];
      const result = await pool.query<PublishedRow>(
        `${PUBLISHED_SELECT} AND s.segment_key = ANY($3::text[])`,
        [new Date(rule.windowStartMs), rule.minimumContributors, keys],
      );
      return result.rows.map(toPublished);
    },
    async publishedInBounds(bounds, rule, limit) {
      const result = await pool.query<PublishedRow>(
        `${PUBLISHED_SELECT} AND s.geom && ST_MakeEnvelope($3, $4, $5, $6, 4326)
         ORDER BY
           CASE s.road_class
             WHEN 'motorway' THEN 0 WHEN 'trunk' THEN 1 WHEN 'primary' THEN 2
             WHEN 'secondary' THEN 3 WHEN 'tertiary' THEN 4 ELSE 9
           END,
           s.segment_key
         LIMIT $7`,
        [
          new Date(rule.windowStartMs),
          rule.minimumContributors,
          bounds.west,
          bounds.south,
          bounds.east,
          bounds.north,
          limit + 1,
        ],
      );
      return {
        segments: result.rows.slice(0, limit).map(toPublished),
        truncated: result.rows.length > limit,
      };
    },
    async record(observations, tokenFor) {
      if (observations.length === 0) return;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const observation of observations) {
          await client.query(
            `INSERT INTO traffic_segments
               (segment_key, way_id, forward, road_class, free_flow_kph, speed_limit_kph, geom)
             VALUES ($1, $2, $3, $4, $5, $6, ST_SetSRID(ST_GeomFromGeoJSON($7), 4326))
             ON CONFLICT (segment_key) DO UPDATE SET
               road_class = EXCLUDED.road_class,
               free_flow_kph = EXCLUDED.free_flow_kph,
               speed_limit_kph = coalesce(EXCLUDED.speed_limit_kph, traffic_segments.speed_limit_kph),
               geom = CASE
                 WHEN EXCLUDED.geom IS NULL THEN traffic_segments.geom
                 WHEN traffic_segments.geom IS NULL THEN EXCLUDED.geom
                 WHEN ST_Covers(traffic_segments.geom, EXCLUDED.geom) THEN traffic_segments.geom
                 ELSE ST_Multi(ST_LineMerge(ST_Union(traffic_segments.geom, EXCLUDED.geom)))
               END`,
            [
              observation.segmentKey,
              observation.wayId,
              observation.forward,
              observation.roadClass,
              observation.freeFlowKph,
              observation.speedLimitKph ?? null,
              observation.lines.length === 0
                ? null
                : JSON.stringify({ coordinates: observation.lines, type: 'MultiLineString' }),
            ],
          );
          const histogram = new Array<number>(HISTOGRAM_BINS).fill(0);
          histogram[observation.speedBin] = 1;
          await client.query(
            `INSERT INTO traffic_flow_buckets AS bucket
               (segment_key, bucket_start, sample_count, speed_histogram, contributor_tokens)
             VALUES ($1, $2, 1, $3::integer[], ARRAY[$4::bigint])
             ON CONFLICT (segment_key, bucket_start) DO UPDATE SET
               sample_count = bucket.sample_count + 1,
               speed_histogram = (
                 SELECT array_agg(pair.existing + pair.added ORDER BY pair.bin)
                 FROM unnest(bucket.speed_histogram, EXCLUDED.speed_histogram)
                   WITH ORDINALITY AS pair (existing, added, bin)
               ),
               -- Kept sorted so the array order says nothing about arrival order.
               contributor_tokens = (
                 SELECT array_agg(token ORDER BY token)
                 FROM unnest(bucket.contributor_tokens || $4::bigint) AS token
               )
             WHERE NOT bucket.contributor_tokens @> ARRAY[$4::bigint]`,
            [
              observation.segmentKey,
              new Date(observation.bucketStartMs),
              histogram,
              tokenFor(observation.segmentKey),
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
  };
}
