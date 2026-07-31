import {
  OfficialRoadEventResponseSchema,
  OfficialRoadEventSchema,
  type OfficialRoadEvent,
  type OfficialRoadEventResponse,
} from '@navoss/contracts';
import { z } from 'zod/v4';

const DEFAULT_DATA_URL =
  'https://api.open511.gov.bc.ca/events?format=json&status=ACTIVE&bbox=-119.65,49.70,-119.20,50.15&limit=500';
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MAXIMUM_STALE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const KELOWNA_BOUNDS = { east: -119.2, north: 50.15, south: 49.7, west: -119.65 } as const;

const CoordinatePairSchema = z.tuple([z.number(), z.number()]);
const GeographySchema = z.discriminatedUnion('type', [
  z.object({ coordinates: CoordinatePairSchema, type: z.literal('Point') }).strict(),
  z
    .object({
      coordinates: z.array(CoordinatePairSchema).min(2).max(20_000),
      type: z.literal('LineString'),
    })
    .strict(),
]);
const RoadSchema = z
  .object({
    direction: z.enum(['BOTH', 'E', 'N', 'NONE', 'S', 'W']),
    from: z.string().optional(),
    name: z.string().min(1),
    state: z.string().optional(),
    to: z.string().optional(),
  })
  .strict();
const ScheduleSchema = z
  .object({
    intervals: z.array(z.string().min(1)).max(500).optional(),
    recurring_schedules: z
      .array(
        z
          .object({
            daily_end_time: z.string().min(1),
            daily_start_time: z.string().min(1),
            days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
            end_date: z.string().min(1),
            start_date: z.string().min(1),
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict();
const Open511EventSchema = z
  .object({
    '+ivr_message': z.string().min(1),
    '+linear_reference_km': z.number(),
    areas: z
      .array(z.object({ id: z.string().min(1), name: z.string().min(1), url: z.url() }).strict())
      .max(20),
    created: z.iso.datetime({ offset: true }),
    description: z.string().min(1),
    event_subtypes: z.array(z.string().min(1)).max(20),
    event_type: z.enum([
      'CONSTRUCTION',
      'INCIDENT',
      'ROAD_CONDITION',
      'SPECIAL_EVENT',
      'WEATHER_CONDITION',
    ]),
    geography: GeographySchema,
    headline: z.string().min(1),
    id: z.string().min(1),
    jurisdiction_url: z.url(),
    roads: z.array(RoadSchema).min(1).max(20),
    schedule: ScheduleSchema.optional(),
    severity: z.enum(['MAJOR', 'MINOR', 'MODERATE', 'UNKNOWN']),
    status: z.literal('ACTIVE'),
    updated: z.iso.datetime({ offset: true }),
    url: z.url(),
  })
  .strict();
const Open511ResponseSchema = z
  .object({
    events: z.array(Open511EventSchema).max(500),
    meta: z.object({ up_url: z.string(), url: z.string(), version: z.literal('v1') }).strict(),
    pagination: z.object({ offset: z.string() }).strict(),
  })
  .strict();

const DIRECTION_LABELS = {
  BOTH: 'Both directions',
  E: 'Eastbound',
  N: 'Northbound',
  NONE: 'Direction not specified',
  S: 'Southbound',
  W: 'Westbound',
} as const;
const FULL_CLOSURE_PATTERN =
  /\b(?:road|highway|bridge|route)\s+(?:is\s+)?closed\b|\bclosed in both directions\b|\ball lanes (?:are )?closed\b|\b(?:full|complete) (?:road )?closure\b/iu;

export class DriveBcRoadEventProviderError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DriveBcRoadEventProviderError';
  }
}

export interface DriveBcRoadEventProvider {
  getRoadEvents(): Promise<OfficialRoadEventResponse>;
  start?(): void;
  stop?(): void;
}

interface DriveBcRoadEventProviderOptions {
  cacheTtlMs?: number;
  clock?: () => number;
  dataUrl?: string;
  fetchImplementation?: typeof fetch;
  maximumStaleMs?: number;
  refreshIntervalMs?: number;
  requestTimeoutMs?: number;
}

function normalizedText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function isInKelowna(latitude: number, longitude: number): boolean {
  return (
    latitude >= KELOWNA_BOUNDS.south &&
    latitude <= KELOWNA_BOUNDS.north &&
    longitude >= KELOWNA_BOUNDS.west &&
    longitude <= KELOWNA_BOUNDS.east
  );
}

function representativeCoordinate(event: z.infer<typeof Open511EventSchema>):
  | {
      latitude: number;
      longitude: number;
    }
  | undefined {
  const pair =
    event.geography.type === 'Point'
      ? event.geography.coordinates
      : event.geography.coordinates.find(([longitude, latitude]) =>
          isInKelowna(latitude, longitude),
        );
  if (pair === undefined) return undefined;
  const [longitude, latitude] = pair;
  return isInKelowna(latitude, longitude) ? { latitude, longitude } : undefined;
}

function parseDriveBcTimestamp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
  }

  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/u.exec(value);
  if (local === null) return undefined;
  const year = Number(local[1]);
  const month = Number(local[2]);
  const day = Number(local[3]);
  const hour = Number(local[4]);
  const minute = Number(local[5]);
  const second = Number(local[6]);
  if ([year, month, day, hour, minute, second].some((part) => !Number.isInteger(part))) {
    return undefined;
  }
  const millisecond = Number((local[7] ?? '').padEnd(3, '0'));
  const target = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone: 'America/Vancouver',
    year: 'numeric',
  });
  const offsetAt = (timestamp: number): number => {
    const formattedParts = formatter.formatToParts(new Date(timestamp));
    const value = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(formattedParts.find((part) => part.type === type)?.value);
    return (
      Date.UTC(
        value('year'),
        value('month') - 1,
        value('day'),
        value('hour'),
        value('minute'),
        value('second'),
      ) - timestamp
    );
  };
  let timestamp = target - offsetAt(target);
  timestamp = target - offsetAt(timestamp);
  return new Date(timestamp).toISOString();
}

