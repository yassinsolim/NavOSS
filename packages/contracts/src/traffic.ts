import { z } from 'zod/v4';

import { IsoDateTimeSchema, LatitudeSchema, LongitudeSchema } from './common.js';

export const COMMUNITY_TRAFFIC_SOURCE_ID = 'navoss-community';
export const COMMUNITY_TRAFFIC_ATTRIBUTION = 'Traffic from opted-in NavOSS drivers';

/** Hard limits of one probe batch. The server rejects anything outside them. */
export const TRAFFIC_PROBE_LIMITS = {
  maxBatchSeconds: 300,
  maxGapSeconds: 15,
  maxPoints: 240,
  minPoints: 10,
  schemaVersion: 1,
} as const;

/** Flow bounds must sit on this grid so URLs are shared, cacheable, and never an exact viewport. */
export const TRAFFIC_FLOW_GRID_DEGREES = 0.05;
export const TRAFFIC_FLOW_MAX_SPAN_DEGREES = 2;

export const TrafficCongestionLevelSchema = z.enum(['free', 'slow', 'heavy', 'stopped']);
export type TrafficCongestionLevel = z.infer<typeof TrafficCongestionLevelSchema>;

export const RouteCongestionLevelSchema = z.enum(['unknown', 'free', 'slow', 'heavy', 'stopped']);
export type RouteCongestionLevel = z.infer<typeof RouteCongestionLevelSchema>;

export const CommunityTrafficSourceSchema = z
  .object({
    attribution: z.literal(COMMUNITY_TRAFFIC_ATTRIBUTION),
    id: z.literal(COMMUNITY_TRAFFIC_SOURCE_ID),
  })
  .strict();

/** `[longitude, latitude, whole seconds since the first point]`. */
export const TrafficProbePointSchema = z.tuple([
  LongitudeSchema,
  LatitudeSchema,
  z.number().int().min(0).max(TRAFFIC_PROBE_LIMITS.maxBatchSeconds),
]);

export const TrafficProbeBatchRequestSchema = z
  .object({
    capturedAt: IsoDateTimeSchema.describe(
      'UTC time of the first point, rounded down to the whole minute',
    ),
    points: z
      .array(TrafficProbePointSchema)
      .min(TRAFFIC_PROBE_LIMITS.minPoints)
      .max(TRAFFIC_PROBE_LIMITS.maxPoints),
    schemaVersion: z.literal(TRAFFIC_PROBE_LIMITS.schemaVersion),
  })
  .strict()
  .superRefine((batch, context) => {
    const capturedAt = Date.parse(batch.capturedAt);
    if (!Number.isFinite(capturedAt) || capturedAt % 60_000 !== 0) {
      context.addIssue({
        code: 'custom',
        message: 'capturedAt must be rounded down to the whole minute',
        path: ['capturedAt'],
      });
    }
    if (batch.points[0]?.[2] !== 0) {
      context.addIssue({
        code: 'custom',
        message: 'the first point must have offset 0',
        path: ['points', 0, 2],
      });
    }
    for (let index = 1; index < batch.points.length; index += 1) {
      const gap = (batch.points[index]?.[2] ?? 0) - (batch.points[index - 1]?.[2] ?? 0);
      if (gap < 1 || gap > TRAFFIC_PROBE_LIMITS.maxGapSeconds) {
        context.addIssue({
          code: 'custom',
          message: 'offsets must increase by 1 to 15 seconds between consecutive points',
          path: ['points', index, 2],
        });
        return;
      }
    }
  });

export type TrafficProbeBatchRequest = z.infer<typeof TrafficProbeBatchRequestSchema>;

export const TrafficProbeBatchResponseSchema = z.object({ status: z.literal('accepted') }).strict();

export type TrafficProbeBatchResponse = z.infer<typeof TrafficProbeBatchResponseSchema>;

export interface TrafficFlowBounds {
  east: number;
  north: number;
  south: number;
  west: number;
}

function onFlowGrid(value: number): boolean {
  const cells = value / TRAFFIC_FLOW_GRID_DEGREES;
  return Math.abs(cells - Math.round(cells)) < 1e-6;
}

/** Parses `west,south,east,north`; returns undefined unless it is a valid, grid-aligned, bounded box. */
export function parseTrafficFlowBounds(bbox: string): TrafficFlowBounds | undefined {
  const parts = bbox.split(',');
  if (parts.length !== 4 || parts.some((part) => !/^-?\d{1,3}(\.\d{1,6})?$/.test(part))) {
    return undefined;
  }
  const [west, south, east, north] = parts.map(Number) as [number, number, number, number];
  if (
    west < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    east <= west ||
    north <= south ||
    east - west > TRAFFIC_FLOW_MAX_SPAN_DEGREES + 1e-9 ||
    north - south > TRAFFIC_FLOW_MAX_SPAN_DEGREES + 1e-9 ||
    ![west, south, east, north].every(onFlowGrid)
  ) {
    return undefined;
  }
  return { east, north, south, west };
}

/**
 * Expands a viewport outward to the flow grid and returns the `bbox` query value, or undefined
 * when the viewport is wider than the service allows (zoom in before requesting flow).
 */
