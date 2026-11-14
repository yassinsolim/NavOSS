/**
 * Local verification of a built dead-end mask against the real graph it is bound to.
 *
 *   node --import tsx infra/offline/verify/dead-end-mask.mts \
 *     --graph <serving graph directory with dead-end-mask.json> --valhalla http://127.0.0.1:8017/ \
 *     [--topology <kept extractor output>] [--output report.json]
 *
 * The graph directory is verified as the API verifies it (archive hash, serving configuration,
 * provenance, mask binding). Needs a Valhalla 3.8.2 serving that directory's
 * `valhalla-serving.json` (the directory mounted at /graph) on loopback. Routed and sampled edges
 * are a sample; the `valleyRegions` analysis covers every node of each region in the topology. Routes come from fixed public places and
 * seeded random points; nothing here is a driver's position. The report holds only lengths,
 * counts, way ids and choke-junction coordinates (map data).
 */
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import {
  loadDeadEndMask,
  type DeadEndMaskStatus,
} from '../../../apps/api/src/traffic/dead-end-mask.js';
import {
  SERVING_GRAPH_FILES,
  verifyServingGraph,
} from '../../../apps/api/src/traffic/serving-graph.js';
import { decodePolyline6, type Position } from '../../../apps/api/src/traffic/geo.js';
import {
  createValhallaMapMatcher,
  type MatchedEdge,
} from '../../../apps/api/src/traffic/map-matcher.js';
import {
  isAggregatedRoad,
  MIN_PUBLISHED_EDGE_METERS,
} from '../../../apps/api/src/traffic/segments.js';
import {
  analyzeTopology,
  createCoverageTest,
  DEFAULT_TERMINAL_CLASSES,
  readTopology,
  REASON,
  ROAD_CLASS,
  TERMINAL_METERS,
  wayIntervals,
} from '../dead-end-mask.mjs';

const { values } = parseArgs({
  options: {
    graph: { type: 'string' },
    output: { type: 'string' },
    topology: { type: 'string' },
    valhalla: { type: 'string', default: 'http://127.0.0.1:8017/' },
  },
});
if (!values.graph) throw new Error('--graph is required');
const graphDirectory = values.graph;
const graphId = String(
  (
    JSON.parse(readFileSync(join(graphDirectory, SERVING_GRAPH_FILES.graph), 'utf8')) as {
      graphId: unknown;
    }
  ).graphId,
);
const valhalla = values.valhalla ?? 'http://127.0.0.1:8017/';

let since = performance.now();
const served = verifyServingGraph(graphDirectory, graphId, '/graph');
const mask = loadDeadEndMask(join(graphDirectory, SERVING_GRAPH_FILES.mask), { graphId });
if (
  mask.identity.provenanceSha256 !== served.provenanceSha256 ||
  mask.identity.pbfSha256 !== served.pbfSha256
) {
  throw new Error('The mask is not bound to this serving graph');
}
const loadMilliseconds = performance.now() - since;
const matcher = createValhallaMapMatcher({
  endpoint: new URL('trace_attributes', valhalla).toString(),
});
const maskedMatcher = createValhallaMapMatcher({
  deadEndMask: mask,
  endpoint: new URL('trace_attributes', valhalla).toString(),
});

type Place = [latitude: number, longitude: number];
const PLACES = {
  braggCreek: [50.9475, -114.565],
  calgary: [51.0447, -114.0719],
  edmonton: [53.5461, -113.4938],
  elbowFalls: [50.8693, -114.8018],
  meziadin: [56.0944, -129.3047],
  portAlberni: [49.2339, -124.8055],
  sheepRiverEnd: [50.6447, -114.6286],
  stewart: [55.9361, -129.989],
  tofino: [49.153, -125.9066],
  turnerValley: [50.6735, -114.278],
  vancouver: [49.2827, -123.1207],
  kananaskisVillage: [51.0256, -115.0315],
  highway1At40: [51.0868, -115.0612],
} satisfies Record<string, Place>;

