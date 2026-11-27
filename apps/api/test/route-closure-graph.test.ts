import type { RouteProvider } from '../src/route-provider.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

import { fixtureValue } from '../../../packages/contracts/test/fixture-value.js';
import { selectClosureEvents } from '../src/route-closures/events.js';
import {
  ClosurePlacementError,
  ClosureProximity,
  placeClosure,
  routeCrossesBarrier,
  validateClosureBarriers,
} from '../src/route-closures/graph.js';
import {
  createClosureRouting,
  routeClosureModeFromEnvironment,
  type ClosureRoutingCounters,
} from '../src/route-closures/index.js';
import {
  closureFixture,
  recordedClosureProvider,
  recordedClosureSources,
} from './support/closure-routing-fixture.js';

const pointCase = fixtureValue(
  closureFixture.cases.find((example) => example.name === 'drivebc-mckay-point-current'),
);
const jingle = fixtureValue(
  closureFixture.cases.find((example) => example.name === 'nanaimo-jingle-pot-current'),
);
type GraphQuery = NonNullable<RouteProvider['getClosureGraph']>;
const EdgeRowsSchema = z.array(z.object({ edges: z.array(z.unknown()).nullable().optional() }));
const TraceViewSchema = z.object({
  units: z.string(),
  shape: z.string(),
  edges: z.array(z.unknown()),
  matched_points: z.array(z.object({ distance_from_trace_point: z.number() })),
});
afterEach(() => vi.useRealTimers());

