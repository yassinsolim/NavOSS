import { createHash } from 'node:crypto';

import {
  RoadEventResponseSchema,
  RoadEventSchema,
  type RoadEvent,
  type RoadEventResponse,
  type RoadEventSource,
} from '@navoss/contracts';
import { z } from 'zod/v4';

const CONSTRUCTION_DATASET_ID = 'w8zq-79bq';
const INCIDENT_DATASET_ID = '4jah-h97u';
const LICENSE_URL = 'https://data.calgary.ca/d/Open-Data-Terms/u45n-7awa';
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MAXIMUM_STALE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const PointSchema = z
  .object({
    coordinates: z.tuple([z.number(), z.number()]),
    type: z.literal('Point'),
  })
  .loose();

const LocationSchema = z
  .object({
    latitude: z.union([z.string(), z.number()]).optional(),
    longitude: z.union([z.string(), z.number()]).optional(),
    point: z.unknown().optional(),
  })
  .loose();

const ConstructionRowSchema = LocationSchema.extend({
  construction_info: z.string().min(1),
  description: z.string().min(1),
  end_dt: z.string().min(1).optional(),
  end_dt_utc: z.string().min(1).optional(),
  start_dt: z.string().min(1).optional(),
  start_dt_utc: z.string().min(1).optional(),
});

const IncidentRowSchema = LocationSchema.extend({
  description: z.string().min(1),
  incident_info: z.string().min(1),
  modified_dt: z.string().min(1).optional(),
  modified_dt_utc: z.string().min(1).optional(),
  start_dt: z.string().min(1).optional(),
  start_dt_utc: z.string().min(1).optional(),
});

const NoIncidentRowSchema = z.object({ incident_info: z.literal('NO TRAFFIC INCIDENTS') }).loose();
const DatasetRowsSchema = z.array(z.unknown()).max(1_000);
const DatasetMetadataSchema = z.object({ rowsUpdatedAt: z.number().int().positive() }).loose();

export class CalgaryRoadEventProviderError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CalgaryRoadEventProviderError';
  }
}

export interface CalgaryRoadEventProvider {
  getRoadEvents(): Promise<RoadEventResponse>;
  start?(): void;
  stop?(): void;
}

interface CalgaryRoadEventProviderOptions {
  cacheTtlMs?: number;
  clock?: () => number;
  constructionDataUrl?: string;
  constructionMetadataUrl?: string;
  fetchImplementation?: typeof fetch;
  incidentDataUrl?: string;
  incidentMetadataUrl?: string;
  maximumStaleMs?: number;
  refreshIntervalMs?: number;
  requestTimeoutMs?: number;
  onFailure?: (failure: { datasetId: string; droppedRows?: number; errorName: string }) => void;
}

function dataUrl(datasetId: string): string {
  const url = new URL(`https://data.calgary.ca/resource/${datasetId}.json`);
  // Selecting either generation's fields makes Socrata reject the other generation.
  url.searchParams.set('$limit', '1001');
  return url.toString();
}

async function fetchJson(
  fetchImplementation: typeof fetch,
  url: string,
  requestTimeoutMs: number,
): Promise<unknown> {
  const response = await fetchImplementation(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) {
    throw new CalgaryRoadEventProviderError(
      `Calgary Open Data returned ${String(response.status)}.`,
    );
  }
  return response.json();
}

function normalizedText(value: string): string {
  return value
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gu, '&')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim();
}

function eventId(prefix: string, parts: readonly unknown[]): string {
  return `${prefix}:${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 20)}`;
}

function coordinate(row: z.infer<typeof LocationSchema>): { latitude: number; longitude: number } {
  const point = PointSchema.safeParse(row.point);
  let longitude: number;
  let latitude: number;
  if (point.success) {
    [longitude, latitude] = point.data.coordinates;
  } else if (typeof row.point === 'string' && /^POINT\s*\(/iu.test(row.point)) {
    const match =
      /^POINT\s*\(\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*\)$/iu.exec(
        row.point,
      );
    if (match === null) throw new CalgaryRoadEventProviderError('Invalid point.');
    longitude = Number(match[1]);
    latitude = Number(match[2]);
  } else {
    if (
      row.longitude === undefined ||
      row.latitude === undefined ||
      String(row.longitude).trim() === '' ||
      String(row.latitude).trim() === ''
    ) {
      throw new CalgaryRoadEventProviderError('Missing coordinates.');
    }
    longitude = Number(row.longitude);
    latitude = Number(row.latitude);
  }
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new CalgaryRoadEventProviderError('Invalid coordinates.');
  }
  return { latitude, longitude };
}

