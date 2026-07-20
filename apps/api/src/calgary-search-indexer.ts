import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { Pool, type PoolClient } from 'pg';
import { z } from 'zod/v4';

import { calgaryStreetTypeLabel } from './calgary-street-types.js';
import { normalizeSearchText } from './search-text.js';

const BUSINESS_DATASET_ID = 'vdjc-pybd';
const ADDRESS_DATASET_ID = 's8b3-j88p';
const BUSINESS_WHERE =
  "point IS NOT NULL AND homeoccind = 'N' AND upper(jobstatusdesc) LIKE '%LICENSED'";
const ADDRESS_WHERE =
  'latitude IS NOT NULL AND longitude IS NOT NULL AND street_name IS NOT NULL AND street_type IS NOT NULL';
const MINIMUM_SOURCE_COUNTS = { address: 300_000, business: 10_000 } as const;
const MAXIMUM_SOURCE_DROP_RATIO = 0.1;
const DEFAULT_PAGE_SIZE = 10_000;
const DEFAULT_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_RETRY_INTERVAL_MS = 15 * 60 * 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

const PointSchema = z.object({
  coordinates: z.tuple([z.coerce.number(), z.coerce.number()]),
  type: z.literal('Point'),
});

const BusinessRowSchema = z
  .object({
    address: z.string().min(1),
    comdistnm: z.string().optional(),
    getbusid: z.string().min(1),
    licencetypes: z.string().optional(),
    point: PointSchema,
    tradename: z.string().min(1),
  })
  .loose();

const AddressRowSchema = z
  .object({
    house_alpha: z.string().optional(),
    house_number: z.string().min(1),
    latitude: z.coerce.number().min(-90).max(90),
    longitude: z.coerce.number().min(-180).max(180),
    street_name: z.string().min(1),
    street_quad: z.string().optional(),
    street_type: z.string().min(1),
  })
  .loose();

const MetadataSchema = z.object({ rowsUpdatedAt: z.number().int().positive() }).loose();
const TableNameRowSchema = z.object({ name: z.string().nullable() });
const CountResponseSchema = z
  .array(z.object({ count: z.coerce.number().int().nonnegative() }).loose())
  .length(1);
const SourceCountRowSchema = z.object({
  count: z.coerce.number().int().nonnegative(),
  source: z.enum(['address', 'business']),
});

type CalgarySearchSource = IndexedCalgaryPlace['source'];

export interface CalgaryDatasetSnapshot {
  count: number;
  updatedAt: Date;
}

export interface IndexedCalgaryPlace {
  category: 'address' | 'poi';
  id: string;
  keywords: string;
  label: string;
  latitude: number;
  longitude: number;
  name: string;
  normalizedKeywords: string;
  normalizedLabel: string;
  normalizedName: string;
  source: 'address' | 'business';
}

interface IndexerOptions {
  connectionString?: string;
  fetchImplementation?: typeof fetch;
  pageSize?: number;
  requestTimeoutMs?: number;
}

const UPPERCASE_LABELS = new Set(['AB', 'BMW', 'NE', 'NW', 'SE', 'SW', 'YMCA']);

function displayWords(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('en-CA')
    .replace(
      /(^|[\s/-])([\p{Letter}])/gu,
      (_, prefix: string, letter: string) => `${prefix}${letter.toLocaleUpperCase('en-CA')}`,
    )
    .split(' ')
    .map((word) => (UPPERCASE_LABELS.has(word.toUpperCase()) ? word.toUpperCase() : word))
    .join(' ');
}

