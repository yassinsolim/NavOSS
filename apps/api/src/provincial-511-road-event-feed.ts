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
  type RoadEventSourceDescriptor,
} from './official-road-event-feed.js';

/**
 * 511 Alberta and Ontario 511 run the same traveller-information platform and publish the same
 * documented `GET /api/v2/get/event` resource. Both now require a developer key (`key` query
 * parameter); without one the endpoint answers `<Error><Message>Invalid Key</Message></Error>`
 * with HTTP 400. The feed is inert (`not-configured`) until the server has a key.
 */

const PROVINCES = {
  alberta: {
    descriptor: {
      attribution: 'Source: 511 Alberta, Government of Alberta.',
      confidence: 'official',
      documentationUrl: 'https://511.alberta.ca/developers/doc',
      licenseUrl: 'https://511.alberta.ca/about/about',
      maximumAgeSeconds: 3_600,
      name: '511 Alberta',
      refreshIntervalSeconds: 300,
      sourceId: 'alberta-511-events',
      timeZone: 'America/Edmonton',
    },
    endpoint: 'https://511.alberta.ca/api/v2/get/event',
  },
  ontario: {
    descriptor: {
      attribution:
        'Contains information licensed under the Open Government Licence \u2013 Ontario.',
      confidence: 'official',
      documentationUrl: 'https://511on.ca/developers/doc',
      licenseUrl: 'https://www.ontario.ca/page/open-government-licence-ontario',
      maximumAgeSeconds: 3_600,
      name: 'Ontario 511',
      refreshIntervalSeconds: 300,
      sourceId: 'ontario-511-events',
      timeZone: 'America/Toronto',
    },
    endpoint: 'https://511on.ca/api/v2/get/event',
  },
} as const satisfies Record<string, { descriptor: RoadEventSourceDescriptor; endpoint: string }>;

export type Provincial511Province = keyof typeof PROVINCES;

const UnixSecondsSchema = z.number().int().positive();

/** Documented fields only; unknown fields are ignored so additive changes do not break loading. */
const EventRowSchema = z
  .object({
    Comment: z.string().nullish(),
    Description: z.string().trim().min(1),
    DirectionOfTravel: z.string().nullish(),
    EventSubType: z.string().nullish(),
    EventType: z.string().trim().min(1),
    ID: z.union([z.string().min(1), z.number().int()]),
    IsFullClosure: z.boolean().nullish(),
    LastUpdated: UnixSecondsSchema.nullish(),
    Latitude: z.number().min(-90).max(90),
    Longitude: z.number().min(-180).max(180),
    PlannedEndDate: UnixSecondsSchema.nullish(),
    Reported: UnixSecondsSchema.nullish(),
    RoadwayName: z.string().nullish(),
    Severity: z.string().nullish(),
    SourceId: z.union([z.string(), z.number()]).nullish(),
    StartDate: UnixSecondsSchema.nullish(),
  })
  .loose();

