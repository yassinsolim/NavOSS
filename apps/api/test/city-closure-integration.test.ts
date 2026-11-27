import { createHash } from 'node:crypto';

import {
  CALGARY_TRAVEL_TIMES_SOURCE_ID,
  createServiceCoverage,
  RouteResponseV2Schema,
  type RouteAlternativeV2,
} from '@navoss/contracts';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fixtureValue } from '../../../packages/contracts/test/fixture-value.js';
import { buildApp } from '../src/app.js';
import type { CorridorTable } from '../src/calgary-travel-times/corridors.js';
import type { TravelTimesFeed } from '../src/calgary-travel-times/feed.js';
import type { CorridorPlacer } from '../src/calgary-travel-times/placement.js';
import {
  CALGARY_TRAVEL_TIMES_SOURCE,
  createCalgaryTravelTimesService,
} from '../src/calgary-travel-times/service.js';
import type { RouteProvider } from '../src/route-provider.js';
import { createFixtureSearchProvider } from '../src/search-provider.js';
import { haversineMeters, type Position } from '../src/traffic/geo.js';
import type { MatchedEdge } from '../src/traffic/map-matcher.js';
import official from './fixtures/road-events/official-closures-2026-11-27.json' with { type: 'json' };
import {
  closureFixture,
  recordedClosureProvider,
  recordedClosureSources,
} from './support/closure-routing-fixture.js';

// The Jingle Pot routes, closure line and graph are recorded public fixtures. The City corridor,
// reading and shifted alternatives are synthetic, not claims about BC traffic.
const jingle = fixtureValue(
  closureFixture.cases.find((example) => example.name === 'nanaimo-jingle-pot-current'),
);
const closureLine = fixtureValue(
  official.driveBc.rows.find((row) => row.id === 'drivebc.ca/RIDE-108168'),
);
const NOW = jingle.now;
const READING_AT = NOW - 10 * 60_000;
const SEGMENT = 'Synthetic integration corridor';
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllEnvs();
});