function localTimestamp(local: string | undefined, utc: string | undefined): string {
  if (utc === undefined) {
    if (local === undefined) throw new CalgaryRoadEventProviderError('Missing timestamp.');
    return local;
  }
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d{1,3})?(?:Z|\+00:00)?$/u.exec(utc);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new CalgaryRoadEventProviderError('Invalid UTC timestamp.');
  }
  const canonical = `${match[1]}T${match[2]}${(match[3] ?? '.000').padEnd(4, '0')}Z`;
  const time = Date.parse(canonical);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== canonical) {
    throw new CalgaryRoadEventProviderError('Invalid UTC timestamp.');
  }
  return `${calgaryLocalDateTime(time)}.${String(new Date(time).getUTCMilliseconds()).padStart(3, '0')}`;
}

function normalizeConstruction(
  row: z.infer<typeof ConstructionRowSchema>,
  currentLocalDateTime: string,
): RoadEvent | undefined {
  const start = localTimestamp(row.start_dt, row.start_dt_utc);
  const end =
    row.end_dt === undefined && row.end_dt_utc === undefined
      ? undefined
      : localTimestamp(row.end_dt, row.end_dt_utc);
  const title = normalizedText(row.construction_info);
  const description = normalizedText(row.description);
  const location = coordinate(row);
  const event = RoadEventSchema.parse({
    confidence: 'official',
    coordinate: location,
    description,
    ...(end === undefined ? {} : { endsAtLocal: end }),
    id: eventId('calgary-construction', [title, description, start, location]),
    sourceId: 'calgary-construction-detours',
    startsAtLocal: start,
    timeZone: 'America/Edmonton',
    title,
    type: 'construction',
  });
  return end !== undefined && end < currentLocalDateTime ? undefined : event;
}

function normalizeIncident(row: z.infer<typeof IncidentRowSchema>): RoadEvent {
  const title = normalizedText(row.incident_info);
  const description = normalizedText(row.description);
  const location = coordinate(row);
  const start = localTimestamp(row.start_dt, row.start_dt_utc);
  localTimestamp(row.modified_dt, row.modified_dt_utc);
  return RoadEventSchema.parse({
    confidence: 'unverified',
    coordinate: location,
    description,
    id: eventId('calgary-incident', [title, start, location]),
    sourceId: 'calgary-current-incidents',
    startsAtLocal: start,
    timeZone: 'America/Edmonton',
    title,
    type: 'incident',
  });
}

function calgaryLocalDateTime(timestamp: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone: 'America/Edmonton',
    year: 'numeric',
  }).formatToParts(timestamp);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (
    values.year === undefined ||
    values.month === undefined ||
    values.day === undefined ||
    values.hour === undefined ||
    values.minute === undefined ||
    values.second === undefined
  ) {
    throw new CalgaryRoadEventProviderError('Calgary local time could not be formatted.');
  }
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`;
}

function source(sourceId: RoadEventSource['sourceId'], updatedAtSeconds: number): RoadEventSource {
  const construction = sourceId === 'calgary-construction-detours';
  return {
    attribution: 'The City of Calgary',
    confidence: construction ? 'official' : 'unverified',
    datasetId: construction ? CONSTRUCTION_DATASET_ID : INCIDENT_DATASET_ID,
    datasetUrl: `https://data.calgary.ca/d/${construction ? CONSTRUCTION_DATASET_ID : INCIDENT_DATASET_ID}`,
    licenseUrl: LICENSE_URL,
    sourceId,
    updateFrequency: construction ? 'twice daily' : '10 minutes',
    updatedAt: new Date(updatedAtSeconds * 1_000).toISOString(),
  };
}

