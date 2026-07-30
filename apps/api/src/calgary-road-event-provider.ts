import { createHash } from 'node:crypto';

import {
  RoadEventResponseSchema,
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
    coordinates: z.tuple([z.coerce.number(), z.coerce.number()]),
    type: z.literal('Point'),
  })
  .loose();

const ConstructionRowSchema = z
  .object({
    construction_info: z.string().min(1),
    description: z.string().min(1),
    end_dt: z.string().min(1).optional(),
    point: PointSchema,
    start_dt: z.string().min(1),
  })
  .loose();

const IncidentRowSchema = z
  .object({
    description: z.string().min(1),
    incident_info: z.string().min(1),
    modified_dt: z.string().min(1),
    point: PointSchema,
    start_dt: z.string().min(1),
  })
  .loose();

const NoIncidentRowSchema = z.object({ incident_info: z.literal('NO TRAFFIC INCIDENTS') }).loose();
const ConstructionRowsSchema = z.array(ConstructionRowSchema).max(1_000);
const IncidentRowsSchema = z.array(z.union([IncidentRowSchema, NoIncidentRowSchema])).max(1_000);
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
}

function dataUrl(datasetId: string, fields: string): string {
  const url = new URL(`https://data.calgary.ca/resource/${datasetId}.json`);
  url.searchParams.set('$limit', '1001');
  url.searchParams.set('$select', fields);
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

function coordinate(point: z.infer<typeof PointSchema>): { latitude: number; longitude: number } {
  const [longitude, latitude] = point.coordinates;
  return { latitude, longitude };
}

function normalizeConstruction(
  row: z.infer<typeof ConstructionRowSchema>,
  currentLocalDateTime: string,
): RoadEvent | undefined {
  if (row.end_dt !== undefined && row.end_dt < currentLocalDateTime) return undefined;
  const title = normalizedText(row.construction_info);
  const description = normalizedText(row.description);
  const location = coordinate(row.point);
  return {
    confidence: 'official',
    coordinate: location,
    description,
    ...(row.end_dt === undefined ? {} : { endsAtLocal: row.end_dt }),
    id: eventId('calgary-construction', [title, description, row.start_dt, location]),
    sourceId: 'calgary-construction-detours',
    startsAtLocal: row.start_dt,
    timeZone: 'America/Edmonton',
    title,
    type: 'construction',
  };
}

function normalizeIncident(row: z.infer<typeof IncidentRowSchema>): RoadEvent {
  const title = normalizedText(row.incident_info);
  const description = normalizedText(row.description);
  const location = coordinate(row.point);
  return {
    confidence: 'unverified',
    coordinate: location,
    description,
    id: eventId('calgary-incident', [title, row.start_dt, location]),
    sourceId: 'calgary-current-incidents',
    startsAtLocal: row.start_dt,
    timeZone: 'America/Edmonton',
    title,
    type: 'incident',
  };
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
  const constructionDataUrl =
    options.constructionDataUrl ??
    dataUrl(CONSTRUCTION_DATASET_ID, 'construction_info,description,start_dt,end_dt,point');
  const constructionMetadataUrl =
    options.constructionMetadataUrl ??
    `https://data.calgary.ca/api/views/${CONSTRUCTION_DATASET_ID}`;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const incidentDataUrl =
    options.incidentDataUrl ??
    dataUrl(INCIDENT_DATASET_ID, 'incident_info,description,start_dt,modified_dt,point');
  const incidentMetadataUrl =
    options.incidentMetadataUrl ?? `https://data.calgary.ca/api/views/${INCIDENT_DATASET_ID}`;
  const maximumStaleMs = options.maximumStaleMs ?? DEFAULT_MAXIMUM_STALE_MS;
  const refreshIntervalMs = options.refreshIntervalMs ?? cacheTtlMs;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let cached: { expiresAt: number; loadedAt: number; value: RoadEventResponse } | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let refreshing: Promise<RoadEventResponse> | undefined;

  const loadRoadEvents = async (): Promise<RoadEventResponse> => {
    const now = clock();
    if (cached !== undefined && now < cached.expiresAt) return cached.value;

    try {
      const [
        constructionPayload,
        constructionMetadataPayload,
        incidentPayload,
        incidentMetadataPayload,
      ] = await Promise.all([
        fetchJson(fetchImplementation, constructionDataUrl, requestTimeoutMs),
        fetchJson(fetchImplementation, constructionMetadataUrl, requestTimeoutMs),
        fetchJson(fetchImplementation, incidentDataUrl, requestTimeoutMs),
        fetchJson(fetchImplementation, incidentMetadataUrl, requestTimeoutMs),
      ]);
      const constructions = ConstructionRowsSchema.parse(constructionPayload);
      const constructionMetadata = DatasetMetadataSchema.parse(constructionMetadataPayload);
      const incidents = IncidentRowsSchema.parse(incidentPayload);
      const incidentMetadata = DatasetMetadataSchema.parse(incidentMetadataPayload);
      const currentLocalDateTime = calgaryLocalDateTime(now);
      const events = [
        ...constructions.flatMap((row) => {
          const event = normalizeConstruction(row, currentLocalDateTime);
          return event === undefined ? [] : [event];
        }),
        ...incidents.flatMap((row) => {
          const incident = IncidentRowSchema.safeParse(row);
          return incident.success ? [normalizeIncident(incident.data)] : [];
        }),
      ].sort((left, right) =>
        left.startsAtLocal === right.startsAtLocal
          ? left.id.localeCompare(right.id, 'en-CA')
          : left.startsAtLocal.localeCompare(right.startsAtLocal, 'en-CA'),
      );
      const value = RoadEventResponseSchema.parse({
        degraded: false,
        events,
        generatedAt: new Date(now).toISOString(),
        sources: [
          source('calgary-construction-detours', constructionMetadata.rowsUpdatedAt),
          source('calgary-current-incidents', incidentMetadata.rowsUpdatedAt),
        ],
        stale: false,
      });
      cached = { expiresAt: now + cacheTtlMs, loadedAt: now, value };
      return value;
    } catch (error: unknown) {
      if (cached !== undefined && now - cached.loadedAt <= maximumStaleMs) {
        return RoadEventResponseSchema.parse({
          ...cached.value,
          degraded: true,
          generatedAt: new Date(now).toISOString(),
          stale: true,
        });
      }
      if (error instanceof CalgaryRoadEventProviderError) throw error;
      throw new CalgaryRoadEventProviderError('Official Calgary road data could not be loaded.', {
        cause: error,
      });
    }
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
