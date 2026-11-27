import {
  compareRouteAlternatives,
  type RouteAlternativeV2,
  type RouteRequestV2,
} from '@navoss/contracts';

import type { ProvincialRoadEventService } from '../provincial-road-events.js';
import {
  applyFastestLabel,
  RouteNotFoundError,
  type RouteProvider,
  type RouteProviderRequestOptions,
} from '../route-provider.js';
import { haversineMeters } from '../traffic/geo.js';
import { selectClosureEvents, type ClosureEventRejection } from './events.js';
import {
  ClosurePlacementError,
  ClosureProximity,
  MAX_CLOSURE_EXCLUSIONS,
  placeClosure,
  validateClosureBarriers,
  routeCrossesBarrier,
  type ClosurePlacementRejection,
  type PlacedClosure,
  type PlacedBarrier,
} from './graph.js';

export type RouteClosureMode = 'off' | 'shadow' | 'on';
type Rejection =
  | ClosureEventRejection
  | ClosurePlacementRejection
  | 'graph-error'
  | 'provider-error'
  | 'no-route'
  | 'timeout'
  | 'exclusion-ignored'
  | 'large-point-detour'
  | 'endpoint-access'
  | 'unsupported-provider';
export interface ClosureRoutingCounters {
  requests: number;
  requestsNearClosures: number;
  routesWouldChange: number;
  exclusionsComputed: number;
  failedOpen: number;
  sourceRowsExamined: number;
  eligibleClosures: number;
  largeLineDetours: number;
  rejected: Partial<Record<Rejection, number>>;
}
export interface ClosureRouting {
  provider: RouteProvider;
  start(): void;
  close(): void;
  counters(): ClosureRoutingCounters;
}
interface Options {
  mode?: RouteClosureMode;
  clock?: () => number;
  /** Tests may shorten the same total budget; production never adds a client-configurable retry. */
  timeoutMs?: number;
  onCounters?: (counters: ClosureRoutingCounters) => void;
}
interface PublicPlacement {
  proximity: ClosureProximity;
  placed?: PlacedClosure;
  rejected?: ClosurePlacementRejection;
}

/** Invalid values fail open to off; only an explicit shadow/on changes routing work. */
export function routeClosureModeFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RouteClosureMode {
  const value = environment.ROUTE_AVOID_CLOSURES;
  return value === 'shadow' || value === 'on' ? value : 'off';
}

