import {
  COMMUNITY_TRAFFIC_ATTRIBUTION,
  COMMUNITY_TRAFFIC_SOURCE_ID,
  compareRouteAlternatives,
  TRAFFIC_PROBE_LIMITS,
  type RouteCongestionLevel,
  type TrafficFlowBounds,
  type TrafficFlowResponse,
  type TrafficProbeBatchRequest,
  type TrafficStatusResponse,
} from '@navoss/contracts';

import { applyFastestLabel } from '../route-provider.js';
import { classifyCongestion, estimateSpeed } from './aggregation.js';
import { createContributorTokens, type ContributorTokens } from './contributor.js';
import type { Position } from './geo.js';
import { createValhallaMapMatcher, type MapMatcher } from './map-matcher.js';
import { deriveObservations, segmentKeyForEdge } from './observations.js';
import { findProbeRejection, trimBatchEnds, type ProbeRejection } from './probe-validation.js';
import { annotateRouteTraffic, type TrafficRouteInput } from './route-traffic.js';
import { readTrafficSettings, type TrafficMode, type TrafficSettings } from './settings.js';
import {
  createInMemoryTrafficStore,
  createPostgresTrafficStore,
  type PublicationRule,
  type PublishedSegment,
  type TrafficCounts,
  type TrafficStore,
} from './store.js';

const PUBLIC_VALHALLA_HOST = 'valhalla1.openstreetmap.de';
const EXPIRY_INTERVAL_MS = 60_000;
const MIN_MATCHED_POINTS = 5;

export const COMMUNITY_TRAFFIC_SOURCE = {
  attribution: COMMUNITY_TRAFFIC_ATTRIBUTION,
  id: COMMUNITY_TRAFFIC_SOURCE_ID,
} as const;

export type IngestOutcome =
  | { status: 'accepted' }
  | { reason: ProbeRejection; status: 'rejected' }
  | { status: 'unavailable' };

