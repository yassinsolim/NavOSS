import { z } from 'zod/v4';

import { CoordinateSchema, IsoDateTimeSchema } from './common.js';

const ONTARIO_BOUNDS = {
  east: -74.32,
  north: 56.9,
  south: 41.67,
  west: -95.16,
} as const;

export const OfficialRoadEventRegionSchema = z.literal('ontario');
export const OfficialRoadEventTypeSchema = z.enum(['construction', 'closure', 'incident']);
export const OfficialRoadEventQuerySchema = z
  .object({ region: OfficialRoadEventRegionSchema })
  .strict();

export const OfficialRoadEventSchema = z
  .object({
    confidence: z.literal('official'),
    coordinate: CoordinateSchema,
    description: z.string().trim().min(1).max(4_000),
    direction: z.string().trim().min(1).max(80),
    endsAt: IsoDateTimeSchema.optional(),
    id: z.string().min(1).max(160),
    isFullClosure: z.boolean(),
    regionId: OfficialRoadEventRegionSchema,
    reportedAt: IsoDateTimeSchema,
    roadwayName: z.string().trim().min(1).max(160),
    sourceId: z.literal('ontario-511-events'),
    startsAt: IsoDateTimeSchema,
    title: z.string().trim().min(1).max(240),
    type: OfficialRoadEventTypeSchema,
    updatedAt: IsoDateTimeSchema,
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

export const OfficialRoadEventSourceSchema = z
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

export const OfficialRoadEventResponseSchema = z
  .object({
    degraded: z.boolean(),
    events: z.array(OfficialRoadEventSchema).max(2_000),
    generatedAt: IsoDateTimeSchema,
    regionId: OfficialRoadEventRegionSchema,
    source: OfficialRoadEventSourceSchema,
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

export type OfficialRoadEvent = z.infer<typeof OfficialRoadEventSchema>;
export type OfficialRoadEventQuery = z.infer<typeof OfficialRoadEventQuerySchema>;
export type OfficialRoadEventRegion = z.infer<typeof OfficialRoadEventRegionSchema>;
export type OfficialRoadEventResponse = z.infer<typeof OfficialRoadEventResponseSchema>;
export type OfficialRoadEventSource = z.infer<typeof OfficialRoadEventSourceSchema>;
export type OfficialRoadEventType = z.infer<typeof OfficialRoadEventTypeSchema>;
