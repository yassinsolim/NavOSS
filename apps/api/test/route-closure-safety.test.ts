import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

import { fixtureValue } from '../../../packages/contracts/test/fixture-value.js';
import { createDriveBcProvinceRoadEventFeed } from '../src/drivebc-province-road-event-feed.js';
import { createProvincial511RoadEventFeed } from '../src/provincial-511-road-event-feed.js';
import { createProvincialRoadEventService } from '../src/provincial-road-events.js';
import type { RouteProvider } from '../src/route-provider.js';
import { selectClosureEvents, type ClosureEvent } from '../src/route-closures/events.js';
import {
  ClosureProximity,
  placeClosure,
  validateClosureBarriers,
} from '../src/route-closures/graph.js';
import { createClosureRouting, type ClosureRouting } from '../src/route-closures/index.js';
import { haversineMeters, type Position } from '../src/traffic/geo.js';
import type { ValhallaExcludeLocation } from '../src/valhalla-pbf.js';
import official from './fixtures/road-events/official-closures-2026-11-27.json' with { type: 'json' };
import ontario from './fixtures/road-events/ontario-511-event-documentation-sample.json' with { type: 'json' };
import {
  closureFixture,
  recordedClosureProvider,
  recordedClosureSources,
} from './support/closure-routing-fixture.js';

const pointCase = fixtureValue(
  closureFixture.cases.find((item) => item.name === 'drivebc-mckay-point-current'),
);
const jingle = fixtureValue(
  closureFixture.cases.find((item) => item.name === 'nanaimo-jingle-pot-current'),
);
const ontarioSample = fixtureValue(ontario.rows[0]);
const jingleRow = fixtureValue(
  official.driveBc.rows.find((row) => row.id === 'drivebc.ca/RIDE-108168'),
);
type GraphQuery = NonNullable<RouteProvider['getClosureGraph']>;
const routings: ClosureRouting[] = [];
afterEach(async () => {
  for (const routing of routings.splice(0)) routing.close();
  await nextTurn();
});

// Synthetic parser/layout vectors below are not additional published events or live road data.
function encodePolyline6(positions: readonly Position[]): string {
  let previousLatitude = 0;
  let previousLongitude = 0;
  let encoded = '';
  const append = (delta: number): void => {
    let value = delta < 0 ? -delta * 2 - 1 : delta * 2;
    while (value >= 0x20) {
      encoded += String.fromCharCode((0x20 | (value % 0x20)) + 63);
      value = Math.floor(value / 0x20);
    }
    encoded += String.fromCharCode(value + 63);
  };
  for (const [longitude, latitude] of positions) {
    const latitudeE6 = Math.round(latitude * 1e6);
    const longitudeE6 = Math.round(longitude * 1e6);
    append(latitudeE6 - previousLatitude);
    append(longitudeE6 - previousLongitude);
    previousLatitude = latitudeE6;
    previousLongitude = longitudeE6;
  }
  return encoded;
}

const point: Position = [ontarioSample.Longitude, ontarioSample.Latitude];
const pointEvent: ClosureEvent = {
  key: 'fixture-express-collector',
  sourceId: 'ontario-511-events',
  direction: 'east',
  roadNames: ['Highway 401'],
  geometryType: 'point',
  geometry: [point],
};
const LocationsSchema = z
  .object({
    locations: z.array(
      z.object({ lat: z.number(), lon: z.number(), radius: z.number().optional() }).loose(),
    ),
  })
  .loose();
