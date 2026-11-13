import {
  COMMUNITY_TRAFFIC_ATTRIBUTION,
  COMMUNITY_TRAFFIC_SOURCE_ID,
  TRAFFIC_PROBE_LIMITS,
  type CommunityAssertion,
  type RouteCongestionLevel,
  type TrafficCredentialResponse,
  type TrafficFlowBounds,
  type TrafficFlowResponse,
  type TrafficProbeBatchRequest,
  type TrafficStatusResponse,
} from '@navoss/contracts';

import {
  createContributionRateLimiter,
  type ContributionRateLimiter,
} from '../contribution-rate-limiter.js';
import { applyFastestLabel } from '../route-provider.js';
import { createTrafficCohorts } from './cohorts.js';
import { createTrafficCredentials, type TrafficCredentials } from './credentials.js';
import type { Position } from './geo.js';
import { createValhallaMapMatcher, type MapMatcher, type MatchedEdge } from './map-matcher.js';
import { deriveObservations } from './observations.js';
import { findProbeRejection, trimBatchEnds, type ProbeRejection } from './probe-validation.js';
import {
  annotateRouteTraffic,
  minorRoadMeters,
  rankWithTraffic,
  type TrafficRouteInput,
} from './route-traffic.js';
import { classifyCongestion } from './segments.js';
import {
  assertTrafficPrivacyLimits,
  readTrafficSettings,
  type TrafficMode,
  type TrafficSettings,
} from './settings.js';
import {
  createInMemoryTrafficReleaseStore,
  createPostgresTrafficReleaseStore,
  type TrafficReleaseStore,
} from './store.js';

const MIN_MATCHED_POINTS = 5;
// Releases are written just after the boundary so a clock that runs slightly early still sees it.
const EPOCH_TIMER_SLACK_MS = 1_000;

export const COMMUNITY_TRAFFIC_SOURCE = {
  attribution: COMMUNITY_TRAFFIC_ATTRIBUTION,
  id: COMMUNITY_TRAFFIC_SOURCE_ID,
} as const;

export type IngestOutcome =
  | { status: 'accepted' }
  | { status: 'rate_limited' }
  | { reason: ProbeRejection; status: 'rejected' }
  | { status: 'unauthorized' }
  | { status: 'unavailable' };

/**
 * Operator-only counters. Nothing here is, or is derived from, a position, a road, an address, or
 * a time, and none of it is reachable over HTTP.
 */
export interface TrafficMetrics {
  batchesAccepted: number;
  batchesDropped: number;
  batchesRateLimited: number;
  batchesRejected: number;
  batchesUnauthorized: number;
  batchesUnavailable: number;
  credentialsIssued: number;
  epochFailures: number;
  flowResponses: number;
  pendingSamples: number;
  pendingSegments: number;
  purgeFailures: number;
  routesAnnotated: number;
  routesWithoutTraffic: number;
  samplesRecorded: number;
  segmentsReleased: number;
}

/**
 * The part of the App Attest installation service community traffic depends on. It verifies a
 * fresh assertion for the `traffic-credential` operation and names the installation.
 */
export interface TrafficAttestation {
  assertTrafficContributor(assertion: CommunityAssertion): Promise<{ installationId: string }>;
}

/** A route as the routing layer computed it; only these fields are read or replaced. */
export interface EnrichableRoute extends TrafficRouteInput {
  distanceMeters: number;
  label: 'alternative' | 'fastest';
  steps: readonly { durationSeconds: number; geometry: readonly Position[] }[];
}

export type TrafficEnrichedRoute<Route extends EnrichableRoute> = Route & {
  congestion?: RouteCongestionLevel[];
  traffic?: { delaySeconds: number; observedFraction: number; typicalDurationSeconds: number };
};

export type TrafficMaintenanceFailure = 'epoch' | 'purge';