function placeId(source: IndexedCalgaryPlace['source'], value: string): string {
  return `calgary-${source}:${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
}

export function normalizeBusinessRow(payload: unknown): IndexedCalgaryPlace {
  const row = BusinessRowSchema.parse(payload);
  const [longitude, latitude] = row.point.coordinates;
  const name = displayWords(row.tradename);
  const address = displayWords(row.address);
  const community = row.comdistnm === undefined ? undefined : displayWords(row.comdistnm);
  const label = [name, address, community, 'Calgary', 'AB'].filter(Boolean).join(', ');
  const keywords = row.licencetypes ?? '';

  return {
    category: 'poi',
    id: `calgary-business:${row.getbusid}`,
    keywords,
    label,
    latitude,
    longitude,
    name,
    normalizedKeywords: normalizeSearchText(keywords),
    normalizedLabel: normalizeSearchText(label),
    normalizedName: normalizeSearchText(name),
    source: 'business',
  };
}

export function normalizeAddressRow(payload: unknown): IndexedCalgaryPlace {
  const row = AddressRowSchema.parse(payload);
  const streetName = displayWords(row.street_name);
  const streetType = calgaryStreetTypeLabel(row.street_type) ?? displayWords(row.street_type);
  const quadrant = row.street_quad?.toUpperCase();
  const house = `${row.house_number}${row.house_alpha?.trim() ?? ''}`;
  const name = [house, streetName, streetType, quadrant].filter(Boolean).join(' ');
  const label = `${name}, Calgary, AB`;

  return {
    category: 'address',
    id: placeId(
      'address',
      `${normalizeSearchText(name)}|${String(row.latitude)}|${String(row.longitude)}`,
    ),
    keywords: '',
    label,
    latitude: row.latitude,
    longitude: row.longitude,
    name,
    normalizedKeywords: '',
    normalizedLabel: normalizeSearchText(label),
    normalizedName: normalizeSearchText(name),
    source: 'address',
  };
}

function datasetUrl(datasetId: string): URL {
  return new URL(`https://data.calgary.ca/resource/${datasetId}.json`);
}

