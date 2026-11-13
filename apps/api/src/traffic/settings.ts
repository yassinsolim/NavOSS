import type { TrafficFlowBounds } from '@navoss/contracts';
import { z } from 'zod/v4';

export type TrafficMode = 'off' | 'collect' | 'live';

export interface TrafficSettings {
  /** Path distance removed from both ends of every uploaded batch before map matching. */
  batchTrimMeters: number;
  /** Points outside these bounds reject the whole batch. */
  bounds: TrafficFlowBounds;
  /** Longest an unpublished observation is held in memory, counted from its arrival epoch. */
  cohortSeconds: number;
  /** How long an upload credential is valid. */
  credentialSeconds: number;
  /** Publication grid: flow changes only on these boundaries. */
  epochSeconds: number;
  /** A segment at or above this share of its free-flow speed is `free`; delay counts below it. */
  freeRatio: number;
  heavyRatio: number;
  /** A batch whose last point is older than this is refused. */
  maxBatchAgeSeconds: number;
  maxConcurrentMatches: number;
  maxFlowFeatures: number;
  /** Clock skew allowed for the batch's last point. */
  maxFutureSeconds: number;
  maxPointSpeedMetersPerSecond: number;
  maxSampleSpeedKph: number;
  /** k: distinct attested installations required in one cohort before a segment is released. */
  minimumContributors: number;
  minSampleMeters: number;
  minSampleSeconds: number;
  mode: TrafficMode;
  rateLimitGlobal: number;
  rateLimitPerContributor: number;
  rateLimitPerNetwork: number;
  rateLimitWindowSeconds: number;
  /** How long a released value is served unless a new cohort replaces it first. */
  releaseSeconds: number;
  /** Traffic may add at most this share of a route's typical duration as delay. */
  routeMaxDelayRatio: number;
  /** Share of a route's length that needs published flow before its ETA is adjusted. */
  routeMinCoverage: number;
  slowRatio: number;
  slowSampleSeconds: number;
  /** Distance the app must exclude at the start and end of every trip; advertised in status. */
  tripEndTrimMeters: number;
}

/**
 * The limits the privacy policy states. They are enforced when the service is built, not only
 * when the environment is parsed, so no configuration or caller can run the pipeline below them.
 */
export const TRAFFIC_PRIVACY_LIMITS = {
  maximumCohortSeconds: 900,
  maximumReleaseSeconds: 900,
  minimumBatchTrimMeters: 100,
  minimumContributors: 3,
  minimumEpochSeconds: 300,
  minimumTripEndTrimMeters: 400,
} as const;

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
  cohortSeconds: 900,
  credentialSeconds: 7_200,
  epochSeconds: 300,
  freeRatio: 0.7,
  heavyRatio: 0.2,
  maxBatchAgeSeconds: 600,
  // Valhalla runs two worker threads; probes may hold at most one so routing always has the other.
  maxConcurrentMatches: 1,
  maxFlowFeatures: 3_000,
  maxFutureSeconds: 60,
  maxPointSpeedMetersPerSecond: 60,
  maxSampleSpeedKph: 180,
  minimumContributors: 3,
  minSampleMeters: 100,
  minSampleSeconds: 5,
  mode: 'off',
  rateLimitGlobal: 6_000,
  // The app uploads about once a minute; three times that leaves room for bursts after a tunnel.
  rateLimitPerContributor: 30,
  // Carrier NAT puts many drivers behind one network, so this only stops a single-network flood.
  rateLimitPerNetwork: 1_200,
  rateLimitWindowSeconds: 600,
  releaseSeconds: 900,
  routeMaxDelayRatio: 1,
  routeMinCoverage: 0.5,
  slowRatio: 0.45,
  slowSampleSeconds: 30,
  tripEndTrimMeters: 400,
};

/** Throws unless the settings are at or above every published privacy limit. */
export function assertTrafficPrivacyLimits(settings: TrafficSettings): void {
  const limits = TRAFFIC_PRIVACY_LIMITS;
  const violations = [
    settings.minimumContributors < limits.minimumContributors && 'minimumContributors',
    settings.batchTrimMeters < limits.minimumBatchTrimMeters && 'batchTrimMeters',
    settings.tripEndTrimMeters < limits.minimumTripEndTrimMeters && 'tripEndTrimMeters',
    settings.epochSeconds < limits.minimumEpochSeconds && 'epochSeconds',
    (settings.cohortSeconds > limits.maximumCohortSeconds ||
      settings.cohortSeconds < settings.epochSeconds ||
      settings.cohortSeconds % settings.epochSeconds !== 0) &&
      'cohortSeconds',
    (settings.releaseSeconds > limits.maximumReleaseSeconds ||
      settings.releaseSeconds < settings.epochSeconds ||
      settings.releaseSeconds % settings.epochSeconds !== 0) &&
      'releaseSeconds',
  ].filter((name) => name !== false);
  if (violations.length > 0) {
    throw new Error(
      `Community traffic settings are below the published privacy limits: ${violations.join(', ')}.`,
    );
  }
}

const optionalInteger = (minimum: number, maximum: number) =>
  z.coerce.number().int().min(minimum).max(maximum).optional();

// Retention (epoch, cohort and release lifetimes) and the aggregated road classes are not
// configurable at all. The remaining privacy values can only be made stricter than the defaults.
const TrafficEnvironmentSchema = z.object({
  COMMUNITY_TRAFFIC_BOUNDS: z
    .string()
    .regex(/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/)
    .optional(),
  COMMUNITY_TRAFFIC_MIN_CONTRIBUTORS: optionalInteger(
    TRAFFIC_PRIVACY_LIMITS.minimumContributors,
    50,
  ),
  COMMUNITY_TRAFFIC_MODE: z.enum(['off', 'collect', 'live']).optional(),
  COMMUNITY_TRAFFIC_RATE_LIMIT_GLOBAL: optionalInteger(1, 1_000_000),
  COMMUNITY_TRAFFIC_ROUTE_MIN_COVERAGE: z.coerce.number().min(0.1).max(1).optional(),
  COMMUNITY_TRAFFIC_TRIP_TRIM_METERS: optionalInteger(
    TRAFFIC_PRIVACY_LIMITS.minimumTripEndTrimMeters,
    2_000,
  ),
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
    bounds:
      west === undefined || south === undefined || east === undefined || north === undefined
        ? defaults.bounds
        : { east, north, south, west },
    minimumContributors: parsed.COMMUNITY_TRAFFIC_MIN_CONTRIBUTORS ?? defaults.minimumContributors,
    mode: parsed.COMMUNITY_TRAFFIC_MODE ?? defaults.mode,
    rateLimitGlobal: parsed.COMMUNITY_TRAFFIC_RATE_LIMIT_GLOBAL ?? defaults.rateLimitGlobal,
    routeMinCoverage: parsed.COMMUNITY_TRAFFIC_ROUTE_MIN_COVERAGE ?? defaults.routeMinCoverage,
    tripEndTrimMeters: parsed.COMMUNITY_TRAFFIC_TRIP_TRIM_METERS ?? defaults.tripEndTrimMeters,
  };
  if (
    settings.bounds.east <= settings.bounds.west ||
    settings.bounds.north <= settings.bounds.south
  ) {
    throw new Error('COMMUNITY_TRAFFIC_BOUNDS must be west,south,east,north.');
  }
  assertTrafficPrivacyLimits(settings);
  return settings;
}
