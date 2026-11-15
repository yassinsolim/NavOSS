import {
  ProvincialRoadEventSchema,
  type ProvincialRoadEvent,
  type ProvincialRoadEventType,
  type RoadEventSeverity,
} from '@navoss/contracts';
import { z } from 'zod/v4';

import {
  createRoadEventFeed,
  normalizedText,
  truncate,
  type RoadEventFeed,
  type RoadEventFeedOptions,
} from './official-road-event-feed.js';

/**
 * City of Edmonton "Traffic Disruptions" (Socrata `k4tx-5k8p`), no key required. Dates are
 * calendar dates (every recorded value is local midnight), so events carry `startsOn`/`endsOn`
 * rather than invented clock times. Rows have no per-row update time; the dataset's own
 * `rowsUpdatedAt` is the source timestamp.
 */

export const EDMONTON_DATASET_ID = 'k4tx-5k8p';
const ACTIVE_STATUSES = ['Current', 'Revised', 'Emergency'] as const;

export function edmontonDataUrl(): string {
  const url = new URL(`https://data.edmonton.ca/resource/${EDMONTON_DATASET_ID}.json`);
  url.searchParams.set(
    '$where',
    `status in (${ACTIVE_STATUSES.map((status) => `'${status}'`).join(',')})`,
  );
  url.searchParams.set('$limit', '2000');
  return url.toString();
}

const FloatingDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)?$/u)
  .transform((value) => value.slice(0, 10));

const RowSchema = z
  .object({
    activity_type: z.string().nullish(),
    date_issued: FloatingDateSchema.nullish(),
    description: z.string().nullish(),
    details: z.string().nullish(),
    disruption_id: z.union([z.string().min(1), z.number().int()]),
    finish_date: FloatingDateSchema.nullish(),
    from_street: z.string().nullish(),
    impact: z.string().nullish(),
    on_street: z.string().trim().min(1),
    point: z
      .object({ coordinates: z.tuple([z.number(), z.number()]), type: z.literal('Point') })
      .loose(),
    start_date: FloatingDateSchema,
    status: z.string(),
    to_street: z.string().nullish(),
  })
  .loose();

const IMPACT_SEVERITY: Readonly<Record<string, RoadEventSeverity>> = {
  'Directional Closure': 'moderate',
  'Increased Travel Time': 'minor',
  'Major Delays': 'major',
  'Permanent Closure': 'major',
  'Total Closure': 'major',
  'Traffic Incident Closure': 'major',
  'Traffic Incident Delays': 'moderate',
  'Travel Delays': 'moderate',
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

export function normalizeEdmontonDisruption(input: unknown): ProvincialRoadEvent | undefined {
  const row = RowSchema.parse(input);
  if (!(ACTIVE_STATUSES as readonly string[]).includes(row.status)) return undefined;
  const impact = row.impact?.trim() ?? '';
  const fullClosure = /^(?:Total|Permanent|Traffic Incident) Closure$/u.test(impact);
  const activity = row.activity_type?.trim() ?? '';
  const type: ProvincialRoadEventType = fullClosure
    ? 'closure'
    : activity === 'Traffic Incident'
      ? 'incident'
      : activity === 'Special Event'
        ? 'special-event'
        : 'construction';
  const roadwayName = truncate(normalizedText(row.on_street), 160);
  const from = row.from_street == null ? '' : normalizedText(row.from_street);
  const to = row.to_street == null ? '' : normalizedText(row.to_street);
  const extent = from !== '' && to !== '' ? `${roadwayName} from ${from} to ${to}.` : undefined;
  const text = [extent, row.details, row.description]
    .filter((part): part is string => part != null && normalizedText(part) !== '')
    .map(normalizedText)
    .join(' ');
  const [longitude, latitude] = row.point.coordinates;
  const severity = IMPACT_SEVERITY[impact];
  return ProvincialRoadEventSchema.parse({
    confidence: 'official',
    coordinate: { latitude, longitude },
    description: truncate(text === '' ? `${TYPE_LABELS[type]} on ${roadwayName}` : text, 4_000),
    ...(row.finish_date == null || row.finish_date < row.start_date
      ? {}
      : { endsOn: row.finish_date }),
    id: `edmonton-disruption:${String(row.disruption_id)}`,
    isFullClosure: fullClosure,
    regionId: 'alberta',
    ...(row.date_issued == null ? {} : { reportedOn: row.date_issued }),
    roadwayName,
    ...(severity === undefined ? {} : { severity }),
    sourceId: 'edmonton-traffic-disruptions',
    startsOn: row.start_date,
    title: truncate(`${TYPE_LABELS[type]} on ${roadwayName}`, 240),
    type,
  });
}

export function createEdmontonRoadEventFeed(
  options: RoadEventFeedOptions & { dataUrl?: string; metadataUrl?: string } = {},
): RoadEventFeed {
  const dataUrl = options.dataUrl ?? edmontonDataUrl();
  const metadataUrl =
    options.metadataUrl ?? `https://data.edmonton.ca/api/views/${EDMONTON_DATASET_ID}`;
  return createRoadEventFeed(
    {
      attribution:
        'Contains information licensed under the Open Government Licence \u2013 City of Edmonton.',
      confidence: 'official',
      documentationUrl: 'https://data.edmonton.ca/d/k4tx-5k8p',
      licenseUrl: 'https://data.edmonton.ca/stories/s/Open-Government-Licence-Edmonton/msh8-if28',
      maximumAgeSeconds: 24 * 3_600,
      name: 'City of Edmonton',
      refreshIntervalSeconds: 600,
      sourceId: 'edmonton-traffic-disruptions',
      timeZone: 'America/Edmonton',
    },
    async ({ fetchJson }) => {
      const [data, metadata] = await Promise.allSettled([
        fetchJson(dataUrl),
        fetchJson(metadataUrl),
      ]);
      if (data.status === 'rejected') throw data.reason;
      const rows = z.array(z.unknown()).max(5_000).parse(data.value);
      const rowsUpdatedAt =
        metadata.status === 'fulfilled'
          ? z
              .object({ rowsUpdatedAt: z.number().int().positive() })
              .loose()
              .safeParse(metadata.value).data?.rowsUpdatedAt
          : undefined;
      const events: ProvincialRoadEvent[] = [];
      let droppedRows = 0;
      for (const row of rows) {
        try {
          const event = normalizeEdmontonDisruption(row);
          if (event !== undefined) events.push(event);
        } catch {
          droppedRows += 1;
        }
      }
      return {
        droppedRows,
        events,
        totalRows: rows.length,
        ...(rowsUpdatedAt === undefined
          ? {}
          : { updatedAt: new Date(rowsUpdatedAt * 1_000).toISOString() }),
      };
    },
    options,
  );
}