/** Counters only. Nothing here is, or is derived from, a position, an address, or a time. */
export interface TrafficMetrics {
  batchesAccepted: number;
  batchesDropped: number;
  batchesRejected: number;
  batchesUnavailable: number;
  flowResponses: number;
  routesAnnotated: number;
  routesWithoutTraffic: number;
  samplesRecorded: number;
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

export interface TrafficService {
  close(): Promise<void>;
  /** Service-wide counts of live segments and samples, whatever the mode. */
  coverage(): Promise<TrafficCounts>;
  /**
   * Route-level traffic for the v2 route response. Routes with enough published flow get an
   * adjusted duration, per-step durations, a delay and per-geometry-segment congestion; the rest
   * are returned untouched, which means traffic is unavailable for that route. The list is
   * re-ranked on the adjusted durations. `trafficSource` is set when at least one route was
   * adjusted. Never throws: a failure leaves every route untouched.
   */
  enrichRoutes<Route extends EnrichableRoute>(
    routes: readonly Route[],
  ): Promise<{
    routes: TrafficEnrichedRoute<Route>[];
    trafficSource?: typeof COMMUNITY_TRAFFIC_SOURCE;
  }>;
  flow(bounds: TrafficFlowBounds): Promise<TrafficFlowResponse>;
  ingest(batch: TrafficProbeBatchRequest, sourceAddress: string): Promise<IngestOutcome>;
  metrics(): TrafficMetrics;
  readonly mode: TrafficMode;
  readonly settings: TrafficSettings;
  /** Prepares storage and begins periodic expiry. Rejects when storage cannot be prepared. */
  start(): Promise<void>;
  status(): Promise<TrafficStatusResponse>;
}

export interface TrafficServiceOptions {
  clock?: () => Date;
  contributorTokens?: ContributorTokens;
  mapMatcher?: MapMatcher;
  settings: TrafficSettings;
  store?: TrafficStore;
}

export function createTrafficService(options: TrafficServiceOptions): TrafficService {
  const { settings } = options;
  const clock = options.clock ?? (() => new Date());
  const store = options.store ?? createInMemoryTrafficStore();
  const tokens = options.contributorTokens ?? createContributorTokens();
  const mapMatcher = options.mapMatcher;
  if (settings.mode !== 'off' && mapMatcher === undefined) {
    throw new Error('Community traffic requires a self-hosted Valhalla map matcher.');
  }
  const counters: TrafficMetrics = {
    batchesAccepted: 0,
    batchesDropped: 0,
    batchesRejected: 0,
    batchesUnavailable: 0,
    flowResponses: 0,
    routesAnnotated: 0,
    routesWithoutTraffic: 0,
    samplesRecorded: 0,
  };
  let matchesInFlight = 0;
  let expiryTimer: NodeJS.Timeout | undefined;

  const rule = (nowMs: number): PublicationRule => ({
    minimumContributors: settings.minimumContributors,
    windowStartMs: nowMs - settings.windowSeconds * 1_000,
  });

  const speedsByKey = (segments: readonly PublishedSegment[], nowMs: number): Map<string, number> =>
    new Map(
      segments.flatMap((segment) => {
        const estimate = estimateSpeed(segment.buckets, nowMs, settings);
        return estimate === undefined ? [] : [[segment.segmentKey, estimate.speedKph] as const];
      }),
    );

  return {
    async close() {
      clearInterval(expiryTimer);
      await store.close();
    },

    coverage: () => store.counts(rule(clock().getTime())),

    async enrichRoutes(routes) {
      const untouched = { routes: [...routes] };
      if (settings.mode !== 'live' || mapMatcher === undefined) return untouched;
      const nowMs = clock().getTime();
      try {
        const annotations = await Promise.all(
          routes.map(async (route) => {
            const longitudes = route.geometry.map(([longitude]) => longitude);
            const latitudes = route.geometry.map(([, latitude]) => latitude);
            // Skip the map-matching round trip when nothing is published near the route, which
            // is the normal case while few drivers contribute.
            const nearby = await store.publishedInBounds(
              {
                east: Math.max(...longitudes),
                north: Math.max(...latitudes),
                south: Math.min(...latitudes),
                west: Math.min(...longitudes),
              },
              rule(nowMs),
              1,
            );
            if (nearby.segments.length === 0) return undefined;
            const edges = await mapMatcher.walkRoute(route.geometry);
            if (edges === undefined) return undefined;
            const keys = [...new Set(edges.flatMap((edge) => segmentKeyForEdge(edge) ?? []))];
            const published = await store.publishedByKeys(keys, rule(nowMs));
            return annotateRouteTraffic(route, edges, speedsByKey(published, nowMs), settings);
          }),
        );
        const annotated = annotations.filter((annotation) => annotation !== undefined).length;
        counters.routesAnnotated += annotated;
        counters.routesWithoutTraffic += routes.length - annotated;
        if (annotated === 0) return untouched;
        const enriched = routes.map((route, index) => {
          const annotation = annotations[index];
          return annotation === undefined
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
              };
        });
        return {
          routes: applyFastestLabel(enriched.sort(compareRouteAlternatives)),
          trafficSource: COMMUNITY_TRAFFIC_SOURCE,
        };
      } catch {
        counters.routesWithoutTraffic += routes.length;
        return untouched;
      }
    },

    async flow(bounds) {
      const now = clock();
      const nowMs = now.getTime();
      const { segments, truncated } = await store.publishedInBounds(
        bounds,
        rule(nowMs),
        settings.maxFlowFeatures,
      );
      counters.flowResponses += 1;
      const features = segments.flatMap((segment) => {
        const estimate = estimateSpeed(segment.buckets, nowMs, settings);
        if (estimate === undefined) return [];
        return [
          {
            geometry: { coordinates: segment.lines, type: 'MultiLineString' as const },
            id: segment.segmentKey,
            properties: {
              ageSeconds: Math.max(0, Math.round((nowMs - estimate.observedAtMs) / 1_000)),
              congestion: classifyCongestion(estimate.speedKph, segment.freeFlowKph, settings),
              freeFlowKph: segment.freeFlowKph,
              observedAt: new Date(estimate.observedAtMs).toISOString(),
              sampleCount: estimate.sampleCount,
              speedKph: Math.round(estimate.speedKph),
            },
            type: 'Feature' as const,
          },
        ];
      });
      return {
        coverage: {
          minimumContributors: settings.minimumContributors,
          publishedSegments: features.length,
          truncated,
          windowSeconds: settings.windowSeconds,
        },
        features,
        generatedAt: now.toISOString(),
        source: COMMUNITY_TRAFFIC_SOURCE,
        type: 'FeatureCollection',
      };
    },

    async ingest(batch, sourceAddress) {
      if (settings.mode === 'off' || mapMatcher === undefined) {
        counters.batchesUnavailable += 1;
        return { status: 'unavailable' };
      }
      const nowMs = clock().getTime();
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
          matched === undefined
            ? []
            : deriveObservations(matched, points, Date.parse(batch.capturedAt), settings);
        if (observations.length === 0) {
          counters.batchesDropped += 1;
          return { status: 'accepted' };
        }
        await store.record(observations, (segmentKey) =>
          tokens.tokenFor(sourceAddress, segmentKey),
        );
        counters.batchesAccepted += 1;
        counters.samplesRecorded += observations.length;
        return { status: 'accepted' };
      } catch {
        // Matcher and storage errors can quote request content, so they are counted, not logged.
        counters.batchesUnavailable += 1;
        return { status: 'unavailable' };
      } finally {
        matchesInFlight -= 1;
      }
    },

