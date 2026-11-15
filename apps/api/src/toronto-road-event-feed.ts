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
} from './official-road-event-feed.js';

/**
 * City of Toronto "Road Restrictions" (version 3 JSON), no key required. Times are Unix
 * milliseconds. The feed lists every permitted restriction, most of them outside their work
 * window at any given moment; NavOSS keeps only rows whose own current impact (`currImpact`) is
 * not `None`, so the list shows what the City says is affecting traffic now.
 */

export const TORONTO_ROAD_RESTRICTIONS_URL =
  'https://secure.toronto.ca/opendata/cart/road_restrictions/v3?format=json';

const MillisecondsSchema = z
  .union([z.string().regex(/^\d{10,14}$/u), z.number().int().positive()])
  .transform((value) => new Date(Number(value)).toISOString());
const NumberTextSchema = z.union([z.string(), z.number()]).transform(Number).pipe(z.number());

const RowSchema = z
  .object({
    createdTime: MillisecondsSchema.nullish(),
    currImpact: z.string().nullish(),
    description: z.string().nullish(),
    directionsAffected: z.string().nullish(),
    endTime: MillisecondsSchema.nullish(),
    expired: z.union([z.number(), z.string()]).nullish(),
    id: z.string().min(1).max(120),
    lastUpdated: MillisecondsSchema,
    latitude: NumberTextSchema,
    longitude: NumberTextSchema,
    name: z.string().nullish(),
    road: z.string().nullish(),
    startTime: MillisecondsSchema.nullish(),
    type: z.string().trim().min(1),
  })
  .loose();
const PayloadSchema = z.object({ Closure: z.array(z.unknown()).max(10_000) }).loose();

const IMPACT_SEVERITY: Readonly<Record<string, RoadEventSeverity>> = {
  High: 'major',
  Low: 'minor',
  Medium: 'moderate',
};
const DIRECTIONS: Readonly<Record<string, string>> = {
  BOTH_DIRECTIONS: 'Both directions',
  ONE_DIRECTION: 'One direction',
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

export function normalizeTorontoRestriction(input: unknown): ProvincialRoadEvent | undefined {
  const row = RowSchema.parse(input);
  if (String(row.expired ?? 0) !== '0') return undefined;
  const impact = row.currImpact?.trim() ?? '';
  if (impact === '' || impact === 'None') return undefined;
  const envelope = PROVINCIAL_ROAD_EVENT_ENVELOPES.ontario;
  if (
    row.latitude < envelope.south ||
    row.latitude > envelope.north ||
    row.longitude < envelope.west ||
    row.longitude > envelope.east
  ) {
    throw new Error('Toronto restriction outside Ontario.');
  }
  const sourceType = row.type.toUpperCase();
  const type: ProvincialRoadEventType =
    sourceType === 'ROAD_CLOSED'
      ? 'closure'
      : sourceType === 'CONSTRUCTION'
        ? 'construction'
        : sourceType === 'HAZARD'
          ? 'hazard'
          : sourceType === 'SPECIAL_EVENT'
            ? 'special-event'
            : 'incident';
  const road = row.road == null ? '' : normalizedText(row.road);
  const roadwayName = road === '' ? undefined : truncate(road, 160);
  const location = row.name == null ? '' : normalizedText(row.name);
  const sourceText = row.description == null ? '' : normalizedText(row.description);
  const description = [location === '' ? '' : `${location}.`, sourceText]
    .filter((part) => part !== '')
    .join(' ');
  const direction = DIRECTIONS[row.directionsAffected ?? ''];
  const severity = IMPACT_SEVERITY[impact];
  let endsAt = row.endTime ?? undefined;
  const startsAt = row.startTime ?? undefined;
  if (startsAt !== undefined && endsAt !== undefined && endsAt < startsAt) endsAt = undefined;
  return ProvincialRoadEventSchema.parse({
    confidence: 'official',
    coordinate: { latitude: row.latitude, longitude: row.longitude },
    description: truncate(description === '' ? TYPE_LABELS[type] : description, 4_000),
    ...(direction === undefined ? {} : { direction }),
    ...(endsAt === undefined ? {} : { endsAt }),
    id: `toronto-restriction:${row.id}`,
    isFullClosure: type === 'closure',
    regionId: 'ontario',
    ...(row.createdTime == null ? {} : { reportedAt: row.createdTime }),
    ...(roadwayName === undefined ? {} : { roadwayName }),
    ...(severity === undefined ? {} : { severity }),
    sourceId: 'toronto-road-restrictions',
    ...(startsAt === undefined ? {} : { startsAt }),
    title: truncate(
      roadwayName === undefined ? TYPE_LABELS[type] : `${TYPE_LABELS[type]} on ${roadwayName}`,
      240,
    ),
    type,
    updatedAt: row.lastUpdated,
  });
}

export function createTorontoRoadEventFeed(
  options: RoadEventFeedOptions & { dataUrl?: string } = {},
): RoadEventFeed {
  const dataUrl = options.dataUrl ?? TORONTO_ROAD_RESTRICTIONS_URL;
  return createRoadEventFeed(
    {
      attribution: 'Contains information licensed under the Open Government Licence \u2013 Toronto.',
      confidence: 'official',
      documentationUrl: 'https://open.toronto.ca/dataset/road-restrictions/',
      licenseUrl: 'https://open.toronto.ca/open-data-licence/',
      maximumAgeSeconds: 3_600,
      name: 'City of Toronto',
      refreshIntervalSeconds: 300,
      sourceId: 'toronto-road-restrictions',
      timeZone: 'America/Toronto',
    },
    async ({ fetchJson }) => {
      const rows = PayloadSchema.parse(await fetchJson(dataUrl)).Closure;
      const events: ProvincialRoadEvent[] = [];
      let droppedRows = 0;
      for (const row of rows) {
        try {
          const event = normalizeTorontoRestriction(row);
          if (event !== undefined) events.push(event);
        } catch {
          droppedRows += 1;
        }
      }
      const updatedAt = newestTimestamp(
        rows.map((row) => RowSchema.safeParse(row).data?.lastUpdated),
      );
      return {
        droppedRows,
        events,
        totalRows: rows.length,
        ...(updatedAt === undefined ? {} : { updatedAt }),
      };
    },
    options,
  );
}