async function withinBudget<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const { promise: deadline, reject } = Promise.withResolvers<never>();
  const onAbort = () => {
    reject(new Error('Closure work timed out.'));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function routesChanged(
  before: readonly RouteAlternativeV2[],
  after: readonly RouteAlternativeV2[],
): boolean {
  if (before.length !== after.length) return true;
  return before.some((route, index) => {
    const other = after[index];
    if (other === undefined) return true;
    if (route.geometry.length !== other.geometry.length) return true;
    return route.geometry.some((point, position) => {
      const otherPoint = other.geometry[position];
      if (otherPoint === undefined) return true;
      return point[0] !== otherPoint[0] || point[1] !== otherPoint[1];
    });
  });
}

export function createClosureRouting(
  routeProvider: RouteProvider,
  roadEvents: ProvincialRoadEventService,
  options: Options = {},
): ClosureRouting {
  const mode = options.mode ?? routeClosureModeFromEnvironment();
  const clock = options.clock ?? Date.now;
  const counters: ClosureRoutingCounters = {
    requests: 0,
    requestsNearClosures: 0,
    routesWouldChange: 0,
    exclusionsComputed: 0,
    failedOpen: 0,
    sourceRowsExamined: 0,
    eligibleClosures: 0,
    largeLineDetours: 0,
    rejected: {},
  };
  const publicPlacements = new Map<string, PublicPlacement>();
  let interval: NodeJS.Timeout | undefined;
  const reject = (reason: Rejection, count = 1) => {
    counters.rejected[reason] = (counters.rejected[reason] ?? 0) + count;
  };
  const snapshot = (): ClosureRoutingCounters => ({
    ...counters,
    rejected: { ...counters.rejected },
  });
  const query = routeProvider.getClosureGraph?.bind(routeProvider);
  const enrichedRoutes = routeProvider.getEnrichedRoutes?.bind(routeProvider);
  const enabled =
    mode !== 'off' && routeProvider.source?.id === 'valhalla-self-hosted' && query !== undefined;
  if (mode !== 'off' && !enabled) reject('unsupported-provider');

  async function avoiding(
    request: RouteRequestV2,
    baseline: RouteAlternativeV2[],
    requestOptions: RouteProviderRequestOptions | undefined,
    signal: AbortSignal,
    getRoutes: (options: RouteProviderRequestOptions) => Promise<RouteAlternativeV2[]>,
  ): Promise<RouteAlternativeV2[]> {
    const selection = selectClosureEvents(await roadEvents.getRoutingSnapshots(), clock());
    signal.throwIfAborted();
    counters.sourceRowsExamined += selection.examined;
    counters.eligibleClosures += selection.events.length;
    for (const [reason, count] of Object.entries(selection.rejected))
      reject(reason as ClosureEventRejection, count);
    const keys = new Set(selection.events.map((event) => event.key));
    for (const key of publicPlacements.keys()) if (!keys.has(key)) publicPlacements.delete(key);
    if (query === undefined || selection.events.length === 0) return baseline;
    const applied = new Map<string, { placed: PlacedClosure; barriers: PlacedBarrier[] }>();
    const endpoints = [request.origin, ...(request.waypoints ?? []), request.destination];
    let current = baseline;
    let near = false;

    // Each pass must add a new official event. A detour is checked against every eligible event,
    // not just those on the original route; count/total-time limits bound the complete computation.
    for (;;) {
      signal.throwIfAborted();
      let added = false;
      for (const event of selection.events) {
        if (applied.has(event.key)) continue;
        let state = publicPlacements.get(event.key);
        if (state === undefined) {
          try {
            state = { proximity: new ClosureProximity(event.geometry) };
            publicPlacements.set(event.key, state);
          } catch (error: unknown) {
            reject(error instanceof ClosurePlacementError ? error.reason : 'graph-error');
            continue;
          }
        }
        if (!current.some((route) => state.proximity.nearRoute(route.geometry))) continue;
        if (!near) {
          counters.requestsNearClosures += 1;
          near = true;
        }
        if (state.rejected !== undefined) {
          reject(state.rejected);
          continue;
        }
        if (state.placed === undefined) {
          try {
            state.placed = await placeClosure(event, query, state.proximity, signal);
          } catch (error: unknown) {
            signal.throwIfAborted();
            if (error instanceof ClosurePlacementError) {
              state.rejected = error.reason;
              reject(error.reason);
            } else reject('graph-error');
            continue;
          }
        }
        signal.throwIfAborted();
        const placed = state.placed;
        const barriers = placed.barriers.filter((barrier) => {
          const atEndpoint = endpoints.some(
            (point) => haversineMeters(barrier.point, [point.longitude, point.latitude]) <= 20,
          );
          if (atEndpoint) reject('endpoint-access');
          return !atEndpoint;
        });
        if (
          !current.some((route) =>
            barriers.some((barrier) => routeCrossesBarrier(route.geometry, barrier)),
          )
        )
          continue;
        applied.set(event.key, { placed, barriers });
        added = true;
      }
      if (!added) break;
      const barriers = [...applied.values()].flatMap((event) => event.barriers);
      const exclusions = [
        ...(requestOptions?.excludeLocations ?? []),
        ...barriers.map((barrier) => barrier.exclusion),
      ];
      if (exclusions.length > MAX_CLOSURE_EXCLUSIONS) {
        reject('exclusion-limit', exclusions.length);
        counters.failedOpen += 1;
        return baseline;
      }
      await validateClosureBarriers(barriers, query, signal);
      counters.exclusionsComputed += barriers.length;
      current = await getRoutes({ ...requestOptions, excludeLocations: exclusions, signal });
      signal.throwIfAborted();
      if (current.length === 0) throw new RouteNotFoundError();
      const clear = current.filter(
        (route) => !barriers.some((barrier) => routeCrossesBarrier(route.geometry, barrier)),
      );
      if (clear.length !== current.length)
        reject('exclusion-ignored', current.length - clear.length);
      if (clear.length === 0) {
        counters.failedOpen += 1;
        return baseline;
      }
      current =
        clear.length === current.length
          ? current
          : applyFastestLabel(clear.sort(compareRouteAlternatives));
    }
    if (applied.size === 0) return baseline;
    const fastestBefore = Math.min(...baseline.map((route) => route.durationSeconds));
    const fastestAfter = Math.min(...current.map((route) => route.durationSeconds));
    const large = fastestAfter - fastestBefore > 15 * 60 && fastestAfter > fastestBefore * 2;
    if (large && [...applied.values()].some((event) => !event.placed.verifiedLine)) {
      reject('large-point-detour');
      counters.failedOpen += 1;
      return baseline;
    }
    if (large) counters.largeLineDetours += 1;
    if (routesChanged(baseline, current)) counters.routesWouldChange += 1;
    return mode === 'shadow' ? baseline : current;
  }

  async function route(
    request: RouteRequestV2,
    requestOptions: RouteProviderRequestOptions | undefined,
    getRoutes: (options?: RouteProviderRequestOptions) => Promise<RouteAlternativeV2[]>,
  ): Promise<RouteAlternativeV2[]> {
    // The ordinary provider call and its errors are unchanged. Closure work cannot replace it.
    const baseline = await getRoutes(requestOptions);
    counters.requests += 1;
    const signal = AbortSignal.any([
      AbortSignal.timeout(options.timeoutMs ?? 2_500),
      ...(requestOptions?.signal === undefined ? [] : [requestOptions.signal]),
    ]);
    try {
      return await withinBudget(
        avoiding(request, baseline, requestOptions, signal, getRoutes),
        signal,
      );
    } catch (error: unknown) {
      counters.failedOpen += 1;
      if (error instanceof ClosurePlacementError) publicPlacements.clear();
      reject(
        signal.aborted
          ? 'timeout'
          : error instanceof RouteNotFoundError
            ? 'no-route'
            : error instanceof ClosurePlacementError
              ? error.reason
              : 'provider-error',
      );
      return baseline;
    }
  }

  const provider: RouteProvider = !enabled
    ? routeProvider
    : {
        ...routeProvider,
        getRoutes: (request, requestOptions) =>
          route(request, requestOptions, (upstreamOptions) =>
            routeProvider.getRoutes(request, upstreamOptions),
          ),
        ...(enrichedRoutes === undefined
          ? {}
          : {
              getEnrichedRoutes: (
                request: RouteRequestV2,
                requestOptions?: RouteProviderRequestOptions,
              ) =>
                route(request, requestOptions, (upstreamOptions) =>
                  enrichedRoutes(request, upstreamOptions),
                ),
            }),
      };
  return {
    provider,
    counters: snapshot,
    start() {
      if (!enabled || interval !== undefined || options.onCounters === undefined) return;
      interval = setInterval(() => options.onCounters?.(snapshot()), 60_000);
      interval.unref();
    },
    close() {
      clearInterval(interval);
      interval = undefined;
      publicPlacements.clear();
    },
  };
}
