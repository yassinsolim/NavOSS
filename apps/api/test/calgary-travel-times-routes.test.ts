import { createHash } from 'node:crypto';

import {
  CALGARY_TRAVEL_TIMES_SOURCE_ID,
  RouteResponseV2Schema,
  type RouteAlternativeV2,
} from '@navoss/contracts';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fixtureValue } from '../../../packages/contracts/test/fixture-value.js';
import { buildApp, type BuildAppOptions } from '../src/app.js';
import type { CorridorTable } from '../src/calgary-travel-times/corridors.js';
import type { TravelTimesFeed } from '../src/calgary-travel-times/feed.js';
import type { CorridorPlacer } from '../src/calgary-travel-times/placement.js';
import {
  CALGARY_TRAVEL_TIMES_SOURCE,
  createCalgaryTravelTimesService,
  type CalgaryTravelTimesMode,
} from '../src/calgary-travel-times/service.js';
import { createFixtureSearchProvider } from '../src/search-provider.js';
import { haversineMeters, type Position } from '../src/traffic/geo.js';
import type { MatchedEdge } from '../src/traffic/map-matcher.js';
import { normalizeValhallaPbfResponse } from '../src/valhalla-pbf.js';
import calgary from './fixtures/valhalla/calgary-deerfoot-glenmore.json' with { type: 'json' };

const source = {
  attribution: 'Routing by Valhalla using OpenStreetMap data' as const,
  degraded: false,
  id: 'valhalla-self-hosted' as const,
  mode: 'production' as const,
  traffic: 'unavailable' as const,
};
const NOW = Date.parse('2026-11-27T16:00:00Z');
const SEGMENT = 'SB Deerfoot Tr: Test corridor';
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** The recorded Deerfoot/Glenmore route, and a clear alternative two minutes slower. */
function providerRoutes(): RouteAlternativeV2[] {
  const recorded = fixtureValue(normalizeValhallaPbfResponse(calgary.response)[0]);
  const shift = (positions: Position[]): Position[] =>
    positions.map(([longitude, latitude]) => [longitude, latitude + 0.02]);
  return [
    { ...recorded, label: 'fastest' },
    {
      ...recorded,
      durationSeconds: recorded.durationSeconds + 120,
      geometry: shift(recorded.geometry),
      id: 'clear-alternative',
      label: 'alternative',
      steps: recorded.steps.map((step) => ({
        ...step,
        durationSeconds: step.durationSeconds + 120 / recorded.steps.length,
        geometry: shift(step.geometry),
      })),
    },
  ];
}

/** One directed graph edge per geometry segment; the id is derived from the segment itself. */
function edgeId(from: Position, to: Position): number {
  return Number.parseInt(
    createHash('sha256')
      .update(JSON.stringify([from, to]))
      .digest('hex')
      .slice(0, 12),
    16,
  );
}
function walk(geometry: readonly Position[]): MatchedEdge[] {
  return geometry.slice(1).map((to, index) => {
    const from = geometry[index] ?? to;
    return {
      beginShapeIndex: index,
      endShapeIndex: index + 1,
      forward: true,
      fromFraction: 0,
      graphId: edgeId(from, to),
      lengthMeters: haversineMeters(from, to),
      line: [from, to],
      roadClass: 'motorway',
      speedKph: 100,
      toFraction: 1,
      use: 'road',
      wayId: 1,
    };
  });
}