function locatedEdge(way: number, heading: number, position: Position = point, distance = 0) {
  return {
    correlated_lat: position[1],
    correlated_lon: position[0],
    distance,
    heading,
    percent_along: 0.5,
    edge_id: { value: way * 10 + (heading < 180 ? 1 : 2) },
    edge_info: {
      way_id: way,
      names: ['Highway 401'],
      shape: encodePolyline6([
        [position[0] - 0.001, position[1]],
        [position[0] + 0.001, position[1]],
      ]),
    },
    edge: { access: { car: true } },
  };
}
function carriagewayQuery(expressHeading: () => number): GraphQuery {
  return (_action, body) => {
    const locations = LocationsSchema.parse(body).locations;
    return Promise.resolve(
      locations.map((location) => ({
        edges:
          (location.radius ?? 0) === 30
            ? [
                locatedEdge(1, 90),
                locatedEdge(2, expressHeading(), [point[0], point[1] + 0.00012], 14),
              ]
            : [locatedEdge(1, 90)],
      })),
    );
  };
}

function lineQuery(ruralEnd = false): { event: ClosureEvent; query: GraphQuery } {
  const scale = 111_195 * Math.cos((point[1] * Math.PI) / 180);
  const positions: Position[] = [
    point,
    [point[0] + 5.3 / scale, point[1]],
    [point[0] + 55.3 / scale, point[1]],
    [point[0] + (ruralEnd ? 2_055.3 : 65.3) / scale, point[1]],
  ];
  const edges = positions.slice(1).map((to, index) => ({
    id: index + 1,
    way_id: index + 1,
    begin_shape_index: index,
    end_shape_index: index + 1,
    length: haversineMeters(fixtureValue(positions[index]), to) / 1_000,
    ...(index === 0 ? { source_percent_along: 1 - 5.3 / 22.2 } : {}),
    ...(index === 2 ? { target_percent_along: 0.95 } : {}),
  }));
  const query: GraphQuery = (action, body) => {
    if (action === 'trace_attributes')
      return Promise.resolve({
        units: 'kilometers',
        shape: encodePolyline6(positions),
        edges,
        matched_points: positions.map(() => ({ distance_from_trace_point: 0 })),
      });
    return Promise.resolve(
      LocationsSchema.parse(body).locations.map((location) => {
        const index = positions.findIndex(
          (to, position) =>
            position > 0 &&
            location.lon <= to[0] &&
            location.lon >= fixtureValue(positions[position - 1])[0],
        );
        if (index < 1) throw new Error('Unexpected line-fixture correlation.');
        return { edges: [locatedEdge(index, 90, [location.lon, location.lat])] };
      }),
    );
  };
  return {
    event: { ...pointEvent, key: 'fixture-line-end', geometryType: 'line', geometry: positions },
    query,
  };
}

function remember(routing: ClosureRouting): ClosureRouting {
  routings.push(routing);
  return routing;
}
function enriched(routing: ClosureRouting) {
  return fixtureValue(routing.provider.getEnrichedRoutes?.bind(routing.provider));
}

const remotePoint = fixtureValue(fixtureValue(jingle.before[0]).geometry[0]);
function callerLocations(count: number): ValhallaExcludeLocation[] {
  return Array.from({ length: count }, () => ({
    lat: remotePoint[1],
    lon: remotePoint[0],
    radius: 0,
    node_snap_tolerance: 0,
    minimum_reachability: 0,
    search_cutoff: 1,
  }));
}