export interface TrafficService {
  close(): Promise<void>;
  /**
   * Route-level traffic for the v2 route response. Routes with enough published flow get an
   * adjusted duration, per-step durations, a delay and per-geometry-segment congestion; the rest
   * are returned untouched, which means traffic is unavailable for that route. The order changes
   * only as `rankWithTraffic` allows. `trafficSource` is set when at least one route was
   * adjusted. Never throws: a failure leaves every route untouched.
   */
  enrichRoutes<Route extends EnrichableRoute>(
    routes: readonly Route[],
  ): Promise<{
    routes: TrafficEnrichedRoute<Route>[];
    trafficSource?: typeof COMMUNITY_TRAFFIC_SOURCE;
  }>;
  flow(bounds: TrafficFlowBounds): Promise<TrafficFlowResponse>;
  ingest(batch: TrafficProbeBatchRequest): Promise<IngestOutcome>;
  /**
   * Exchanges a verified assertion for an upload credential. Returns undefined when traffic is
   * off or attestation is not configured; rejects with the attestation service's own error.
   */
  issueCredential(assertion: CommunityAssertion): Promise<TrafficCredentialResponse | undefined>;
  metrics(): TrafficMetrics;
  readonly mode: TrafficMode;
  /** Closes the publication epoch that ended at the latest boundary, once. */
  runEpoch(): Promise<void>;
  readonly settings: TrafficSettings;
  /**
   * Erases stored releases in every mode, then, unless off, checks the schema and starts the
   * epoch timer. Rejects when an enabled pipeline cannot prepare its storage.
   */
  start(): Promise<void>;
  status(): TrafficStatusResponse;
}

export interface TrafficServiceOptions {
  /** Undefined when App Attest is not configured: no credential can be issued. */
  attestation?: TrafficAttestation | undefined;
  clock?: () => Date;
  credentials?: TrafficCredentials;
  mapMatcher?: MapMatcher;
  /** Told about failed maintenance so the operator sees it; receives no data. */
  onMaintenanceFailure?: (failure: TrafficMaintenanceFailure) => void;
  settings: TrafficSettings;
  store?: TrafficReleaseStore;
}