/** The table, placement and feed of one corridor on the first 60 % of the recommended route. */
function fakes(liveMinutes = 15) {
  const routes = providerRoutes();
  const jammed = fixtureValue(routes[0]);
  // The corridor is the first 60 % of the recommended route's geometry.
  const corridorGeometry = jammed.geometry.slice(0, Math.floor(jammed.geometry.length * 0.6));
  const corridorEdges = walk(corridorGeometry);
  const lengthMeters = corridorEdges.reduce((sum, edge) => sum + edge.lengthMeters, 0);
  const [start = [0, 0]] = corridorGeometry;
  const end = corridorGeometry.at(-1) ?? start;
  const table: CorridorTable = {
    baselines: { method: 'test', recordedFrom: null, recordedTo: null, snapshots: 0 },
    corridors: [
      {
        anchors: [
          { headingDegrees: 180, latitude: start[1], longitude: start[0] },
          { headingDegrees: 180, latitude: end[1], longitude: end[0] },
        ],
        baselineMinutes: 8,
        expectedMeters: Math.round(lengthMeters),
        roads: ['Deerfoot Trail'],
        segment: SEGMENT,
      },
    ],
    format: 'navoss-calgary-travel-times-corridors',
    formatVersion: 1,
    leftOut: [],
  };
  const placer: CorridorPlacer = {
    place: () =>
      Promise.resolve({
        corridor: {
          lengthMeters,
          pieces: corridorEdges.map((edge) => ({
            edgeMeters: edge.lengthMeters,
            fromFraction: 0,
            graphId: edge.graphId ?? 0,
            toFraction: 1,
          })),
          segment: SEGMENT,
        },
        lengthMeters,
        roadShare: 1,
        status: 'placed',
      }),
  };
  const feed: TravelTimesFeed = {
    counters: () => ({
      fetchFailures: 0,
      fetches: 1,
      malformedRows: 0,
      notModified: 0,
      rejectedAnswers: 0,
    }),
    refresh: () => Promise.resolve(),
    snapshot: () => ({
      fetchedAtMs: NOW,
      rows: new Map([
        [SEGMENT, { lastUpdateMs: Date.parse('2026-11-27T15:50:00Z'), minutes: liveMinutes }],
        ['A label the City added later', { lastUpdateMs: NOW, minutes: 3 }],
      ]),
    }),
    start: () => undefined,
    stop: () => undefined,
  };
  const walkRoute = vi.fn((geometry: readonly Position[]) => Promise.resolve(walk(geometry)));
  return { feed, placer, routes, table, walkRoute };
}

async function setup(
  mode: CalgaryTravelTimesMode | undefined,
  options: { liveMinutes?: number; overrides?: Partial<BuildAppOptions> } = {},
) {
  const { feed, placer, routes, table, walkRoute } = fakes(options.liveMinutes);
  const service =
    mode === undefined
      ? undefined
      : createCalgaryTravelTimesService({
          clock: () => NOW,
          feed,
          graphVersion: () => Promise.resolve('graph-1'),
          mapMatcher: { walkRoute },
          mode,
          placer,
          table,
        });
  const app = await buildApp({
    ...(service === undefined ? {} : { calgaryTravelTimes: service }),
    clock: () => new Date(NOW),
    communityReports: null,
    routeProvider: {
      getEnrichedRoutes: () => Promise.resolve(providerRoutes()),
      getRoutes: () => Promise.resolve([]),
      source,
    },
    searchProvider: createFixtureSearchProvider(),
    ...options.overrides,
  });
  apps.push(app);
  if (service !== undefined && mode !== 'off') {
    await vi.waitFor(() => {
      expect(service.metrics().corridorsPlaced).toBe(1);
    });
  }
  return { app, routes, service, walkRoute };
}

async function post(app: FastifyInstance, trafficSources?: string[], alternatives?: number) {
  const response = await app.inject({
    method: 'POST',
    payload: {
      ...calgary.request,
      ...(alternatives === undefined ? {} : { alternatives }),
      ...(trafficSources === undefined ? {} : { trafficSources }),
    },
    url: '/v2/routes',
  });
  expect(response.statusCode).toBe(200);
  return response.json<unknown>();
}

