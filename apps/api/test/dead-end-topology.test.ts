import { describe, expect, it } from 'vitest';

import {
  analyzeTopology,
  BACKWARD,
  BOTH,
  createCoverageTest,
  createMask,
  dominators,
  ELIGIBLE,
  EXCLUDED,
  EXTRACT_POLICY_VERSION,
  FORWARD,
  NODE_BARRIER,
  NODE_CLIPPED,
  outermostCommonDominators,
  REASON,
  ROAD_CLASS,
  UNKNOWN,
  wayIntervals,
  type RoadClassName,
  type Topology,
} from '../../../infra/offline/dead-end-mask.mjs';
import { parseDeadEndMask } from '../src/traffic/dead-end-mask.js';
import type { Position } from '../src/traffic/geo.js';

/**
 * Builds a topology the way `dead-end-extract.py` does: ways split at nodes shared by two ways (or
 * used twice by one), at their ends and at stopping barriers, which become separate terminals.
 */
interface FixtureWay {
  id: number;
  nodes: number[];
  road?: RoadClassName;
  direction?: number;
}
function topologyOf(
  positions: Record<number, Position>,
  ways: FixtureWay[],
  options: { barriers?: number[]; clipped?: number[] } = {},
): Topology {
  const uses = new Map<number, number>();
  for (const way of ways) for (const node of way.nodes) uses.set(node, (uses.get(node) ?? 0) + 1);
  const barriers = new Set(options.barriers ?? []);
  const index = new Map<number, number>();
  const nodeIds: number[] = [];
  const flags: number[] = [];
  const nodeOf = (id: number, barrier: boolean) => {
    if (barrier) {
      nodeIds.push(id);
      flags.push(NODE_BARRIER);
      return nodeIds.length - 1;
    }
    let found = index.get(id);
    if (found === undefined) {
      found = nodeIds.length;
      index.set(id, found);
      nodeIds.push(id);
      flags.push((options.clipped ?? []).includes(id) ? NODE_CLIPPED : 0);
    }
    return found;
  };
  const segments: number[][] = [];
  const sequences: string[] = [];
  const lengths: number[] = [];
  const coords: number[] = [];
  const runCoordOffset: number[] = [];
  for (const [run, way] of ways.entries()) {
    runCoordOffset.push(coords.length / 2);
    for (const node of way.nodes) {
      const [longitude, latitude] = positions[node] ?? [0, 0];
      coords.push(Math.round(longitude * 1e7), Math.round(latitude * 1e7));
    }
    let start = 0;
    let meters = 0;
    for (let at = 1; at < way.nodes.length; at += 1) {
      const [x1, y1] = positions[way.nodes[at - 1] ?? 0] ?? [0, 0];
      const [x2, y2] = positions[way.nodes[at] ?? 0] ?? [0, 0];
      meters += Math.hypot(
        (x2 - x1) * 111_320 * Math.cos((y1 * Math.PI) / 180),
        (y2 - y1) * 110_574,
      );
      const node = way.nodes[at] ?? 0;
      if (at === way.nodes.length - 1 || (uses.get(node) ?? 0) > 1 || barriers.has(node)) {
        const first = way.nodes[start] ?? 0;
        const from = nodeOf(first, barriers.has(first));
        const to = nodeOf(node, barriers.has(node));
        sequences.push(
          [`n${String(from)}`, ...way.nodes.slice(start + 1, at), `n${String(to)}`].join(','),
        );
        segments.push([from, to, run, start, at, way.direction ?? BOTH]);
        lengths.push(meters);
        start = at;
        meters = 0;
      }
    }
  }
  const lonLat = nodeIds.flatMap((id) => {
    const [longitude, latitude] = positions[id] ?? [0, 0];
    return [Math.round(longitude * 1e7), Math.round(latitude * 1e7)];
  });
  // Copies of one physical stretch (the same nodes, either way round) point at the first copy
  // and all carry the union of the copies' directions, as the extractor writes them.
  const swap = (direction: number) => ((direction & FORWARD) << 1) | ((direction & BACKWARD) >> 1);
  const segPhys = segments.map((_, index) => index);
  const firstOf = new Map<string, number>();
  for (const [index, sequence] of sequences.entries()) {
    const reverse = sequence.split(',').reverse().join(',');
    const known = firstOf.get(sequence) ?? firstOf.get(reverse);
    if (known === undefined) {
      firstOf.set(sequence, index);
      continue;
    }
    segPhys[index] = known;
    const own = segments[index]?.[5] ?? 0;
    const target = segments[known] ?? [];
    target[5] = (target[5] ?? 0) | (sequences[known] === sequence ? own : swap(own));
  }
  for (const [index, known] of segPhys.entries()) {
    if (known === index) continue;
    const merged = segments[known]?.[5] ?? 0;
    const target = segments[index] ?? [];
    target[5] = sequences[known] === sequences[index] ? merged : swap(merged);
  }
  const column = (field: number) => segments.map((segment) => segment[field] ?? 0);
  return {
    coords: Int32Array.from(coords),
    droppedReason: new Uint8Array(),
    droppedWay: new Float64Array(),
    nodeCount: nodeIds.length,
    nodeFlags: Uint8Array.from(flags),
    nodeLonLat: Int32Array.from(lonLat),
    runBase: new Uint32Array(ways.length),
    runClass: Uint8Array.from(ways.map((way) => ROAD_CLASS[way.road ?? 'secondary'])),
    runCoordOffset: Uint32Array.from(runCoordOffset),
    runFlags: new Uint8Array(ways.length),
    runVertices: Uint32Array.from(ways.map((way) => way.nodes.length)),
    runWay: Float64Array.from(ways.map((way) => way.id)),
    segDir: Uint8Array.from(column(5)),
    segPhys: Uint32Array.from(segPhys),
    segFrom: Uint32Array.from(column(0)),
    segLength: Float64Array.from(lengths),
    segRun: Uint32Array.from(column(2)),
    segTo: Uint32Array.from(column(1)),
    segVEnd: Uint32Array.from(column(4)),
    segVStart: Uint32Array.from(column(3)),
  };
}