describe('closure safety review: carriageway and published line extent', () => {
  it('rejects a nearest collector when a same-name same-direction express way is within 30 metres', async () => {
    await expect(
      placeClosure(
        pointEvent,
        carriagewayQuery(() => 90),
        new ClosureProximity([point]),
        AbortSignal.timeout(1_000),
      ),
    ).rejects.toMatchObject({ reason: 'ambiguous-edge' });
  });

  it('does not confuse a different-direction neighbouring way with the closed direction', async () => {
    const placed = await placeClosure(
      pointEvent,
      carriagewayQuery(() => 270),
      new ClosureProximity([point]),
      AbortSignal.timeout(1_000),
    );
    expect(placed.barriers).toHaveLength(1);
  });

  it('rechecks carriageway ambiguity when a cached nearest way itself has not changed', async () => {
    let heading = 270;
    const query = carriagewayQuery(() => heading);
    const placed = await placeClosure(
      pointEvent,
      query,
      new ClosureProximity([point]),
      AbortSignal.timeout(1_000),
    );
    heading = 90;
    await expect(
      validateClosureBarriers(placed.barriers, query, AbortSignal.timeout(1_000)),
    ).rejects.toMatchObject({ reason: 'ambiguous-edge' });
  });

  it('drops a 5.3-metre match on a 22.2-metre first edge, while retaining the well-covered end', async () => {
    const { event, query } = lineQuery();
    const placed = await placeClosure(
      event,
      query,
      new ClosureProximity(event.geometry),
      AbortSignal.timeout(1_000),
    );
    expect(placed.barriers).toHaveLength(2);
    expect(placed.droppedEndEdges).toBe(1);
    expect(placed.barriers.every((barrier) => barrier.fingerprint.way_id !== 1)).toBe(true);
  });

  it('also drops a mostly matched rural end whose unmatched extent still exceeds 15 metres', async () => {
    const { event, query } = lineQuery(true);
    const placed = await placeClosure(
      event,
      query,
      new ClosureProximity(event.geometry),
      AbortSignal.timeout(1_000),
    );
    expect(placed.barriers).toHaveLength(1);
    expect(placed.droppedEndEdges).toBe(2);
    expect(placed.barriers[0]?.fingerprint.way_id).toBe(2);
  });
});

describe('closure safety review: detached shadow and cached refreshes', () => {
  it('returns shadow routes before any closure work and permits only one process-wide flight', async () => {
    const sources = recordedClosureSources(() => pointCase.now);
    await sources.ready();
    const replay = recordedClosureProvider();
    const blocked = Promise.withResolvers<unknown>();
    const query = vi.fn<GraphQuery>(() => blocked.promise);
    const provider: RouteProvider = { ...replay.provider, getClosureGraph: query };
    const first = remember(
      createClosureRouting(provider, sources.service, {
        mode: 'shadow',
        clock: () => pointCase.now,
        timeoutMs: 20,
      }),
    );
    const second = remember(
      createClosureRouting(provider, sources.service, {
        mode: 'shadow',
        clock: () => pointCase.now,
        timeoutMs: 20,
      }),
    );
    try {
      expect(await enriched(first)(pointCase.request)).toEqual(pointCase.before);
      expect(query).not.toHaveBeenCalled();
      expect(await enriched(second)(pointCase.request)).toEqual(pointCase.before);
      expect(second.counters().shadowSkipped).toBe(1);
      await nextTurn();
      expect(query).toHaveBeenCalledOnce();
    } finally {
      blocked.resolve([{ edges: [] }]);
      await nextTurn();
    }
  });

  it('uses a current cached closure throughout an in-flight source refresh', async () => {
    let clock = jingle.now;
    const pending = Promise.withResolvers<Response>();
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ events: [jingleRow] })),
    );
    const feed = createDriveBcProvinceRoadEventFeed({ clock: () => clock, fetchImplementation });
    await feed.getSnapshot();
    const service = createProvincialRoadEventService(
      { alberta: [], 'british-columbia': [feed], ontario: [] },
      () => clock,
    );
    const replay = recordedClosureProvider();
    const routing = remember(
      createClosureRouting(replay.provider, service, {
        mode: 'on',
        clock: () => clock,
        timeoutMs: 50,
      }),
    );
    clock += 301_000;
    fetchImplementation.mockImplementation(() => pending.promise);
    const refreshing = feed.getSnapshot();
    try {
      expect(await enriched(routing)(jingle.request)).toEqual(jingle.after);
      expect(await enriched(routing)(jingle.request)).toEqual(jingle.after);
      expect(routing.counters().failedOpen).toBe(0);
    } finally {
      pending.resolve(Response.json({ events: [jingleRow] }));
      await refreshing;
      feed.stop();
    }
  });

  it('does not wait for an unrelated province with no snapshot while cached closures are available', async () => {
    const pending = Promise.withResolvers<Response>();
    const feed = createDriveBcProvinceRoadEventFeed({
      clock: () => jingle.now,
      fetchImplementation: () => Promise.resolve(Response.json({ events: [jingleRow] })),
    });
    await feed.getSnapshot();
    const cold = createProvincial511RoadEventFeed('ontario', 'fixture-only-key', {
      clock: () => jingle.now,
      fetchImplementation: () => pending.promise,
    });
    const service = createProvincialRoadEventService(
      {
        alberta: [],
        'british-columbia': [feed],
        ontario: [cold],
      },
      () => jingle.now,
    );
    const replay = recordedClosureProvider();
    const routing = remember(
      createClosureRouting(replay.provider, service, {
        mode: 'on',
        clock: () => jingle.now,
        timeoutMs: 50,
      }),
    );
    service.start();
    try {
      expect(await enriched(routing)(jingle.request)).toEqual(jingle.after);
      expect(routing.counters().failedOpen).toBe(0);
    } finally {
      pending.resolve(Response.json(ontario.rows));
      await cold.getSnapshot();
      service.stop();
    }
  });

  it('reads an empty cache as unavailable without initiating a refresh on the route path', async () => {
    const pending = Promise.withResolvers<Response>();
    const fetchImplementation = vi.fn<typeof fetch>(() => pending.promise);
    const feed = createDriveBcProvinceRoadEventFeed({
      clock: () => jingle.now,
      fetchImplementation,
    });
    const service = createProvincialRoadEventService({
      alberta: [],
      'british-columbia': [feed],
      ontario: [],
    });
    const reading = service.getRoutingSnapshots();
    try {
      expect(fetchImplementation).not.toHaveBeenCalled();
      const snapshots = await reading;
      expect(snapshots[0]?.source.status).toBe('unavailable');
    } finally {
      pending.resolve(Response.json({ events: [jingleRow] }));
      await reading;
      feed.stop();
    }
  });
});