async function fetchJson(
  fetchImplementation: typeof fetch,
  url: URL | string,
  requestTimeoutMs: number,
): Promise<unknown> {
  const response = await fetchImplementation(url, {
    headers: { accept: 'application/json', 'user-agent': 'NavOSS/0.1' },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Calgary Open Data returned ${String(response.status)}.`);
  }
  return response.json();
}

async function fetchMetadata(
  fetchImplementation: typeof fetch,
  datasetId: string,
  requestTimeoutMs: number,
): Promise<Date> {
  const payload = await fetchJson(
    fetchImplementation,
    `https://data.calgary.ca/api/views/${datasetId}`,
    requestTimeoutMs,
  );
  return new Date(MetadataSchema.parse(payload).rowsUpdatedAt * 1_000);
}

async function fetchDatasetCount(
  fetchImplementation: typeof fetch,
  datasetId: string,
  where: string,
  requestTimeoutMs: number,
): Promise<number> {
  const url = datasetUrl(datasetId);
  url.searchParams.set('$select', 'count(*)');
  url.searchParams.set('$where', where);
  const payload = await fetchJson(fetchImplementation, url, requestTimeoutMs);
  const row = CountResponseSchema.parse(payload).at(0);
  if (row === undefined) {
    throw new Error(`Calgary dataset ${datasetId} did not return a count.`);
  }
  return row.count;
}

async function fetchDatasetSnapshot(
  fetchImplementation: typeof fetch,
  datasetId: string,
  where: string,
  requestTimeoutMs: number,
): Promise<CalgaryDatasetSnapshot> {
  const [count, updatedAt] = await Promise.all([
    fetchDatasetCount(fetchImplementation, datasetId, where, requestTimeoutMs),
    fetchMetadata(fetchImplementation, datasetId, requestTimeoutMs),
  ]);
  return { count, updatedAt };
}

export function validateDatasetSnapshot(
  source: CalgarySearchSource,
  snapshot: CalgaryDatasetSnapshot,
  previousCount?: number,
): void {
  if (snapshot.count < MINIMUM_SOURCE_COUNTS[source]) {
    throw new Error(
      `Calgary ${source} source returned an implausible record count (${String(snapshot.count)}).`,
    );
  }

  if (
    previousCount !== undefined &&
    snapshot.count < Math.floor(previousCount * (1 - MAXIMUM_SOURCE_DROP_RATIO))
  ) {
    throw new Error(
      `Calgary ${source} source dropped from ${String(previousCount)} to ${String(snapshot.count)} records.`,
    );
  }
}

export function assertDatasetSnapshotStable(
  source: CalgarySearchSource,
  before: CalgaryDatasetSnapshot,
  after: CalgaryDatasetSnapshot,
): void {
  if (before.count !== after.count || before.updatedAt.getTime() !== after.updatedAt.getTime()) {
    throw new Error(`Calgary ${source} source changed during indexing.`);
  }
}

async function tableExists(client: PoolClient, tableName: string): Promise<boolean> {
  const response = await client.query('SELECT to_regclass($1) AS name', [`public.${tableName}`]);
  return TableNameRowSchema.parse(response.rows.at(0) as unknown).name !== null;
}

async function currentSourceCounts(
  client: PoolClient,
): Promise<Partial<Record<CalgarySearchSource, number>>> {
  if (!(await tableExists(client, 'calgary_search_places'))) {
    return {};
  }

  const response = await client.query(
    'SELECT source, count(*)::bigint AS count FROM calgary_search_places GROUP BY source',
  );
  return Object.fromEntries(
    z
      .array(SourceCountRowSchema)
      .parse(response.rows)
      .map((row) => [row.source, row.count]),
  );
}

async function createStagingTables(client: PoolClient, suffix: string): Promise<void> {
  await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  await client.query(`
    CREATE TABLE calgary_search_places_${suffix} (
      id text PRIMARY KEY,
      source text NOT NULL CHECK (source IN ('address', 'business')),
      name text NOT NULL,
      label text NOT NULL,
      category text NOT NULL CHECK (category IN ('address', 'poi')),
      latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
      longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
      keywords text NOT NULL,
      normalized_name text NOT NULL,
      normalized_label text NOT NULL,
      normalized_keywords text NOT NULL,
      search_vector tsvector GENERATED ALWAYS AS (
        to_tsvector(
          'simple',
          normalized_name || ' ' || normalized_label || ' ' || normalized_keywords
        )
      ) STORED
    )
  `);
  await client.query(`
    CREATE TABLE calgary_search_metadata_${suffix} (
      source text PRIMARY KEY,
      dataset_id text NOT NULL,
      dataset_updated_at timestamptz NOT NULL,
      indexed_at timestamptz NOT NULL,
      row_count bigint NOT NULL CHECK (row_count > 0)
    )
  `);
}

async function insertPlaces(
  client: PoolClient,
  tableName: string,
  places: IndexedCalgaryPlace[],
): Promise<void> {
  if (places.length === 0) {
    return;
  }

  await client.query(
    `
      INSERT INTO ${tableName} (
        id, source, name, label, category, latitude, longitude, keywords,
        normalized_name, normalized_label, normalized_keywords
      )
      SELECT * FROM unnest(
        $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
        $6::double precision[], $7::double precision[], $8::text[],
        $9::text[], $10::text[], $11::text[]
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        label = EXCLUDED.label,
        category = EXCLUDED.category,
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        keywords = EXCLUDED.keywords,
        normalized_name = EXCLUDED.normalized_name,
        normalized_label = EXCLUDED.normalized_label,
        normalized_keywords = EXCLUDED.normalized_keywords
    `,
    [
      places.map((place) => place.id),
      places.map((place) => place.source),
      places.map((place) => place.name),
      places.map((place) => place.label),
      places.map((place) => place.category),
      places.map((place) => place.latitude),
      places.map((place) => place.longitude),
      places.map((place) => place.keywords),
      places.map((place) => place.normalizedName),
      places.map((place) => place.normalizedLabel),
      places.map((place) => place.normalizedKeywords),
    ],
  );
}

async function ingestDataset(
  client: PoolClient,
  options: {
    datasetId: string;
    fetchImplementation: typeof fetch;
    normalizeRow: (row: unknown) => IndexedCalgaryPlace;
    order: string;
    pageSize: number;
    requestTimeoutMs: number;
    select: string;
    tableName: string;
    where: string;
  },
): Promise<number> {
  let count = 0;
  let offset = 0;

  for (;;) {
    const url = datasetUrl(options.datasetId);
    url.searchParams.set('$limit', String(options.pageSize));
    url.searchParams.set('$offset', String(offset));
    url.searchParams.set('$order', options.order);
    url.searchParams.set('$select', options.select);
    url.searchParams.set('$where', options.where);
    const payload = await fetchJson(options.fetchImplementation, url, options.requestTimeoutMs);
    const rows = z.array(z.unknown()).parse(payload);
    await insertPlaces(client, options.tableName, rows.map(options.normalizeRow));
    count += rows.length;
    offset += rows.length;

    if (rows.length < options.pageSize) {
      return count;
    }
  }
}

async function createIndexes(client: PoolClient, tableName: string): Promise<void> {
  await client.query(
    `CREATE INDEX ${tableName}_name_prefix_idx ON ${tableName} (normalized_name text_pattern_ops)`,
  );
  await client.query(
    `CREATE INDEX ${tableName}_label_prefix_idx ON ${tableName} (normalized_label text_pattern_ops)`,
  );
  await client.query(
    `CREATE INDEX ${tableName}_name_trgm_idx ON ${tableName} USING gin (normalized_name gin_trgm_ops)`,
  );
  await client.query(
    `CREATE INDEX ${tableName}_label_trgm_idx ON ${tableName} USING gin (normalized_label gin_trgm_ops)`,
  );
  await client.query(
    `CREATE INDEX ${tableName}_search_vector_idx ON ${tableName} USING gin (search_vector)`,
  );
  await client.query(`ANALYZE ${tableName}`);
}

async function swapTables(client: PoolClient, suffix: string): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query('DROP TABLE IF EXISTS calgary_search_places_previous');
    await client.query('DROP TABLE IF EXISTS calgary_search_metadata_previous');
    if (await tableExists(client, 'calgary_search_places')) {
      await client.query(
        'ALTER TABLE calgary_search_places RENAME TO calgary_search_places_previous',
      );
    }
    if (await tableExists(client, 'calgary_search_metadata')) {
      await client.query(
        'ALTER TABLE calgary_search_metadata RENAME TO calgary_search_metadata_previous',
      );
    }
    await client.query(
      `ALTER TABLE calgary_search_places_${suffix} RENAME TO calgary_search_places`,
    );
    await client.query(
      `ALTER TABLE calgary_search_metadata_${suffix} RENAME TO calgary_search_metadata`,
    );
    await client.query('COMMIT');
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function syncCalgarySearchIndex(options: IndexerOptions): Promise<{
  addresses: number;
  businesses: number;
}> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pool = new Pool({
    ...(options.connectionString === undefined
      ? {}
      : { connectionString: options.connectionString }),
    max: 1,
  });
  const client = await pool.connect();
  const suffix = `${Date.now().toString(36)}_${process.pid.toString(36)}`;
  const placesTable = `calgary_search_places_${suffix}`;
  const metadataTable = `calgary_search_metadata_${suffix}`;

  try {
    const previousCounts = await currentSourceCounts(client);
    const [businessSnapshot, addressSnapshot] = await Promise.all([
      fetchDatasetSnapshot(
        fetchImplementation,
        BUSINESS_DATASET_ID,
        BUSINESS_WHERE,
        requestTimeoutMs,
      ),
      fetchDatasetSnapshot(
        fetchImplementation,
        ADDRESS_DATASET_ID,
        ADDRESS_WHERE,
        requestTimeoutMs,
      ),
    ]);
    validateDatasetSnapshot('business', businessSnapshot, previousCounts.business);
    validateDatasetSnapshot('address', addressSnapshot, previousCounts.address);
    await createStagingTables(client, suffix);
    const businesses = await ingestDataset(client, {
      datasetId: BUSINESS_DATASET_ID,
      fetchImplementation,
      normalizeRow: normalizeBusinessRow,
      order: 'getbusid',
      pageSize,
      requestTimeoutMs,
      select: 'getbusid,tradename,address,comdistnm,licencetypes,point',
      tableName: placesTable,
      where: BUSINESS_WHERE,
    });
    const addresses = await ingestDataset(client, {
      datasetId: ADDRESS_DATASET_ID,
      fetchImplementation,
      normalizeRow: normalizeAddressRow,
      order: 'address,latitude,longitude',
      pageSize,
      requestTimeoutMs,
      select: 'house_number,house_alpha,street_name,street_type,street_quad,latitude,longitude',
      tableName: placesTable,
      where: ADDRESS_WHERE,
    });
    const [businessSnapshotAfter, addressSnapshotAfter] = await Promise.all([
      fetchDatasetSnapshot(
        fetchImplementation,
        BUSINESS_DATASET_ID,
        BUSINESS_WHERE,
        requestTimeoutMs,
      ),
      fetchDatasetSnapshot(
        fetchImplementation,
        ADDRESS_DATASET_ID,
        ADDRESS_WHERE,
        requestTimeoutMs,
      ),
    ]);
    assertDatasetSnapshotStable('business', businessSnapshot, businessSnapshotAfter);
    assertDatasetSnapshotStable('address', addressSnapshot, addressSnapshotAfter);
    const indexedCountResponse = await client.query(
      `SELECT source, count(*)::bigint AS count FROM ${placesTable} GROUP BY source`,
    );
    const indexedCounts = Object.fromEntries(
      z
        .array(SourceCountRowSchema)
        .parse(indexedCountResponse.rows)
        .map((row) => [row.source, row.count]),
    ) as Partial<Record<CalgarySearchSource, number>>;
    if (
      businesses !== businessSnapshot.count ||
      indexedCounts.business !== businessSnapshot.count
    ) {
      throw new Error('Calgary business source did not index its complete snapshot.');
    }
    if (addresses !== addressSnapshot.count || indexedCounts.address !== addressSnapshot.count) {
      throw new Error('Calgary address source did not index its complete snapshot.');
    }
    const indexedAt = new Date();
    await client.query(
      `INSERT INTO ${metadataTable} (source, dataset_id, dataset_updated_at, indexed_at, row_count) VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $4, $9)`,
      [
        'business',
        BUSINESS_DATASET_ID,
        businessSnapshot.updatedAt,
        indexedAt,
        businesses,
        'address',
        ADDRESS_DATASET_ID,
        addressSnapshot.updatedAt,
        addresses,
      ],
    );
    await createIndexes(client, placesTable);
    await swapTables(client, suffix);
    return { addresses, businesses };
  } catch (error: unknown) {
    await client.query(`DROP TABLE IF EXISTS ${placesTable}`).catch(() => undefined);
    await client.query(`DROP TABLE IF EXISTS ${metadataTable}`).catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function run(): Promise<void> {
  const connectionString = process.env.SEARCH_DATABASE_URL;
  if (connectionString === undefined && process.env.PGHOST === undefined) {
    throw new Error('PostgreSQL search database configuration is required.');
  }
  const refreshIntervalMs = Number(
    process.env.SEARCH_INDEX_REFRESH_INTERVAL_MS ?? DEFAULT_REFRESH_INTERVAL_MS,
  );
  const retryIntervalMs = Number(
    process.env.SEARCH_INDEX_RETRY_INTERVAL_MS ?? DEFAULT_RETRY_INTERVAL_MS,
  );
  const runOnce = process.env.SEARCH_INDEX_ONCE === '1';

  for (;;) {
    try {
      const result = await syncCalgarySearchIndex({
        ...(connectionString === undefined ? {} : { connectionString }),
      });
      console.log(
        `Calgary search index refreshed: ${String(result.businesses)} businesses, ${String(result.addresses)} addresses.`,
      );
      if (runOnce) {
        return;
      }
      await delay(refreshIntervalMs);
    } catch (error: unknown) {
      console.error(
        `Calgary search index refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      if (runOnce) {
        throw error;
      }
      await delay(retryIntervalMs);
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