const KM = 1 / 70; // about a kilometre of longitude at 51°N
const nowhere = () => false;

/** A 4 x 4 grid of two-way secondary roads, 1 km apart; node id = 100 + 10 * row + column. */
function grid() {
  const positions: Record<number, Position> = {};
  const ways: FixtureWay[] = [];
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      positions[100 + 10 * row + column] = [-114 + column * KM, 51 + row * 0.009];
    }
  }
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const from = 100 + 10 * row + column;
      ways.push({ id: 1000 + from, nodes: [from, from + 1] });
      const up = 100 + 10 * column + row;
      ways.push({ id: 2000 + up, nodes: [up, up + 10] });
    }
  }
  return { positions, ways };
}

function analyse(
  topology: Topology,
  options: { outside?: (x: number, y: number) => boolean } = {},
) {
  const analysis = analyzeTopology(topology, {
    isOutsideCoverage: options.outside ?? nowhere,
    terminalClasses: new Set([ROAD_CLASS.secondary, ROAD_CLASS.tertiary]),
    terminalMeters: 400,
  });
  const intervals = wayIntervals(topology, analysis, 400);
  const statusOf = (wayId: number) => Array.from(intervals.get(wayId)?.status ?? []);
  const reasonOf = (wayId: number) => Array.from(intervals.get(wayId)?.reason ?? []);
  return { analysis, intervals, reasonOf, statusOf };
}

