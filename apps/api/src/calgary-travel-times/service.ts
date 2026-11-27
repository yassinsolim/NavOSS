import {
  CALGARY_TRAVEL_TIMES_ATTRIBUTION,
  CALGARY_TRAVEL_TIMES_SOURCE_ID,
  compareRouteAlternatives,
  type RouteCongestionLevel,
} from '@navoss/contracts';

import { z } from 'zod/v4';

import { applyFastestLabel } from '../route-provider.js';
import type { Position } from '../traffic/geo.js';
import {
  createValhallaMapMatcher,
  type MapMatcher,
  type MatchedEdge,
} from '../traffic/map-matcher.js';
import {
  minorRoadMeters,
  rankWithTraffic,
  type TrafficRouteInput,
} from '../traffic/route-traffic.js';
import { isLocalMatcherEndpoint } from '../traffic/service.js';
import { DEFAULT_TRAFFIC_SETTINGS } from '../traffic/settings.js';
import { CORRIDOR_TABLE, type CorridorTable } from './corridors.js';
import {
  annotateCityRoute,
  buildDelayModel,
  delayedRoutePoints,
  type DelayedPoint,
  type CorridorReading,
  type DelayModel,
  type PlacedCorridor,
} from './delay-model.js';
import { createTravelTimesFeed, type TravelTimesFeed } from './feed.js';
import { createCorridorPlacer, type CorridorPlacer, type PlacementFailure } from './placement.js';

export type CalgaryTravelTimesMode = 'live' | 'off' | 'shadow';

export const CALGARY_TRAVEL_TIMES_SOURCE = {
  attribution: CALGARY_TRAVEL_TIMES_ATTRIBUTION,
  id: CALGARY_TRAVEL_TIMES_SOURCE_ID,
} as const;

/**
 * A reading older than this is not applied. The City publishes about every 20 minutes and the
 * feed is polled every 3: 50 minutes tolerates one missed publication (40 minutes plus polling and
 * a margin) but not two, so a jam that has cleared is not kept for more than about half an hour.
 */
export const MAX_READING_AGE_MS = 50 * 60_000;
// Graph changes are noticed at most this late.
const GRAPH_CHECK_MS = 60_000;
const STATUS_TIMEOUT_MS = 3_000;
const SUMMARY_INTERVAL_MS = 15 * 60_000;
// Routes are evaluated only when they come within this margin of a corridor anchor's box.
const NEAR_MARGIN_DEGREES = 0.03;
/**
 * The recommended route must carry at least this much City delay before a route around it is
 * requested. Three minutes is clearly beyond what whole-minute values and their rounding can
 * produce, and below it a detour rarely wins once its own extra distance is counted.
 */
export const AVOID_MIN_DELAY_SECONDS = 180;
// The whole candidate: the extra provider call and the walk that checks its roads.
export const AVOID_TIMEOUT_MS = 2_500;
// One excluded point every 400 m keeps the candidate off the delayed carriageway; Valhalla accepts
// 50 exclusions by default.
const AVOID_SPACING_METERS = 400;
const AVOID_MAX_POINTS = 40;

/**
 * Requests routes for the same trip avoiding the given points, each in its direction of travel.
 * The app wires it to the routing provider; the first route returned is the candidate.
 */
export type AvoidRoutes<Route> = (
  points: readonly DelayedPoint[],
  signal: AbortSignal,
) => Promise<readonly Route[]>;

export interface CalgaryTravelTimesMetrics {
  avoidFailures: number;
  /** Avoid candidates that were distinct, faster with traffic, and offered. */
  avoidIncluded: number;
  avoidRequests: number;
  corridorsLeftOutInTable: number;
  corridorsOff: Partial<Record<PlacementFailure, number>>;
  corridorsPlaced: number;
  feedAgeSeconds: number | null;
  fetchFailures: number;
  malformedRows: number;
  /** Responses whose route order would change (shadow) or changed (live). */
  ordersChanged: number;
  placements: number;
  rejectedAnswers: number;
  routesEvaluated: number;
  routesWithDelay: number;
  shadowSkipped: number;
  /** Distinct feed labels that are neither in the table nor recorded as left out. */
  unknownSegments: number;
}