async function route(locations: Place[]): Promise<Position[] | undefined> {
  const response = await fetch(new URL('route', valhalla), {
    body: JSON.stringify({
      costing: 'auto',
      directions_type: 'none',
      locations: locations.map(([lat, lon]) => ({ lat, lon })),
    }),
    method: 'POST',
  });
  if (!response.ok) return undefined;
  const body = (await response.json()) as { trip: { legs: { shape: string }[] } };
  const shape: Position[] = [];
  for (const leg of body.trip.legs) {
    const points = decodePolyline6(leg.shape);
    shape.push(...(shape.length > 0 ? points.slice(1) : points));
  }
  return shape;
}

const STATUSES: (DeadEndMaskStatus | 'shortOrPartial')[] = ['eligible', 'excluded', 'unknown'];
interface Tally {
  meters: Record<string, number>;
  edges: Record<string, number>;
}
/** Metres of excluded or unknown edges per way, per sample, for the explanation below. */
const refused = new Map<string, Map<number, number>>();
const lookups: { edge: MatchedEdge; line: Position[] }[] = [];

function tally(edges: MatchedEdge[], into: Tally, sample: string) {
  const ways = refused.get(sample) ?? new Map<number, number>();
  refused.set(sample, ways);
  for (const edge of edges) {
    if (!isAggregatedRoad(edge)) continue;
    const key =
      edge.segmentKey === undefined || edge.lengthMeters < MIN_PUBLISHED_EDGE_METERS
        ? 'shortOrPartial'
        : mask.status(edge, edge.line);
    if (key !== 'shortOrPartial') lookups.push({ edge, line: edge.line });
    if (key === 'excluded' || key === 'unknown') {
      ways.set(edge.wayId, (ways.get(edge.wayId) ?? 0) + edge.lengthMeters);
    }
    into.meters[key] = (into.meters[key] ?? 0) + edge.lengthMeters;
    into.edges[key] = (into.edges[key] ?? 0) + 1;
  }
}

function summary(result: Tally) {
  const decided = STATUSES.slice(0, 3).reduce((sum, key) => sum + (result.meters[key] ?? 0), 0);
  return {
    km: Math.round(decided / 100) / 10,
    edges: result.edges,
    share: Object.fromEntries(
      STATUSES.slice(0, 3).map((key) => [
        key,
        decided === 0 ? 0 : Math.round((1000 * (result.meters[key] ?? 0)) / decided) / 10,
      ]),
    ),
    shortOrPartialKm: Math.round((result.meters.shortOrPartial ?? 0) / 100) / 10,
  };
}

// Seeded random OD pairs within an area (mulberry32), as in the eligibility measurement.
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const report: Record<string, unknown> = {
  graphId: mask.identity.graphId,
  maskLoadMilliseconds: Math.round(loadMilliseconds),
};

const through: Record<string, Place[]> = {
  'Calgary–Edmonton': [PLACES.calgary, PLACES.edmonton],
  'Calgary–Vancouver': [PLACES.calgary, PLACES.vancouver],
  'Highway 1 – Kananaskis Village (AB 40, control)': [
    PLACES.highway1At40,
    PLACES.kananaskisVillage,
  ],
};
const valleys: Record<string, Place[]> = {
  'AB 66: Bragg Creek – Elbow Falls': [PLACES.braggCreek, PLACES.elbowFalls],
  'AB 546: Turner Valley – Sheep River road end': [PLACES.turnerValley, PLACES.sheepRiverEnd],
  'BC 4: Port Alberni – Tofino': [PLACES.portAlberni, PLACES.tofino],
  'BC 37A: Meziadin Junction – Stewart': [PLACES.meziadin, PLACES.stewart],
};
const walked = new Map<string, MatchedEdge[]>();
for (const [name, places] of Object.entries({ ...through, ...valleys })) {
  const geometry = await route(places);
  const edges = geometry === undefined ? undefined : await matcher.walkRoute(geometry);
  if (edges === undefined) {
    report[name] = 'route or walk failed';
    continue;
  }
  walked.set(name, edges);
  const result: Tally = { edges: {}, meters: {} };
  tally(edges, result, name);
  report[name] = summary(result);
}