export function createCalgaryRoadEventProvider(
  options: CalgaryRoadEventProviderOptions = {},
): CalgaryRoadEventProvider {
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const clock = options.clock ?? Date.now;
  const constructionDataUrl = options.constructionDataUrl ?? dataUrl(CONSTRUCTION_DATASET_ID);
  const constructionMetadataUrl =
    options.constructionMetadataUrl ??
    `https://data.calgary.ca/api/views/${CONSTRUCTION_DATASET_ID}`;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const incidentDataUrl = options.incidentDataUrl ?? dataUrl(INCIDENT_DATASET_ID);
  const incidentMetadataUrl =
    options.incidentMetadataUrl ?? `https://data.calgary.ca/api/views/${INCIDENT_DATASET_ID}`;
  const maximumStaleMs = options.maximumStaleMs ?? DEFAULT_MAXIMUM_STALE_MS;
  const refreshIntervalMs = options.refreshIntervalMs ?? cacheTtlMs;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let cached: { expiresAt: number; value: RoadEventResponse } | undefined;
  const datasets = new Map<
    RoadEventSource['sourceId'],
    { events: RoadEvent[]; loadedAt: number; source: RoadEventSource }
  >();
  let interval: ReturnType<typeof setInterval> | undefined;
  let refreshing: Promise<RoadEventResponse> | undefined;

  const loadRoadEvents = async (): Promise<RoadEventResponse> => {
    const now = clock();
    if (cached !== undefined && now < cached.expiresAt) return cached.value;
    const currentLocalDateTime = calgaryLocalDateTime(now);

    const loadDataset = async (
      sourceId: RoadEventSource['sourceId'],
      dataUrl: string,
      metadataUrl: string,
    ): Promise<{
      events: RoadEvent[];
      source: RoadEventSource | undefined;
      available: boolean;
      degraded: boolean;
      cacheUntil: number;
    }> => {
      const construction = sourceId === 'calgary-construction-detours';
      const datasetId = construction ? CONSTRUCTION_DATASET_ID : INCIDENT_DATASET_ID;
      const previous = datasets.get(sourceId);
      const usablePrevious =
        previous !== undefined && now - previous.loadedAt <= maximumStaleMs ? previous : undefined;
      const [dataResult, metadataResult] = await Promise.allSettled([
        fetchJson(fetchImplementation, dataUrl, requestTimeoutMs),
        fetchJson(fetchImplementation, metadataUrl, requestTimeoutMs),
      ]);
      let currentSource: RoadEventSource | undefined;
      try {
        if (metadataResult.status === 'rejected') throw metadataResult.reason;
        const metadata = DatasetMetadataSchema.parse(metadataResult.value);
        currentSource = source(sourceId, metadata.rowsUpdatedAt);
      } catch (error: unknown) {
        options.onFailure?.({
          datasetId,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      }

      try {
        if (dataResult.status === 'rejected') throw dataResult.reason;
        if (currentSource === undefined)
          throw new CalgaryRoadEventProviderError('Missing source metadata.');
        const rows = DatasetRowsSchema.parse(dataResult.value);
        const events: RoadEvent[] = [];
        let droppedRows = 0;
        for (const row of rows) {
          try {
            if (!construction && NoIncidentRowSchema.safeParse(row).success) continue;
            const event = construction
              ? normalizeConstruction(ConstructionRowSchema.parse(row), currentLocalDateTime)
              : normalizeIncident(IncidentRowSchema.parse(row));
            if (event !== undefined) events.push(event);
          } catch {
            droppedRows += 1;
          }
        }
        if (droppedRows > 0) {
          options.onFailure?.({ datasetId, droppedRows, errorName: 'RoadEventRowParseError' });
        }
        // Allow an isolated bad row; reject feeds with more than 10% malformed rows.
        if (droppedRows > Math.max(1, Math.floor(rows.length * 0.1))) {
          throw new CalgaryRoadEventProviderError('Too many malformed rows.');
        }
        const incomplete = droppedRows > 0;
        datasets.set(sourceId, { events, loadedAt: now, source: currentSource });
        return {
          events,
          source: currentSource,
          available: true,
          degraded: incomplete,
          cacheUntil: Number.POSITIVE_INFINITY,
        };
      } catch (error: unknown) {
        options.onFailure?.({
          datasetId,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
        return {
          events: usablePrevious?.events ?? [],
          source: usablePrevious?.source ?? currentSource,
          available: usablePrevious !== undefined,
          degraded: true,
          cacheUntil:
            usablePrevious === undefined
              ? Number.POSITIVE_INFINITY
              : usablePrevious.loadedAt + maximumStaleMs + 1,
        };
      }
    };

    const [construction, incidents] = await Promise.all([
      loadDataset('calgary-construction-detours', constructionDataUrl, constructionMetadataUrl),
      loadDataset('calgary-current-incidents', incidentDataUrl, incidentMetadataUrl),
    ]);
    // V1 requires both source descriptors; never invent a missing source timestamp.
    if (
      construction.source === undefined ||
      incidents.source === undefined ||
      (!construction.available && !incidents.available)
    ) {
      throw new CalgaryRoadEventProviderError('Official Calgary road data could not be loaded.');
    }
    const events = [...construction.events, ...incidents.events].sort((left, right) =>
      left.startsAtLocal === right.startsAtLocal
        ? left.id.localeCompare(right.id, 'en-CA')
        : left.startsAtLocal.localeCompare(right.startsAtLocal, 'en-CA'),
    );
    const degraded = construction.degraded || incidents.degraded;
    const value = RoadEventResponseSchema.parse({
      degraded,
      events,
      generatedAt: new Date(now).toISOString(),
      sources: [construction.source, incidents.source],
      stale: degraded,
    });
    cached = {
      expiresAt: Math.min(now + cacheTtlMs, construction.cacheUntil, incidents.cacheUntil),
      value,
    };
    return value;
  };

  const getRoadEvents = (): Promise<RoadEventResponse> => {
    if (refreshing !== undefined) return refreshing;
    refreshing = loadRoadEvents().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };

  return {
    getRoadEvents,
    start(): void {
      if (interval !== undefined) return;
      void getRoadEvents().catch(() => undefined);
      interval = setInterval(() => {
        void getRoadEvents().catch(() => undefined);
      }, refreshIntervalMs);
      interval.unref();
    },
    stop(): void {
      if (interval === undefined) return;
      clearInterval(interval);
      interval = undefined;
    },
  };
}