/** The route fields this source reads or replaces; every other field passes through. */
export interface CityEnrichableRoute extends TrafficRouteInput {
  distanceMeters: number;
  id: string;
  label: 'alternative' | 'fastest';
  steps: readonly { durationSeconds: number; geometry: readonly Position[] }[];
}

export type CityEnrichedRoute<Route extends CityEnrichableRoute> = Route & {
  congestion?: RouteCongestionLevel[];
  traffic?: {
    delaySeconds: number;
    observedFraction: number;
    oldestObservedAt: string;
    snapshotAt: string;
    typicalDurationSeconds: number;
  };
};

export interface CityEnrichment<Route extends CityEnrichableRoute> {
  routes: CityEnrichedRoute<Route>[];
  trafficSource: typeof CALGARY_TRAVEL_TIMES_SOURCE;
}

// The validated v2 request body; only the declaration is read.
const DeclarationSchema = z.object({
  alternatives: z.number().int().optional(),
  trafficSources: z.array(z.string()).optional(),
});

export interface CalgaryTravelTimesService {
  close(): void;
  /**
   * City traffic for one v2 route response. Undefined means the response is left exactly as it
   * is: the mode is not `live`, the request did not declare the source, no fresh corridor is
   * near, or anything failed. In `shadow` the routes are evaluated in the background for the
   * counters only. Never rejects.
   */
  enrich<Route extends CityEnrichableRoute>(
    routes: readonly Route[],
    /** The validated `/v2/routes` request body. */
    request: unknown,
    /** In `live`, how to ask the routing provider for a route around a delay. */
    avoid?: AvoidRoutes<Route>,
  ): Promise<CityEnrichment<Route> | undefined>;
  metrics(): CalgaryTravelTimesMetrics;
  readonly mode: CalgaryTravelTimesMode;
  /** Starts polling and places the corridors in the background. */
  start(): void;
}

export interface CalgaryTravelTimesServiceOptions {
  clock?: () => number;
  feed?: TravelTimesFeed;
  /** Reads the serving graph's identity; a change re-places every corridor. */
  graphVersion?: () => Promise<string | undefined>;
  mapMatcher?: Pick<MapMatcher, 'walkRoute'>;
  mode: CalgaryTravelTimesMode;
  onSummary?: (metrics: CalgaryTravelTimesMetrics) => void;
  placer?: CorridorPlacer;
  table?: CorridorTable;
}

function routeBounds(routes: readonly { geometry: readonly Position[] }[]) {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const route of routes) {
    for (const [longitude, latitude] of route.geometry) {
      west = Math.min(west, longitude);
      east = Math.max(east, longitude);
      south = Math.min(south, latitude);
      north = Math.max(north, latitude);
    }
  }
  return { east, north, south, west };
}