const cities: Record<string, [number, number, number, number]> = {
  Calgary: [-114.25, 50.9, -113.93, 51.17],
  Edmonton: [-113.65, 53.43, -113.35, 53.64],
  'Metro Vancouver': [-123.22, 49.05, -122.7, 49.33],
};
for (const [name, [west, south, east, north]] of Object.entries(cities)) {
  const next = random(name.length * 7919);
  const point = (): Place => [south + next() * (north - south), west + next() * (east - west)];
  const result: Tally = { edges: {}, meters: {} };
  let routes = 0;
  for (let attempt = 0; attempt < 60 && routes < 40; attempt += 1) {
    const geometry = await route([point(), point()]);
    const edges = geometry === undefined ? undefined : await matcher.walkRoute(geometry);
    if (edges === undefined) continue;
    routes += 1;
    tally(edges, result, name);
  }
  report[`${name} (${String(routes)} random routes)`] = summary(result);
}

// Runtime lookup cost on the real edges looked up above.
since = performance.now();
const repeats = 20;
for (let repeat = 0; repeat < repeats; repeat += 1) {
  for (const { edge, line } of lookups) mask.status(edge, line);
}
report.lookup = {
  edges: lookups.length,
  microsecondsPerLookup:
    Math.round(
      ((performance.now() - since) * 1000 * 100) / (repeats * Math.max(1, lookups.length)),
    ) / 100,
};

// End to end through the matcher: synthetic traces on route geometry (60 km/h, 2 s fixes), screened
// by the same `/locate` path the API uses, with and without the mask.
function trace(geometry: Position[], fromMeters: number, meters: number) {
  const points: { offsetSeconds: number; position: Position }[] = [];
  let travelled = 0;
  let nextMark = fromMeters;
  for (let index = 1; index < geometry.length && points.length < 120; index += 1) {
    const from = geometry[index - 1] ?? [0, 0];
    const to = geometry[index] ?? [0, 0];
    const step =
      Math.hypot((to[0] - from[0]) * Math.cos((from[1] * Math.PI) / 180), to[1] - from[1]) *
      111_320;
    while (nextMark <= travelled + step && nextMark < fromMeters + meters) {
      const share = step === 0 ? 0 : (nextMark - travelled) / step;
      points.push({
        offsetSeconds: points.length * 2,
        position: [
          Math.round((from[0] + (to[0] - from[0]) * share) * 1e5) / 1e5,
          Math.round((from[1] + (to[1] - from[1]) * share) * 1e5) / 1e5,
        ],
      });
      nextMark += 33.3;
    }
    travelled += step;
  }
  return points;
}
const endToEnd: Record<string, unknown> = {};
for (const [name, places, fromMeters] of [
  ['Calgary–Edmonton, 20 km in', through['Calgary–Edmonton'], 20_000],
  ['BC 4, 20 km before Tofino', valleys['BC 4: Port Alberni – Tofino'], 95_000],
  ['AB 66, 5 km before Elbow Falls', valleys['AB 66: Bragg Creek – Elbow Falls'], 12_000],
  [
    'BC 37A, 15 km before Stewart (unknown: leaves the extract)',
    valleys['BC 37A: Meziadin Junction – Stewart'],
    45_000,
  ],
] as const) {
  const geometry = await route([...(places ?? [])]);
  if (geometry === undefined) continue;
  const points = trace(geometry, fromMeters, 3_000);
  const plain = await matcher.matchTrace(points);
  const masked = await maskedMatcher.matchTrace(points);
  const open = (edges: MatchedEdge[] | undefined) =>
    (edges ?? []).filter((edge) => edge.openThroughRoad === true).length;
  endToEnd[name] = {
    candidateEdges: (masked?.edges ?? []).filter((edge) => edge.openThroughRoad !== undefined)
      .length,
    openWithoutMask: open(plain?.edges),
    openWithMask: open(masked?.edges),
    points: points.length,
  };
}
report.endToEnd = endToEnd;