describe('closure graph placement from real 3.8.2 responses', () => {
  it('rejects the actual published bridge point that snaps to 128 Avenue rather than 15 Street Bridge', async () => {
    const replay = recordedClosureProvider();
    const query = fixtureValue(replay.provider.getClosureGraph?.bind(replay.provider));
    const event = closureFixture.mismatch.event;
    await expect(
      placeClosure(event, query, new ClosureProximity(event.geometry), AbortSignal.timeout(2_500)),
    ).rejects.toMatchObject({ reason: 'road-name-mismatch' });
  });

  it('excludes only the requested direction and leaves the measured reverse route untouched', async () => {
    const replay = recordedClosureProvider();
    const query = fixtureValue(replay.provider.getClosureGraph?.bind(replay.provider));
    const event = closureFixture.boundaries.direction.event;
    const placed = await placeClosure(
      event,
      query,
      new ClosureProximity(event.geometry),
      AbortSignal.timeout(2_500),
    );
    const barrier = fixtureValue(placed.barriers[0]);
    const forward = fixtureValue(closureFixture.boundaries.direction.routes[0]);
    const reverse = fixtureValue(closureFixture.boundaries.direction.routes[1]);
    expect(routeCrossesBarrier(fixtureValue(forward.before[0]).geometry, barrier)).toBe(true);
    expect(routeCrossesBarrier(fixtureValue(forward.after[0]).geometry, barrier)).toBe(false);
    expect(routeCrossesBarrier(fixtureValue(reverse.before[0]).geometry, barrier)).toBe(false);
    expect(reverse.after).toEqual(reverse.before);
    expect(barrier.exclusion.heading_tolerance).toBe(5);
  });

  it('does not pretend a both-direction source was covered when only one carriageway can be confirmed', async () => {
    const replay = recordedClosureProvider();
    const original = fixtureValue(replay.provider.getClosureGraph?.bind(replay.provider));
    const query: GraphQuery = async (action, body, signal) => {
      const rows = EdgeRowsSchema.parse(await original(action, body, signal));
      return rows.map((row) => ({ edges: row.edges?.slice(0, 1) }));
    };
    const event = { ...closureFixture.boundaries.direction.event, direction: 'both' as const };
    await expect(
      placeClosure(event, query, new ClosureProximity(event.geometry), AbortSignal.timeout(2_500)),
    ).rejects.toMatchObject({ reason: 'direction-not-placeable' });
  });

  it('rechecks cached public placement before use and rejects a replaced graph with no matching edge', async () => {
    const replay = recordedClosureProvider();
    const query = fixtureValue(replay.provider.getClosureGraph?.bind(replay.provider));
    const event = closureFixture.boundaries.direction.event;
    const placed = await placeClosure(
      event,
      query,
      new ClosureProximity(event.geometry),
      AbortSignal.timeout(2_500),
    );
    await expect(
      validateClosureBarriers(placed.barriers, query, AbortSignal.timeout(2_500)),
    ).resolves.toBeUndefined();
    const replaced: GraphQuery = () => Promise.resolve([{ edges: [] }]);
    await expect(
      validateClosureBarriers(placed.barriers, replaced, AbortSignal.timeout(2_500)),
    ).rejects.toBeInstanceOf(ClosurePlacementError);
  });

  it('places all 17 affected graph sections of the current Pavilion source line without a polygon', async () => {
    const sources = recordedClosureSources(() => jingle.now);
    await sources.ready();
    const selected = selectClosureEvents(await sources.service.getRoutingSnapshots(), jingle.now);
    const event = fixtureValue(
      selected.events.find((item) => item.roadNames.includes('Pavilion Road')),
    );
    const replay = recordedClosureProvider();
    const query = fixtureValue(replay.provider.getClosureGraph?.bind(replay.provider));
    const placed = await placeClosure(
      event,
      query,
      new ClosureProximity(event.geometry),
      AbortSignal.timeout(2_500),
    );
    expect(placed.verifiedLine).toBe(true);
    expect(placed.barriers).toHaveLength(17);
    expect(placed.barriers.every((barrier) => barrier.exclusion.search_cutoff === 1)).toBe(true);
  });

  it('rejects a line match whose source vertices are not within the measured geometry tolerance', async () => {
    const sources = recordedClosureSources(() => jingle.now);
    await sources.ready();
    const event = fixtureValue(
      selectClosureEvents(await sources.service.getRoutingSnapshots(), jingle.now).events.find(
        (item) => item.roadNames.includes('Jingle Pot Road'),
      ),
    );
    const replay = recordedClosureProvider();
    const original = fixtureValue(replay.provider.getClosureGraph?.bind(replay.provider));
    const query: GraphQuery = async (action, body, signal) => {
      const value = await original(action, body, signal);
      if (action !== 'trace_attributes') return value;
      const trace = TraceViewSchema.parse(value);
      return {
        ...trace,
        matched_points: trace.matched_points.map((point) => ({
          ...point,
          distance_from_trace_point: 100,
        })),
      };
    };
    await expect(
      placeClosure(event, query, new ClosureProximity(event.geometry), AbortSignal.timeout(2_500)),
    ).rejects.toMatchObject({ reason: 'geometry-mismatch' });
  });

  it('rejects the complete event rather than silently truncating an over-limit exclusion set', async () => {
    const sources = recordedClosureSources(() => jingle.now);
    await sources.ready();
    const event = fixtureValue(
      selectClosureEvents(await sources.service.getRoutingSnapshots(), jingle.now).events.find(
        (item) => item.roadNames.includes('Jingle Pot Road'),
      ),
    );
    const replay = recordedClosureProvider();
    const original = fixtureValue(replay.provider.getClosureGraph?.bind(replay.provider));
    const query: GraphQuery = async (action, body, signal) => {
      const value = await original(action, body, signal);
      if (action !== 'trace_attributes') return value;
      const trace = TraceViewSchema.parse(value);
      return { ...trace, edges: Array.from({ length: 51 }, () => fixtureValue(trace.edges[0])) };
    };
    await expect(
      placeClosure(event, query, new ClosureProximity(event.geometry), AbortSignal.timeout(2_500)),
    ).rejects.toMatchObject({ reason: 'exclusion-limit' });
  });
});