describe('closure safety review: barricade direction and private counters', () => {
  it('keeps the barrier when an origin reroutes from just before the barricade', async () => {
    const example = fixtureValue(
      closureFixture.boundaries.endpoints.cases.find((item) => item.name === 'origin-before'),
    );
    const sources = recordedClosureSources(() => closureFixture.boundaries.endpoints.now);
    await sources.ready();
    const replay = recordedClosureProvider();
    const routing = remember(
      createClosureRouting(replay.provider, sources.service, {
        mode: 'on',
        clock: () => closureFixture.boundaries.endpoints.now,
      }),
    );
    expect(await enriched(routing)(example.request)).toEqual(example.after);
    expect(routing.counters().exclusionsComputed).toBe(1);
    // Valhalla can ignore a terminal-edge exclusion; normal requests must still fail open.
    // The strict candidate path must never return that unverified ordinary result.
    expect(await routing.getCandidateRoutes(example.request)).toBeUndefined();
    expect(replay.calls.some((call) => call.excluded)).toBe(true);
  });

  it('allows travel away from a nearby barricade without a separate endpoint-access counter', async () => {
    const example = fixtureValue(
      closureFixture.boundaries.endpoints.cases.find((item) => item.name === 'origin-after'),
    );
    const sources = recordedClosureSources(() => closureFixture.boundaries.endpoints.now);
    await sources.ready();
    const replay = recordedClosureProvider();
    const routing = remember(
      createClosureRouting(replay.provider, sources.service, {
        mode: 'on',
        clock: () => closureFixture.boundaries.endpoints.now,
      }),
    );
    expect(await enriched(routing)(example.request)).toEqual(example.before);
    expect(routing.counters().failedOpen).toBe(1);
    expect(routing.counters().rejected).not.toHaveProperty('endpoint-access');
  });
});