// Why the valleys are excluded: the choke junction and region of the walked edges' ways.
if (values.topology) {
  const topology = await readTopology(values.topology);
  const analysis = analyzeTopology(topology, {
    isOutsideCoverage: createCoverageTest(),
    terminalClasses: new Set(DEFAULT_TERMINAL_CLASSES.map((name) => ROAD_CLASS[name])),
    terminalMeters: TERMINAL_METERS,
  });
  const intervals = wayIntervals(topology, analysis, TERMINAL_METERS);
  const regionMeters = new Map<number, number>();
  const regionClipped = new Map<number, boolean>();
  for (let segment = 0; segment < topology.segFrom.length; segment += 1) {
    if (topology.segPhys[segment] !== segment) continue; // a copy of one physical stretch
    const from = topology.segFrom[segment] ?? 0;
    const to = topology.segTo[segment] ?? 0;
    const choke =
      analysis.choke[to] !== -1 ? (analysis.choke[to] ?? -1) : (analysis.choke[from] ?? -1);
    if (choke !== -1)
      regionMeters.set(choke, (regionMeters.get(choke) ?? 0) + (topology.segLength[segment] ?? 0));
  }
  for (let node = 0; node < topology.nodeCount; node += 1) {
    if (analysis.clipped[node] === 1 && analysis.choke[node] !== -1)
      regionClipped.set(analysis.choke[node] ?? -1, true);
  }
  const chokesOfWay = new Map<number, Set<number>>();
  for (let segment = 0; segment < topology.segFrom.length; segment += 1) {
    const wayId = topology.runWay[topology.segRun[segment] ?? 0] ?? 0;
    for (const node of [topology.segFrom[segment] ?? 0, topology.segTo[segment] ?? 0]) {
      const choke = analysis.choke[node] ?? -1;
      if (choke === -1) continue;
      const set = chokesOfWay.get(wayId) ?? new Set<number>();
      set.add(choke);
      chokesOfWay.set(wayId, set);
    }
  }
  const reasonNames = Object.fromEntries(
    Object.entries(REASON).map(([name, code]) => [code, name]),
  );
  const explained: Record<string, unknown> = {};
  for (const name of Object.keys(valleys)) {
    const ways = new Set(
      (walked.get(name) ?? []).filter((edge) => isAggregatedRoad(edge)).map((edge) => edge.wayId),
    );
    const byReason: Record<string, number> = {};
    const chokes = new Set<number>();
    for (const wayId of ways) {
      const way = intervals.get(wayId);
      if (way === undefined) {
        byReason['not in topology (policy)'] = (byReason['not in topology (policy)'] ?? 0) + 1;
        continue;
      }
      for (let index = 0; index < way.status.length; index += 1) {
        const key = `${['eligible', 'excluded', 'unknown'][way.status[index] ?? 2] ?? ''}:${reasonNames[way.reason[index] ?? 0] ?? ''}`;
        byReason[key] = Math.round((byReason[key] ?? 0) + (way.meters[index] ?? 0));
      }
      for (const choke of chokesOfWay.get(wayId) ?? []) chokes.add(choke);
    }
    explained[name] = {
      metersByStatusOfWholeWays: byReason,
      regions: [...chokes].map((choke) => ({
        chokeJunction: [
          (topology.nodeLonLat[2 * choke] ?? 0) / 1e7,
          (topology.nodeLonLat[2 * choke + 1] ?? 0) / 1e7,
        ],
        chokeOnCore: analysis.core[choke] === 1,
        regionRoadKm: Math.round((regionMeters.get(choke) ?? 0) / 100) / 10,
        leavesExtract: regionClipped.get(choke) ?? false,
      })),
    };
  }
  report.valleyRegions = explained;
  const refusals: Record<string, unknown> = {};
  for (const [sample, ways] of refused) {
    if (sample in valleys || ways.size === 0) continue;
    refusals[sample] = [...ways]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 8)
      .map(([wayId, meters]) => {
        const way = intervals.get(wayId);
        const reasons = new Set<string>();
        for (let index = 0; index < (way?.status.length ?? 0); index += 1) {
          if (way?.status[index] !== 0) reasons.add(reasonNames[way?.reason[index] ?? 0] ?? '');
        }
        const chokes = [...(chokesOfWay.get(wayId) ?? [])].map((choke) => ({
          at: [
            (topology.nodeLonLat[2 * choke] ?? 0) / 1e7,
            (topology.nodeLonLat[2 * choke + 1] ?? 0) / 1e7,
          ],
          regionRoadKm: Math.round((regionMeters.get(choke) ?? 0) / 100) / 10,
        }));
        return { chokes, km: Math.round(meters / 100) / 10, reasons: [...reasons], wayId };
      });
  }
  report.refusedOnSamples = refusals;
}

const text = JSON.stringify(report, null, 2);
if (values.output) await writeFile(values.output, text + '\n');
console.log(text);
