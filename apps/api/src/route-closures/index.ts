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
import type { Position } from '../traffic/geo.js';
import { selectClosureEvents, type ClosureEventRejection } from './events.js';
import {
  ClosurePlacementError,
  ClosureProximity,
  MAX_CLOSURE_EXCLUSIONS,
  placeClosure,
  barrierForEndpoints,
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
  | 'unsupported-provider';
export interface ClosureRoutingCounters {
  requests: number;
  requestsNearClosures: number;
  routesWouldChange: number;
  exclusionsComputed: number;
  shadowSkipped: number;
  candidatesDeclined: number;
  failedOpen: number;
  sourceRowsExamined: number;
  eligibleClosures: number;
  largeLineDetours: number;
  rejected: Partial<Record<Rejection, number>>;
}
/** Internal result only; it is never included in either shipped route response. */
export interface ClosureRouteCandidate {
  routes: RouteAlternativeV2[];
  closuresApplied: boolean;
}
export interface ClosureRouting {
  provider: RouteProvider;
  /** In on mode, a candidate is declined rather than returned without required official barriers. */
  getCandidateRoutes(
    request: RouteRequestV2,
    requestOptions?: RouteProviderRequestOptions,
  ): Promise<ClosureRouteCandidate | undefined>;
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
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(new Error('Closure work timed out.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

class ClosureAvoidanceError extends Error {
  public constructor(public readonly reason: Rejection) {
    super('Official closure avoidance could not be verified.');
    this.name = 'ClosureAvoidanceError';
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

// One detached shadow computation across all app instances in this process.
let shadowInFlight = false;

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
    shadowSkipped: 0,
    candidatesDeclined: 0,
    failedOpen: 0,
    sourceRowsExamined: 0,
    eligibleClosures: 0,
    largeLineDetours: 0,
    rejected: {},
  };
  const publicPlacements = new Map<string, PublicPlacement>();
  let interval: NodeJS.Timeout | undefined;
  let shadowStart: NodeJS.Immediate | undefined;
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
  const shutdown = enabled ? new AbortController() : undefined;

  const workSignal = (requestOptions: RouteProviderRequestOptions | undefined) =>
    AbortSignal.any([
      AbortSignal.timeout(options.timeoutMs ?? 2_500),
      ...(requestOptions?.signal === undefined ? [] : [requestOptions.signal]),
      ...(shutdown === undefined ? [] : [shutdown.signal]),
    ]);

  async function avoiding(
    request: RouteRequestV2,
    baseline: RouteAlternativeV2[],
    requestOptions: RouteProviderRequestOptions | undefined,
    signal: AbortSignal,
    getRoutes: (options: RouteProviderRequestOptions) => Promise<RouteAlternativeV2[]>,
    candidate = false,
  ): Promise<ClosureRouteCandidate> {
    const selection = selectClosureEvents(await roadEvents.getRoutingSnapshots(), clock());
    signal.throwIfAborted();
    counters.sourceRowsExamined += selection.examined;
    counters.eligibleClosures += selection.events.length;
    for (const [reason, count] of Object.entries(selection.rejected))
      reject(reason as ClosureEventRejection, count);
    const keys = new Set(selection.events.map((event) => event.key));
    for (const key of publicPlacements.keys()) if (!keys.has(key)) publicPlacements.delete(key);
    if (query === undefined || selection.events.length === 0)
      return { routes: baseline, closuresApplied: false };
    const applied = new Map<string, { placed: PlacedClosure; barriers: PlacedBarrier[] }>();
    const endpoints: Position[] = [
      request.origin,
      ...(request.waypoints ?? []),
      request.destination,
    ].map((point) => [point.longitude, point.latitude]);
    let endpointAccessCounted = false;
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
          if (candidate) throw new ClosurePlacementError(state.rejected);
          reject(state.rejected);
          continue;
        }
        if (state.placed === undefined) {
          try {
            state.placed = await placeClosure(event, query, state.proximity, signal);
            if (state.placed.droppedEndEdges > 0)
              reject('partial-line-end', state.placed.droppedEndEdges);
          } catch (error: unknown) {
            signal.throwIfAborted();
            if (error instanceof ClosurePlacementError) state.rejected = error.reason;
            if (candidate) throw error;
            reject(error instanceof ClosurePlacementError ? error.reason : 'graph-error');
            continue;
          }
        }
        signal.throwIfAborted();
        const placed = state.placed;
        const barriers: PlacedBarrier[] = [];
        for (const barrier of placed.barriers) {
          const restricted = barrierForEndpoints(barrier, endpoints);
          if (restricted !== barrier && !endpointAccessCounted) {
            // Endpoint access is deliberately not a place-identifying rejection counter.
            counters.failedOpen += 1;
            endpointAccessCounted = true;
          }
          if (restricted !== undefined) barriers.push(restricted);
        }
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
        ...barriers.map((barrier) => barrier.exclusion),
        ...(requestOptions?.excludeLocations ?? []),
      ];
      if (exclusions.length > MAX_CLOSURE_EXCLUSIONS)
        throw new ClosureAvoidanceError('exclusion-limit');
      await validateClosureBarriers(barriers, query, signal);
      counters.exclusionsComputed += barriers.length;
      current = await getRoutes({ ...requestOptions, excludeLocations: exclusions, signal });
      signal.throwIfAborted();
      if (current.length === 0) throw new RouteNotFoundError();
      const clear = current.filter(
        (route) => !barriers.some((barrier) => routeCrossesBarrier(route.geometry, barrier)),
      );
      if (clear.length === 0) throw new ClosureAvoidanceError('exclusion-ignored');
      if (clear.length !== current.length)
        reject('exclusion-ignored', current.length - clear.length);
      current =
        clear.length === current.length
          ? current
          : applyFastestLabel(clear.sort(compareRouteAlternatives));
    }
    if (applied.size === 0) return { routes: baseline, closuresApplied: false };
    const fastestBefore = Math.min(...baseline.map((route) => route.durationSeconds));
    const fastestAfter = Math.min(...current.map((route) => route.durationSeconds));
    const large = fastestAfter - fastestBefore > 15 * 60 && fastestAfter > fastestBefore * 2;
    if (large && [...applied.values()].some((event) => !event.placed.verifiedLine))
      throw new ClosureAvoidanceError('large-point-detour');
    if (large) counters.largeLineDetours += 1;
    if (routesChanged(baseline, current)) counters.routesWouldChange += 1;
    return { routes: current, closuresApplied: true };
  }

  function recordFailure(error: unknown, signal: AbortSignal, candidate = false): void {
    if (candidate) counters.candidatesDeclined += 1;
    else counters.failedOpen += 1;
    if (error instanceof ClosurePlacementError) publicPlacements.clear();
    reject(
      signal.aborted
        ? 'timeout'
        : error instanceof RouteNotFoundError
          ? 'no-route'
          : error instanceof ClosurePlacementError || error instanceof ClosureAvoidanceError
            ? error.reason
            : 'provider-error',
    );
  }

  function shadow(
    request: RouteRequestV2,
    baseline: RouteAlternativeV2[],
    requestOptions: RouteProviderRequestOptions | undefined,
    getRoutes: (options?: RouteProviderRequestOptions) => Promise<RouteAlternativeV2[]>,
  ): void {
    if (shadowInFlight || shutdown?.signal.aborted) {
      counters.shadowSkipped += 1;
      return;
    }
    shadowInFlight = true;
    shadowStart = setImmediate(() => {
      shadowStart = undefined;
      const signal = workSignal(requestOptions);
      // Only the actual work's settlement frees the process slot, even if a provider ignores abort.
      void avoiding(request, baseline, requestOptions, signal, getRoutes)
        .catch((error: unknown) => {
          recordFailure(error, signal);
        })
        .finally(() => {
          shadowInFlight = false;
        });
    });
  }

  async function route(
    request: RouteRequestV2,
    requestOptions: RouteProviderRequestOptions | undefined,
    getRoutes: (options?: RouteProviderRequestOptions) => Promise<RouteAlternativeV2[]>,
  ): Promise<RouteAlternativeV2[]> {
    // The ordinary provider call and its errors are unchanged. Closure work cannot replace it.
    const baseline = await getRoutes(requestOptions);
    counters.requests += 1;
    if (mode === 'shadow') {
      shadow(request, baseline, requestOptions, getRoutes);
      return baseline;
    }
    const signal = workSignal(requestOptions);
    try {
      const result = await withinBudget(
        avoiding(request, baseline, requestOptions, signal, getRoutes),
        signal,
      );
      return result.routes;
    } catch (error: unknown) {
      recordFailure(error, signal);
      return baseline;
    }
  }

  async function getCandidateRoutes(
    request: RouteRequestV2,
    requestOptions?: RouteProviderRequestOptions,
  ): Promise<ClosureRouteCandidate | undefined> {
    const getRoutes = (upstreamOptions?: RouteProviderRequestOptions) =>
      enrichedRoutes === undefined
        ? routeProvider.getRoutes(request, upstreamOptions)
        : enrichedRoutes(request, upstreamOptions);
    let baseline: RouteAlternativeV2[];
    try {
      baseline = await getRoutes(requestOptions);
    } catch {
      counters.candidatesDeclined += 1;
      reject(requestOptions?.signal?.aborted ? 'timeout' : 'provider-error');
      return undefined;
    }
    counters.requests += 1;
    if (!enabled) return { routes: baseline, closuresApplied: false };
    if (mode === 'shadow') {
      shadow(request, baseline, requestOptions, getRoutes);
      return { routes: baseline, closuresApplied: false };
    }
    const signal = workSignal(requestOptions);
    try {
      return await withinBudget(
        avoiding(request, baseline, requestOptions, signal, getRoutes, true),
        signal,
      );
    } catch (error: unknown) {
      recordFailure(error, signal, true);
      return undefined;
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
    getCandidateRoutes,
    counters: snapshot,
    start() {
      if (!enabled || interval !== undefined || options.onCounters === undefined) return;
      interval = setInterval(() => options.onCounters?.(snapshot()), 60_000);
      interval.unref();
    },
    close() {
      clearInterval(interval);
      interval = undefined;
      if (shadowStart !== undefined) {
        clearImmediate(shadowStart);
        shadowStart = undefined;
        shadowInFlight = false;
      }
      shutdown?.abort();
      publicPlacements.clear();
    },
  };
}
