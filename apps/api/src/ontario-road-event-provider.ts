import {
  OfficialRoadEventResponseSchema,
  OfficialRoadEventSchema,
  type OfficialRoadEvent,
  type OfficialRoadEventResponse,
  type OfficialRoadEventType,
} from '@navoss/contracts';
import { z } from 'zod/v4';

const DEFAULT_DATA_URL = 'https://511on.ca/api/v2/get/event?format=json&lang=en';
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MAXIMUM_STALE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const ONTARIO_BOUNDS = {
  east: -74.32,
  north: 56.9,
  south: 41.67,
  west: -95.16,
} as const;

const Ontario511EventRowSchema = z
  .object({
    Description: z.string().min(1),
    DirectionOfTravel: z.string().min(1),
    EventType: z.enum(['roadwork', 'closures', 'accidentsAndIncidents']),
    ID: z.union([z.string(), z.number()]),
    IsFullClosure: z.boolean(),
    LastUpdated: z.number().int().nonnegative(),
    Latitude: z.number(),
    Longitude: z.number(),
    PlannedEndDate: z.number().int().nonnegative().nullable().optional(),
    Reported: z.number().int().nonnegative(),
    RoadwayName: z.string().min(1),
    SourceId: z.union([z.string(), z.number()]),
    StartDate: z.number().int().nonnegative(),
  })
  .loose();

const Ontario511EventRowsSchema = z.array(Ontario511EventRowSchema).max(2_000);

export class OntarioRoadEventProviderError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OntarioRoadEventProviderError';
  }
}

export interface OntarioRoadEventProvider {
  getRoadEvents(): Promise<OfficialRoadEventResponse>;
  start?(): void;
  stop?(): void;
}

interface OntarioRoadEventProviderOptions {
  cacheTtlMs?: number;
  clock?: () => number;
  dataUrl?: string;
  fetchImplementation?: typeof fetch;
  maximumStaleMs?: number;
  refreshIntervalMs?: number;
  requestTimeoutMs?: number;
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
    throw new OntarioRoadEventProviderError(`Ontario 511 returned ${String(response.status)}.`);
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
    .replace(/&nbsp;/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function eventType(
  value: z.infer<typeof Ontario511EventRowSchema>['EventType'],
): OfficialRoadEventType {
  if (value === 'roadwork') return 'construction';
  if (value === 'closures') return 'closure';
  return 'incident';
}

function isInOntario(latitude: number, longitude: number): boolean {
  return (
    latitude >= ONTARIO_BOUNDS.south &&
    latitude <= ONTARIO_BOUNDS.north &&
    longitude >= ONTARIO_BOUNDS.west &&
    longitude <= ONTARIO_BOUNDS.east
  );
}

function normalizeEvent(
  row: z.infer<typeof Ontario511EventRowSchema>,
  currentTimeSeconds: number,
): OfficialRoadEvent | undefined {
  if (
    !isInOntario(row.Latitude, row.Longitude) ||
    (row.PlannedEndDate !== null &&
      row.PlannedEndDate !== undefined &&
      row.PlannedEndDate < currentTimeSeconds)
  ) {
    return undefined;
  }

  const type = eventType(row.EventType);
  const roadwayName = normalizedText(row.RoadwayName);
  const typeLabel =
    type === 'construction' ? 'Construction' : type === 'closure' ? 'Closure' : 'Incident';
  return OfficialRoadEventSchema.parse({
    confidence: 'official',
    coordinate: { latitude: row.Latitude, longitude: row.Longitude },
    description: normalizedText(row.Description),
    direction: normalizedText(row.DirectionOfTravel),
    ...(row.PlannedEndDate === null || row.PlannedEndDate === undefined
      ? {}
      : { endsAt: new Date(row.PlannedEndDate * 1_000).toISOString() }),
    id: `ontario-511:${String(row.ID)}:${String(row.SourceId)}`,
    isFullClosure: row.IsFullClosure,
    regionId: 'ontario',
    reportedAt: new Date(row.Reported * 1_000).toISOString(),
    roadwayName,
    sourceId: 'ontario-511-events',
    startsAt: new Date(row.StartDate * 1_000).toISOString(),
    title: `${typeLabel} on ${roadwayName}`,
    type,
    updatedAt: new Date(row.LastUpdated * 1_000).toISOString(),
  });
}

export function createOntarioRoadEventProvider(
  options: OntarioRoadEventProviderOptions = {},
): OntarioRoadEventProvider {
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const clock = options.clock ?? Date.now;
  const dataUrl = options.dataUrl ?? DEFAULT_DATA_URL;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const maximumStaleMs = options.maximumStaleMs ?? DEFAULT_MAXIMUM_STALE_MS;
  const refreshIntervalMs = options.refreshIntervalMs ?? cacheTtlMs;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let cached: { expiresAt: number; loadedAt: number; value: OfficialRoadEventResponse } | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let refreshing: Promise<OfficialRoadEventResponse> | undefined;

  const loadRoadEvents = async (): Promise<OfficialRoadEventResponse> => {
    const now = clock();
    if (cached !== undefined && now < cached.expiresAt) return cached.value;

    try {
      const rows = Ontario511EventRowsSchema.parse(
        await fetchJson(fetchImplementation, dataUrl, requestTimeoutMs),
      );
      const currentTimeSeconds = Math.floor(now / 1_000);
      const events = rows
        .flatMap((row) => {
          const event = normalizeEvent(row, currentTimeSeconds);
          return event === undefined ? [] : [event];
        })
        .sort((left, right) =>
          left.startsAt === right.startsAt
            ? left.id.localeCompare(right.id, 'en-CA')
            : left.startsAt.localeCompare(right.startsAt, 'en-CA'),
        );
      const latestUpdateSeconds = rows.reduce(
        (latest, row) => Math.max(latest, row.LastUpdated),
        0,
      );
      const value = OfficialRoadEventResponseSchema.parse({
        degraded: false,
        events,
        generatedAt: new Date(now).toISOString(),
        regionId: 'ontario',
        source: {
          apiDocumentationUrl: 'https://511on.ca/developers/doc',
          attribution:
            'Contains information licensed under the Open Government Licence \u2013 Ontario.',
          confidence: 'official',
          licenseUrl: 'https://www.ontario.ca/page/open-government-licence-ontario',
          refreshIntervalSeconds: 300,
          sourceId: 'ontario-511-events',
          ...(latestUpdateSeconds === 0
            ? {}
            : { updatedAt: new Date(latestUpdateSeconds * 1_000).toISOString() }),
        },
        stale: false,
      });
      cached = { expiresAt: now + cacheTtlMs, loadedAt: now, value };
      return value;
    } catch (error: unknown) {
      if (cached !== undefined && now - cached.loadedAt <= maximumStaleMs) {
        return OfficialRoadEventResponseSchema.parse({
          ...cached.value,
          degraded: true,
          generatedAt: new Date(now).toISOString(),
          stale: true,
        });
      }
      if (error instanceof OntarioRoadEventProviderError) throw error;
      throw new OntarioRoadEventProviderError('Official Ontario road data could not be loaded.', {
        cause: error,
      });
    }
  };

  const getRoadEvents = (): Promise<OfficialRoadEventResponse> => {
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
