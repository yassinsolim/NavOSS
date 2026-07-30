import { z } from 'zod/v4';

import { CoordinateSchema, IsoDateTimeSchema } from './common.js';

export const RoadEventTypeSchema = z.enum(['construction', 'incident']);
export const RoadEventConfidenceSchema = z.enum(['official', 'unverified']);
export const RoadEventSourceIdSchema = z.enum([
  'calgary-construction-detours',
  'calgary-current-incidents',
]);

const CalgaryLocalDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?$/u);
const CALGARY_BOUNDS = {
  east: -113.859,
  north: 51.212,
  south: 50.842,
  west: -114.316,
} as const;

export const RoadEventSchema = z
  .object({
    confidence: RoadEventConfidenceSchema,
    coordinate: CoordinateSchema,
    description: z.string().trim().min(1).max(2_000),
    endsAtLocal: CalgaryLocalDateTimeSchema.optional(),
    id: z.string().min(1).max(160),
    sourceId: RoadEventSourceIdSchema,
    startsAtLocal: CalgaryLocalDateTimeSchema,
    timeZone: z.literal('America/Edmonton'),
    title: z.string().trim().min(1).max(240),
    type: RoadEventTypeSchema,
  })
  .strict()
  .superRefine((event, context) => {
    const construction = event.sourceId === 'calgary-construction-detours';
    if (construction !== (event.type === 'construction' && event.confidence === 'official')) {
      context.addIssue({
        code: 'custom',
        message: 'construction events must use the official construction source posture',
        path: ['sourceId'],
      });
    }
    if (!construction && (event.type !== 'incident' || event.confidence !== 'unverified')) {
      context.addIssue({
        code: 'custom',
        message: 'current incidents must remain explicitly unverified',
        path: ['confidence'],
      });
    }
    if (
      event.coordinate.latitude < CALGARY_BOUNDS.south ||
      event.coordinate.latitude > CALGARY_BOUNDS.north ||
      event.coordinate.longitude < CALGARY_BOUNDS.west ||
      event.coordinate.longitude > CALGARY_BOUNDS.east
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Calgary road events must remain within the supported coverage bounds',
        path: ['coordinate'],
      });
    }
    if (event.endsAtLocal !== undefined && event.endsAtLocal < event.startsAtLocal) {
      context.addIssue({
        code: 'custom',
        message: 'road-event end time cannot precede its start time',
        path: ['endsAtLocal'],
      });
    }
  });

export const RoadEventSourceSchema = z
  .object({
    attribution: z.literal('The City of Calgary'),
    confidence: RoadEventConfidenceSchema,
    datasetId: z.enum(['w8zq-79bq', '4jah-h97u']),
    datasetUrl: z.url(),
    licenseUrl: z.literal('https://data.calgary.ca/d/Open-Data-Terms/u45n-7awa'),
    sourceId: RoadEventSourceIdSchema,
    updateFrequency: z.enum(['10 minutes', 'twice daily']),
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((source, context) => {
    const construction = source.sourceId === 'calgary-construction-detours';
    const valid = construction
      ? source.confidence === 'official' &&
        source.datasetId === 'w8zq-79bq' &&
        source.datasetUrl === 'https://data.calgary.ca/d/w8zq-79bq' &&
        source.updateFrequency === 'twice daily'
      : source.confidence === 'unverified' &&
        source.datasetId === '4jah-h97u' &&
        source.datasetUrl === 'https://data.calgary.ca/d/4jah-h97u' &&
        source.updateFrequency === '10 minutes';
    if (!valid) {
      context.addIssue({
        code: 'custom',
        message: 'road-event source metadata must preserve its declared trust posture',
        path: ['sourceId'],
      });
    }
  });

export const RoadEventResponseSchema = z
  .object({
    degraded: z.boolean(),
    events: z.array(RoadEventSchema).max(1_000),
    generatedAt: IsoDateTimeSchema,
    sources: z.array(RoadEventSourceSchema).length(2),
    stale: z.boolean(),
  })
  .strict()
  .superRefine((response, context) => {
    if (response.degraded !== response.stale) {
      context.addIssue({
        code: 'custom',
        message: 'road events are degraded exactly when the last valid snapshot is stale',
        path: ['degraded'],
      });
    }
    if (new Set(response.sources.map((source) => source.sourceId)).size !== 2) {
      context.addIssue({
        code: 'custom',
        message: 'both Calgary road-event sources must be represented',
        path: ['sources'],
      });
    }
  });

export type RoadEvent = z.infer<typeof RoadEventSchema>;
export type RoadEventResponse = z.infer<typeof RoadEventResponseSchema>;
export type RoadEventSource = z.infer<typeof RoadEventSourceSchema>;
export type RoadEventType = z.infer<typeof RoadEventTypeSchema>;
