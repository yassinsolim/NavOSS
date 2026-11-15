import { z } from 'zod/v4';

import { CoordinateSchema, IsoDateTimeSchema } from './common.js';

/**
 * Official road events served at `GET /v2/events?region=…`.
 *
 * `kelowna-bc` keeps the original single-source DriveBC shape that builds 75 and 80 parse
 * strictly. `alberta`, `british-columbia` and `ontario` use the provincial shape: several
 * independently loaded sources, each with its own trust posture and freshness state, and events
 * that keep their source's own wording and timestamps. Build 80 never parses the provincial shape;
 * it asked for `ontario` only, which the deployed server always answered 503.
 */

interface Envelope {
  east: number;
  north: number;
  south: number;
  west: number;
}

const KELOWNA_BOUNDS: Envelope = { east: -119.2, north: 50.15, south: 49.7, west: -119.65 };

/**
 * Retrieval envelopes, not borders: a source's own jurisdiction decides what it publishes, and
 * these only reject coordinates that cannot belong to the province (swapped or zeroed values).
 */
export const PROVINCIAL_ROAD_EVENT_ENVELOPES = {
  alberta: { east: -109.9, north: 60.1, south: 48.9, west: -120.1 },
  'british-columbia': { east: -114, north: 60.1, south: 48.2, west: -139.1 },
  ontario: { east: -74.32, north: 56.9, south: 41.67, west: -95.16 },
} as const satisfies Record<string, Envelope>;

function inEnvelope(coordinate: { latitude: number; longitude: number }, bounds: Envelope) {
  return (
    coordinate.latitude >= bounds.south &&
    coordinate.latitude <= bounds.north &&
    coordinate.longitude >= bounds.west &&
    coordinate.longitude <= bounds.east
  );
}

export const ProvincialRoadEventRegionSchema = z.enum(['alberta', 'british-columbia', 'ontario']);
export const OfficialRoadEventRegionSchema = z.enum([
  'alberta',
  'british-columbia',
  'kelowna-bc',
  'ontario',
]);
export const OfficialRoadEventQuerySchema = z
  .object({ region: OfficialRoadEventRegionSchema })
  .strict();

// ---------------------------------------------------------------------------------------------
// Kelowna (legacy single-source shape, unchanged for shipped clients)

export const KelownaRoadEventTypeSchema = z.enum(['construction', 'closure', 'incident']);

export const KelownaRoadEventSchema = z
  .object({
    confidence: z.literal('official'),
    coordinate: CoordinateSchema,
    description: z.string().trim().min(1).max(4_000),
    direction: z.string().trim().min(1).max(80),
    endsAt: IsoDateTimeSchema.optional(),
    id: z.string().min(1).max(160),
    isFullClosure: z.boolean(),
    regionId: z.literal('kelowna-bc'),
    reportedAt: IsoDateTimeSchema,
    roadwayName: z.string().trim().min(1).max(160),
    sourceId: z.literal('drivebc-open511-events'),
    startsAt: IsoDateTimeSchema,
    title: z.string().trim().min(1).max(240),
    type: KelownaRoadEventTypeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (!inEnvelope(event.coordinate, KELOWNA_BOUNDS)) {
      context.addIssue({
        code: 'custom',
        message: 'Kelowna road events must remain within regional bounds',
        path: ['coordinate'],
      });
    }
    if (event.endsAt !== undefined && event.endsAt < event.startsAt) {
      context.addIssue({
        code: 'custom',
        message: 'road-event end time cannot precede its start time',
        path: ['endsAt'],
      });
    }
  });

export const KelownaRoadEventSourceSchema = z
  .object({
    apiDocumentationUrl: z.literal('https://api.open511.gov.bc.ca/help'),
    attribution: z.literal(
      'Contains information licensed under the Open Government Licence \u2013 British Columbia.',
    ),
    confidence: z.literal('official'),
    dataUrl: z.literal(
      'https://api.open511.gov.bc.ca/events?format=json&status=ACTIVE&bbox=-119.65,49.70,-119.20,50.15&limit=500',
    ),
    licenseUrl: z.literal(
      'https://www2.gov.bc.ca/gov/content/data/open-data/open-government-license-bc',
    ),
    refreshIntervalSeconds: z.literal(300),
    sourceId: z.literal('drivebc-open511-events'),
    updatedAt: IsoDateTimeSchema.optional(),
  })
  .strict();

export const KelownaRoadEventResponseSchema = z
  .object({
    degraded: z.boolean(),
    events: z.array(KelownaRoadEventSchema).max(500),
    generatedAt: IsoDateTimeSchema,
    regionId: z.literal('kelowna-bc'),
    source: KelownaRoadEventSourceSchema,
    stale: z.boolean(),
  })
  .strict()
  .superRefine((response, context) => {
    if (response.degraded !== response.stale) {
      context.addIssue({
        code: 'custom',
        message: 'official road events are degraded exactly when the last valid snapshot is stale',
        path: ['degraded'],
      });
    }
  });