export function createCalgaryTravelTimesService(
  options: CalgaryTravelTimesServiceOptions,
): CalgaryTravelTimesService {
  const { mode } = options;
  const clock = options.clock ?? Date.now;
  const table = options.table ?? CORRIDOR_TABLE;
  const feed = options.feed ?? createTravelTimesFeed({ clock });
  const thresholds = DEFAULT_TRAFFIC_SETTINGS;
  const definitions = new Map(table.corridors.map((corridor) => [corridor.segment, corridor]));
  const leftOut = new Set(table.leftOut.map((entry) => entry.segment));
  const anchors = table.corridors.flatMap((corridor) => corridor.anchors);
  const area = {
    east: Math.max(...anchors.map((anchor) => anchor.longitude)) + NEAR_MARGIN_DEGREES,
    north: Math.max(...anchors.map((anchor) => anchor.latitude)) + NEAR_MARGIN_DEGREES,
    south: Math.min(...anchors.map((anchor) => anchor.latitude)) - NEAR_MARGIN_DEGREES,
    west: Math.min(...anchors.map((anchor) => anchor.longitude)) - NEAR_MARGIN_DEGREES,
  };
  const counters = {
    avoidFailures: 0,
    avoidIncluded: 0,
    avoidRequests: 0,
    ordersChanged: 0,
    placements: 0,
    routesEvaluated: 0,
    routesWithDelay: 0,
    shadowSkipped: 0,
  };
  let placed: PlacedCorridor[] = [];
  let off: Partial<Record<PlacementFailure, number>> = {};
  // Every graph Valhalla serves is a generation; edge ids of one mean nothing on another.
  let generation = 0;
  let placedGraph: string | undefined;
  let placing: { generation: number; promise: Promise<void> } | undefined;
  let model: { key: string; value: DelayModel } | undefined;
  let shadowBusy = false;
  const timers: ReturnType<typeof setInterval>[] = [];
  const unknownSegments = new Set<string>();
  const graphVersion = options.graphVersion ?? (() => Promise.resolve('configured'));

  /** Places every corridor for one generation; publishes only if it is still the current one. */
  const placeAll = async (forGeneration: number): Promise<void> => {
    if (options.placer === undefined) return;
    const next: PlacedCorridor[] = [];
    const failures: Partial<Record<PlacementFailure, number>> = {};
    for (const definition of table.corridors) {
      if (generation !== forGeneration) return;
      const outcome = await options.placer.place(definition);
      if (outcome.status === 'placed') next.push(outcome.corridor);
      else failures[outcome.reason] = (failures[outcome.reason] ?? 0) + 1;
    }
    if (generation !== forGeneration) return;
    placed = next;
    off = failures;
    model = undefined;
    counters.placements += 1;
  };
  const replace = (): Promise<void> => {
    if (placing?.generation === generation) return placing.promise;
    const forGeneration = generation;
    const promise = placeAll(forGeneration)
      .catch(() => undefined)
      .finally(() => {
        if (placing?.generation === forGeneration) placing = undefined;
      });
    placing = { generation: forGeneration, promise };
    return promise;
  };
  /**
   * On another graph the current placement is dropped at once, so no City traffic is applied
   * until the corridors are placed on the new graph (or ever, if that fails). On the same graph a
   * placement Valhalla could not answer is retried, keeping the current one meanwhile.
   */
  const checkGraph = async (): Promise<void> => {
    const graph = await graphVersion();
    if (graph === undefined) return;
    if (graph !== placedGraph) {
      generation += 1;
      placedGraph = graph;
      placed = [];
      off = {};
      model = undefined;
      await replace();
    } else if ((off.unavailable ?? 0) > 0) {
      await replace();
    }
  };

  /** The model for the current placement and the fresh rows of the current feed answer. */
  const currentModel = (): DelayModel | undefined => {
    const snapshot = feed.snapshot();
    if (snapshot === undefined || placed.length === 0) return undefined;
    const now = clock();
    const readings = new Map<string, CorridorReading>();
    for (const [segment, row] of snapshot.rows) {
      const definition = definitions.get(segment);
      if (definition === undefined) {
        if (!leftOut.has(segment)) unknownSegments.add(segment);
        continue;
      }
      if (definition.baselineMinutes === null || now - row.lastUpdateMs > MAX_READING_AGE_MS) {
        continue;
      }
      readings.set(segment, {
        baselineMinutes: definition.baselineMinutes,
        lastUpdateMs: row.lastUpdateMs,
        liveMinutes: row.minutes,
      });
    }
    if (readings.size === 0) return undefined;
    const key = `${String(counters.placements)}:${[...readings]
      .map(
        ([segment, reading]) =>
          `${segment}=${String(reading.liveMinutes)}@${String(reading.lastUpdateMs)}`,
      )
      .join('|')}`;
    if (model?.key !== key) {
      model = { key, value: buildDelayModel(placed, readings, thresholds) };
    }
    return model.value;
  };

  interface Rankable<Route extends CityEnrichableRoute> {
    distanceMeters: number;
    durationSeconds: number;
    edges: MatchedEdge[] | undefined;
    minorMeters: number | undefined;
    route: CityEnrichedRoute<Route>;
  }
  interface Evaluated<Route extends CityEnrichableRoute> extends Rankable<Route> {
    annotated: boolean;
    delaySeconds: number;
  }

  /** Walks and annotates one route; `delayed` is true when it carries City delay. */
  const annotate = async <Route extends CityEnrichableRoute>(
    route: Route,
    delayModel: DelayModel,
    walker: Pick<MapMatcher, 'walkRoute'>,
  ): Promise<Evaluated<Route>> => {
    const edges = await walker.walkRoute(route.geometry);
    const city =
      edges === undefined
        ? undefined
        : annotateCityRoute(route, edges, delayModel, thresholds.routeMaxDelayRatio);
    const annotation = city?.annotation;
    return {
      annotated: annotation !== undefined,
      delaySeconds: annotation?.delaySeconds ?? 0,
      distanceMeters: route.distanceMeters,
      durationSeconds: annotation?.durationSeconds ?? route.durationSeconds,
      edges,
      minorMeters: edges === undefined ? undefined : minorRoadMeters(edges),
      route:
        city === undefined || annotation === undefined
          ? route
          : {
              ...route,
              congestion: annotation.congestion,
              durationSeconds: annotation.durationSeconds,
              steps: route.steps.map((step, stepIndex) => ({
                ...step,
                durationSeconds: annotation.stepDurationsSeconds[stepIndex] ?? step.durationSeconds,
              })),
              traffic: {
                delaySeconds: annotation.delaySeconds,
                observedFraction: annotation.observedFraction,
                oldestObservedAt: new Date(city.oldestUpdateMs).toISOString(),
                snapshotAt: new Date(delayModel.latestUpdateMs).toISOString(),
                typicalDurationSeconds: annotation.typicalDurationSeconds,
              },
            },
    };
  };

  const evaluate = async <Route extends CityEnrichableRoute>(
    routes: readonly Route[],
    delayModel: DelayModel,
    avoid: { limit: number; request: AvoidRoutes<Route> } | undefined,
  ): Promise<{ changedOrder: boolean; enrichment: CityEnrichment<Route> } | undefined> => {
    const walker = options.mapMatcher;
    if (walker === undefined) return undefined;
    const evaluated: Evaluated<Route>[] = [];
    for (const route of routes) evaluated.push(await annotate(route, delayModel, walker));
    counters.routesEvaluated += routes.length;
    counters.routesWithDelay += evaluated.filter((entry) => entry.delaySeconds > 0).length;
    if (evaluated.every((entry) => !entry.annotated)) return undefined;
    let ranked: Rankable<Route>[] = rankWithTraffic(evaluated);
    const recommended = ranked[0];
    if (
      avoid !== undefined &&
      recommended?.edges !== undefined &&
      (recommended.route.traffic?.delaySeconds ?? 0) >= AVOID_MIN_DELAY_SECONDS
    ) {
      const candidate = await avoidCandidate(recommended.edges, ranked, delayModel, walker, avoid);
      if (candidate !== undefined && compareRouteAlternatives(candidate, recommended) < 0) {
        counters.avoidIncluded += 1;
        ranked = rankWithTraffic([...ranked, candidate]).slice(0, avoid.limit);
      }
    }
    const result = ranked.map(({ route }) => route);
    const changedOrder =
      result.length !== routes.length ||
      result.some((route, index) => route.id !== routes[index]?.id);
    return {
      changedOrder,
      enrichment: { routes: applyFastestLabel(result), trafficSource: CALGARY_TRAVEL_TIMES_SOURCE },
    };
  };

  /**
   * Asks the routing provider once for a route that avoids the delayed stretches of the
   * recommended route. Valhalla computes alternates on free flow, so every alternate may share
   * the jammed corridor; this is the only way to see a route around it. Time-boxed; any failure,
   * or a route identical to one already offered, gives no candidate.
   */
  const avoidCandidate = async <Route extends CityEnrichableRoute>(
    edges: readonly MatchedEdge[],
    offered: readonly Rankable<Route>[],
    delayModel: DelayModel,
    walker: Pick<MapMatcher, 'walkRoute'>,
    avoid: { request: AvoidRoutes<Route> },
  ): Promise<Rankable<Route> | undefined> => {
    const points = delayedRoutePoints(edges, delayModel, AVOID_SPACING_METERS, AVOID_MAX_POINTS);
    if (points.length === 0) return undefined;
    counters.avoidRequests += 1;
    // One deadline for the provider call and the walk that checks the candidate together.
    const deadline = AbortSignal.timeout(AVOID_TIMEOUT_MS);
    const work = (async () => {
      const [route] = await avoid.request(points, deadline);
      if (route === undefined) return undefined;
      const same = offered.some(
        ({ route: other }) =>
          other.geometry.length === route.geometry.length &&
          other.geometry.every(
            ([longitude, latitude], index) =>
              route.geometry[index]?.[0] === longitude && route.geometry[index][1] === latitude,
          ),
      );
      if (same) return undefined;
      return annotate(route, delayModel, walker);
    })();
    const expired = new Promise<'expired'>((resolve) => {
      deadline.addEventListener(
        'abort',
        () => {
          resolve('expired');
        },
        { once: true },
      );
    });
    const outcome = await Promise.race([work.catch(() => 'failed' as const), expired]);
    if (outcome === 'failed' || outcome === 'expired') {
      counters.avoidFailures += 1;
      return undefined;
    }
    return outcome;
  };

  return {
    close() {
      for (const timer of timers) clearInterval(timer);
      timers.length = 0;
      feed.stop();
    },
    async enrich(routes, request, avoid) {
      if (mode === 'off' || routes.length === 0) return undefined;
      const declaration = DeclarationSchema.safeParse(request);
      const declared =
        declaration.success &&
        declaration.data.trafficSources?.includes(CALGARY_TRAVEL_TIMES_SOURCE_ID) === true;
      if (mode === 'live' && !declared) return undefined;
      try {
        const bounds = routeBounds(routes);
        if (
          bounds.west > area.east ||
          bounds.east < area.west ||
          bounds.south > area.north ||
          bounds.north < area.south
        ) {
          return undefined;
        }
        const delayModel = currentModel();
        if (delayModel === undefined) return undefined;
        // Results computed against a graph that has since been replaced are dropped.
        const forGeneration = generation;
        if (mode === 'shadow') {
          // Counters only, off the request path, one evaluation at a time.
          if (shadowBusy) {
            counters.shadowSkipped += 1;
            return undefined;
          }
          shadowBusy = true;
          // No extra provider call in shadow: the avoid candidate is a live-only step.
          void evaluate(routes, delayModel, undefined)
            .then((result) => {
              if (result?.changedOrder === true && generation === forGeneration) {
                counters.ordersChanged += 1;
              }
            })
            .catch(() => undefined)
            .finally(() => {
              shadowBusy = false;
            });
          return undefined;
        }
        const alternatives = declaration.success ? (declaration.data.alternatives ?? 1) : 1;
        const result = await evaluate(
          routes,
          delayModel,
          avoid === undefined
            ? undefined
            : {
                // Within the contract's three routes and what the client asked for.
                limit: Math.min(3, Math.max(routes.length, alternatives + 1)),
                request: avoid,
              },
        );
        if (generation !== forGeneration) return undefined;
        if (result === undefined) return undefined;
        if (result.changedOrder) counters.ordersChanged += 1;
        return result.enrichment;
      } catch {
        return undefined;
      }
    },
    metrics() {
      const snapshot = feed.snapshot();
      const newest =
        snapshot === undefined
          ? undefined
          : Math.max(...[...snapshot.rows.values()].map((row) => row.lastUpdateMs));
      const feedCounters = feed.counters();
      return {
        avoidFailures: counters.avoidFailures,
        avoidIncluded: counters.avoidIncluded,
        avoidRequests: counters.avoidRequests,
        corridorsLeftOutInTable: table.leftOut.length,
        corridorsOff: { ...off },
        corridorsPlaced: placed.length,
        feedAgeSeconds:
          newest === undefined ? null : Math.max(0, Math.round((clock() - newest) / 1_000)),
        fetchFailures: feedCounters.fetchFailures,
        malformedRows: feedCounters.malformedRows,
        ordersChanged: counters.ordersChanged,
        placements: counters.placements,
        rejectedAnswers: feedCounters.rejectedAnswers,
        routesEvaluated: counters.routesEvaluated,
        routesWithDelay: counters.routesWithDelay,
        shadowSkipped: counters.shadowSkipped,
        unknownSegments: unknownSegments.size,
      };
    },
    mode,
    start() {
      if (mode === 'off' || timers.length > 0) return;
      feed.start();
      void checkGraph().catch(() => undefined);
      const watch = setInterval(() => {
        void checkGraph().catch(() => undefined);
      }, GRAPH_CHECK_MS);
      watch.unref();
      timers.push(watch);
      if (options.onSummary !== undefined) {
        const summary = setInterval(() => {
          options.onSummary?.(this.metrics());
        }, SUMMARY_INTERVAL_MS);
        summary.unref();
        timers.push(summary);
      }
    },
  };
}

