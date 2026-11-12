import type { TrafficFlowBounds } from '@navoss/contracts';
import { z } from 'zod/v4';

export type TrafficMode = 'off' | 'collect' | 'live';

export interface TrafficSettings {
  /** Path distance removed from both ends of every uploaded batch before map matching. */
  batchTrimMeters: number;
  /** Points outside these bounds reject the whole batch. */
  bounds: TrafficFlowBounds;
  bucketSeconds: number;
  /** A segment at or above this share of its free-flow speed is `free`; delay counts below it. */
  freeRatio: number;
  halfLifeSeconds: number;
  heavyRatio: number;
  maxBatchAgeSeconds: number;
  maxConcurrentMatches: number;
  maxFlowFeatures: number;
  maxFutureSeconds: number;
  maxPointSpeedMetersPerSecond: number;
  maxSampleSpeedKph: number;
  /** k: independent contributors required inside the window before a segment is published. */
  minimumContributors: number;
  minSampleMeters: number;
  minSampleSeconds: number;
  mode: TrafficMode;
  rateLimitGlobal: number;
  rateLimitPerSource: number;
  rateLimitWindowSeconds: number;
  /** Share of a route's length that needs published flow before its ETA is adjusted. */
  routeMinCoverage: number;
  slowRatio: number;
  slowSampleSeconds: number;
  /** Distance the app must exclude at the start and end of every trip; advertised in status. */
  tripEndTrimMeters: number;
  windowSeconds: number;
}

/** Alberta and British Columbia, the coverage target. */
const ALBERTA_BC_BOUNDS: TrafficFlowBounds = {
  east: -109.9,
  north: 60.1,
  south: 48.2,
  west: -139.1,
};

export const DEFAULT_TRAFFIC_SETTINGS: TrafficSettings = {
  batchTrimMeters: 100,
  bounds: ALBERTA_BC_BOUNDS,
  bucketSeconds: 300,
  freeRatio: 0.7,
  halfLifeSeconds: 600,
  heavyRatio: 0.2,
  maxBatchAgeSeconds: 900,
  // Valhalla runs two worker threads; probes may hold at most one so routing always has the other.
  maxConcurrentMatches: 1,
  maxFlowFeatures: 3_000,
  maxFutureSeconds: 120,
  maxPointSpeedMetersPerSecond: 60,
  maxSampleSpeedKph: 180,
  minimumContributors: 3,
  minSampleMeters: 100,
  minSampleSeconds: 5,
  mode: 'off',
  rateLimitGlobal: 6_000,
  rateLimitPerSource: 60,
  rateLimitWindowSeconds: 600,
  routeMinCoverage: 0.5,
  slowRatio: 0.45,
  slowSampleSeconds: 30,
  tripEndTrimMeters: 400,
  windowSeconds: 1_800,
};

const optionalInteger = (minimum: number, maximum: number) =>
  z.coerce.number().int().min(minimum).max(maximum).optional();

const TrafficEnvironmentSchema = z.object({
  COMMUNITY_TRAFFIC_BATCH_TRIM_METERS: optionalInteger(50, 1_000),
  COMMUNITY_TRAFFIC_BOUNDS: z
    .string()
    .regex(/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/)
    .optional(),
  COMMUNITY_TRAFFIC_BUCKET_SECONDS: optionalInteger(60, 900),
  COMMUNITY_TRAFFIC_HALF_LIFE_SECONDS: optionalInteger(60, 3_600),
  // k = 1 would publish a single driver's speed, so it cannot be configured.
  COMMUNITY_TRAFFIC_MIN_CONTRIBUTORS: optionalInteger(2, 50),
  COMMUNITY_TRAFFIC_MODE: z.enum(['off', 'collect', 'live']).optional(),
  COMMUNITY_TRAFFIC_RATE_LIMIT_GLOBAL: optionalInteger(1, 1_000_000),
  COMMUNITY_TRAFFIC_RATE_LIMIT_PER_SOURCE: optionalInteger(1, 10_000),
  COMMUNITY_TRAFFIC_ROUTE_MIN_COVERAGE: z.coerce.number().min(0.1).max(1).optional(),
  COMMUNITY_TRAFFIC_TRIP_TRIM_METERS: optionalInteger(200, 2_000),
  COMMUNITY_TRAFFIC_WINDOW_SECONDS: optionalInteger(300, 7_200),
});

export function readTrafficSettings(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): TrafficSettings {
  const blankAsUnset = Object.fromEntries(
    Object.keys(TrafficEnvironmentSchema.shape).map((name) => {
      const value = environment[name]?.trim();
      return [name, value === undefined || value === '' ? undefined : value];
    }),
  );
  const parsed = TrafficEnvironmentSchema.parse(blankAsUnset);
  const defaults = DEFAULT_TRAFFIC_SETTINGS;
  const [west, south, east, north] = parsed.COMMUNITY_TRAFFIC_BOUNDS?.split(',').map(Number) ?? [];
  const settings: TrafficSettings = {
    ...defaults,
    batchTrimMeters: parsed.COMMUNITY_TRAFFIC_BATCH_TRIM_METERS ?? defaults.batchTrimMeters,
    bounds:
      west === undefined || south === undefined || east === undefined || north === undefined
        ? defaults.bounds
        : { east, north, south, west },
    bucketSeconds: parsed.COMMUNITY_TRAFFIC_BUCKET_SECONDS ?? defaults.bucketSeconds,
    halfLifeSeconds: parsed.COMMUNITY_TRAFFIC_HALF_LIFE_SECONDS ?? defaults.halfLifeSeconds,
    minimumContributors: parsed.COMMUNITY_TRAFFIC_MIN_CONTRIBUTORS ?? defaults.minimumContributors,
    mode: parsed.COMMUNITY_TRAFFIC_MODE ?? defaults.mode,
    rateLimitGlobal: parsed.COMMUNITY_TRAFFIC_RATE_LIMIT_GLOBAL ?? defaults.rateLimitGlobal,
    rateLimitPerSource:
      parsed.COMMUNITY_TRAFFIC_RATE_LIMIT_PER_SOURCE ?? defaults.rateLimitPerSource,
    routeMinCoverage: parsed.COMMUNITY_TRAFFIC_ROUTE_MIN_COVERAGE ?? defaults.routeMinCoverage,
    tripEndTrimMeters: parsed.COMMUNITY_TRAFFIC_TRIP_TRIM_METERS ?? defaults.tripEndTrimMeters,
    windowSeconds: parsed.COMMUNITY_TRAFFIC_WINDOW_SECONDS ?? defaults.windowSeconds,
  };
  if (
    settings.bounds.east <= settings.bounds.west ||
    settings.bounds.north <= settings.bounds.south
  ) {
    throw new Error('COMMUNITY_TRAFFIC_BOUNDS must be west,south,east,north.');
  }
  if (settings.windowSeconds < settings.bucketSeconds) {
    throw new Error('COMMUNITY_TRAFFIC_WINDOW_SECONDS must cover at least one bucket.');
  }
  return settings;
}
