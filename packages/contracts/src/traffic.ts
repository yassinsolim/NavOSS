import { z } from 'zod/v4';

import { IsoDateTimeSchema, LatitudeSchema, LongitudeSchema } from './common.js';
import { CommunityAssertedRequestSchema } from './community-report.js';

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

/**
 * Opaque, short-lived upload credential issued to an attested installation by
 * `POST /v2/traffic/credentials`. The app sends it back unchanged with every batch.
 */
export const TrafficCredentialSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .min(32)
  .max(256);

/** One fresh App Attest assertion over the `traffic-credential` operation. */
export const TrafficCredentialRequestSchema = CommunityAssertedRequestSchema;

export type TrafficCredentialRequest = z.infer<typeof TrafficCredentialRequestSchema>;

export const TrafficCredentialResponseSchema = z
  .object({
    credential: TrafficCredentialSchema,
    expiresAt: IsoDateTimeSchema,
  })
  .strict();

export type TrafficCredentialResponse = z.infer<typeof TrafficCredentialResponseSchema>;

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
    credential: TrafficCredentialSchema,
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

/**
 * One published road edge. It carries no contributor or sample count: every feature is backed by
 * at least `coverage.minimumContributors` attested installations, and no finer number is released.
 */
export const TrafficFlowFeatureSchema = z
  .object({
    geometry: z
      .object({
        coordinates: z.array(FlowPositionSchema).min(2),
        type: z.literal('LineString'),
      })
      .strict(),
    id: z.string().regex(/^w[0-9]+[fb]-[0-9a-f]{12}$/),
    properties: z
      .object({
        congestion: TrafficCongestionLevelSchema,
        freeFlowKph: z.number().int().positive().max(200),
        /** End of the publication epoch that released this value; always on the epoch grid. */
        observedAt: IsoDateTimeSchema,
        /** Rounded to 5 km/h. */
        speedKph: z.number().int().nonnegative().max(200).multipleOf(5),
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
        minimumContributors: z.number().int().min(3),
        truncated: z.boolean(),
      })
      .strict(),
    features: z.array(TrafficFlowFeatureSchema),
    /** Start of the publication epoch this snapshot belongs to; the body is constant within it. */
    generatedAt: IsoDateTimeSchema,
    source: CommunityTrafficSourceSchema,
    type: z.literal('FeatureCollection'),
    /** The next epoch boundary; nothing changes before it, so do not poll sooner. */
    validUntil: IsoDateTimeSchema,
  })
  .strict();

export type TrafficFlowResponse = z.infer<typeof TrafficFlowResponseSchema>;

/**
 * Public status: the mode and the rules, never a count of segments, samples or contributors.
 * Those totals would let a caller probe whether an unpublished road has been driven.
 */
export const TrafficStatusResponseSchema = z
  .object({
    generatedAt: IsoDateTimeSchema,
    mode: z.enum(['off', 'collecting', 'live']),
    probes: z
      .object({
        accepting: z.boolean(),
        batchTargetMeters: z.number().int().positive(),
        batchTargetSeconds: z.number().int().positive(),
        /** Path distance the server removes from both ends of every batch before matching. */
        batchTrimMeters: z.number().int().min(100),
        credentialEndpoint: z.literal('/v2/traffic/credentials'),
        endpoint: z.literal('/v2/traffic/probes'),
        maxBatchSeconds: z.number().int().positive(),
        maxGapSeconds: z.number().int().positive(),
        maxPoints: z.number().int().positive(),
        minPoints: z.number().int().positive(),
        sampleIntervalSeconds: z.number().int().positive(),
        schemaVersion: z.literal(TRAFFIC_PROBE_LIMITS.schemaVersion),
        /** Distance the app must exclude at both ends of every trip; the server cannot check it. */
        tripEndTrimMeters: z.number().int().min(400),
      })
      .strict(),
    publication: z
      .object({
        /** Longest time an unpublished observation is held (in memory) before it is dropped. */
        cohortSeconds: z.number().int().positive(),
        /** Flow changes only on this grid. */
        epochSeconds: z.number().int().min(300),
        minimumContributors: z.number().int().min(3),
        /** How long a published value stays up unless a new cohort replaces it. */
        releaseSeconds: z.number().int().positive(),
      })
      .strict(),
    source: CommunityTrafficSourceSchema,
  })
  .strict()
  .superRefine((status, context) => {
    if (status.probes.accepting && status.mode === 'off') {
      context.addIssue({
        code: 'custom',
        message: 'probes are never accepted while the pipeline is off',
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