export function readCalgaryTravelTimesMode(
  environment: Readonly<Record<string, string | undefined>>,
): CalgaryTravelTimesMode {
  const value = environment.CALGARY_TRAVEL_TIMES_MODE?.trim() ?? '';
  if (value === '' || value === 'off') return 'off';
  if (value === 'shadow' || value === 'live') return value;
  throw new Error('CALGARY_TRAVEL_TIMES_MODE must be off, shadow or live.');
}

/** Valhalla's tileset timestamp from `/status`; it changes whenever another graph is served. */
export function createValhallaGraphVersion(
  statusEndpoint: string,
  fetchImplementation: typeof fetch = fetch,
): () => Promise<string | undefined> {
  return async () => {
    try {
      const response = await fetchImplementation(statusEndpoint, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as { tileset_last_modified?: unknown };
      return typeof body.tileset_last_modified === 'number'
        ? String(body.tileset_last_modified)
        : undefined;
    } catch {
      return undefined;
    }
  };
}

export function createConfiguredCalgaryTravelTimesService(
  options: Pick<CalgaryTravelTimesServiceOptions, 'onSummary'> & {
    onFeedFailure?: (failure: { errorName: string; malformedRows?: number }) => void;
  } = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CalgaryTravelTimesService {
  const mode = readCalgaryTravelTimesMode(environment);
  if (mode === 'off') return createCalgaryTravelTimesService({ mode });
  const traceUrl =
    environment.VALHALLA_TRACE_URL ??
    (environment.VALHALLA_URL === undefined
      ? undefined
      : new URL('trace_attributes', environment.VALHALLA_URL).toString());
  if (traceUrl === undefined || !isLocalMatcherEndpoint(traceUrl)) {
    throw new Error(
      'CALGARY_TRAVEL_TIMES_MODE requires VALHALLA_TRACE_URL (or VALHALLA_URL) to be a self-hosted Valhalla on loopback, a private address, or a single-label service name.',
    );
  }
  const mapMatcher = createValhallaMapMatcher({ endpoint: traceUrl });
  return createCalgaryTravelTimesService({
    ...options,
    feed: createTravelTimesFeed(
      options.onFeedFailure === undefined ? {} : { onFailure: options.onFeedFailure },
    ),
    graphVersion: createValhallaGraphVersion(
      environment.VALHALLA_STATUS_URL ?? new URL('status', traceUrl).toString(),
    ),
    mapMatcher,
    mode,
    placer: createCorridorPlacer({
      mapMatcher,
      routeEndpoint: new URL('route', traceUrl).toString(),
    }),
  });
}
