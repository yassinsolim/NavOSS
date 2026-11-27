import {
  PROVINCIAL_ROAD_EVENT_ENVELOPES,
  ProvincialRoadEventSchema,
  type ProvincialRoadEvent,
  type ProvincialRoadEventType,
  type RoadEventSeverity,
} from '@navoss/contracts';
import { z } from 'zod/v4';

import {
  createRoadEventFeed,
  newestTimestamp,
  normalizedText,
  truncate,
  type RoadEventFeed,
  type RoadEventFeedOptions,
  type RoadEventRoutingRow,
} from './official-road-event-feed.js';

/**
 * DriveBC's Open511 events for the whole province, no key required. The API caps a page at 500
 * events and documents `limit`/`offset` pagination.
 *
 * Schedule intervals carry no offset. On 2026-11-15 the start of 121 of 298 live intervals equalled
 * the event's `created` time converted to UTC (and none equalled it as Pacific wall time), so
 * offsetless interval times are read as UTC.
 */

export const DRIVEBC_PROVINCE_EVENTS_URL =
  'https://api.open511.gov.bc.ca/events?format=json&status=ACTIVE';
const PAGE_SIZE = 500;
const MAXIMUM_PAGES = 8;

const PairSchema = z.tuple([z.number(), z.number()]);
const RowSchema = z
  .object({
    created: z.iso.datetime({ offset: true }),
    description: z.string().trim().min(1),
    event_subtypes: z.array(z.string()).max(20).optional(),
    event_type: z.string().trim().min(1),
    geography: z.union([
      z.object({ coordinates: PairSchema, type: z.literal('Point') }).loose(),
      z
        .object({
          coordinates: z.array(PairSchema).min(1).max(20_000),
          type: z.literal('LineString'),
        })
        .loose(),
    ]),
    id: z.string().min(1).max(120),
    roads: z
      .array(
        z
          .object({
            direction: z.string().optional(),
            name: z.string().optional(),
            state: z.string().optional(),
          })
          .loose(),
      )
      .max(20)
      .optional(),
    schedule: z
      .object({
        intervals: z.array(z.string()).max(500).optional(),
        recurring_schedules: z
          .array(
            z
              .object({ end_date: z.string().optional(), start_date: z.string().optional() })
              .loose(),
          )
          .max(100)
          .optional(),
      })
      .loose()
      .optional(),
    severity: z.string().optional(),
    status: z.string().optional(),
    updated: z.iso.datetime({ offset: true }),
  })
  .loose();
const PageSchema = z.object({ events: z.array(z.unknown()).max(PAGE_SIZE) }).loose();

const DIRECTIONS: Readonly<Record<string, string>> = {
  BOTH: 'Both directions',
  E: 'Eastbound',
  N: 'Northbound',
  S: 'Southbound',
  W: 'Westbound',
};
const SEVERITIES: Readonly<Record<string, RoadEventSeverity>> = {
  MAJOR: 'major',
  MINOR: 'minor',
  MODERATE: 'moderate',
};
const TYPE_LABELS: Readonly<Record<ProvincialRoadEventType, string>> = {
  closure: 'Closure',
  collision: 'Collision',
  construction: 'Construction',
  hazard: 'Hazard',
  incident: 'Incident',
  'road-condition': 'Road conditions',
  'special-event': 'Special event',
  'stalled-vehicle': 'Stalled vehicle',
};

/** Offsetless Open511 interval bound, read as UTC (see the module comment). */
export function intervalInstant(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const text = value.trim();
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/u.test(text);
  if (!hasOffset && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/u.test(text)) {
    throw new Error('Invalid interval bound.');
  }
  const time = Date.parse(hasOffset ? text : `${text}Z`);
  if (!Number.isFinite(time)) throw new Error('Invalid interval bound.');
  return new Date(time).toISOString();
}

function eventType(row: z.infer<typeof RowSchema>, closed: boolean): ProvincialRoadEventType {
  const subtypes = new Set((row.event_subtypes ?? []).map((subtype) => subtype.toUpperCase()));
  const type = row.event_type.toUpperCase();
  let mapped: ProvincialRoadEventType;
  if (type === 'CONSTRUCTION') mapped = 'construction';
  else if (type === 'ROAD_CONDITION' || type === 'WEATHER_CONDITION') mapped = 'road-condition';
  else if (type === 'SPECIAL_EVENT') mapped = 'special-event';
  else if (subtypes.has('ACCIDENT')) mapped = 'collision';
  else if (subtypes.has('STALLED_VEHICLE') || subtypes.has('DISABLED_VEHICLE')) {
    mapped = 'stalled-vehicle';
  } else if (
    ['HAZARD', 'OBSTRUCTION', 'SPILL', 'FALLEN_TREE', 'ANIMAL_ON_ROADWAY'].some((subtype) =>
      subtypes.has(subtype),
    )
  ) {
    mapped = 'hazard';
  } else mapped = 'incident';
  return closed && mapped !== 'collision' ? 'closure' : mapped;
}