describe('closure routing consistency, budgets and aggregate-only observation', () => {
  it('keeps the exact provider object off and never wraps the licensed Mapbox path', () => {
    const replay = recordedClosureProvider();
    const sources = recordedClosureSources(() => pointCase.now);
    const off = createClosureRouting(replay.provider, sources.service, { mode: 'off' });
    expect(off.provider).toBe(replay.provider);
    off.close();
    const mapbox: RouteProvider = {
      ...replay.provider,
      source: {
        attribution: 'Routing and traffic by Mapbox',
        degraded: false,
        id: 'mapbox-traffic',
        mode: 'production',
        traffic: 'live',
      },
    };
    const configured = createClosureRouting(mapbox, sources.service, { mode: 'on' });
    expect(configured.provider).toBe(mapbox);
    expect(configured.counters().rejected['unsupported-provider']).toBe(1);
    expect(sources.bcFetch).not.toHaveBeenCalled();
    configured.close();
  });

  it('uses the same rules for repeat calls and reports changed routes while shadow returns both original answers', async () => {
    const replay = recordedClosureProvider();
    const sources = recordedClosureSources(() => pointCase.now);
    await sources.ready();
    const routing = createClosureRouting(replay.provider, sources.service, {
      mode: 'shadow',
      clock: () => pointCase.now,
    });
    const get = fixtureValue(routing.provider.getEnrichedRoutes?.bind(routing.provider));
    expect(await get(pointCase.request)).toEqual(pointCase.before);
    await vi.waitFor(() => {
      expect(routing.counters().routesWouldChange).toBe(1);
    });
    expect(await get(pointCase.request)).toEqual(pointCase.before);
    await vi.waitFor(() => {
      expect(routing.counters().routesWouldChange).toBe(2);
    });
    expect(routing.counters()).toMatchObject({
      requests: 2,
      requestsNearClosures: 2,
      routesWouldChange: 2,
      failedOpen: 0,
    });
    expect(sources.cityFetch).toHaveBeenCalledTimes(2); // One data GET and one metadata GET, not two pollers.
    expect(sources.bcFetch).toHaveBeenCalledOnce();
    routing.close();
  });

  it('aborts the avoiding computation at its total deadline and returns the already held route', async () => {
    const replay = recordedClosureProvider({ failure: 'timeout' });
    const sources = recordedClosureSources(() => pointCase.now);
    await sources.ready();
    const routing = createClosureRouting(replay.provider, sources.service, {
      mode: 'on',
      clock: () => pointCase.now,
      timeoutMs: 10,
    });
    const get = fixtureValue(routing.provider.getEnrichedRoutes?.bind(routing.provider));
    expect(await get(pointCase.request)).toEqual(pointCase.before);
    expect(routing.counters()).toMatchObject({ failedOpen: 1, rejected: { timeout: 1 } });
    routing.close();
  });

  it('emits real aggregate counters without coordinates, event identities or route/request records', async () => {
    vi.useFakeTimers();
    const observed: ClosureRoutingCounters[] = [];
    const replay = recordedClosureProvider();
    const sources = recordedClosureSources(() => pointCase.now);
    await sources.ready();
    const routing = createClosureRouting(replay.provider, sources.service, {
      mode: 'shadow',
      clock: () => pointCase.now,
      onCounters: (counters) => {
        observed.push(counters);
      },
    });
    routing.start();
    const get = fixtureValue(routing.provider.getEnrichedRoutes?.bind(routing.provider));
    await get(pointCase.request);
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(60_000);
    expect(observed).toHaveLength(1);
    const values = fixtureValue(observed[0]);
    expect(values.routesWouldChange).toBe(1);
    const { rejected, ...totals } = values;
    expect(Object.values(totals).every((count) => Number.isInteger(count))).toBe(true);
    expect(Object.values(rejected).every((count) => typeof count === 'number')).toBe(true);
    const encoded = JSON.stringify(values);
    expect(encoded).not.toContain('calgary-construction:');
    expect(encoded).not.toContain('drivebc-open511:');
    expect(encoded).not.toContain('-114.');
    expect(encoded).not.toContain('requestId');
    routing.close();
  });

  it('requires an explicit valid switch value and fails open for unknown configuration', () => {
    expect(routeClosureModeFromEnvironment({})).toBe('off');
    expect(routeClosureModeFromEnvironment({ ROUTE_AVOID_CLOSURES: 'unknown' })).toBe('off');
    expect(routeClosureModeFromEnvironment({ ROUTE_AVOID_CLOSURES: 'shadow' })).toBe('shadow');
    expect(routeClosureModeFromEnvironment({ ROUTE_AVOID_CLOSURES: 'on' })).toBe('on');
  });
});