/** Stable test-only graph edges shared by the placed corridor and the route walk. */
function walk(geometry: readonly Position[]): MatchedEdge[] {
  return geometry.slice(1).map((to, index) => {
    const from = fixtureValue(geometry[index]);
    const graphId = Number.parseInt(
      createHash('sha256')
        .update(JSON.stringify([from, to]))
        .digest('hex')
        .slice(0, 12),
      16,
    );
    return {
      beginShapeIndex: index,
      endShapeIndex: index + 1,
      forward: true,
      fromFraction: 0,
      graphId,
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

function route(id: string, geometry: Position[], durationSeconds: number): RouteAlternativeV2 {
  const distanceMeters = walk(geometry).reduce((sum, edge) => sum + edge.lengthMeters, 0);
  return {
    id,
    label: 'fastest',
    geometry,
    distanceMeters,
    durationSeconds,
    steps: [
      {
        distanceMeters,
        durationSeconds,
        geometry,
        instruction: 'Follow the fixture route.',
        maneuverType: 'depart',
        roadName: '',
      },
    ],
  };
}

function scenarioRoutes() {
  const detour = fixtureValue(jingle.after[0]);
  const closed = fixtureValue(jingle.before[0]);
  // Keep the recorded endpoints, but make a distinct alternative after the jammed corridor.
  const otherGeometry = detour.geometry.map(([lon, lat], index): Position =>
    index === detour.geometry.length - 2 ? [lon, lat + 0.0001] : [lon, lat],
  );
  // Shift only the middle, far from Jingle Pot; preserve the recorded closure-clear approaches.
  const clearGeometry = detour.geometry.map(([lon, lat], index): Position => {
    const shift = Math.max(0, Math.min(1, (index - 50) / 20, (220 - index) / 20));
    return [lon, lat - 0.02 * shift];
  });
  return {
    original: route('jammed-original', detour.geometry, detour.durationSeconds),
    alternative: route('jammed-alternative', otherGeometry, detour.durationSeconds + 60),
    unsafe: route('closed-candidate', closed.geometry, closed.durationSeconds),
    clear: route('clear-candidate', clearGeometry, 950),
  };
}

function cityService(original: RouteAlternativeV2) {
  // The actual recorded detour is 13 km / 18 min, so six minutes survives the delay cap.
  const corridor = original.geometry.slice(75, 180);
  const edges = walk(corridor);
  const lengthMeters = edges.reduce((sum, edge) => sum + edge.lengthMeters, 0);
  const start = fixtureValue(corridor[0]);
  const end = fixtureValue(corridor.at(-1));
  const table: CorridorTable = {
    baselines: { method: 'test', recordedFrom: null, recordedTo: null, snapshots: 0 },
    corridors: [
      {
        anchors: [
          { headingDegrees: 0, latitude: start[1], longitude: start[0] },
          { headingDegrees: 0, latitude: end[1], longitude: end[0] },
        ],
        baselineMinutes: 8,
        expectedMeters: Math.round(lengthMeters),
        roads: ['Synthetic corridor'],
        segment: SEGMENT,
      },
    ],
    format: 'navoss-calgary-travel-times-corridors',
    formatVersion: 1,
    leftOut: [],
  };
  const placementPublished = Promise.withResolvers<void>();
  const placer: CorridorPlacer = {
    place: () => {
      const result = Promise.resolve({
        corridor: {
          lengthMeters,
          pieces: edges.map((edge) => ({
            edgeMeters: edge.lengthMeters,
            fromFraction: 0,
            graphId: fixtureValue(edge.graphId),
            toFraction: 1,
          })),
          segment: SEGMENT,
        },
        lengthMeters,
        roadShare: 1,
        status: 'placed' as const,
      });
      // Queue the barrier after the service's await continuation publishes this one corridor.
      void result.then(() => queueMicrotask(() => placementPublished.resolve()));
      return result;
    },
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
      rows: new Map([[SEGMENT, { lastUpdateMs: READING_AT, minutes: 15 }]]),
    }),
    start: () => undefined,
    stop: () => undefined,
  };
  const service = createCalgaryTravelTimesService({
    clock: () => NOW,
    feed,
    graphVersion: () => Promise.resolve('fixture-graph'),
    mapMatcher: { walkRoute: (geometry) => Promise.resolve(walk(geometry)) },
    mode: 'live',
    placer,
    table,
  });
  return { service, placementPublished: placementPublished.promise };
}

async function setup(ignoreClosureExclusion: boolean) {
  // The recorded interval starts at 2026-11-27T01:01Z and is open at the fixture clock.
  vi.stubEnv('ROUTE_AVOID_CLOSURES', 'on');
  vi.stubEnv('COMMUNITY_TRAFFIC_MODE', 'off');
  const routes = scenarioRoutes();
  const { service: city, placementPublished } = cityService(routes.original);
  const sources = recordedClosureSources(() => NOW, { cityRows: [], bcRows: [closureLine] });
  const replay = recordedClosureProvider();
  const provider: RouteProvider = {
    ...replay.provider,
    getEnrichedRoutes: (request, options) => {
      const exclusions = options?.excludeLocations ?? [];
      if (exclusions.length === 0) {
        return Promise.resolve(
          [routes.original, { ...routes.alternative, label: 'alternative' as const }].slice(
            0,
            (request.alternatives ?? 1) + 1,
          ),
        );
      }
      // The scripted Valhalla response distinguishes City-only from combined exclusions.
      const hasClosure = exclusions.some((location) => location.search_cutoff === 1);
      return Promise.resolve([
        hasClosure && !ignoreClosureExclusion ? routes.clear : routes.unsafe,
      ]);
    },
  };
  const app = await buildApp({
    calgaryTravelTimes: city,
    clock: () => new Date(NOW),
    communityReports: null,
    coverage: createServiceCoverage(['alberta', 'british-columbia']),
    coverageReadiness: null,
    databaseReadiness: null,
    enrichRoutes: (original) => ({ routes: original }),
    provincialRoadEvents: sources.service,
    routeProvider: provider,
    searchProvider: createFixtureSearchProvider(),
  });
  apps.push(app);
  await app.ready();
  await placementPublished;
  await sources.service.getRoadEvents('british-columbia');
  return { app, routes };
}

async function post(app: FastifyInstance, alternatives: number) {
  const response = await app.inject({
    method: 'POST',
    url: '/v2/routes',
    payload: { ...jingle.request, alternatives, trafficSources: [CALGARY_TRAVEL_TIMES_SOURCE_ID] },
  });
  expect(response.statusCode).toBe(200);
  return RouteResponseV2Schema.parse(response.json());
}

describe('City traffic and official closures on /v2/routes', () => {
  it('retains the City-annotated originals when an upstream candidate ignores the closure', async () => {
    const { app, routes } = await setup(true);
    const body = await post(app, 1);
    expect(body.source.trafficSource).toEqual(CALGARY_TRAVEL_TIMES_SOURCE);
    expect(body.source.traffic).toBe('live');
    expect(body.routes.map((entry) => entry.id)).toEqual([
      routes.original.id,
      routes.alternative.id,
    ]);
    expect(body.routes.map((entry) => entry.label)).toEqual(['fastest', 'alternative']);
    expect(body.routes.every((entry) => (entry.traffic?.delaySeconds ?? 0) >= 180)).toBe(true);
    expect(body.routes[0]?.traffic?.delaySeconds).toBeCloseTo(360, 0);
    expect(body.routes[0]?.traffic?.snapshotAt).toBe(new Date(READING_AT).toISOString());
    expect(body.routes.some((entry) => entry.id === routes.unsafe.id)).toBe(false);
  });

  it.each([0, 1])(
    'promotes a verified clear candidate within an alternatives=%i limit',
    async (alternatives) => {
      const { app, routes } = await setup(false);
      const body = await post(app, alternatives);
      expect(body.source.trafficSource).toEqual(CALGARY_TRAVEL_TIMES_SOURCE);
      expect(body.source.traffic).toBe('live');
      expect(body.routes.map((entry) => entry.id)).toEqual(
        alternatives === 0 ? [routes.clear.id] : [routes.clear.id, routes.original.id],
      );
      expect(body.routes).toHaveLength(alternatives + 1);
      expect(body.routes[0]?.label).toBe('fastest');
      expect(body.routes.some((entry) => entry.id === routes.unsafe.id)).toBe(false);
    },
  );
});