describe('City of Calgary travel times on /v2/routes', () => {
  it('with the mode off the API answers exactly as without the feature, declared or not', async () => {
    const { app: without } = await setup(undefined);
    const { app: off, walkRoute } = await setup('off');
    const expected = await post(without);
    expect(await post(off)).toEqual(expected);
    expect(await post(off, [CALGARY_TRAVEL_TIMES_SOURCE_ID])).toEqual(expected);
    expect(walkRoute).not.toHaveBeenCalled();
  });

  it('live without the declaration answers exactly as today', async () => {
    const { app: without } = await setup(undefined);
    const { app: live, walkRoute } = await setup('live');
    const expected = await post(without);
    expect(await post(live)).toEqual(expected);
    expect(await post(live, ['a-source-from-2027'])).toEqual(expected);
    expect(walkRoute).not.toHaveBeenCalled();
  });

  it('live with the declaration and a jam applies the City delay and re-ranks', async () => {
    const { app, routes } = await setup('live');
    const body = RouteResponseV2Schema.parse(await post(app, [CALGARY_TRAVEL_TIMES_SOURCE_ID]));
    const jammed = fixtureValue(routes[0]);
    const clear = fixtureValue(routes[1]);
    expect(body.source).toEqual({
      attribution: source.attribution,
      id: source.id,
      mode: source.mode,
      traffic: 'live',
      trafficSource: CALGARY_TRAVEL_TIMES_SOURCE,
    });
    // The clear alternative was two minutes slower; with 15 - 8 - 1 = 6 minutes it now leads.
    expect(body.routes.map((route) => route.id)).toEqual([clear.id, jammed.id]);
    expect(body.routes.map((route) => route.label)).toEqual(['fastest', 'alternative']);
    const delayed = fixtureValue(body.routes[1]);
    expect(delayed.traffic?.delaySeconds).toBeCloseTo(360, 0);
    expect(delayed.durationSeconds).toBeCloseTo(jammed.durationSeconds + 360, 0);
    expect(delayed.traffic?.typicalDurationSeconds).toBe(jammed.durationSeconds);
    expect(delayed.traffic?.observedFraction).toBeGreaterThan(0.4);
    expect(delayed.traffic?.snapshotAt).toBe('2026-11-27T15:50:00.000Z');
    const stepSum = delayed.steps.reduce((sum, step) => sum + step.durationSeconds, 0);
    const baseSum = jammed.steps.reduce((sum, step) => sum + step.durationSeconds, 0);
    expect(stepSum - baseSum).toBeCloseTo(360, 0);
    expect(delayed.congestion?.some((level) => level !== 'free' && level !== 'unknown')).toBe(true);
    // The clear route never touches the corridor and stays unannotated.
    expect(body.routes[0]?.traffic).toBeUndefined();
  });

  it('live with the declaration and clear corridors annotates zero delay and keeps the order', async () => {
    const { app, routes } = await setup('live', { liveMinutes: 9 });
    const body = RouteResponseV2Schema.parse(await post(app, [CALGARY_TRAVEL_TIMES_SOURCE_ID]));
    expect(body.routes.map((route) => route.id)).toEqual(routes.map((route) => route.id));
    expect(body.routes[0]?.traffic?.delaySeconds).toBe(0);
    expect(body.routes[0]?.durationSeconds).toBe(routes[0]?.durationSeconds);
  });

  it('shadow evaluates and counts but leaves every response untouched', async () => {
    const { app: without } = await setup(undefined);
    const { app, service } = await setup('shadow');
    const expected = await post(without);
    expect(await post(app, [CALGARY_TRAVEL_TIMES_SOURCE_ID])).toEqual(expected);
    await vi.waitFor(() => {
      expect(service?.metrics()).toMatchObject({
        ordersChanged: 1,
        routesEvaluated: 2,
        routesWithDelay: 1,
        unknownSegments: 1,
      });
    });
  });

  it('never applies together with community traffic, which wins when it adjusted anything', async () => {
    const community = {
      attribution: 'Traffic from opted-in NavOSS drivers' as const,
      id: 'navoss-community' as const,
    };
    const { app, walkRoute } = await setup('live', {
      overrides: {
        enrichRoutes: (routes) => ({
          routes: routes.map((route) => ({
            ...route,
            congestion: route.geometry.slice(1).map(() => 'free' as const),
            traffic: {
              delaySeconds: 0,
              observedFraction: 1,
              typicalDurationSeconds: route.durationSeconds,
            },
          })),
          trafficSource: community,
        }),
      },
    });
    const body = RouteResponseV2Schema.parse(await post(app, [CALGARY_TRAVEL_TIMES_SOURCE_ID]));
    expect(body.source.trafficSource).toEqual(community);
    expect(walkRoute).not.toHaveBeenCalled();
  });

  describe('avoid candidate', () => {
    function avoidingProvider(failing = false) {
      const [jammed, clear] = providerRoutes();
      const getEnrichedRoutes = vi.fn(
        (_request: unknown, options?: { excludeLocations?: readonly unknown[] }) =>
          options?.excludeLocations === undefined
            ? Promise.resolve([fixtureValue(jammed)])
            : failing
              ? Promise.reject(new Error('timed out'))
              : Promise.resolve([{ ...fixtureValue(clear), label: 'fastest' as const }]),
      );
      return {
        getEnrichedRoutes,
        routeProvider: { getEnrichedRoutes, getRoutes: () => Promise.resolve([]), source },
      };
    }

    it('asks once for a route around the delayed stretch and offers it when faster with traffic', async () => {
      const { getEnrichedRoutes, routeProvider } = avoidingProvider();
      const { app, routes } = await setup('live', { overrides: { routeProvider } });
      const body = RouteResponseV2Schema.parse(
        await post(app, [CALGARY_TRAVEL_TIMES_SOURCE_ID], 1),
      );
      expect(getEnrichedRoutes).toHaveBeenCalledTimes(2);
      const exclusions = (getEnrichedRoutes.mock.calls[1]?.[1]?.excludeLocations ?? []) as {
        heading?: number;
        heading_tolerance?: number;
        node_snap_tolerance?: number;
      }[];
      expect(exclusions.length).toBeGreaterThan(0);
      for (const exclusion of exclusions) {
        expect(typeof exclusion.heading).toBe('number');
        expect(exclusion.heading_tolerance).toBe(30);
        // Valhalla's default (5 m) would snap a point near a fork to the node and exclude the
        // clear exit with the delayed carriageway.
        expect(exclusion.node_snap_tolerance).toBe(0);
      }
      expect(body.routes.map((route) => route.id)).toEqual([routes[1]?.id, routes[0]?.id]);
      expect(body.routes[0]?.label).toBe('fastest');
      expect(body.routes[1]?.traffic?.delaySeconds).toBeCloseTo(360, 0);
    });

    it('keeps within the routes the client asked for', async () => {
      const { routeProvider } = avoidingProvider();
      const { app, routes } = await setup('live', { overrides: { routeProvider } });
      const response = await app.inject({
        method: 'POST',
        payload: {
          ...calgary.request,
          alternatives: 0,
          trafficSources: [CALGARY_TRAVEL_TIMES_SOURCE_ID],
        },
        url: '/v2/routes',
      });
      const body = RouteResponseV2Schema.parse(response.json());
      expect(body.routes.map((route) => route.id)).toEqual([routes[1]?.id]);
    });

    it('ignores a failed avoid request and answers with the delayed route', async () => {
      const { routeProvider } = avoidingProvider(true);
      const { app, routes, service } = await setup('live', { overrides: { routeProvider } });
      const body = RouteResponseV2Schema.parse(await post(app, [CALGARY_TRAVEL_TIMES_SOURCE_ID]));
      expect(body.routes.map((route) => route.id)).toEqual([routes[0]?.id]);
      expect(body.routes[0]?.traffic?.delaySeconds).toBeCloseTo(360, 0);
      expect(service?.metrics().avoidFailures).toBe(1);
    });

    it('does not ask when the delay is below the threshold', async () => {
      const { getEnrichedRoutes, routeProvider } = avoidingProvider();
      // 10 - 8 - 1 = 1 minute of delay.
      const { app } = await setup('live', { liveMinutes: 10, overrides: { routeProvider } });
      await post(app, [CALGARY_TRAVEL_TIMES_SOURCE_ID]);
      expect(getEnrichedRoutes).toHaveBeenCalledTimes(1);
    });
  });

  describe('graph replacement', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('applies no City traffic from the moment the graph changes until it is placed again', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const { feed, placer, routes, table, walkRoute } = fakes();
      let graph = 'graph-1';
      let finishPlacement: ((failed: boolean) => void) | undefined;
      const service = createCalgaryTravelTimesService({
        clock: () => NOW,
        feed,
        graphVersion: () => Promise.resolve(graph),
        mapMatcher: { walkRoute },
        mode: 'live',
        placer: {
          place: (definition) =>
            graph === 'graph-1'
              ? placer.place(definition)
              : new Promise((resolve) => {
                  finishPlacement = (failed) => {
                    resolve(
                      failed ? { reason: 'roads', status: 'failed' } : placer.place(definition),
                    );
                  };
                }),
        },
        table,
      });
      const declared = { trafficSources: [CALGARY_TRAVEL_TIMES_SOURCE_ID] };
      service.start();
      await vi.waitFor(() => {
        expect(service.metrics().corridorsPlaced).toBe(1);
      });
      expect(await service.enrich(routes, declared)).toBeDefined();

      // The new graph reuses the same edge ids for other roads (the fake walk is unchanged).
      graph = 'graph-2';
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(finishPlacement).toBeDefined();
      expect(await service.enrich(routes, declared)).toBeUndefined();

      // Placement on the new graph fails: still nothing, for good.
      finishPlacement?.(true);
      await vi.waitFor(() => {
        expect(service.metrics().corridorsOff).toEqual({ roads: 1 });
      });
      expect(await service.enrich(routes, declared)).toBeUndefined();
      expect(service.metrics().corridorsPlaced).toBe(0);
      service.close();
    });

    it('drops an evaluation that started on a graph replaced while it ran', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const { feed, placer, routes, table } = fakes();
      let graph = 'graph-1';
      let walking = false;
      let open: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const service = createCalgaryTravelTimesService({
        clock: () => NOW,
        feed,
        graphVersion: () => Promise.resolve(graph),
        mapMatcher: {
          walkRoute: async (geometry) => {
            walking = true;
            await gate;
            return walk(geometry);
          },
        },
        mode: 'live',
        placer,
        table,
      });
      service.start();
      await vi.waitFor(() => {
        expect(service.metrics().corridorsPlaced).toBe(1);
      });
      const pending = service.enrich(routes, {
        trafficSources: [CALGARY_TRAVEL_TIMES_SOURCE_ID],
      });
      await vi.waitFor(() => {
        expect(walking).toBe(true);
      });
      graph = 'graph-2';
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      open?.();
      expect(await pending).toBeUndefined();
      service.close();
    });
  });

  describe('one slot for observation and avoid work', () => {
    function gatedService(mode: 'live' | 'shadow') {
      const { feed, placer, routes, table } = fakes();
      let open: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const walkRoute = vi.fn(async (geometry: readonly Position[]) => {
        await gate;
        return walk(geometry);
      });
      const service = createCalgaryTravelTimesService({
        clock: () => NOW,
        feed,
        graphVersion: () => Promise.resolve('graph-1'),
        mapMatcher: { walkRoute },
        mode,
        placer,
        table,
      });
      return { open: () => open?.(), routes, service, walkRoute };
    }
    const declared = { trafficSources: [CALGARY_TRAVEL_TIMES_SOURCE_ID] };

    it('shadow skips, and counts, a request arriving while an evaluation is in flight', async () => {
      const { open, routes, service, walkRoute } = gatedService('shadow');
      service.start();
      await vi.waitFor(() => {
        expect(service.metrics().corridorsPlaced).toBe(1);
      });
      expect(await service.enrich(routes, declared)).toBeUndefined();
      expect(await service.enrich(routes, declared)).toBeUndefined();
      expect(service.metrics().shadowSkipped).toBe(1);
      open();
      await vi.waitFor(() => {
        expect(service.metrics().routesEvaluated).toBe(2);
      });
      expect(walkRoute).toHaveBeenCalledTimes(2);
      service.close();
    });

    it('shadow gives Valhalla to a route request that begins during its evaluation', async () => {
      const { open, routes, service, walkRoute } = gatedService('shadow');
      service.start();
      await vi.waitFor(() => {
        expect(service.metrics().corridorsPlaced).toBe(1);
      });
      const first = service.beginRequest();
      expect(await service.enrich(routes, declared)).toBeUndefined();
      first();
      const second = service.beginRequest();
      open();
      await vi.waitFor(() => {
        expect(service.metrics().shadowYielded).toBe(1);
      });
      second();
      // The first walk had started; the second never did.
      expect(walkRoute).toHaveBeenCalledTimes(1);
      expect(service.metrics().routesEvaluated).toBe(0);
      service.close();
    });

    it('live asks for at most one avoid candidate at a time, skipping and counting the rest', async () => {
      const { feed, placer, routes, table } = fakes();
      const service = createCalgaryTravelTimesService({
        clock: () => NOW,
        feed,
        graphVersion: () => Promise.resolve('graph-1'),
        mapMatcher: { walkRoute: (geometry) => Promise.resolve(walk(geometry)) },
        mode: 'live',
        placer,
        table,
      });
      service.start();
      await vi.waitFor(() => {
        expect(service.metrics().corridorsPlaced).toBe(1);
      });
      let answer: (() => void) | undefined;
      const avoid = vi.fn(
        () =>
          new Promise<RouteAlternativeV2[]>((resolve) => {
            answer = () => {
              resolve([]);
            };
          }),
      );
      const jammedOnly = [fixtureValue(routes[0])];
      const first = service.enrich(jammedOnly, declared, avoid);
      await vi.waitFor(() => {
        expect(avoid).toHaveBeenCalledTimes(1);
      });
      const second = await service.enrich(jammedOnly, declared, avoid);
      expect(second?.routes[0]?.traffic?.delaySeconds).toBeCloseTo(360, 0);
      expect(avoid).toHaveBeenCalledTimes(1);
      expect(service.metrics().avoidSkipped).toBe(1);
      answer?.();
      expect((await first)?.routes).toHaveLength(1);
      service.close();
    });
  });
});
