import type { SearchQuery, SearchResponse, SearchResult, SearchSource } from '@navoss/contracts';
import { Pool } from 'pg';
import { z } from 'zod/v4';

import { normalizeSearchText, prefixTsQuery } from './search-text.js';
import type { SearchProvider } from './search-provider.js';

const DEFAULT_METADATA_CACHE_MS = 5 * 60 * 1_000;
const DEFAULT_STALE_AFTER_MS = 36 * 60 * 60 * 1_000;

const SearchRowSchema = z.object({
  category: z.enum(['address', 'landmark', 'neighborhood', 'poi', 'street']),
  confidence: z.coerce.number().min(0).max(1),
  id: z.string().min(1),
  label: z.string().min(1),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  name: z.string().min(1),
});

const MetadataRowSchema = z.object({
  dataset_id: z.string().min(1),
  dataset_updated_at: z.coerce.date(),
  indexed_at: z.coerce.date(),
  row_count: z.coerce.number().int().positive(),
  source: z.string().min(1),
});

interface SearchDatabase {
  query(queryText: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

interface CalgarySearchProviderOptions {
  clock?: () => number;
  connectionString?: string;
  database?: SearchDatabase;
  metadataCacheMs?: number;
  staleAfterMs?: number;
}

const PRIMARY_SEARCH_SQL = `
  SELECT
    id,
    name,
    label,
    category,
    latitude,
    longitude,
    CASE
      WHEN normalized_label = $1 THEN 1.0
      WHEN normalized_name = $1 THEN 0.99
      WHEN normalized_label LIKE $1 || '%' THEN 0.97
      WHEN normalized_name LIKE $1 || '%' THEN 0.96
      WHEN search_vector @@ to_tsquery('simple', $2) THEN
        0.90 + LEAST(0.05, ts_rank(search_vector, to_tsquery('simple', $2)) * 0.1)
      ELSE 0.80
    END AS confidence
  FROM calgary_search_places
  WHERE
    normalized_label LIKE $1 || '%'
    OR normalized_name LIKE $1 || '%'
    OR search_vector @@ to_tsquery('simple', $2)
  ORDER BY
    confidence DESC,
    CASE
      WHEN $4::double precision IS NULL OR $5::double precision IS NULL THEN 0
      ELSE power(latitude - $4, 2) + power(longitude - $5, 2)
    END ASC,
    name ASC,
    id ASC
  LIMIT $3
`;

const FUZZY_SEARCH_SQL = `
  SELECT
    id,
    name,
    label,
    category,
    latitude,
    longitude,
    0.70 + GREATEST(
      similarity(normalized_name, $1),
      similarity(normalized_label, $1)
    ) * 0.18 AS confidence
  FROM calgary_search_places
  WHERE
    (normalized_name % $1 OR normalized_label % $1)
    AND GREATEST(
      similarity(normalized_name, $1),
      similarity(normalized_label, $1)
    ) >= $5
  ORDER BY
    confidence DESC,
    CASE
      WHEN $3::double precision IS NULL OR $4::double precision IS NULL THEN 0
      ELSE power(latitude - $3, 2) + power(longitude - $4, 2)
    END ASC,
    name ASC,
    id ASC
  LIMIT $2
`;

const METADATA_SQL = `
  SELECT source, dataset_id, dataset_updated_at, indexed_at, row_count
  FROM calgary_search_metadata
  ORDER BY source
`;

const READY_SQL = `
  SELECT
    to_regclass('public.calgary_search_places') IS NOT NULL
    AND to_regclass('public.calgary_search_metadata') IS NOT NULL AS ready
`;

function toSource(rows: z.infer<typeof MetadataRowSchema>[], now: number): SearchSource {
  const sources = new Set(rows.map((row) => row.source));
  if (rows.length !== 2 || !sources.has('address') || !sources.has('business')) {
    throw new Error('Calgary search metadata is incomplete.');
  }

  const indexedAt = Math.min(...rows.map((row) => row.indexed_at.getTime()));
  return {
    datasetVersion: rows
      .map((row) => `${row.dataset_id}@${row.dataset_updated_at.toISOString()}`)
      .join('+'),
    freshness: now - indexedAt > DEFAULT_STALE_AFTER_MS ? 'stale' : 'fresh',
    id: 'calgary-open-data-index',
    updatedAt: new Date(indexedAt).toISOString(),
  };
}

function fuzzyThreshold(normalizedQuery: string): number {
  if (normalizedQuery.length >= 18) {
    return 0.52;
  }
  if (normalizedQuery.length >= 10) {
    return 0.58;
  }
  return 0.66;
}

export function createPostgresCalgarySearchProvider(
  options: CalgarySearchProviderOptions = {},
): SearchProvider {
  const connectionString = options.connectionString ?? process.env.SEARCH_DATABASE_URL;
  if (
    options.database === undefined &&
    connectionString === undefined &&
    process.env.PGHOST === undefined
  ) {
    throw new Error('PostgreSQL search database configuration is required.');
  }

  const database: SearchDatabase =
    options.database ??
    new Pool({
      ...(connectionString === undefined ? {} : { connectionString }),
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 30_000,
      max: 4,
      statement_timeout: 2_000,
    });
  const clock = options.clock ?? Date.now;
  const metadataCacheMs = options.metadataCacheMs ?? DEFAULT_METADATA_CACHE_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  let cachedSource: { expiresAt: number; value: SearchSource } | undefined;

  async function getSource(): Promise<SearchSource> {
    const now = clock();
    if (cachedSource !== undefined && now < cachedSource.expiresAt) {
      return cachedSource.value;
    }

    const response = await database.query(METADATA_SQL);
    const rows = z.array(MetadataRowSchema).parse(response.rows);
    const indexedAt = Math.min(...rows.map((row) => row.indexed_at.getTime()));
    const value = {
      ...toSource(rows, now),
      freshness: now - indexedAt > staleAfterMs ? ('stale' as const) : ('fresh' as const),
    };
    cachedSource = { expiresAt: now + metadataCacheMs, value };
    return value;
  }

  return {
    async isReady() {
      try {
        const response = await database.query(READY_SQL);
        const tablesReady = z.object({ ready: z.boolean() }).parse(response.rows[0]).ready;
        if (!tablesReady) {
          return false;
        }
        const source = await getSource();
        const metadataResponse = await database.query(METADATA_SQL);
        const metadata = z.array(MetadataRowSchema).parse(metadataResponse.rows);
        return (
          source.freshness === 'fresh' &&
          metadata.some((row) => row.source === 'address' && row.row_count >= 300_000) &&
          metadata.some((row) => row.source === 'business' && row.row_count >= 10_000)
        );
      } catch {
        return false;
      }
    },
    async search(query: SearchQuery): Promise<SearchResponse> {
      const normalizedQuery = normalizeSearchText(query.q);
      const source = await getSource();
      if (normalizedQuery.length === 0) {
        return { degraded: false, results: [], source };
      }

      const response = await database.query(PRIMARY_SEARCH_SQL, [
        normalizedQuery,
        prefixTsQuery(normalizedQuery),
        query.limit,
        query.latitude ?? null,
        query.longitude ?? null,
      ]);
      const rows =
        response.rows.length > 0 || normalizedQuery.length < 4
          ? response.rows
          : (
              await database.query(FUZZY_SEARCH_SQL, [
                normalizedQuery,
                query.limit,
                query.latitude ?? null,
                query.longitude ?? null,
                fuzzyThreshold(normalizedQuery),
              ])
            ).rows;
      const results: SearchResult[] = z
        .array(SearchRowSchema)
        .parse(rows)
        .map((row) => ({
          category: row.category,
          center: { latitude: row.latitude, longitude: row.longitude },
          confidence: row.confidence,
          id: row.id,
          label: row.label,
          name: row.name,
        }));

      return {
        degraded: source.freshness === 'stale',
        results,
        source,
      };
    },
  };
}