export function snapTrafficFlowBounds(viewport: TrafficFlowBounds): string | undefined {
  const west = Math.floor(viewport.west / TRAFFIC_FLOW_GRID_DEGREES + 1e-9);
  const south = Math.floor(viewport.south / TRAFFIC_FLOW_GRID_DEGREES + 1e-9);
  const east = Math.max(west + 1, Math.ceil(viewport.east / TRAFFIC_FLOW_GRID_DEGREES - 1e-9));
  const north = Math.max(south + 1, Math.ceil(viewport.north / TRAFFIC_FLOW_GRID_DEGREES - 1e-9));
  const bbox = [west, south, east, north]
    .map((cells) => (cells * TRAFFIC_FLOW_GRID_DEGREES).toFixed(2))
    .join(',');
  return parseTrafficFlowBounds(bbox) === undefined ? undefined : bbox;
}

export const TrafficFlowQuerySchema = z
  .object({
    bbox: z
      .string()
      .max(64)
      .describe(
        'west,south,east,north in degrees; every value a multiple of 0.05 and each span at most 2',
      ),
  })
  .strict();

export type TrafficFlowQuery = z.infer<typeof TrafficFlowQuerySchema>;

const FlowPositionSchema = z.tuple([LongitudeSchema, LatitudeSchema]);

export const TrafficFlowFeatureSchema = z
  .object({
    geometry: z
      .object({
        coordinates: z.array(z.array(FlowPositionSchema).min(2)).min(1),
        type: z.literal('MultiLineString'),
      })
      .strict(),
    id: z.string().min(1),
    properties: z
      .object({
        ageSeconds: z.number().int().nonnegative(),
        congestion: TrafficCongestionLevelSchema,
        freeFlowKph: z.number().int().positive().max(200),
        observedAt: IsoDateTimeSchema,
        sampleCount: z.number().int().positive(),
        speedKph: z.number().int().nonnegative().max(200),
      })
      .strict(),
    type: z.literal('Feature'),
  })
  .strict();

export type TrafficFlowFeature = z.infer<typeof TrafficFlowFeatureSchema>;

export const TrafficFlowResponseSchema = z
  .object({
    coverage: z
      .object({
        minimumContributors: z.number().int().min(2),
        publishedSegments: z.number().int().nonnegative(),
        truncated: z.boolean(),
        windowSeconds: z.number().int().positive(),
      })
      .strict(),
    features: z.array(TrafficFlowFeatureSchema),
    generatedAt: IsoDateTimeSchema,
    source: CommunityTrafficSourceSchema,
    type: z.literal('FeatureCollection'),
  })
  .strict();

export type TrafficFlowResponse = z.infer<typeof TrafficFlowResponseSchema>;

export const TrafficStatusResponseSchema = z
  .object({
    coverage: z
      .object({
        observedSegments: z.number().int().nonnegative(),
        publishedSegments: z.number().int().nonnegative(),
        samples: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    generatedAt: IsoDateTimeSchema,
    mode: z.enum(['off', 'collecting', 'live']),
    probes: z
      .object({
        accepting: z.boolean(),
        batchTargetMeters: z.number().int().positive(),
        batchTargetSeconds: z.number().int().positive(),
        endpoint: z.literal('/v1/traffic/probes'),
        maxBatchSeconds: z.number().int().positive(),
        maxGapSeconds: z.number().int().positive(),
        maxPoints: z.number().int().positive(),
        minPoints: z.number().int().positive(),
        sampleIntervalSeconds: z.number().int().positive(),
        schemaVersion: z.literal(TRAFFIC_PROBE_LIMITS.schemaVersion),
        tripEndTrimMeters: z.number().int().positive(),
      })
      .strict(),
    publication: z
      .object({
        bucketSeconds: z.number().int().positive(),
        minimumContributors: z.number().int().min(2),
        windowSeconds: z.number().int().positive(),
      })
      .strict(),
    source: CommunityTrafficSourceSchema,
  })
  .strict()
  .superRefine((status, context) => {
    if ((status.mode === 'live') !== (status.coverage !== undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'coverage is reported exactly when traffic is live',
        path: ['coverage'],
      });
    }
    if (status.probes.accepting !== (status.mode !== 'off')) {
      context.addIssue({
        code: 'custom',
        message: 'probes are accepted exactly when the pipeline is collecting or live',
        path: ['probes', 'accepting'],
      });
    }
  });

export type TrafficStatusResponse = z.infer<typeof TrafficStatusResponseSchema>;

/**
 * Community-traffic annotation for one computed route. It is a fragment for the v2 route
 * response: the legacy `/v1/routes` shape is frozen and never carries it.
 */
export const RouteTrafficAnnotationSchema = z
  .object({
    congestion: z.array(RouteCongestionLevelSchema).min(1),
    delaySeconds: z.number().nonnegative(),
    durationSeconds: z.number().positive(),
    observedFraction: z.number().min(0).max(1),
    stepDurationsSeconds: z.array(z.number().nonnegative()).min(1),
    typicalDurationSeconds: z.number().positive(),
  })
  .strict()
  .superRefine((annotation, context) => {
    if (
      Math.abs(
        annotation.durationSeconds - annotation.typicalDurationSeconds - annotation.delaySeconds,
      ) > 0.001
    ) {
      context.addIssue({
        code: 'custom',
        message: 'adjusted duration must equal typical duration plus delay',
        path: ['durationSeconds'],
      });
    }
  });

export type RouteTrafficAnnotation = z.infer<typeof RouteTrafficAnnotationSchema>;
