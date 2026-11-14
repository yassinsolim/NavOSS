import { join } from 'node:path';

import { SERVICE_COVERAGE_BOUNDS, type TrafficFlowBounds } from '@navoss/contracts';
import { z } from 'zod/v4';

import { DeadEndMaskError, loadDeadEndMask, type DeadEndMask } from './dead-end-mask.js';
import { SERVING_GRAPH_FILES, verifyServingGraph } from './serving-graph.js';

export type TrafficMode = 'off' | 'collect' | 'live';

export interface TrafficSettings {
  /** Path distance removed from both ends of every uploaded batch before map matching. */
  batchTrimMeters: number;
  /** Points outside these bounds reject the whole batch. */
  bounds: TrafficFlowBounds;
  /**
   * Driving window of a cohort: a release rests only on samples whose driving began, and which
   * arrived, within this long before its boundary. Also the longest a sample is held in memory.
   */
  cohortSeconds: number;
  /** How long an upload credential is valid. */
  credentialSeconds: number;
  /** Publication grid: flow changes only on these boundaries. */
  epochSeconds: number;
  /** A segment at or above this share of its free-flow speed is `free`; delay counts below it. */
  freeRatio: number;
  heavyRatio: number;
  /** A batch whose first point (`capturedAt`) is older than this on arrival is refused. */
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
  /**
   * An installation registered more recently than this gets no upload credential, so App Attest
   * keys made on the spot cannot contribute.
   */
  minimumInstallationAgeSeconds: number;
  mode: TrafficMode;
  /**
   * For this long after registration an installation is a newcomer: each cohort counts at most
   * one newcomer per network bucket.
   */
  newcomerSeconds: number;
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

/** Retrieval envelope only. Probe eligibility additionally uses the shared province polygons. */
const DEFAULT_TRAFFIC_BOUNDS: TrafficFlowBounds = {
  east: SERVICE_COVERAGE_BOUNDS.northEast.longitude,
  north: SERVICE_COVERAGE_BOUNDS.northEast.latitude,
  south: SERVICE_COVERAGE_BOUNDS.southWest.latitude,
  west: SERVICE_COVERAGE_BOUNDS.southWest.longitude,
};

export const DEFAULT_TRAFFIC_SETTINGS: TrafficSettings = {
  batchTrimMeters: 100,
  bounds: DEFAULT_TRAFFIC_BOUNDS,
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
  minimumInstallationAgeSeconds: 86_400,
  mode: 'off',
  newcomerSeconds: 7 * 86_400,
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

const GraphIdSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Loads the dead-end mask of the graph Valhalla serves, after verifying that graph:
 * `COMMUNITY_TRAFFIC_GRAPH_DIR` is the serving graph directory as mounted (read-only) in both
 * Valhalla's and the API's container (`/graph` under `compose.traffic-graph.yaml`), and
 * `COMMUNITY_TRAFFIC_GRAPH_ID` the graph id the operator enables, from that directory's
 * `graph.json`. `verifyServingGraph` hashes the archive Valhalla's configuration names; the mask
 * (`dead-end-mask.json` in the same directory) must be bound to the same graph, the same
 * provenance record and the same extract.
 *
 * - `off`: nothing is read.
 * - `collect`: optional (collection publishes nothing); a configured directory must verify.
 * - `live`: both are required. A missing or mismatched archive, configuration, provenance or
 *   mask refuses to start; there is no permissive fallback.
 */
export function loadConfiguredDeadEndMask(
  mode: TrafficMode,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DeadEndMask | undefined {
  if (mode === 'off') return undefined;
  const directory = environment.COMMUNITY_TRAFFIC_GRAPH_DIR?.trim() ?? '';
  const graphId = environment.COMMUNITY_TRAFFIC_GRAPH_ID?.trim() ?? '';
  if (mode === 'live' && (directory === '' || graphId === '')) {
    throw new Error(
      'COMMUNITY_TRAFFIC_MODE=live requires COMMUNITY_TRAFFIC_GRAPH_DIR and COMMUNITY_TRAFFIC_GRAPH_ID.',
    );
  }
  if (directory === '') return undefined;
  if (!GraphIdSchema.safeParse(graphId).success) {
    throw new Error(
      'COMMUNITY_TRAFFIC_GRAPH_DIR requires COMMUNITY_TRAFFIC_GRAPH_ID: the 64-hex SHA-256 of the graph Valhalla serves.',
    );
  }
  const graph = verifyServingGraph(directory, graphId);
  const mask = loadDeadEndMask(join(directory, SERVING_GRAPH_FILES.mask), { graphId });
  if (
    mask.identity.provenanceSha256 !== graph.provenanceSha256 ||
    mask.identity.pbfSha256 !== graph.pbfSha256 ||
    mask.identity.dataDate !== graph.dataDate
  ) {
    throw new DeadEndMaskError(
      'The dead-end mask was built from another extract or graph build than the one served.',
    );
  }
  return mask;
}