function parseInterval(schedule: z.infer<typeof ScheduleSchema> | undefined): {
  endsAt?: string;
  startsAt?: string;
} {
  const [start, end] = schedule?.intervals?.[0]?.split('/') ?? [];
  const startsAt = parseDriveBcTimestamp(start);
  const endsAt = parseDriveBcTimestamp(end);
  const recurring = schedule?.recurring_schedules?.[0];
  const recurringStartsAt = parseDriveBcTimestamp(
    recurring === undefined
      ? undefined
      : `${recurring.start_date}T${recurring.daily_start_time}:00`,
  );
  const recurringEndsAt = parseDriveBcTimestamp(
    recurring === undefined ? undefined : `${recurring.end_date}T${recurring.daily_end_time}:00`,
  );
  const resolvedEndsAt = endsAt ?? recurringEndsAt;
  const resolvedStartsAt = startsAt ?? recurringStartsAt;
  return {
    ...(resolvedEndsAt === undefined ? {} : { endsAt: resolvedEndsAt }),
    ...(resolvedStartsAt === undefined ? {} : { startsAt: resolvedStartsAt }),
  };
}

function recurringScheduleDescription(
  schedule: z.infer<typeof ScheduleSchema> | undefined,
): string | undefined {
  const recurring = schedule?.recurring_schedules?.[0];
  if (recurring === undefined) return undefined;
  return `Recurring daily work window ${recurring.daily_start_time}–${recurring.daily_end_time} on source-listed days through ${recurring.end_date} (America/Vancouver).`;
}

function normalizeEvent(row: z.infer<typeof Open511EventSchema>): OfficialRoadEvent | undefined {
  const coordinate = representativeCoordinate(row);
  if (coordinate === undefined) return undefined;
  const recurringDescription = recurringScheduleDescription(row.schedule);
  const description = normalizedText(
    recurringDescription === undefined
      ? row.description
      : `${row.description} ${recurringDescription}`,
  );
  const isFullClosure = FULL_CLOSURE_PATTERN.test(description);
  const type = isFullClosure
    ? 'closure'
    : row.event_type === 'CONSTRUCTION'
      ? 'construction'
      : 'incident';
  const roadwayName = normalizedText(row.roads[0]?.name ?? '');
  const typeLabel =
    type === 'construction' ? 'Construction' : type === 'closure' ? 'Closure' : 'Incident';
  const interval = parseInterval(row.schedule);
  const startsAt = interval.startsAt ?? new Date(row.created).toISOString();
  return OfficialRoadEventSchema.parse({
    confidence: 'official',
    coordinate,
    description,
    direction: DIRECTION_LABELS[row.roads[0]?.direction ?? 'BOTH'],
    ...(interval.endsAt === undefined ? {} : { endsAt: interval.endsAt }),
    id: `drivebc-open511:${row.id.replace(/^drivebc\.ca\//u, '')}`,
    isFullClosure,
    regionId: 'kelowna-bc',
    reportedAt: new Date(row.created).toISOString(),
    roadwayName,
    sourceId: 'drivebc-open511-events',
    startsAt,
    title: `${typeLabel} on ${roadwayName}`,
    type,
    updatedAt: new Date(row.updated).toISOString(),
  });
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
    throw new DriveBcRoadEventProviderError(`DriveBC Open511 returned ${String(response.status)}.`);
  }
  return response.json();
}

export function createDriveBcRoadEventProvider(
  options: DriveBcRoadEventProviderOptions = {},
): DriveBcRoadEventProvider {
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
      const payload = Open511ResponseSchema.parse(
        await fetchJson(fetchImplementation, dataUrl, requestTimeoutMs),
      );
      const events = payload.events
        .flatMap((row) => {
          const event = normalizeEvent(row);
          return event === undefined ? [] : [event];
        })
        .sort((left, right) => left.id.localeCompare(right.id, 'en-CA'));
      const updatedAt = payload.events.reduce<string | undefined>(
        (latest, event) =>
          latest === undefined || event.updated > latest ? event.updated : latest,
        undefined,
      );
      const value = OfficialRoadEventResponseSchema.parse({
        degraded: false,
        events,
        generatedAt: new Date(now).toISOString(),
        regionId: 'kelowna-bc',
        source: {
          apiDocumentationUrl: 'https://api.open511.gov.bc.ca/help',
          attribution:
            'Contains information licensed under the Open Government Licence \u2013 British Columbia.',
          confidence: 'official',
          dataUrl: DEFAULT_DATA_URL,
          licenseUrl:
            'https://www2.gov.bc.ca/gov/content/data/open-data/open-government-license-bc',
          refreshIntervalSeconds: 300,
          sourceId: 'drivebc-open511-events',
          ...(updatedAt === undefined ? {} : { updatedAt: new Date(updatedAt).toISOString() }),
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
      if (error instanceof DriveBcRoadEventProviderError) throw error;
      throw new DriveBcRoadEventProviderError('Official DriveBC road data could not be loaded.', {
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
      interval = setInterval(() => void getRoadEvents().catch(() => undefined), refreshIntervalMs);
      interval.unref();
    },
    stop(): void {
      if (interval === undefined) return;
      clearInterval(interval);
      interval = undefined;
    },
  };
}