describe('dead-end mask topology', () => {
  it('computes immediate dominators exactly as their definition says', () => {
    // Independent check: x dominates v when removing x leaves v unreachable from the root.
    let seed = 7;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let trial = 0; trial < 60; trial += 1) {
      const nodes = 4 + Math.floor(next() * 10);
      const arcs: [number, number][] = [];
      for (let arc = 0; arc < nodes * 2; arc += 1) {
        arcs.push([Math.floor(next() * nodes), Math.floor(next() * nodes)]);
      }
      const csrOf = (pairs: [number, number][]) => {
        const start = new Int32Array(nodes + 1);
        for (const [from] of pairs) start[from + 1] = (start[from + 1] ?? 0) + 1;
        for (let node = 0; node < nodes; node += 1)
          start[node + 1] = (start[node + 1] ?? 0) + (start[node] ?? 0);
        const cursor = start.slice(0, nodes);
        const list = new Int32Array(pairs.length);
        for (const [from, to] of pairs) {
          list[cursor[from] ?? 0] = to;
          cursor[from] = (cursor[from] ?? 0) + 1;
        }
        return { list, start };
      };
      const idom = dominators(nodes, 0, csrOf(arcs), csrOf(arcs.map(([from, to]) => [to, from])));
      const reach = (without: number) => {
        const seen = new Set<number>(without === 0 ? [] : [0]);
        const queue = without === 0 ? [] : [0];
        while (queue.length > 0) {
          const node = queue.pop() ?? 0;
          for (const [from, to] of arcs) {
            if (from === node && to !== without && !seen.has(to)) {
              seen.add(to);
              queue.push(to);
            }
          }
        }
        return seen;
      };
      const reachable = reach(-1);
      for (let node = 1; node < nodes; node += 1) {
        if (!reachable.has(node)) {
          expect(idom[node]).toBe(-1);
          continue;
        }
        const strict = [...Array(nodes).keys()].filter((x) => x !== node && !reach(x).has(node));
        // The immediate dominator is the strict dominator every other strict dominator dominates.
        const immediate = strict.find((x) =>
          strict.every((other) => other === x || !reach(other).has(x)),
        );
        expect(idom[node]).toBe(immediate);
      }
    }
  });

  it('keeps a connected grid on the main network', () => {
    const { positions, ways } = grid();
    const { statusOf } = analyse(topologyOf(positions, ways));
    for (const way of ways) expect(statusOf(way.id)).toEqual([ELIGIBLE]);
  });

  it('excludes a valley with its own loop when one road leads to it, and keeps two real exits', () => {
    const { positions, ways } = grid();
    // From the grid's north-east corner (133), a 3 km stem to a loop of four roads.
    Object.assign(positions, {
      1: [-114 + 4 * KM, 51.027],
      2: [-114 + 5 * KM, 51.027],
      3: [-114 + 6 * KM, 51.027],
      4: [-114 + 6 * KM, 51.036],
      5: [-114 + 5 * KM, 51.036],
    });
    const valley: FixtureWay[] = [
      { id: 1, nodes: [133, 1, 2] },
      { id: 2, nodes: [2, 3, 4] },
      { id: 3, nodes: [4, 5] },
      { id: 4, nodes: [5, 2] },
    ];
    const dead = analyse(topologyOf(positions, [...ways, ...valley]));
    for (const way of valley)
      expect(dead.statusOf(way.id).every((status) => status === EXCLUDED)).toBe(true);
    expect(dead.reasonOf(3)).toEqual([REASON.pocket]);
    expect(dead.statusOf(1132)).toEqual([ELIGIBLE]);

    // A second road from the loop to another grid junction makes it a through region.
    positions[6] = [-114 + 3 * KM, 51.036];
    const exit: FixtureWay = { id: 5, nodes: [5, 6, 123] };
    const through = analyse(topologyOf(positions, [...ways, ...valley, exit]));
    for (const way of [...valley, exit])
      expect(through.statusOf(way.id).every((status) => status === ELIGIBLE)).toBe(true);
  });

  it('does not count the two directions of a road, a divided entry or two roads to one junction as two exits', () => {
    const { positions, ways } = grid();
    Object.assign(positions, {
      1: [-114 + 4 * KM, 51.027],
      2: [-114 + 6 * KM, 51.027],
      3: [-114 + 6 * KM, 51.036],
      7: [-114 + 4 * KM, 51.0275],
    });
    const loop: FixtureWay[] = [{ id: 2, nodes: [1, 2, 3, 1] }];
    // Divided entry: one carriageway in, one out, between grid junction 133 and the valley at 1.
    const divided: FixtureWay[] = [
      { direction: FORWARD, id: 10, nodes: [133, 1] },
      { direction: BACKWARD, id: 11, nodes: [133, 7, 1] },
    ];
    const dividedResult = analyse(topologyOf(positions, [...ways, ...divided, ...loop]));
    for (const way of [...divided, ...loop]) {
      expect(dividedResult.statusOf(way.id).every((status) => status === EXCLUDED)).toBe(true);
    }
    // Two separate two-way roads, both from junction 133: still one way in.
    const parallel: FixtureWay[] = [
      { id: 10, nodes: [133, 1] },
      { id: 11, nodes: [133, 7, 1] },
    ];
    const parallelResult = analyse(topologyOf(positions, [...ways, ...parallel, ...loop]));
    for (const way of [...parallel, ...loop]) {
      expect(parallelResult.statusOf(way.id).every((status) => status === EXCLUDED)).toBe(true);
    }
  });

  it('keeps one-way motorway carriageways with a diverge and a merge eligible', () => {
    const { positions, ways } = grid();
    // A motorway pair along the grid's south edge, 2 km south, joined to the grid by ramps.
    const south = 51 - 0.018;
    Object.assign(positions, {
      301: [-114 - KM, south],
      302: [-114 + KM, south],
      303: [-114 + 2 * KM, south],
      304: [-114 + 4 * KM, south],
      311: [-114 - KM, south - 0.0005],
      312: [-114 + KM, south - 0.0005],
      313: [-114 + 2 * KM, south - 0.0005],
      314: [-114 + 4 * KM, south - 0.0005],
    });
    const motorway: FixtureWay[] = [
      { direction: FORWARD, id: 31, nodes: [301, 302, 303, 304], road: 'motorway' },
      { direction: FORWARD, id: 32, nodes: [314, 313, 312, 311], road: 'motorway' },
      // Eastbound exit (diverge at 302) and entrance (merge at 303), westbound likewise.
      { direction: FORWARD, id: 33, nodes: [302, 101], road: 'motorway_link' },
      { direction: FORWARD, id: 34, nodes: [101, 303], road: 'motorway_link' },
      { direction: FORWARD, id: 35, nodes: [313, 102], road: 'motorway_link' },
      { direction: FORWARD, id: 36, nodes: [102, 312], road: 'motorway_link' },
      // The carriageways' far ends meet the grid at both sides (a through motorway).
      { direction: FORWARD, id: 37, nodes: [304, 103], road: 'motorway_link' },
      { direction: FORWARD, id: 38, nodes: [103, 314], road: 'motorway_link' },
      { direction: FORWARD, id: 39, nodes: [311, 100], road: 'motorway_link' },
      { direction: FORWARD, id: 40, nodes: [100, 301], road: 'motorway_link' },
    ];
    const { statusOf } = analyse(topologyOf(positions, [...ways, ...motorway]));
    for (const way of motorway)
      expect(statusOf(way.id).every((status) => status === ELIGIBLE)).toBe(true);
  });

  it('excludes isolated components, and marks components and regions that leave the extract unknown', () => {
    const { positions, ways } = grid();
    Object.assign(positions, {
      1: [-113, 52],
      2: [-112.99, 52],
      3: [-112.98, 52.01],
      11: [-114 + 4 * KM, 51.027],
      12: [-114 + 9 * KM, 51.027],
      21: [-110, 52],
      22: [-109.99, 52],
    });
    const island: FixtureWay[] = [{ id: 1, nodes: [1, 2, 3, 1] }];
    const toBorder: FixtureWay = { id: 2, nodes: [133, 11, 12] };
    const clippedIsland: FixtureWay = { id: 3, nodes: [21, 22] };
    const outside = (longitude: number) => longitude > -113.9 && longitude < -113.8;
    const { reasonOf, statusOf } = analyse(
      topologyOf(positions, [...ways, ...island, toBorder, clippedIsland], { clipped: [22] }),
      { outside },
    );
    expect(statusOf(1).every((status) => status === EXCLUDED)).toBe(true);
    expect(reasonOf(1)[0]).toBe(REASON.isolated);
    // The road to the province edge ends outside it: continuation unknown, not a proven dead end.
    expect(statusOf(2)).toEqual([UNKNOWN, UNKNOWN]);
    expect(reasonOf(2)).toEqual([REASON.pocket, REASON.pocket]);
    expect(statusOf(3)).toEqual([UNKNOWN]);
    expect(reasonOf(3)).toEqual([REASON.isolated]);
  });

  it('treats a stopping barrier as two road ends', () => {
    const { positions, ways } = grid();
    Object.assign(positions, { 1: [-114 + 1.5 * KM, 51.0135] });
    // A road across the middle of a grid square, from junction 111 to 112, gated in the middle.
    const gated: FixtureWay = { id: 9, nodes: [111, 1, 112] };
    const open = analyse(topologyOf(positions, [...ways, gated]));
    expect(open.statusOf(9)).toEqual([ELIGIBLE, ELIGIBLE]);
    const closed = analyse(topologyOf(positions, [...ways, gated], { barriers: [1] }));
    expect(closed.statusOf(9)).toEqual([EXCLUDED, EXCLUDED]);
  });

  it('excludes the first 400 m along the network from a road end, on curved and sparse geometry', () => {
    const positions: Record<number, Position> = {};
    const ways: FixtureWay[] = [];
    // Two parallel through roads 2 km apart, joined at both ends: a cycle, so the main network.
    // Road A runs east along 51°N with a vertex every 100 m.
    const step = KM / 10;
    for (let at = 0; at <= 40; at += 1) positions[at] = [-114 + at * step, 51];
    for (let at = 0; at <= 40; at += 1) positions[100 + at] = [-114 + at * step, 51.018];
    ways.push({ id: 1, nodes: [...Array(41).keys()] });
    ways.push({ id: 2, nodes: [...Array(41).keys()].map((at) => 100 + at) });
    ways.push({ id: 3, nodes: [0, 100] });
    ways.push({ id: 4, nodes: [40, 140] });
    // A 170 m dead-end spur off road A at vertex 20 (2 km), drawn as a zigzag of 57 m legs.
    positions[201] = [-114 + 20 * step + 0.0005, 51.0004];
    positions[202] = [-114 + 20 * step, 51.0008];
    positions[203] = [-114 + 20 * step + 0.0005, 51.0012];
    ways.push({ id: 5, nodes: [20, 201, 202, 203] });
    // A hairpin spur off road B at vertex 20: its end is 50 m from the road in a straight line
    // but 1.2 km along the network.
    positions[301] = [-114 + 20 * step, 51.018 + 0.0054];
    positions[302] = [-114 + 20 * step + 0.0007, 51.018 + 0.0054];
    positions[303] = [-114 + 20 * step + 0.0007, 51.018 + 0.00045];
    ways.push({ id: 6, nodes: [120, 301, 302, 303] });
    const topology = topologyOf(positions, ways);
    const { intervals, statusOf, reasonOf } = analyse(topology);
    expect(statusOf(5).every((status) => status === EXCLUDED)).toBe(true);
    const spur = intervals.get(5)?.meters.reduce((sum, value) => sum + value, 0) ?? 0;
    expect(spur).toBeGreaterThan(160);
    expect(spur).toBeLessThan(180);
    // Road A: the spur's end is `spur` metres from the junction, so road A is excluded for
    // 400 - spur metres each way from vertex 20, rounded out to whole 100 m intervals.
    const roadA = statusOf(1);
    const reach = Math.ceil((400 - spur) / 100);
    roadA.forEach((status, index) => {
      const inside = index >= 20 - reach && index < 20 + reach;
      expect(status, `interval ${String(index)}`).toBe(inside ? EXCLUDED : ELIGIBLE);
      if (inside) expect(reasonOf(1)[index]).toBe(REASON.terminal);
    });
    // Road B: the hairpin end is near in a straight line, far along the network.
    expect(statusOf(2).every((status) => status === ELIGIBLE)).toBe(true);

    // Sparse geometry: the same road drawn with one interval per kilometre is excluded for the
    // whole kilometre that comes within 400 m, never only part of it.
    const sparse = topologyOf(
      { ...positions, 500: [-114 + 10 * step, 51], 501: [-114 + 30 * step, 51] },
      [{ id: 1, nodes: [0, 500, 20, 501, 40] }, ...ways.slice(1)],
    );
    const sparseResult = analyse(sparse);
    expect(sparseResult.statusOf(1)).toEqual([ELIGIBLE, EXCLUDED, EXCLUDED, ELIGIBLE]);
  });

  it('writes a mask the API reads, refusing the excluded part of a way that crosses the boundary', () => {
    const { positions, ways } = grid();
    // Way 77 continues from the grid road 132-133 through junction 133 into a valley.
    Object.assign(positions, {
      1: [-114 + 4 * KM, 51.027],
      2: [-114 + 5 * KM, 51.027],
    });
    const throughValley: FixtureWay = { id: 77, nodes: [132, 133, 1, 2] };
    const withoutGridEdge = ways.filter((way) => way.id !== 1000 + 132);
    const topology = topologyOf(positions, [...withoutGridEdge, throughValley]);
    const { mask } = createMask(
      topology,
      {
        graph: {
          dataDate: '2026-11-11',
          graphId: 'd'.repeat(64),
          provenanceSha256: 'f'.repeat(64),
          routingEngineVersion: '3.8.2',
        },
        inputs: {
          extractPolicyVersion: EXTRACT_POLICY_VERSION,
          osmTimestamp: '2026-11-11T21:22:47Z',
          pbf: 'alberta-british-columbia-261111.osm.pbf',
          pbfSha256: 'e'.repeat(64),
        },
      },
      {
        isOutsideCoverage: nowhere,
        terminalClasses: new Set([ROAD_CLASS.tertiary]),
      },
    );
    expect(mask.ways.mixed.map(([wayId, letters]) => [wayId, letters])).toEqual([[77, 'exx']]);
    const reader = parseDeadEndMask(JSON.stringify(mask), { graphId: 'd'.repeat(64) });
    const line = (ids: number[]) => ids.map((id) => positions[id] ?? ([0, 0] as Position));
    expect(reader.status({ forward: true, wayId: 77 }, line([132, 133]))).toBe('eligible');
    expect(reader.status({ forward: false, wayId: 77 }, line([133, 132]))).toBe('eligible');
    expect(reader.status({ forward: true, wayId: 77 }, line([133, 1]))).toBe('excluded');
    expect(reader.status({ forward: true, wayId: 77 }, line([132, 133, 1]))).toBe('excluded');
    expect(reader.status({ forward: true, wayId: 1000 + 100 }, line([100, 101]))).toBe('eligible');
    expect(mask.rules.terminalMeters).toBe(400);
  });

  it('finds road ends outside Alberta and British Columbia', () => {
    const outside = createCoverageTest();
    expect(outside(-114.0719, 51.0447)).toBe(false); // Calgary
    expect(outside(-123.1207, 49.2827)).toBe(false); // Vancouver
    expect(outside(-129.99, 55.936)).toBe(false); // Stewart
    expect(outside(-130.06, 56.0)).toBe(true); // Salmon River Road beyond Hyder, Alaska
    expect(outside(-109.5, 52)).toBe(true); // Saskatchewan
    expect(outside(-129.0, 60.3)).toBe(true); // Yukon
  });

  it('never takes a bridge as the main network, and fails closed without a cycle', () => {
    // Two 300 m triangles joined by a 1 km bridge: the largest single block by length is the
    // bridge, which has no second route.
    const m = 1 / 111_320 / Math.cos((51 * Math.PI) / 180); // a metre of longitude at 51°N
    const positions: Record<number, Position> = {
      1: [-114, 51],
      2: [-114 + 100 * m, 51],
      3: [-114 + 50 * m, 51 + 0.00078],
      4: [-114 + 1100 * m, 51],
      5: [-114 + 1200 * m, 51],
      6: [-114 + 1150 * m, 51 + 0.00078],
    };
    const triangles: FixtureWay[] = [
      { id: 1, nodes: [1, 2] },
      { id: 2, nodes: [2, 3] },
      { id: 3, nodes: [3, 1] },
      { id: 4, nodes: [4, 5] },
      { id: 5, nodes: [5, 6] },
      { id: 6, nodes: [6, 4] },
    ];
    const bridge: FixtureWay = { id: 7, nodes: [2, 4] };
    const { analysis, statusOf } = analyse(topologyOf(positions, [...triangles, bridge]));
    expect(analysis.stats.coreMeters).toBeGreaterThan(250);
    expect(analysis.stats.coreMeters).toBeLessThan(350);
    expect(statusOf(7)).toEqual([EXCLUDED]);
    // One triangle is the core; the other lies behind the bridge.
    const eligibleTriangles = [1, 2, 3, 4, 5, 6].filter((id) => statusOf(id)[0] === ELIGIBLE);
    expect(eligibleTriangles.length).toBe(3);

    // A tree of roads has no block with two routes: nothing is the core, nothing is eligible.
    const tree = analyse(
      topologyOf(positions, [{ id: 1, nodes: [1, 2] }, bridge, { id: 4, nodes: [4, 5] }]),
    );
    expect(tree.analysis.stats.coreNodes).toBe(0);
    for (const id of [1, 7, 4]) expect(tree.statusOf(id)).toEqual([EXCLUDED]);
  });

  it('counts a retraced road once, and keeps genuinely distinct parallel roads', () => {
    const m = 1 / 111_320 / Math.cos((51 * Math.PI) / 180);
    // A 300 m main-network triangle; from its corner 1, one 200 m road to P = 10 (drawn as one
    // way 1 → P → 1, out and back over the same nodes) and a 50 m spur from P to a road end.
    // Counted twice, the road would be a 400 m two-road block, longer than the real cycle.
    const positions: Record<number, Position> = {
      1: [-114, 51],
      2: [-114 + 100 * m, 51],
      3: [-114 + 50 * m, 51 + 0.00078],
      10: [-114 - 200 * m, 51],
      12: [-114 - 200 * m, 51 + 0.00045],
    };
    const core: FixtureWay[] = [
      { id: 1, nodes: [1, 2] },
      { id: 2, nodes: [2, 3] },
      { id: 3, nodes: [3, 1] },
    ];
    const retraced: FixtureWay = { id: 20, nodes: [1, 10, 1], road: 'primary' };
    const spur: FixtureWay = { id: 21, nodes: [10, 12], road: 'residential' };
    const traced = analyse(topologyOf(positions, [...core, retraced, spur]));
    expect(traced.analysis.stats.coreMeters).toBeLessThan(350);
    expect(traced.statusOf(20).every((status) => status === EXCLUDED)).toBe(true);
    expect(traced.statusOf(21)).toEqual([EXCLUDED]);

    // The same stretch drawn as two one-way ways, one each way, is one two-way road: still one
    // access, but drivable both ways (not an isolated component).
    const pair = analyse(
      topologyOf(positions, [
        ...core,
        { direction: FORWARD, id: 22, nodes: [1, 10], road: 'primary' },
        { direction: FORWARD, id: 23, nodes: [10, 1], road: 'primary' },
        spur,
      ]),
    );
    expect(pair.reasonOf(22)).toEqual([REASON.pocket]);
    expect(pair.reasonOf(23)).toEqual([REASON.pocket]);

    // Two different roads between 1 and 10 (the second through 12): a real cycle with a second
    // route, and the longest one, so it is the network.
    const distinct = analyse(
      topologyOf(positions, [
        ...core,
        { id: 24, nodes: [1, 10], road: 'primary' },
        { id: 25, nodes: [10, 12, 1], road: 'primary' },
      ]),
    );
    expect(distinct.statusOf(24).every((status) => status === ELIGIBLE)).toBe(true);
    expect(distinct.statusOf(25).every((status) => status === ELIGIBLE)).toBe(true);
  });

  it('starts the 400 m rule at a road end when any copy of its stretch is of a terminal class', () => {
    const m = 1 / 111_320 / Math.cos((51 * Math.PI) / 180);
    // A main-network triangle of secondary roads with a vertex every 100 m along road 1, and a
    // 100 m spur from its corner 1 drawn twice over the same nodes: once as a secondary road, once
    // as a residential street. Which copy represents the stretch must not matter.
    const positions: Record<number, Position> = { 1: [-114, 51], 2: [-114 + 1000 * m, 51] };
    for (let at = 1; at < 10; at += 1) positions[100 + at] = [-114 + at * 100 * m, 51];
    positions[3] = [-114 + 500 * m, 51 + 0.0078];
    positions[10] = [-114 - 100 * m, 51];
    const arterial: FixtureWay = {
      id: 1,
      nodes: [1, 101, 102, 103, 104, 105, 106, 107, 108, 109, 2],
    };
    const core: FixtureWay[] = [arterial, { id: 2, nodes: [2, 3] }, { id: 3, nodes: [3, 1] }];
    const secondary: FixtureWay = { id: 20, nodes: [1, 10], road: 'secondary' };
    const residential: FixtureWay = { id: 21, nodes: [1, 10], road: 'residential' };
    for (const spur of [
      [secondary, residential],
      [residential, secondary],
    ]) {
      const { analysis, reasonOf, statusOf } = analyse(topologyOf(positions, [...core, ...spur]));
      expect(analysis.stats.trueTerminals).toBe(1);
      // The spur end is about 100 m from corner 1: the arterial's first 300 m are excluded (and
      // the interval touching 300 m, rounded out), the rest from 400 m on is not.
      expect(statusOf(1).slice(0, 3)).toEqual([EXCLUDED, EXCLUDED, EXCLUDED]);
      expect(
        statusOf(1)
          .slice(4)
          .every((status) => status === ELIGIBLE),
      ).toBe(true);
      expect(reasonOf(1)[0]).toBe(REASON.terminal);
    }
    // A residential spur alone ends no terminal-class road: the arterial stays eligible.
    const alone = analyse(topologyOf(positions, [...core, residential]));
    expect(alone.analysis.stats.trueTerminals).toBe(0);
    expect(alone.statusOf(1).every((status) => status === ELIGIBLE)).toBe(true);
  });

  it('finds the outermost common dominator exactly as the ancestor walk does', () => {
    // Oracle: walk every exit-tree ancestor and keep the outermost one that dominates in the
    // entry tree (checked by walking the entry tree, independent of preorder intervals).
    let seed = 11;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const csrOf = (count: number, pairs: [number, number][]) => {
      const start = new Int32Array(count + 1);
      for (const [from] of pairs) start[from + 1] = (start[from + 1] ?? 0) + 1;
      for (let node = 0; node < count; node += 1)
        start[node + 1] = (start[node + 1] ?? 0) + (start[node] ?? 0);
      const cursor = start.slice(0, count);
      const list = new Int32Array(pairs.length);
      for (const [from, to] of pairs) {
        list[cursor[from] ?? 0] = to;
        cursor[from] = (cursor[from] ?? 0) + 1;
      }
      return { list, start };
    };
    let pockets = 0;
    for (let trial = 0; trial < 300; trial += 1) {
      const count = 3 + Math.floor(next() * 14);
      const arcs: [number, number][] = [];
      for (let arc = 0; arc < count * 2; arc += 1) {
        arcs.push([Math.floor(next() * count), Math.floor(next() * count)]);
      }
      const reversed = arcs.map(([from, to]) => [to, from] as [number, number]);
      const entry = dominators(count, 0, csrOf(count, arcs), csrOf(count, reversed));
      const exit = dominators(count, 0, csrOf(count, reversed), csrOf(count, arcs));
      const { choke } = outermostCommonDominators(count, 0, entry, exit);
      const entryAncestor = (candidate: number, node: number) => {
        for (let at = entry[node] ?? -1; at !== -1 && at !== 0; at = entry[at] ?? -1) {
          if (at === candidate) return true;
        }
        return false;
      };
      for (let node = 1; node < count; node += 1) {
        if (entry[node] === -1 || exit[node] === -1) continue;
        let best = -1;
        for (let at = exit[node] ?? 0; at !== 0 && at !== -1; at = exit[at] ?? 0) {
          if (entryAncestor(at, node)) best = at;
        }
        expect(choke[node], `trial ${String(trial)} node ${String(node)}`).toBe(best);
        if (best !== -1) pockets += 1;
      }
    }
    expect(pockets).toBeGreaterThan(50);
  });

  it('finds chokes in O(n log n) on long chains', () => {
    // A two-way chain hanging off the root: the ancestor walk needed n(n+1)/2 steps.
    const run = (count: number) => {
      const entry = new Int32Array(count);
      for (let node = 1; node < count; node += 1) entry[node] = node - 1;
      entry[0] = 0;
      const { choke, operations } = outermostCommonDominators(count, 0, entry, entry.slice());
      expect(choke[1]).toBe(-1);
      expect(choke[count - 1]).toBe(1);
      return operations;
    };
    const sizes = [1_000, 10_000, 100_000, 1_000_000];
    const operations = sizes.map(run);
    for (const [index, size] of sizes.entries()) {
      const levels = Math.ceil(Math.log2(size));
      expect(operations[index]).toBeLessThanOrEqual(size * (3 * levels + 1));
    }
    // Ten times the nodes costs about ten times the work (quadratic would be a hundred).
    for (let index = 1; index < sizes.length; index += 1) {
      expect((operations[index] ?? 0) / (operations[index - 1] ?? 1)).toBeLessThan(13);
    }
  });
});
