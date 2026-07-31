import { z } from 'zod/v4';

import { CoordinateSchema, IsoDateTimeSchema } from './common.js';

const ONTARIO_BOUNDS = {
  east: -74.32,
  north: 56.9,
  south: 41.67,
  west: -95.16,
} as const;

const KELOWNA_BOUNDS = {
  east: -119.2,
  north: 50.15,
  south: 49.7,
  west: -119.65,
} as const;

export const OfficialRoadEventRegionSchema = z.enum(['ontario', 'kelowna-bc']);
export const OfficialRoadEventTypeSchema = z.enum(['construction', 'closure', 'incident']);
export const OfficialRoadEventQuerySchema = z
  .object({ region: OfficialRoadEventRegionSchema })
  .strict();

const OfficialRoadEventBaseShape = {
  confidence: z.literal('official'),
  coordinate: CoordinateSchema,
  description: z.string().trim().min(1).max(4_000),
  direction: z.string().trim().min(1).max(80),
  endsAt: IsoDateTimeSchema.optional(),
  id: z.string().min(1).max(160),
  isFullClosure: z.boolean(),
  reportedAt: IsoDateTimeSchema,
  roadwayName: z.string().trim().min(1).max(160),
  startsAt: IsoDateTimeSchema,
  title: z.string().trim().min(1).max(240),
  type: OfficialRoadEventTypeSchema,
  updatedAt: IsoDateTimeSchema,
} as const;

const OntarioRoadEventSchema = z
  .object({
    ...OfficialRoadEventBaseShape,
    regionId: z.literal('ontario'),
    sourceId: z.literal('ontario-511-events'),
  })
  .strict()
  .superRefine((event, context) => {
    if (
      event.coordinate.latitude < ONTARIO_BOUNDS.south ||
      event.coordinate.latitude > ONTARIO_BOUNDS.north ||
      event.coordinate.longitude < ONTARIO_BOUNDS.west ||
      event.coordinate.longitude > ONTARIO_BOUNDS.east
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Ontario road events must remain within provincial bounds',
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

const KelownaRoadEventSchema = z
  .object({
    ...OfficialRoadEventBaseShape,
    regionId: z.literal('kelowna-bc'),
    sourceId: z.literal('drivebc-open511-events'),
  })
  .strict()
  .superRefine((event, context) => {
    if (
      event.coordinate.latitude < KELOWNA_BOUNDS.south ||
      event.coordinate.latitude > KELOWNA_BOUNDS.north ||
      event.coordinate.longitude < KELOWNA_BOUNDS.west ||
      event.coordinate.longitude > KELOWNA_BOUNDS.east
    ) {
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

export const OfficialRoadEventSchema = z.union([OntarioRoadEventSchema, KelownaRoadEventSchema]);

const OntarioRoadEventSourceSchema = z
  .object({
    apiDocumentationUrl: z.literal('https://511on.ca/developers/doc'),
    attribution: z.literal(
      'Contains information licensed under the Open Government Licence \u2013 Ontario.',
    ),
    confidence: z.literal('official'),
    licenseUrl: z.literal('https://www.ontario.ca/page/open-government-licence-ontario'),
    refreshIntervalSeconds: z.literal(300),
    sourceId: z.literal('ontario-511-events'),
    updatedAt: IsoDateTimeSchema.optional(),
  })
  .strict();

const DriveBcRoadEventSourceSchema = z
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

export const OfficialRoadEventSourceSchema = z.union([
  OntarioRoadEventSourceSchema,
  DriveBcRoadEventSourceSchema,
]);

const OfficialRoadEventResponseBaseShape = {
  degraded: z.boolean(),
  generatedAt: IsoDateTimeSchema,
  stale: z.boolean(),
} as const;

const OntarioRoadEventResponseSchema = z
  .object({
    ...OfficialRoadEventResponseBaseShape,
    events: z.array(OntarioRoadEventSchema).max(2_000),
    regionId: z.literal('ontario'),
    source: OntarioRoadEventSourceSchema,
  })
  .strict();

const KelownaRoadEventResponseSchema = z
  .object({
    ...OfficialRoadEventResponseBaseShape,
    events: z.array(KelownaRoadEventSchema).max(500),
    regionId: z.literal('kelowna-bc'),
    source: DriveBcRoadEventSourceSchema,
  })
  .strict();

export const OfficialRoadEventResponseSchema = z
  .union([OntarioRoadEventResponseSchema, KelownaRoadEventResponseSchema])
  .superRefine((response, context) => {
    if (response.degraded !== response.stale) {
      context.addIssue({
        code: 'custom',
        message: 'official road events are degraded exactly when the last valid snapshot is stale',
        path: ['degraded'],
      });
    }
  });

export type OfficialRoadEvent = z.infer<typeof OfficialRoadEventSchema>;
export type OfficialRoadEventQuery = z.infer<typeof OfficialRoadEventQuerySchema>;
export type OfficialRoadEventRegion = z.infer<typeof OfficialRoadEventRegionSchema>;
export type OfficialRoadEventResponse = z.infer<typeof OfficialRoadEventResponseSchema>;
export type OfficialRoadEventSource = z.infer<typeof OfficialRoadEventSourceSchema>;
export type OfficialRoadEventType = z.infer<typeof OfficialRoadEventTypeSchema>;