// ---------------------------------------------------------------------------------------------
// Provincial (multi-source)

export const ProvincialRoadEventTypeSchema = z.enum([
  'collision',
  'closure',
  'construction',
  'hazard',
  /** The source reports an incident without saying what kind. */
  'incident',
  'road-condition',
  'special-event',
  'stalled-vehicle',
]);
export const RoadEventSeveritySchema = z.enum(['minor', 'moderate', 'major']);
export const ProvincialRoadEventSourceIdSchema = z.enum([
  'alberta-511-events',
  'calgary-construction-detours',
  'calgary-current-incidents',
  'drivebc-open511-events',
  'edmonton-traffic-disruptions',
  'ontario-511-events',
  'toronto-road-restrictions',
]);
/**
 * `current`: validated this refresh. `stale`: the latest refresh failed and the last valid
 * snapshot, still inside `maximumAgeSeconds`, is served. `unavailable`: no valid snapshot inside
 * that bound. `not-configured`: the source needs a key this server does not have.
 */
export const RoadEventSourceStatusSchema = z.enum([
  'current',
  'stale',
  'unavailable',
  'not-configured',
]);

const LocalDateSchema = z.iso.date();

const PROVINCIAL_SOURCE_REGIONS: Readonly<
  Record<
    z.infer<typeof ProvincialRoadEventSourceIdSchema>,
    z.infer<typeof ProvincialRoadEventRegionSchema>
  >
> = {
  'alberta-511-events': 'alberta',
  'calgary-construction-detours': 'alberta',
  'calgary-current-incidents': 'alberta',
  'drivebc-open511-events': 'british-columbia',
  'edmonton-traffic-disruptions': 'alberta',
  'ontario-511-events': 'ontario',
  'toronto-road-restrictions': 'ontario',
};

export const ProvincialRoadEventSchema = z
  .object({
    /** `unverified` only for sources that describe themselves so (Calgary current incidents). */
    confidence: z.enum(['official', 'unverified']),
    coordinate: CoordinateSchema,
    /** The source's own description, with markup and whitespace normalised. */
    description: z.string().trim().min(1).max(4_000),
    direction: z.string().trim().min(1).max(80).optional(),
    /** Planned end as an instant. Date-only sources use `endsOn` instead. */
    endsAt: IsoDateTimeSchema.optional(),
    /** Last day of a date-only source's planned end, in the source's time zone (inclusive). */
    endsOn: LocalDateSchema.optional(),
    id: z.string().min(1).max(160),
    isFullClosure: z.boolean().optional(),
    regionId: ProvincialRoadEventRegionSchema,
    /** When the source first reported the event. */
    reportedAt: IsoDateTimeSchema.optional(),
    reportedOn: LocalDateSchema.optional(),
    roadwayName: z.string().trim().min(1).max(160).optional(),
    severity: RoadEventSeveritySchema.optional(),
    sourceId: ProvincialRoadEventSourceIdSchema,
    startsAt: IsoDateTimeSchema.optional(),
    startsOn: LocalDateSchema.optional(),
    title: z.string().trim().min(1).max(240),
    type: ProvincialRoadEventTypeSchema,
    /** The source's own last-update time for this event; absent when the source has none. */
    updatedAt: IsoDateTimeSchema.optional(),
  })
  .strict()
  .superRefine((event, context) => {
    if (PROVINCIAL_SOURCE_REGIONS[event.sourceId] !== event.regionId) {
      context.addIssue({
        code: 'custom',
        message: 'road-event source does not publish for this region',
        path: ['sourceId'],
      });
    }
    if (!inEnvelope(event.coordinate, PROVINCIAL_ROAD_EVENT_ENVELOPES[event.regionId])) {
      context.addIssue({
        code: 'custom',
        message: 'road events must remain within the provincial envelope',
        path: ['coordinate'],
      });
    }
    if ((event.confidence === 'unverified') !== (event.sourceId === 'calgary-current-incidents')) {
      context.addIssue({
        code: 'custom',
        message: 'only Calgary current incidents are unverified',
        path: ['confidence'],
      });
    }
    if (
      event.startsAt !== undefined &&
      event.endsAt !== undefined &&
      Date.parse(event.endsAt) < Date.parse(event.startsAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'road-event end time cannot precede its start time',
        path: ['endsAt'],
      });
    }
    if (
      event.startsOn !== undefined &&
      event.endsOn !== undefined &&
      event.endsOn < event.startsOn
    ) {
      context.addIssue({
        code: 'custom',
        message: 'road-event end date cannot precede its start date',
        path: ['endsOn'],
      });
    }
  });