export function createTrafficService(options: TrafficServiceOptions): TrafficService {
  const { settings } = options;
  assertTrafficPrivacyLimits(settings);
  const clock = options.clock ?? (() => new Date());
  const store = options.store ?? createInMemoryTrafficReleaseStore();
  const credentials = options.credentials ?? createTrafficCredentials(settings.credentialSeconds);
  const cohorts = createTrafficCohorts(settings);
  const mapMatcher = options.mapMatcher;
  if (settings.mode !== 'off' && mapMatcher === undefined) {
    throw new Error('Community traffic requires a self-hosted Valhalla map matcher.');
  }
  const contributorLimiter: ContributionRateLimiter = createContributionRateLimiter({
    clock: () => clock().getTime(),
    globalLimit: settings.rateLimitGlobal,
    sourceLimit: settings.rateLimitPerContributor,
    windowMs: settings.rateLimitWindowSeconds * 1_000,
  });
  const counters = {
    batchesAccepted: 0,
    batchesDropped: 0,
    batchesRateLimited: 0,
    batchesRejected: 0,
    batchesUnauthorized: 0,
    batchesUnavailable: 0,
    credentialsIssued: 0,
    epochFailures: 0,
    flowResponses: 0,
    purgeFailures: 0,
    routesAnnotated: 0,
    routesWithoutTraffic: 0,
    samplesRecorded: 0,
    segmentsReleased: 0,
  };
  const epochMs = settings.epochSeconds * 1_000;
  const epochStart = (): number => Math.floor(clock().getTime() / epochMs) * epochMs;
  let matchesInFlight = 0;
  let lastClosedEpochMs: number | undefined;
  let epochTimer: NodeJS.Timeout | undefined;
  let closed = false;

  const runEpoch = async (): Promise<void> => {
    const tickMs = epochStart();
    if (lastClosedEpochMs !== undefined && tickMs <= lastClosedEpochMs) return;
    lastClosedEpochMs = tickMs;
    const releases = cohorts.closeEpoch(tickMs);
    counters.segmentsReleased += releases.length;
    try {
      // While only collecting, cohorts are counted and discarded: nothing is stored or served.
      await store.publishEpoch(tickMs, settings.mode === 'live' ? releases : []);
    } catch {
      counters.epochFailures += 1;
      options.onMaintenanceFailure?.('epoch');
    }
  };

  const scheduleEpoch = (): void => {
    if (closed) return;
    const delay = epochStart() + epochMs + EPOCH_TIMER_SLACK_MS - clock().getTime();
    epochTimer = setTimeout(
      () => {
        void runEpoch().finally(scheduleEpoch);
      },
      Math.max(EPOCH_TIMER_SLACK_MS, delay),
    );
    epochTimer.unref();
  };

  return {
    async close() {
      closed = true;
      clearTimeout(epochTimer);
      cohorts.clear();
      contributorLimiter.close();
      await store.close();
    },

    async enrichRoutes(routes) {
      const untouched = { routes: [...routes] };
      if (settings.mode !== 'live' || mapMatcher === undefined || routes.length === 0) {
        return untouched;
      }
      const tickMs = epochStart();
      try {
        const longitudes = routes.flatMap((route) =>
          route.geometry.map(([longitude]) => longitude),
        );
        const latitudes = routes.flatMap((route) => route.geometry.map(([, latitude]) => latitude));
        // Skip the map-matching round trips when nothing is published near the routes, which is
        // the normal case while few drivers contribute.
        const nearby = await store.inBounds(
          {
            east: Math.max(...longitudes),
            north: Math.max(...latitudes),
            south: Math.min(...latitudes),
            west: Math.min(...longitudes),
          },
          tickMs,
          1,
        );
        if (nearby.releases.length === 0) {
          counters.routesWithoutTraffic += routes.length;
          return untouched;
        }
        // Every route is walked, not only the congested one: ranking needs each route's roads.
        const walks: (MatchedEdge[] | undefined)[] = [];
        for (const route of routes) walks.push(await mapMatcher.walkRoute(route.geometry));
        const keys = [
          ...new Set(
            walks.flatMap((edges) => edges?.flatMap((edge) => edge.segmentKey ?? []) ?? []),
          ),
        ];
        const speeds = new Map(
          (await store.byKeys(keys, tickMs)).map((release) => [
            release.segmentKey,
            release.speedKph,
          ]),
        );
        const annotations = routes.map((route, index) => {
          const edges = walks[index];
          return edges === undefined
            ? undefined
            : annotateRouteTraffic(route, edges, speeds, settings);
        });
        const annotated = annotations.filter((annotation) => annotation !== undefined).length;
        counters.routesAnnotated += annotated;
        counters.routesWithoutTraffic += routes.length - annotated;
        if (annotated === 0) return untouched;
        const enriched = routes.map((route, index) => {
          const annotation = annotations[index];
          const edges = walks[index];
          return {
            minorMeters: edges === undefined ? undefined : minorRoadMeters(edges),
            route:
              annotation === undefined
                ? route
                : {
                    ...route,
                    congestion: annotation.congestion,
                    durationSeconds: annotation.durationSeconds,
                    steps: route.steps.map((step, stepIndex) => ({
                      ...step,
                      durationSeconds:
                        annotation.stepDurationsSeconds[stepIndex] ?? step.durationSeconds,
                    })),
                    traffic: {
                      delaySeconds: annotation.delaySeconds,
                      observedFraction: annotation.observedFraction,
                      typicalDurationSeconds: annotation.typicalDurationSeconds,
                    },
                  },
          };
        });
        const ranked = rankWithTraffic(
          enriched.map(({ minorMeters, route }) => ({
            distanceMeters: route.distanceMeters,
            durationSeconds: route.durationSeconds,
            minorMeters,
            route,
          })),
        );
        return {
          routes: applyFastestLabel(ranked.map(({ route }) => route)),
          trafficSource: COMMUNITY_TRAFFIC_SOURCE,
        };
      } catch {
        counters.routesWithoutTraffic += routes.length;
        return untouched;
      }
    },

    async flow(bounds) {
      const tickMs = epochStart();
      const { releases, truncated } = await store.inBounds(
        bounds,
        tickMs,
        settings.maxFlowFeatures,
      );
      counters.flowResponses += 1;
      return {
        coverage: { minimumContributors: settings.minimumContributors, truncated },
        features: releases.map((release) => ({
          geometry: { coordinates: release.line, type: 'LineString' as const },
          id: release.segmentKey,
          properties: {
            congestion: classifyCongestion(release.speedKph, release.freeFlowKph, settings),
            freeFlowKph: release.freeFlowKph,
            observedAt: new Date(release.releasedAtMs).toISOString(),
            speedKph: release.speedKph,
          },
          type: 'Feature' as const,
        })),
        // Epoch boundaries, not the request time: every caller in an epoch gets the same body.
        generatedAt: new Date(tickMs).toISOString(),
        source: COMMUNITY_TRAFFIC_SOURCE,
        type: 'FeatureCollection',
        validUntil: new Date(tickMs + epochMs).toISOString(),
      };
    },

    async ingest(batch) {
      if (settings.mode === 'off' || mapMatcher === undefined) {
        counters.batchesUnavailable += 1;
        return { status: 'unavailable' };
      }
      const nowMs = clock().getTime();
      // The credential is checked before anything else is spent on the request, and only a valid
      // one draws on the shared quota, so junk cannot use up what real drivers need.
      const seed = credentials.open(batch.credential, nowMs);
      if (seed === undefined) {
        counters.batchesUnauthorized += 1;
        return { status: 'unauthorized' };
      }
      if (!contributorLimiter.consume(seed.toString('base64'))) {
        counters.batchesRateLimited += 1;
        return { status: 'rate_limited' };
      }
      const rejection = findProbeRejection(batch, nowMs, settings);
      if (rejection !== undefined) {
        counters.batchesRejected += 1;
        return { reason: rejection, status: 'rejected' };
      }
      // From here the batch exists only in these local variables. It is never logged, queued or
      // stored, and an error below carries no part of it.
      const points = trimBatchEnds(batch.points, settings.batchTrimMeters);
      if (points.length < MIN_MATCHED_POINTS) {
        counters.batchesDropped += 1;
        return { status: 'accepted' };
      }
      // Map matching shares Valhalla with routing; shed probe load before it can slow a route.
      if (matchesInFlight >= settings.maxConcurrentMatches) {
        counters.batchesUnavailable += 1;
        return { status: 'unavailable' };
      }
      matchesInFlight += 1;
      try {
        const matched = await mapMatcher.matchTrace(points);
        const observations =
          matched === undefined ? [] : deriveObservations(matched, points, settings);
        if (observations.length === 0) {
          counters.batchesDropped += 1;
          return { status: 'accepted' };
        }
        // The arrival epoch comes from the server clock. Nothing the batch says about time
        // decides where its samples count.
        counters.samplesRecorded += cohorts.add(
          observations,
          (segmentKey) => credentials.tagFor(seed, segmentKey),
          clock().getTime(),
        );
        counters.batchesAccepted += 1;
        return { status: 'accepted' };
      } catch {
        // Matcher errors can quote request content, so they are counted, not logged.
        counters.batchesUnavailable += 1;
        return { status: 'unavailable' };
      } finally {
        matchesInFlight -= 1;
      }
    },

    async issueCredential(assertion) {
      if (settings.mode === 'off' || options.attestation === undefined) return undefined;
      // The installation id is read once to derive the seed and is not kept, logged or stored.
      const { installationId } = await options.attestation.assertTrafficContributor(assertion);
      const { credential, expiresAtMs } = credentials.issue(installationId, clock().getTime());
      counters.credentialsIssued += 1;
      return { credential, expiresAt: new Date(expiresAtMs).toISOString() };
    },

    metrics() {
      const pending = cohorts.pending();
      return { ...counters, pendingSamples: pending.samples, pendingSegments: pending.segments };
    },
    mode: settings.mode,
    runEpoch,
    settings,

    async start() {
      if (epochTimer !== undefined) return;
      // Releases are erased on every start, in every mode. Switching the feature off therefore
      // removes its data, and segment keys from a replaced routing graph never outlive a restart.
      try {
        await store.purge();
      } catch (error: unknown) {
        counters.purgeFailures += 1;
        options.onMaintenanceFailure?.('purge');
        if (settings.mode !== 'off') throw error;
      }
      if (settings.mode === 'off') return;
      await store.ready();
      lastClosedEpochMs = epochStart();
      scheduleEpoch();
    },

    status() {
      return {
        generatedAt: clock().toISOString(),
        mode: settings.mode === 'collect' ? 'collecting' : settings.mode,
        probes: {
          accepting: settings.mode !== 'off' && options.attestation !== undefined,
          batchTargetMeters: 600,
          batchTargetSeconds: 60,
          batchTrimMeters: settings.batchTrimMeters,
          credentialEndpoint: '/v2/traffic/credentials',
          endpoint: '/v2/traffic/probes',
          maxBatchSeconds: TRAFFIC_PROBE_LIMITS.maxBatchSeconds,
          maxGapSeconds: TRAFFIC_PROBE_LIMITS.maxGapSeconds,
          maxPoints: TRAFFIC_PROBE_LIMITS.maxPoints,
          minPoints: TRAFFIC_PROBE_LIMITS.minPoints,
          sampleIntervalSeconds: 2,
          schemaVersion: TRAFFIC_PROBE_LIMITS.schemaVersion,
          tripEndTrimMeters: settings.tripEndTrimMeters,
        },
        publication: {
          cohortSeconds: settings.cohortSeconds,
          epochSeconds: settings.epochSeconds,
          minimumContributors: settings.minimumContributors,
          releaseSeconds: settings.releaseSeconds,
        },
        source: COMMUNITY_TRAFFIC_SOURCE,
      };
    },
  };
}