function representative(
  row: z.infer<typeof RowSchema>,
): { latitude: number; longitude: number } | undefined {
  const pairs =
    row.geography.type === 'Point' ? [row.geography.coordinates] : row.geography.coordinates;
  const envelope = PROVINCIAL_ROAD_EVENT_ENVELOPES['british-columbia'];
  const inside = pairs.filter(
    ([longitude, latitude]) =>
      latitude >= envelope.south &&
      latitude <= envelope.north &&
      longitude >= envelope.west &&
      longitude <= envelope.east,
  );
  const pair = inside[Math.floor(inside.length / 2)];
  return pair === undefined ? undefined : { latitude: pair[1], longitude: pair[0] };
}

export function normalizeDriveBcEvent(input: unknown): ProvincialRoadEvent | undefined {
  const row = RowSchema.parse(input);
  if (row.status !== undefined && row.status !== 'ACTIVE') return undefined;
  const coordinate = representative(row);
  // Zeroed, swapped or out-of-province geometry is a malformed row, counted against the feed.
  if (coordinate === undefined) throw new Error('DriveBC event has no in-province vertex.');
  const road = row.roads?.[0];
  const closed = road?.state?.toUpperCase() === 'CLOSED';
  const type = eventType(row, closed);
  const roadwayName =
    road?.name === undefined || normalizedText(road.name) === ''
      ? undefined
      : truncate(normalizedText(road.name), 160);
  const [start, end] = row.schedule?.intervals?.[0]?.split('/') ?? [];
  const recurring = row.schedule?.recurring_schedules?.[0];
  const startsAt = intervalInstant(start);
  let endsAt = intervalInstant(end);
  if (startsAt !== undefined && endsAt !== undefined && endsAt < startsAt) endsAt = undefined;
  const startsOn = startsAt === undefined ? recurring?.start_date : undefined;
  const endsOn = endsAt === undefined ? recurring?.end_date : undefined;
  const direction = DIRECTIONS[road?.direction?.toUpperCase() ?? ''];
  const severity = SEVERITIES[row.severity?.toUpperCase() ?? ''];
  return ProvincialRoadEventSchema.parse({
    confidence: 'official',
    coordinate,
    description: truncate(normalizedText(row.description), 4_000),
    ...(direction === undefined ? {} : { direction }),
    ...(endsAt === undefined ? {} : { endsAt }),
    ...(endsOn === undefined ? {} : { endsOn }),
    id: `drivebc-open511:${row.id.replace(/^drivebc\.ca\//u, '')}`,
    isFullClosure: closed,
    regionId: 'british-columbia',
    reportedAt: new Date(row.created).toISOString(),
    ...(roadwayName === undefined ? {} : { roadwayName }),
    ...(severity === undefined ? {} : { severity }),
    sourceId: 'drivebc-open511-events',
    ...(startsAt === undefined ? {} : { startsAt }),
    ...(startsOn === undefined ? {} : { startsOn }),
    title: roadwayName === undefined ? TYPE_LABELS[type] : `${TYPE_LABELS[type]} on ${roadwayName}`,
    type,
    updatedAt: new Date(row.updated).toISOString(),
  });
}

export function createDriveBcProvinceRoadEventFeed(
  options: RoadEventFeedOptions & { dataUrl?: string } = {},
): RoadEventFeed {
  const dataUrl = options.dataUrl ?? DRIVEBC_PROVINCE_EVENTS_URL;
  return createRoadEventFeed(
    {
      attribution:
        'Contains information licensed under the Open Government Licence \u2013 British Columbia.',
      confidence: 'official',
      documentationUrl: 'https://api.open511.gov.bc.ca/help',
      licenseUrl: 'https://www2.gov.bc.ca/gov/content/data/open-data/open-government-license-bc',
      maximumAgeSeconds: 3_600,
      name: 'DriveBC',
      refreshIntervalSeconds: 300,
      sourceId: 'drivebc-open511-events',
      timeZone: 'America/Vancouver',
    },
    async ({ fetchJson }) => {
      const rows: unknown[] = [];
      for (let page = 0; page < MAXIMUM_PAGES; page += 1) {
        const url = new URL(dataUrl);
        url.searchParams.set('limit', String(PAGE_SIZE));
        url.searchParams.set('offset', String(page * PAGE_SIZE));
        const { events } = PageSchema.parse(await fetchJson(url.toString()));
        rows.push(...events);
        if (events.length < PAGE_SIZE) break;
      }
      const events: ProvincialRoadEvent[] = [];
      const routingRows: RoadEventRoutingRow[] = [];
      let droppedRows = 0;
      for (const row of rows) {
        try {
          const event = normalizeDriveBcEvent(row);
          if (event !== undefined) {
            events.push(event);
            routingRows.push({ event, row });
          }
        } catch {
          droppedRows += 1;
        }
      }
      const updatedAt = newestTimestamp(events.map((event) => event.updatedAt));
      return {
        droppedRows,
        events,
        routingRows,
        totalRows: rows.length,
        ...(updatedAt === undefined ? {} : { updatedAt }),
      };
    },
    options,
  );
}