describe('closure safety review: local recurring DriveBC time zone', () => {
  it.each([
    ['southeastern mountain community', [-115.76, 49.51]],
    ['northeastern mountain community', [-120.23, 55.75]],
  ] as const)(
    'rejects recurring hours in a %s rather than assigning Vancouver time',
    async (_name, coordinate) => {
      const now = Date.parse('2026-11-27T17:30:00Z');
      const feed = createDriveBcProvinceRoadEventFeed({
        clock: () => now,
        fetchImplementation: () =>
          Promise.resolve(
            Response.json({
              events: [
                {
                  ...jingleRow,
                  geography: { type: 'Point', coordinates: coordinate },
                  schedule: {
                    recurring_schedules: [
                      {
                        start_date: '2026-11-27',
                        daily_start_time: '10:00',
                        daily_end_time: '11:00',
                        days: [5],
                      },
                    ],
                  },
                },
              ],
            }),
          ),
      });
      const selected = selectClosureEvents([await feed.getSnapshot()], now);
      expect(selected.events).toEqual([]);
      expect(selected.rejected['schedule-uncertain']).toBe(1);
    },
  );
});

describe('closure safety review: strict internal avoid candidates', () => {
  it('keeps official barriers and declines a caller candidate when combined exclusions exceed 50', async () => {
    const sources = recordedClosureSources(() => pointCase.now);
    await sources.ready();
    const replay = recordedClosureProvider();
    const routing = remember(
      createClosureRouting(replay.provider, sources.service, {
        mode: 'on',
        clock: () => pointCase.now,
      }),
    );
    expect(await enriched(routing)(pointCase.request)).toEqual(pointCase.after);
    expect(
      await routing.getCandidateRoutes(pointCase.request, {
        excludeLocations: callerLocations(50),
      }),
    ).toBeUndefined();
    expect(await enriched(routing)(pointCase.request)).toEqual(pointCase.after);
    expect(routing.counters().candidatesDeclined).toBe(1);
    expect(routing.counters().rejected['exclusion-limit']).toBe(1);
  });

  it('accepts a within-limit caller candidate and reports successful official barrier application', async () => {
    const sources = recordedClosureSources(() => pointCase.now);
    await sources.ready();
    const replay = recordedClosureProvider();
    const routing = remember(
      createClosureRouting(replay.provider, sources.service, {
        mode: 'on',
        clock: () => pointCase.now,
      }),
    );
    const candidate = fixtureValue(
      await routing.getCandidateRoutes(pointCase.request, {
        excludeLocations: callerLocations(49),
      }),
    );
    expect(candidate.routes).toEqual(pointCase.after);
    expect(candidate.closuresApplied).toBe(true);
  });

  it.each(['http', 'no-route', 'ignored'] as const)(
    'declines a %s avoiding failure instead of returning ordinary candidate routes',
    async (failure) => {
      const sources = recordedClosureSources(() => pointCase.now);
      await sources.ready();
      const replay = recordedClosureProvider({ failure });
      const routing = remember(
        createClosureRouting(replay.provider, sources.service, {
          mode: 'on',
          clock: () => pointCase.now,
        }),
      );
      expect(await routing.getCandidateRoutes(pointCase.request)).toBeUndefined();
      expect(await enriched(routing)(pointCase.request)).toEqual(pointCase.before);
    },
  );

  it('declines a candidate when cached official barriers no longer verify on the graph', async () => {
    const sources = recordedClosureSources(() => pointCase.now);
    await sources.ready();
    const replay = recordedClosureProvider();
    const original = fixtureValue(replay.provider.getClosureGraph?.bind(replay.provider));
    let replaced = false;
    const provider: RouteProvider = {
      ...replay.provider,
      getClosureGraph: (action, body, signal) =>
        replaced ? Promise.resolve([{ edges: [] }]) : original(action, body, signal),
    };
    const routing = remember(
      createClosureRouting(provider, sources.service, { mode: 'on', clock: () => pointCase.now }),
    );
    expect((await routing.getCandidateRoutes(pointCase.request))?.closuresApplied).toBe(true);
    replaced = true;
    expect(await routing.getCandidateRoutes(pointCase.request)).toBeUndefined();
    expect(await enriched(routing)(pointCase.request)).toEqual(pointCase.before);
  });
});