export const ProvincialRoadEventSourceSchema = z
  .object({
    attribution: z.string().trim().min(1).max(240),
    /** When NavOSS last validated this source. Freshness bookkeeping, never shown as event age. */
    checkedAt: IsoDateTimeSchema.optional(),
    confidence: z.enum(['official', 'unverified']),
    documentationUrl: z.url(),
    eventCount: z.number().int().nonnegative(),
    /** Some rows were malformed and dropped (at most 10% of the feed). */
    incomplete: z.boolean(),
    licenseUrl: z.url(),
    /** Beyond this age a snapshot is never served, and clients drop what they hold. */
    maximumAgeSeconds: z.number().int().positive(),
    name: z.string().trim().min(1).max(80),
    refreshIntervalSeconds: z.number().int().positive(),
    sourceId: ProvincialRoadEventSourceIdSchema,
    status: RoadEventSourceStatusSchema,
    timeZone: z.enum(['America/Edmonton', 'America/Toronto', 'America/Vancouver']),
    /** The source's own newest timestamp (an event or dataset update time). */
    updatedAt: IsoDateTimeSchema.optional(),
  })
  .strict();

export const ProvincialRoadEventResponseSchema = z
  .object({
    /** True when any source is not current or is incomplete. */
    degraded: z.boolean(),
    /** Newest first by the source's own update (or report, or start) time. */
    events: z.array(ProvincialRoadEventSchema).max(5_000),
    generatedAt: IsoDateTimeSchema,
    regionId: ProvincialRoadEventRegionSchema,
    sources: z.array(ProvincialRoadEventSourceSchema).min(1).max(8),
    /** True when any served source is a stale snapshot. */
    stale: z.boolean(),
  })
  .strict()
  .superRefine((response, context) => {
    const sources = new Map(response.sources.map((source) => [source.sourceId, source]));
    if (sources.size !== response.sources.length) {
      context.addIssue({
        code: 'custom',
        message: 'duplicate road-event source',
        path: ['sources'],
      });
    }
    for (const [index, source] of response.sources.entries()) {
      if (PROVINCIAL_SOURCE_REGIONS[source.sourceId] !== response.regionId) {
        context.addIssue({
          code: 'custom',
          message: 'road-event source does not publish for this region',
          path: ['sources', index, 'sourceId'],
        });
      }
    }
    for (const [index, event] of response.events.entries()) {
      const source = sources.get(event.sourceId);
      if (
        event.regionId !== response.regionId ||
        source === undefined ||
        (source.status !== 'current' && source.status !== 'stale') ||
        source.confidence !== event.confidence
      ) {
        context.addIssue({
          code: 'custom',
          message: 'every event must come from a served source of this region with its posture',
          path: ['events', index],
        });
      }
    }
    const stale = response.sources.some((source) => source.status === 'stale');
    const degraded = response.sources.some(
      (source) => source.status !== 'current' || source.incomplete,
    );
    if (response.stale !== stale || response.degraded !== degraded) {
      context.addIssue({
        code: 'custom',
        message: 'stale and degraded must summarise the source states',
        path: ['degraded'],
      });
    }
  });

export const OfficialRoadEventResponseSchema = z.union([
  KelownaRoadEventResponseSchema,
  ProvincialRoadEventResponseSchema,
]);

export type KelownaRoadEvent = z.infer<typeof KelownaRoadEventSchema>;
export type KelownaRoadEventResponse = z.infer<typeof KelownaRoadEventResponseSchema>;
export type KelownaRoadEventSource = z.infer<typeof KelownaRoadEventSourceSchema>;
export type KelownaRoadEventType = z.infer<typeof KelownaRoadEventTypeSchema>;
export type OfficialRoadEventQuery = z.infer<typeof OfficialRoadEventQuerySchema>;
export type OfficialRoadEventRegion = z.infer<typeof OfficialRoadEventRegionSchema>;
export type OfficialRoadEventResponse = z.infer<typeof OfficialRoadEventResponseSchema>;
export type ProvincialRoadEvent = z.infer<typeof ProvincialRoadEventSchema>;
export type ProvincialRoadEventRegion = z.infer<typeof ProvincialRoadEventRegionSchema>;
export type ProvincialRoadEventResponse = z.infer<typeof ProvincialRoadEventResponseSchema>;
export type ProvincialRoadEventSource = z.infer<typeof ProvincialRoadEventSourceSchema>;
export type ProvincialRoadEventSourceId = z.infer<typeof ProvincialRoadEventSourceIdSchema>;
export type ProvincialRoadEventType = z.infer<typeof ProvincialRoadEventTypeSchema>;
export type RoadEventSeverity = z.infer<typeof RoadEventSeveritySchema>;
export type RoadEventSourceStatus = z.infer<typeof RoadEventSourceStatusSchema>;