    metrics: () => ({ ...counters }),
    mode: settings.mode,
    settings,

    async start() {
      if (settings.mode === 'off' || expiryTimer !== undefined) return;
      await store.initialize();
      const expire = (): void => {
        void store
          .expire(clock().getTime() - (settings.windowSeconds + settings.bucketSeconds) * 1_000)
          .catch(() => undefined);
      };
      expiryTimer = setInterval(expire, EXPIRY_INTERVAL_MS);
      expiryTimer.unref();
    },

    async status() {
      const now = clock();
      return {
        ...(settings.mode === 'live' ? { coverage: await store.counts(rule(now.getTime())) } : {}),
        generatedAt: now.toISOString(),
        mode: settings.mode === 'collect' ? 'collecting' : settings.mode,
        probes: {
          accepting: settings.mode !== 'off',
          batchTargetMeters: 600,
          batchTargetSeconds: 60,
          endpoint: '/v1/traffic/probes',
          maxBatchSeconds: TRAFFIC_PROBE_LIMITS.maxBatchSeconds,
          maxGapSeconds: TRAFFIC_PROBE_LIMITS.maxGapSeconds,
          maxPoints: TRAFFIC_PROBE_LIMITS.maxPoints,
          minPoints: TRAFFIC_PROBE_LIMITS.minPoints,
          sampleIntervalSeconds: 2,
          schemaVersion: TRAFFIC_PROBE_LIMITS.schemaVersion,
          tripEndTrimMeters: settings.tripEndTrimMeters,
        },
        publication: {
          bucketSeconds: settings.bucketSeconds,
          minimumContributors: settings.minimumContributors,
          windowSeconds: settings.windowSeconds,
        },
        source: COMMUNITY_TRAFFIC_SOURCE,
      };
    },
  };
}

/**
 * Builds the service from the environment. Community traffic stays off unless
 * `COMMUNITY_TRAFFIC_MODE` is `collect` or `live`, and then it refuses to start without a
 * self-hosted Valhalla: driving traces are never sent to a public routing server.
 */
export function createConfiguredTrafficService(
  options: { clock?: () => Date } = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): TrafficService {
  const settings = readTrafficSettings(environment);
  if (settings.mode === 'off') return createTrafficService({ ...options, settings });
  const traceUrl =
    environment.VALHALLA_TRACE_URL ??
    (environment.VALHALLA_URL === undefined
      ? undefined
      : new URL('trace_attributes', environment.VALHALLA_URL).toString());
  if (traceUrl === undefined || new URL(traceUrl).hostname === PUBLIC_VALHALLA_HOST) {
    throw new Error(
      'COMMUNITY_TRAFFIC_MODE requires VALHALLA_URL or VALHALLA_TRACE_URL to point at a self-hosted Valhalla.',
    );
  }
  return createTrafficService({
    ...options,
    mapMatcher: createValhallaMapMatcher({ endpoint: traceUrl }),
    settings,
    store:
      environment.PGHOST === undefined
        ? createInMemoryTrafficStore()
        : createPostgresTrafficStore(),
  });
}