/**
 * True for an endpoint that can only be a matcher the operator runs: loopback, a private or
 * link-local address literal, or a single-label name such as a Compose service. A name with a dot
 * can resolve on the public internet, so it is refused, whatever it is.
 */
export function isLocalMatcherEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[')) {
    const address = host.slice(1, -1);
    return (
      address === '::1' || /^f[cd][0-9a-f]{2}:/.test(address) || /^fe[89ab][0-9a-f]:/.test(address)
    );
  }
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)?.slice(1).map(Number);
  if (octets !== undefined) {
    const [first = 0, second = 0] = octets;
    return (
      first === 127 ||
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(host);
}

/**
 * Builds the service from the environment. Community traffic stays off unless
 * `COMMUNITY_TRAFFIC_MODE` is `collect` or `live`, and then it refuses to start unless the trace
 * endpoint is a local matcher: driving traces are never sent to a server someone else runs.
 */
export function createConfiguredTrafficService(
  options: Pick<TrafficServiceOptions, 'attestation' | 'clock' | 'onMaintenanceFailure'> = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): TrafficService {
  const settings = readTrafficSettings(environment);
  const store =
    environment.PGHOST === undefined || environment.PGHOST === ''
      ? createInMemoryTrafficReleaseStore()
      : createPostgresTrafficReleaseStore();
  if (settings.mode === 'off') return createTrafficService({ ...options, settings, store });
  const traceUrl =
    environment.VALHALLA_TRACE_URL ??
    (environment.VALHALLA_URL === undefined
      ? undefined
      : new URL('trace_attributes', environment.VALHALLA_URL).toString());
  if (traceUrl === undefined || !isLocalMatcherEndpoint(traceUrl)) {
    throw new Error(
      'COMMUNITY_TRAFFIC_MODE requires VALHALLA_TRACE_URL (or VALHALLA_URL) to be a self-hosted Valhalla on loopback, a private address, or a single-label service name.',
    );
  }
  return createTrafficService({
    ...options,
    mapMatcher: createValhallaMapMatcher({ endpoint: traceUrl }),
    settings,
    store,
  });
}