const SEVERITIES: Readonly<Record<string, RoadEventSeverity>> = {
  major: 'major',
  minor: 'minor',
  moderate: 'moderate',
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

/** The documented taxonomy plus the sub-type words the platform uses for incident kinds. */
function eventType(row: z.infer<typeof EventRowSchema>): ProvincialRoadEventType {
  const type = row.EventType.toLowerCase();
  const subType = (row.EventSubType ?? '').toLowerCase();
  let mapped: ProvincialRoadEventType;
  if (type === 'roadwork' || type === 'constructionprojects') mapped = 'construction';
  else if (type === 'closures') mapped = 'closure';
  else if (type === 'specialevents') mapped = 'special-event';
  else if (/weather|roadcondition|winter/u.test(type)) mapped = 'road-condition';
  else if (/collision|accident|crash/u.test(subType)) mapped = 'collision';
  else if (/stall|disabled|brokendown/u.test(subType)) mapped = 'stalled-vehicle';
  else if (/debris|hazard|animal|spill|obstruction/u.test(subType)) mapped = 'hazard';
  else mapped = 'incident';
  if (row.IsFullClosure === true && mapped !== 'collision' && mapped !== 'road-condition') {
    return 'closure';
  }
  return mapped;
}

function optionalLabel(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = normalizedText(value);
  return text === '' || /^(?:unknown|none|no data)$/iu.test(text) ? undefined : text;
}

function isoSeconds(value: number | null | undefined): string | undefined {
  return value === null || value === undefined ? undefined : new Date(value * 1_000).toISOString();
}

export function normalize511Event(
  input: unknown,
  province: Provincial511Province,
): ProvincialRoadEvent | undefined {
  const row = EventRowSchema.parse(input);
  const envelope = PROVINCIAL_ROAD_EVENT_ENVELOPES[province];
  if (
    row.Latitude < envelope.south ||
    row.Latitude > envelope.north ||
    row.Longitude < envelope.west ||
    row.Longitude > envelope.east
  ) {
    return undefined;
  }
  const type = eventType(row);
  const roadwayName = optionalLabel(row.RoadwayName);
  const comment = optionalLabel(row.Comment);
  const description = truncate(
    normalizedText(comment === undefined ? row.Description : `${row.Description} ${comment}`),
    4_000,
  );
  const severity = SEVERITIES[(row.Severity ?? '').trim().toLowerCase()];
  const direction = optionalLabel(row.DirectionOfTravel);
  const startsAt = isoSeconds(row.StartDate);
  let endsAt = isoSeconds(row.PlannedEndDate);
  if (startsAt !== undefined && endsAt !== undefined && endsAt < startsAt) endsAt = undefined;
  return ProvincialRoadEventSchema.parse({
    confidence: 'official',
    coordinate: { latitude: row.Latitude, longitude: row.Longitude },
    description,
    ...(direction === undefined ? {} : { direction: truncate(direction, 80) }),
    ...(endsAt === undefined ? {} : { endsAt }),
    id: `${PROVINCES[province].descriptor.sourceId}:${String(row.ID)}`,
    ...(row.IsFullClosure === null || row.IsFullClosure === undefined
      ? {}
      : { isFullClosure: row.IsFullClosure }),
    regionId: province,
    ...(row.Reported === null || row.Reported === undefined
      ? {}
      : { reportedAt: isoSeconds(row.Reported) }),
    ...(roadwayName === undefined ? {} : { roadwayName: truncate(roadwayName, 160) }),
    ...(severity === undefined ? {} : { severity }),
    sourceId: PROVINCES[province].descriptor.sourceId,
    ...(startsAt === undefined ? {} : { startsAt }),
    title: truncate(
      roadwayName === undefined ? TYPE_LABELS[type] : `${TYPE_LABELS[type]} on ${roadwayName}`,
      240,
    ),
    type,
    ...(row.LastUpdated === null || row.LastUpdated === undefined
      ? {}
      : { updatedAt: isoSeconds(row.LastUpdated) }),
  });
}

export function createProvincial511RoadEventFeed(
  province: Provincial511Province,
  apiKey: string | undefined,
  options: RoadEventFeedOptions & { endpoint?: string } = {},
): RoadEventFeed {
  const { descriptor, endpoint } = PROVINCES[province];
  const key = apiKey?.trim();
  if (key === undefined || key === '') return createRoadEventFeed(descriptor, undefined, options);
  const url = new URL(options.endpoint ?? endpoint);
  url.searchParams.set('format', 'json');
  url.searchParams.set('lang', 'en');
  url.searchParams.set('key', key);
  return createRoadEventFeed(
    descriptor,
    async ({ fetchJson }) => {
      const rows = z
        .array(z.unknown())
        .max(10_000)
        .parse(await fetchJson(url.toString()));
      const events: ProvincialRoadEvent[] = [];
      let droppedRows = 0;
      for (const row of rows) {
        try {
          const event = normalize511Event(row, province);
          if (event !== undefined) events.push(event);
        } catch {
          droppedRows += 1;
        }
      }
      const updatedAt = newestTimestamp(events.map((event) => event.updatedAt));
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
