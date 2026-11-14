/**
 * Builds the community-traffic dead-end mask from the dated Alberta + British Columbia extract
 * and binds it to the connected routing graph built from the same extract.
 *
 *   node --import tsx infra/offline/dead-end-mask.mts \
 *     --inputs artifacts/offline/inputs/261111 \
 *     --graph artifacts/offline/graphs/<key> \
 *     --output artifacts/dead-end-mask [--keep-topology]
 *
 * The algorithm and the main-network rule are described in
 * docs/architecture/community-traffic.md#dead-end-mask.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

import {
  DEAD_END_MASK_FORMAT,
  DEAD_END_MASK_FORMAT_VERSION,
  deadEndMaskPayloadDigest,
  encodeDeltas,
  type DeadEndMaskFile,
  type DeadEndMaskWays,
} from '../../apps/api/src/traffic/dead-end-mask.js';
import { SERVICE_AREA_DATA } from '../../packages/contracts/src/coverage-data.js';
import { routingEnginePin } from './engine.mjs';
import { sha256File } from './tools.mjs';

const exec = promisify(execFile);

/** Class codes written by `dead-end-extract.py`. */
export const ROAD_CLASS = {
  motorway: 1,
  motorway_link: 2,
  trunk: 3,
  trunk_link: 4,
  primary: 5,
  primary_link: 6,
  secondary: 7,
  secondary_link: 8,
  tertiary: 9,
  tertiary_link: 10,
  unclassified: 11,
  residential: 12,
  living_street: 13,
  service: 14,
  road: 15,
  ferry: 16,
  minor_service: 17,
} as const;
export type RoadClassName = keyof typeof ROAD_CLASS;

export const PUBLISHABLE_CLASSES: readonly RoadClassName[] = [
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
];

/**
 * Road ends that start the 400 m exclusion along the network: ends of roads the pipeline could
 * publish and of tertiary roads (whose sparse rural ends the class rule already treats as
 * household-identifying). Every road end of any class is inside a single-access region, which is
 * excluded whole whatever its length; what this list decides is only how far exclusion spills
 * past that region's junction onto roads that also carry through traffic. Spilling from every
 * residential, unclassified and service road end excluded 32% of the motorway-to-secondary
 * length in Calgary, 46% in Edmonton and 60% in Metro Vancouver (measured on the 2026-11-11
 * extract), i.e. most arterials, without shrinking the set of trips behind any published edge;
 * the first 400 m of every trip from such an end remains the app's trip-end trim.
 */
export const DEFAULT_TERMINAL_CLASSES: readonly RoadClassName[] = [
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
];

export const TERMINAL_METERS = 400;
export const CORE_RULE =
  'largest-two-way-biconnected-block: the largest set of junctions (by road length) joined pairwise by two vertex-disjoint routes of two-way roads';

export const FORWARD = 1;
export const BACKWARD = 2;
export const BOTH = 3;
export const NODE_CLIPPED = 1;
export const NODE_BARRIER = 2;
export const RUN_MISSING_NODES = 1;

export interface Topology {
  nodeCount: number;
  /** Two int32 per node: longitude and latitude in 1e-7 degrees. */
  nodeLonLat: Int32Array;
  nodeFlags: Uint8Array;
  segFrom: Uint32Array;
  segTo: Uint32Array;
  segRun: Uint32Array;
  segVStart: Uint32Array;
  segVEnd: Uint32Array;
  segLength: Float64Array;
  segDir: Uint8Array;
  runWay: Float64Array;
  runBase: Uint32Array;
  runClass: Uint8Array;
  runVertices: Uint32Array;
  runFlags: Uint8Array;
  /** Offset (in vertices) into `coords` for publishable runs, 0xffffffff otherwise. */
  runCoordOffset: Uint32Array;
  coords: Int32Array;
  droppedWay: Float64Array;
  droppedReason: Uint8Array;
}

/** Node status codes. */
export const ELIGIBLE = 0;
export const EXCLUDED = 1;
export const UNKNOWN = 2;

export const REASON = {
  none: 0,
  pocket: 1,
  isolated: 2,
  terminal: 3,
  policy: 4,
  missingNodes: 5,
} as const;

export interface Analysis {
  /** ELIGIBLE, EXCLUDED or UNKNOWN per node. */
  nodeStatus: Uint8Array;
  /** REASON per node. */
  nodeReason: Uint8Array;
  /** Outermost single junction every route into and out of the node passes, or -1. */
  choke: Int32Array;
  /** Network distance to the nearest true terminal, capped at the terminal distance. */
  terminalDistance: Float64Array;
  clipped: Uint8Array;
  core: Uint8Array;
  stats: {
    blocks: number;
    coreMeters: number;
    secondBlockMeters: number;
    coreNodes: number;
    pocketNodes: number;
    unreachableNodes: number;
    trueTerminals: number;
    clippedNodes: number;
    chokeWalkSteps: number;
  };
}

export interface AnalysisOptions {
  isOutsideCoverage: (longitude: number, latitude: number) => boolean;
  terminalClasses: ReadonlySet<number>;
  terminalMeters: number;
}

interface Csr {
  start: Int32Array;
  list: Int32Array;
}

function csr(
  nodes: number,
  count: number,
  fill: (add: (node: number, value: number) => void) => void,
): Csr {
  const start = new Int32Array(nodes + 1);
  fill((node) => {
    start[node + 1] = (start[node + 1] ?? 0) + 1;
  });
  for (let node = 0; node < nodes; node += 1)
    start[node + 1] = (start[node + 1] ?? 0) + (start[node] ?? 0);
  const cursor = start.slice(0, nodes);
  const list = new Int32Array(count);
  fill((node, value) => {
    list[cursor[node] ?? 0] = value;
    cursor[node] = (cursor[node] ?? 0) + 1;
  });
  return { start, list };
}

/**
 * Immediate dominators by Lengauer–Tarjan with path compression, iteratively (no recursion, so a
 * million-node graph cannot overflow the stack). `idom[node]` is -1 for nodes `root` cannot
 * reach and `root` for the root.
 */
export function dominators(nodes: number, root: number, succ: Csr, pred: Csr): Int32Array {
  const semi = new Int32Array(nodes).fill(-1);
  const vertex = new Int32Array(nodes);
  const parent = new Int32Array(nodes).fill(-1);
  const ancestor = new Int32Array(nodes).fill(-1);
  const label = new Int32Array(nodes);
  const idom = new Int32Array(nodes).fill(-1);
  const bucketHead = new Int32Array(nodes).fill(-1);
  const bucketNext = new Int32Array(nodes).fill(-1);
  const iterator = new Int32Array(nodes);
  const stack = new Int32Array(nodes);
  let count = 0;
  let depth = 0;
  semi[root] = count;
  vertex[count++] = root;
  label[root] = root;
  stack[depth++] = root;
  iterator[root] = succ.start[root] ?? 0;
  while (depth > 0) {
    const node = stack[depth - 1] ?? 0;
    const position = iterator[node] ?? 0;
    if (position < (succ.start[node + 1] ?? 0)) {
      iterator[node] = position + 1;
      const next = succ.list[position] ?? 0;
      if (semi[next] === -1) {
        parent[next] = node;
        semi[next] = count;
        vertex[count++] = next;
        label[next] = next;
        iterator[next] = succ.start[next] ?? 0;
        stack[depth++] = next;
      }
    } else depth -= 1;
  }

  const path = stack; // reused for path compression
  const evaluate = (node: number): number => {
    if (ancestor[node] === -1) return node;
    let length = 0;
    let current = node;
    while (ancestor[ancestor[current] ?? 0] !== -1) {
      path[length++] = current;
      current = ancestor[current] ?? 0;
    }
    while (length > 0) {
      const item = path[--length] ?? 0;
      const above = ancestor[item] ?? 0;
      if ((semi[label[above] ?? 0] ?? 0) < (semi[label[item] ?? 0] ?? 0)) {
        label[item] = label[above] ?? 0;
      }
      ancestor[item] = ancestor[above] ?? -1;
    }
    return label[node] ?? node;
  };

  for (let index = count - 1; index >= 1; index -= 1) {
    const node = vertex[index] ?? 0;
    for (
      let position = pred.start[node] ?? 0;
      position < (pred.start[node + 1] ?? 0);
      position += 1
    ) {
      const from = pred.list[position] ?? 0;
      if (semi[from] === -1) continue;
      const best = evaluate(from);
      if ((semi[best] ?? 0) < (semi[node] ?? 0)) semi[node] = semi[best] ?? 0;
    }
    const bucket = vertex[semi[node] ?? 0] ?? 0;
    bucketNext[node] = bucketHead[bucket] ?? -1;
    bucketHead[bucket] = node;
    const above = parent[node] ?? 0;
    ancestor[node] = above;
    let item = bucketHead[above] ?? -1;
    while (item !== -1) {
      const following = bucketNext[item] ?? -1;
      const best = evaluate(item);
      idom[item] = (semi[best] ?? 0) < (semi[item] ?? 0) ? best : above;
      item = following;
    }
    bucketHead[above] = -1;
  }
  for (let index = 1; index < count; index += 1) {
    const node = vertex[index] ?? 0;
    if (idom[node] !== vertex[semi[node] ?? 0]) idom[node] = idom[idom[node] ?? 0] ?? -1;
  }
  idom[root] = root;
  return idom;
}

class UnionFind {
  private readonly parent: Int32Array;
  public constructor(size: number) {
    this.parent = new Int32Array(size).map((_, index) => index);
  }
  public find(node: number): number {
    let root = node;
    while (this.parent[root] !== root) root = this.parent[root] ?? root;
    let current = node;
    while (this.parent[current] !== root) {
      const next = this.parent[current] ?? root;
      this.parent[current] = root;
      current = next;
    }
    return root;
  }
  public union(left: number, right: number): void {
    const a = this.find(left);
    const b = this.find(right);
    if (a !== b) this.parent[a] = b;
  }
}

/** Min-heap of (distance, node) pairs. */
class Heap {
  private distances: number[] = [];
  private nodes: number[] = [];
  public get size(): number {
    return this.nodes.length;
  }
  public push(distance: number, node: number): void {
    this.distances.push(distance);
    this.nodes.push(node);
    let index = this.nodes.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if ((this.distances[parent] ?? 0) <= distance) break;
      this.distances[index] = this.distances[parent] ?? 0;
      this.nodes[index] = this.nodes[parent] ?? 0;
      index = parent;
    }
    this.distances[index] = distance;
    this.nodes[index] = node;
  }
  public pop(): [number, number] {
    const top: [number, number] = [this.distances[0] ?? 0, this.nodes[0] ?? 0];
    const lastDistance = this.distances.pop() ?? 0;
    const lastNode = this.nodes.pop() ?? 0;
    const size = this.nodes.length;
    if (size > 0) {
      let index = 0;
      for (;;) {
        const left = 2 * index + 1;
        if (left >= size) break;
        const right = left + 1;
        const child =
          right < size && (this.distances[right] ?? 0) < (this.distances[left] ?? 0) ? right : left;
        if ((this.distances[child] ?? 0) >= lastDistance) break;
        this.distances[index] = this.distances[child] ?? 0;
        this.nodes[index] = this.nodes[child] ?? 0;
        index = child;
      }
      this.distances[index] = lastDistance;
      this.nodes[index] = lastNode;
    }
    return top;
  }
}

/**
 * Classifies every node of the road topology:
 *
 * 1. **Main network (core).** The largest biconnected block (by road length) of the undirected
 *    graph of two-way roads: junctions joined pairwise by two routes that share no junction,
 *    each drivable both ways. It is computed, not chosen, and contains no single-access region by
 *    construction.
 * 2. **Single-access regions.** On the directed graph (one arc per legal direction), immediate
 *    dominators from a root joined to every core junction, once for entering (from the core) and
 *    once for leaving (to the core). A node is in a dead-end region when one junction other than
 *    itself lies on every route in **and** every route out. The two directions of a road are one
 *    road; a divided road into a valley is caught because its exit carriageway is the only way out;
 *    a motorway diverge is not, because only its entry is single.
 * 3. **Isolated.** Nodes that cannot reach the core or be reached from it.
 * 4. **Unknown continuation.** A region (or isolated component) containing a node where the road
 *    leaves the extract (a referenced node missing, or a road end outside Alberta and British
 *    Columbia) is `unknown`, not `excluded` and never `eligible`.
 * 5. **Road ends.** Network distance from every true terminal (a road end of a public road class,
 *    not clipped), for the 400 m rule.
 */
export function analyzeTopology(topology: Topology, options: AnalysisOptions): Analysis {
  const nodes = topology.nodeCount;
  const segments = topology.segFrom.length;
  const { segFrom, segTo, segDir, segLength, segRun, runClass, nodeFlags, nodeLonLat } = topology;

  const undirected = csr(nodes, segments * 2, (add) => {
    for (let segment = 0; segment < segments; segment += 1) {
      add(segFrom[segment] ?? 0, segment);
      add(segTo[segment] ?? 0, segment);
    }
  });
  const degree = (node: number) =>
    (undirected.start[node + 1] ?? 0) - (undirected.start[node] ?? 0);
  const other = (segment: number, node: number) =>
    (segFrom[segment] ?? 0) === node ? (segTo[segment] ?? 0) : (segFrom[segment] ?? 0);

  // Clipped nodes: the extractor's missing-node stubs, plus road ends outside the provinces
  // (Geofabrik extracts end roads at a buffer polygon around the province).
  const clipped = new Uint8Array(nodes);
  let clippedNodes = 0;
  for (let node = 0; node < nodes; node += 1) {
    if (
      ((nodeFlags[node] ?? 0) & NODE_CLIPPED) !== 0 ||
      (degree(node) === 1 &&
        options.isOutsideCoverage(
          (nodeLonLat[2 * node] ?? 0) / 1e7,
          (nodeLonLat[2 * node + 1] ?? 0) / 1e7,
        ))
    ) {
      clipped[node] = 1;
      clippedNodes += 1;
    }
  }

  // 1. Core: biconnected blocks of the two-way subgraph (iterative Hopcroft–Tarjan).
  const isTwoWay = (segment: number) =>
    segDir[segment] === BOTH && segFrom[segment] !== segTo[segment];
  const discovery = new Int32Array(nodes).fill(-1);
  const low = new Int32Array(nodes);
  const parentSegment = new Int32Array(nodes).fill(-1);
  const iterator = new Int32Array(nodes);
  const callStack = new Int32Array(nodes);
  const edgeStack = new Int32Array(segments);
  const blockOf = new Int32Array(segments).fill(-1);
  const blockMeters: number[] = [];
  let time = 0;
  let edgeDepth = 0;
  for (let rootNode = 0; rootNode < nodes; rootNode += 1) {
    if (discovery[rootNode] !== -1) continue;
    let depth = 0;
    discovery[rootNode] = low[rootNode] = time++;
    iterator[rootNode] = undirected.start[rootNode] ?? 0;
    callStack[depth++] = rootNode;
    while (depth > 0) {
      const node = callStack[depth - 1] ?? 0;
      const position = iterator[node] ?? 0;
      if (position < (undirected.start[node + 1] ?? 0)) {
        iterator[node] = position + 1;
        const segment = undirected.list[position] ?? 0;
        if (!isTwoWay(segment) || segment === parentSegment[node]) continue;
        const next = other(segment, node);
        if (discovery[next] === -1) {
          edgeStack[edgeDepth++] = segment;
          parentSegment[next] = segment;
          discovery[next] = low[next] = time++;
          iterator[next] = undirected.start[next] ?? 0;
          callStack[depth++] = next;
        } else if ((discovery[next] ?? 0) < (discovery[node] ?? 0)) {
          edgeStack[edgeDepth++] = segment;
          if ((discovery[next] ?? 0) < (low[node] ?? 0)) low[node] = discovery[next] ?? 0;
        }
      } else {
        depth -= 1;
        const segment = parentSegment[node] ?? -1;
        if (segment === -1) continue;
        const above = other(segment, node);
        if ((low[node] ?? 0) < (low[above] ?? 0)) low[above] = low[node] ?? 0;
        if ((low[node] ?? 0) >= (discovery[above] ?? 0)) {
          const block = blockMeters.length;
          let meters = 0;
          let popped: number;
          do {
            popped = edgeStack[--edgeDepth] ?? 0;
            blockOf[popped] = block;
            meters += segLength[popped] ?? 0;
          } while (popped !== segment);
          blockMeters.push(meters);
        }
      }
    }
  }
  let coreBlock = -1;
  let coreMeters = 0;
  let secondBlockMeters = 0;
  for (const [block, meters] of blockMeters.entries()) {
    if (meters > coreMeters) {
      secondBlockMeters = coreMeters;
      coreMeters = meters;
      coreBlock = block;
    } else if (meters > secondBlockMeters) secondBlockMeters = meters;
  }
  const core = new Uint8Array(nodes);
  let coreNodes = 0;
  for (let segment = 0; segment < segments; segment += 1) {
    if (blockOf[segment] !== coreBlock || coreBlock === -1) continue;
    for (const node of [segFrom[segment] ?? 0, segTo[segment] ?? 0]) {
      if (core[node] === 0) {
        core[node] = 1;
        coreNodes += 1;
      }
    }
  }

  // 2. Dominators, entering and leaving, from a root joined to every core node.
  const root = nodes;
  const arcs = (reverse: boolean) => {
    let count = 0;
    for (let segment = 0; segment < segments; segment += 1) {
      if (segFrom[segment] === segTo[segment]) continue;
      if (((segDir[segment] ?? 0) & FORWARD) !== 0) count += 1;
      if (((segDir[segment] ?? 0) & BACKWARD) !== 0) count += 1;
    }
    count += coreNodes;
    const each = (visit: (from: number, to: number) => void) => {
      for (let segment = 0; segment < segments; segment += 1) {
        const from = segFrom[segment] ?? 0;
        const to = segTo[segment] ?? 0;
        if (from === to) continue;
        const direction = segDir[segment] ?? 0;
        if ((direction & FORWARD) !== 0) reverse ? visit(to, from) : visit(from, to);
        if ((direction & BACKWARD) !== 0) reverse ? visit(from, to) : visit(to, from);
      }
      for (let node = 0; node < nodes; node += 1) if (core[node] === 1) visit(root, node);
    };
    const succ = csr(nodes + 1, count, (add) => {
      each((from, to) => {
        add(from, to);
      });
    });
    const pred = csr(nodes + 1, count, (add) => {
      each((from, to) => {
        add(to, from);
      });
    });
    return { pred, succ };
  };
  const entering = arcs(false);
  const entry = dominators(nodes + 1, root, entering.succ, entering.pred);
  const leaving = arcs(true);
  const exit = dominators(nodes + 1, root, leaving.succ, leaving.pred);

  // Preorder intervals of the entry dominator tree, to test "x dominates v" in O(1).
  const children = csr(nodes + 1, nodes, (add) => {
    for (let node = 0; node < nodes; node += 1) {
      const dominator = entry[node] ?? -1;
      if (dominator !== -1) add(dominator, node);
    }
  });
  const enter = new Int32Array(nodes + 1).fill(-1);
  const leave = new Int32Array(nodes + 1).fill(-1);
  {
    let clock = 0;
    let depth = 0;
    const position = new Int32Array(nodes + 1);
    const stack = new Int32Array(nodes + 1);
    enter[root] = clock++;
    position[root] = children.start[root] ?? 0;
    stack[depth++] = root;
    while (depth > 0) {
      const node = stack[depth - 1] ?? 0;
      const at = position[node] ?? 0;
      if (at < (children.start[node + 1] ?? 0)) {
        position[node] = at + 1;
        const child = children.list[at] ?? 0;
        enter[child] = clock++;
        position[child] = children.start[child] ?? 0;
        stack[depth++] = child;
      } else {
        leave[node] = clock++;
        depth -= 1;
      }
    }
  }

  const choke = new Int32Array(nodes).fill(-1);
  const unreachable = new Uint8Array(nodes);
  let pocketNodes = 0;
  let unreachableNodes = 0;
  let chokeWalkSteps = 0;
  for (let node = 0; node < nodes; node += 1) {
    if (entry[node] === -1 || exit[node] === -1) {
      unreachable[node] = 1;
      unreachableNodes += 1;
      continue;
    }
    let best = -1;
    for (
      let candidate = exit[node] ?? root;
      candidate !== root;
      candidate = exit[candidate] ?? root
    ) {
      chokeWalkSteps += 1;
      if (
        (enter[candidate] ?? -1) !== -1 &&
        (enter[candidate] ?? 0) <= (enter[node] ?? 0) &&
        (leave[node] ?? 0) <= (leave[candidate] ?? 0)
      ) {
        best = candidate;
      }
    }
    if (best !== -1) {
      choke[node] = best;
      pocketNodes += 1;
    }
  }

  // 3/4. Regions: pocket branches (same outermost choke, joined without passing it) and
  // unreachable components; either is unknown when it holds a clipped node.
  const regions = new UnionFind(nodes);
  for (let segment = 0; segment < segments; segment += 1) {
    const from = segFrom[segment] ?? 0;
    const to = segTo[segment] ?? 0;
    if (
      (choke[from] !== -1 && choke[from] === choke[to]) ||
      (unreachable[from] === 1 && unreachable[to] === 1)
    ) {
      regions.union(from, to);
    }
  }
  const regionClipped = new Uint8Array(nodes);
  for (let node = 0; node < nodes; node += 1) {
    if (clipped[node] === 1 && (choke[node] !== -1 || unreachable[node] === 1)) {
      regionClipped[regions.find(node)] = 1;
    }
  }
  const nodeStatus = new Uint8Array(nodes);
  const nodeReason = new Uint8Array(nodes);
  for (let node = 0; node < nodes; node += 1) {
    if (choke[node] === -1 && unreachable[node] === 0) continue;
    nodeStatus[node] = regionClipped[regions.find(node)] === 1 ? UNKNOWN : EXCLUDED;
    nodeReason[node] = unreachable[node] === 1 ? REASON.isolated : REASON.pocket;
  }

  // 5. Distance from true terminals, bounded at the terminal distance (multi-source Dijkstra).
  const terminalDistance = new Float64Array(nodes).fill(Infinity);
  const heap = new Heap();
  let trueTerminals = 0;
  for (let node = 0; node < nodes; node += 1) {
    if (degree(node) !== 1 || clipped[node] === 1) continue;
    const segment = undirected.list[undirected.start[node] ?? 0] ?? 0;
    if (!options.terminalClasses.has(runClass[segRun[segment] ?? 0] ?? 0)) continue;
    trueTerminals += 1;
    terminalDistance[node] = 0;
    heap.push(0, node);
  }
  while (heap.size > 0) {
    const [distance, node] = heap.pop();
    if (distance > (terminalDistance[node] ?? Infinity)) continue;
    for (
      let position = undirected.start[node] ?? 0;
      position < (undirected.start[node + 1] ?? 0);
      position += 1
    ) {
      const segment = undirected.list[position] ?? 0;
      const next = other(segment, node);
      const candidate = distance + (segLength[segment] ?? 0);
      if (candidate < options.terminalMeters && candidate < (terminalDistance[next] ?? Infinity)) {
        terminalDistance[next] = candidate;
        heap.push(candidate, next);
      }
    }
  }

  return {
    choke,
    clipped,
    core,
    nodeReason,
    nodeStatus,
    stats: {
      blocks: blockMeters.length,
      chokeWalkSteps,
      clippedNodes,
      coreMeters,
      coreNodes,
      pocketNodes,
      secondBlockMeters,
      trueTerminals,
      unreachableNodes,
    },
    terminalDistance,
  };
}

function haversineE7(x1: number, y1: number, x2: number, y2: number): number {
  const toRadians = Math.PI / 180 / 1e7;
  const lat1 = y1 * toRadians;
  const lat2 = y2 * toRadians;
  const a =
    Math.sin((lat2 - lat1) / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(((x2 - x1) * toRadians) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Status and reason of a segment from its two end nodes (a loop on one node is a dead end). */
export function segmentBase(topology: Topology, analysis: Analysis, segment: number) {
  const from = topology.segFrom[segment] ?? 0;
  const to = topology.segTo[segment] ?? 0;
  const statuses = [analysis.nodeStatus[from] ?? 0, analysis.nodeStatus[to] ?? 0];
  const reasons = [analysis.nodeReason[from] ?? 0, analysis.nodeReason[to] ?? 0];
  if (from === to && statuses[0] === ELIGIBLE) return { reason: REASON.pocket, status: EXCLUDED };
  const index =
    statuses[0] === EXCLUDED ? 0 : statuses[1] === EXCLUDED ? 1 : statuses[0] === UNKNOWN ? 0 : 1;
  return { reason: reasons[index] ?? 0, status: statuses[index] ?? 0 };
}

export interface WayIntervals {
  wayId: number;
  classCode: number;
  /** Vertices in 1e-7 degrees, two per vertex. */
  coordinates: Int32Array;
  status: Uint8Array;
  reason: Uint8Array;
  /** Length of each interval in metres. */
  meters: Float64Array;
}

/**
 * Status of every node-to-node interval of every publishable way. An interval inherits its
 * segment's status, and an eligible interval with any part within `terminalMeters` of a true
 * terminal along the network is excluded. A way split by missing nodes is unknown throughout.
 */
export function wayIntervals(
  topology: Topology,
  analysis: Analysis,
  terminalMeters: number,
): Map<number, WayIntervals> {
  const result = new Map<number, WayIntervals>();
  const runsOfWay = new Map<number, number>();
  for (let run = 0; run < topology.runWay.length; run += 1) {
    const wayId = topology.runWay[run] ?? 0;
    runsOfWay.set(wayId, (runsOfWay.get(wayId) ?? 0) + 1);
  }
  for (let run = 0; run < topology.runWay.length; run += 1) {
    const offset = topology.runCoordOffset[run] ?? 0xffffffff;
    if (offset === 0xffffffff) continue;
    const vertices = topology.runVertices[run] ?? 0;
    const wayId = topology.runWay[run] ?? 0;
    const coordinates = topology.coords.subarray(2 * offset, 2 * (offset + vertices));
    const meters = new Float64Array(vertices - 1);
    for (let index = 0; index + 1 < vertices; index += 1) {
      meters[index] = haversineE7(
        coordinates[2 * index] ?? 0,
        coordinates[2 * index + 1] ?? 0,
        coordinates[2 * index + 2] ?? 0,
        coordinates[2 * index + 3] ?? 0,
      );
    }
    const unknownWay =
      ((topology.runFlags[run] ?? 0) & RUN_MISSING_NODES) !== 0 || (runsOfWay.get(wayId) ?? 0) > 1;
    const status = new Uint8Array(vertices - 1).fill(unknownWay ? UNKNOWN : 255);
    const reason = new Uint8Array(vertices - 1).fill(unknownWay ? REASON.missingNodes : 0);
    result.set(wayId, {
      classCode: topology.runClass[run] ?? 0,
      coordinates,
      meters,
      reason,
      status,
      wayId,
    });
  }
  for (let segment = 0; segment < topology.segFrom.length; segment += 1) {
    const run = topology.segRun[segment] ?? 0;
    const way = result.get(topology.runWay[run] ?? 0);
    if (way === undefined) continue;
    const start = topology.segVStart[segment] ?? 0;
    const end = topology.segVEnd[segment] ?? 0;
    if (end <= start) continue;
    const base = segmentBase(topology, analysis, segment);
    const fromDistance = analysis.terminalDistance[topology.segFrom[segment] ?? 0] ?? Infinity;
    const toDistance = analysis.terminalDistance[topology.segTo[segment] ?? 0] ?? Infinity;
    let length = 0;
    for (let index = start; index < end; index += 1) length += way.meters[index] ?? 0;
    let along = 0;
    for (let index = start; index < end; index += 1) {
      if (way.status[index] === UNKNOWN && way.reason[index] === REASON.missingNodes) continue;
      const next = along + (way.meters[index] ?? 0);
      if (base.status !== ELIGIBLE) {
        way.status[index] = base.status;
        way.reason[index] = base.reason;
      } else if (
        fromDistance + along < terminalMeters ||
        toDistance + (length - next) < terminalMeters
      ) {
        way.status[index] = EXCLUDED;
        way.reason[index] = REASON.terminal;
      } else {
        way.status[index] = ELIGIBLE;
        way.reason[index] = REASON.none;
      }
      along = next;
    }
  }
  for (const way of result.values()) {
    for (let index = 0; index < way.status.length; index += 1) {
      if (way.status[index] === 255) {
        way.status[index] = UNKNOWN;
        way.reason[index] = REASON.missingNodes;
      }
    }
  }
  return result;
}

const LETTERS = ['e', 'x', 'u'] as const;

/** The `ways` member of the mask, deterministic for the same input. */
export function maskWays(
  intervals: Map<number, WayIntervals>,
  topology: Topology,
): DeadEndMaskWays {
  const lists: [number[], number[], number[]] = [[], [], []];
  const mixed: DeadEndMaskWays['mixed'] = [];
  for (const way of [...intervals.values()].sort((left, right) => left.wayId - right.wayId)) {
    const first = way.status[0] ?? UNKNOWN;
    if (way.status.every((status) => status === first)) {
      lists[first]?.push(way.wayId);
      continue;
    }
    const coordinates: number[] = [];
    for (let index = 0; index < way.coordinates.length; index += 1) {
      coordinates.push(Math.round((way.coordinates[index] ?? 0) / 10));
    }
    const deltas = coordinates.map((value, index) =>
      index < 2 ? value : value - (coordinates[index - 2] ?? 0),
    );
    mixed.push([
      way.wayId,
      Array.from(way.status, (status) => LETTERS[status] ?? 'u').join(''),
      deltas,
    ]);
  }
  for (const wayId of topology.droppedWay) {
    if (!intervals.has(wayId)) lists[EXCLUDED].push(wayId);
  }
  const excluded = [...new Set(lists[EXCLUDED])].sort((left, right) => left - right);
  return {
    eligible: encodeDeltas(lists[ELIGIBLE]),
    excluded: encodeDeltas(excluded),
    unknown: encodeDeltas(lists[UNKNOWN]),
    mixed,
  };
}

/** Point-in-province test over the shared Alberta and BC boundaries, indexed by latitude band. */
export function createCoverageTest(
  areas: readonly {
    boundary: { coordinates: number[][][][] };
  }[] = SERVICE_AREA_DATA as unknown as {
    boundary: { coordinates: number[][][][] };
  }[],
): (longitude: number, latitude: number) => boolean {
  const BAND = 0.05;
  const bands = new Map<number, number[]>();
  const edges: number[] = [];
  for (const area of areas) {
    for (const polygon of area.boundary.coordinates) {
      for (const ring of polygon) {
        for (let index = 0; index + 1 < ring.length; index += 1) {
          const [x1 = 0, y1 = 0] = ring[index] ?? [];
          const [x2 = 0, y2 = 0] = ring[index + 1] ?? [];
          const edge = edges.length / 4;
          edges.push(x1, y1, x2, y2);
          for (
            let band = Math.floor(Math.min(y1, y2) / BAND);
            band <= Math.floor(Math.max(y1, y2) / BAND);
            band += 1
          ) {
            const list = bands.get(band) ?? [];
            list.push(edge);
            bands.set(band, list);
          }
        }
      }
    }
  }
  // Even-odd over all rings of both provinces: the provinces do not overlap, and holes count.
  return (longitude, latitude) => {
    let inside = false;
    for (const edge of bands.get(Math.floor(latitude / BAND)) ?? []) {
      const x1 = edges[4 * edge] ?? 0;
      const y1 = edges[4 * edge + 1] ?? 0;
      const x2 = edges[4 * edge + 2] ?? 0;
      const y2 = edges[4 * edge + 3] ?? 0;
      if (
        y1 > latitude !== y2 > latitude &&
        longitude < x1 + ((latitude - y1) * (x2 - x1)) / (y2 - y1)
      ) {
        inside = !inside;
      }
    }
    return !inside;
  };
}

const ARRAY_TYPES = {
  coords: Int32Array,
  dropped_reason: Uint8Array,
  dropped_way: BigInt64Array,
  node_flags: Uint8Array,
  node_lonlat: Int32Array,
  run_base: Uint32Array,
  run_class: Uint8Array,
  run_coord_offset: Uint32Array,
  run_flags: Uint8Array,
  run_vertices: Uint32Array,
  run_way: BigInt64Array,
  seg_dir: Uint8Array,
  seg_from: Uint32Array,
  seg_len: Float64Array,
  seg_run: Uint32Array,
  seg_to: Uint32Array,
  seg_vend: Uint32Array,
  seg_vstart: Uint32Array,
} as const;

/** Reads the extractor's output directory. */
export async function readTopology(
  directory: string,
): Promise<Topology & { policyVersion: number }> {
  const header = JSON.parse(await readFile(join(directory, 'header.json'), 'utf8')) as {
    arrays: Record<string, { length: number }>;
    nodes: number;
    policyVersion: number;
  };
  const arrays: Record<string, unknown> = {};
  for (const [name, Type] of Object.entries(ARRAY_TYPES)) {
    const bytes = await readFile(join(directory, `${name}.bin`));
    const expected = header.arrays[name]?.length;
    if (bytes.byteLength !== (expected ?? -1) * Type.BYTES_PER_ELEMENT) {
      throw new Error(`Topology array ${name} has the wrong size`);
    }
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    arrays[name] = new Type(buffer);
  }
  const toNumbers = (values: BigInt64Array) => Float64Array.from(values, (value) => Number(value));
  return {
    coords: arrays.coords as Int32Array,
    droppedReason: arrays.dropped_reason as Uint8Array,
    droppedWay: toNumbers(arrays.dropped_way as BigInt64Array),
    nodeCount: header.nodes,
    nodeFlags: arrays.node_flags as Uint8Array,
    nodeLonLat: arrays.node_lonlat as Int32Array,
    policyVersion: header.policyVersion,
    runBase: arrays.run_base as Uint32Array,
    runClass: arrays.run_class as Uint8Array,
    runCoordOffset: arrays.run_coord_offset as Uint32Array,
    runFlags: arrays.run_flags as Uint8Array,
    runVertices: arrays.run_vertices as Uint32Array,
    runWay: toNumbers(arrays.run_way as BigInt64Array),
    segDir: arrays.seg_dir as Uint8Array,
    segFrom: arrays.seg_from as Uint32Array,
    segLength: arrays.seg_len as Float64Array,
    segRun: arrays.seg_run as Uint32Array,
    segTo: arrays.seg_to as Uint32Array,
    segVEnd: arrays.seg_vend as Uint32Array,
    segVStart: arrays.seg_vstart as Uint32Array,
  };
}

export interface MaskIdentity {
  graph: DeadEndMaskFile['graph'];
  inputs: DeadEndMaskFile['inputs'];
}

/** Analyses a topology and returns the complete mask document plus the per-way intervals. */
export function createMask(
  topology: Topology,
  identity: MaskIdentity,
  options: Partial<AnalysisOptions> = {},
) {
  const terminalClasses = DEFAULT_TERMINAL_CLASSES;
  const analysisOptions: AnalysisOptions = {
    isOutsideCoverage: options.isOutsideCoverage ?? createCoverageTest(),
    terminalClasses:
      options.terminalClasses ?? new Set(terminalClasses.map((name) => ROAD_CLASS[name])),
    terminalMeters: options.terminalMeters ?? TERMINAL_METERS,
  };
  const analysis = analyzeTopology(topology, analysisOptions);
  const intervals = wayIntervals(topology, analysis, analysisOptions.terminalMeters);
  const ways = maskWays(intervals, topology);
  const meters = [0, 0, 0];
  for (const way of intervals.values()) {
    for (let index = 0; index < way.status.length; index += 1) {
      meters[way.status[index] ?? UNKNOWN] =
        (meters[way.status[index] ?? UNKNOWN] ?? 0) + (way.meters[index] ?? 0);
    }
  }
  const classNames = Object.fromEntries(
    Object.entries(ROAD_CLASS).map(([name, code]) => [code, name]),
  ) as Record<number, string>;
  const mask: DeadEndMaskFile = {
    format: DEAD_END_MASK_FORMAT,
    formatVersion: DEAD_END_MASK_FORMAT_VERSION,
    graph: identity.graph,
    inputs: identity.inputs,
    rules: {
      core: CORE_RULE,
      publishableClasses: [...PUBLISHABLE_CLASSES],
      terminalClasses: [...analysisOptions.terminalClasses]
        .map((code) => classNames[code] ?? String(code))
        .sort(),
      terminalMeters: analysisOptions.terminalMeters,
    },
    summary: {
      blocks: analysis.stats.blocks,
      clippedNodes: analysis.stats.clippedNodes,
      coreMeters: Math.round(analysis.stats.coreMeters),
      coreNodes: analysis.stats.coreNodes,
      eligibleMeters: Math.round(meters[ELIGIBLE] ?? 0),
      excludedMeters: Math.round(meters[EXCLUDED] ?? 0),
      mixedWays: ways.mixed.length,
      nodes: topology.nodeCount,
      pocketNodes: analysis.stats.pocketNodes,
      secondBlockMeters: Math.round(analysis.stats.secondBlockMeters),
      segments: topology.segFrom.length,
      trueTerminals: analysis.stats.trueTerminals,
      unknownMeters: Math.round(meters[UNKNOWN] ?? 0),
      unreachableNodes: analysis.stats.unreachableNodes,
      ways: intervals.size + topology.droppedWay.length,
    },
    ways,
    payloadSha256: deadEndMaskPayloadDigest(ways),
  };
  return { analysis, intervals, mask };
}

async function builderImage(scripts: string): Promise<string> {
  const engine = routingEnginePin();
  const dockerfileHash = await sha256File(join(scripts, 'Dockerfile'));
  const key = createHash('sha256').update(JSON.stringify({ dockerfileHash, engine })).digest('hex');
  const image = `navoss-offline-builder:${key.slice(0, 12)}`;
  const present = await exec('docker', ['image', 'inspect', image]).then(
    () => true,
    () => false,
  );
  if (!present) {
    await exec(
      'docker',
      [
        'build',
        '--build-arg',
        `VALHALLA_IMAGE=${engine.image}`,
        '-t',
        image,
        '-f',
        join(scripts, 'Dockerfile'),
        scripts,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
  }
  return image;
}

/** Verifies the dated input the same way the offline pipeline does, and returns its identity. */
async function verifiedInputs(inputs: string) {
  const sums = await readFile(join(inputs, 'SHA256SUMS'), 'utf8');
  const data = JSON.parse(await readFile(join(inputs, 'data.json'), 'utf8')) as {
    dataDate: string;
    osmTimestamp: string;
  };
  const line = sums
    .split('\n')
    .map((entry) => /^([0-9a-f]{64}) {2}(alberta-british-columbia-\d{6}\.osm\.pbf)$/.exec(entry))
    .find((match) => match !== null);
  if (!line?.[1] || !line[2]) throw new Error('SHA256SUMS has no merged Alberta + BC extract');
  const [, sha256, name] = line;
  const date = /-(\d{2})(\d{2})(\d{2})\.osm\.pbf$/.exec(name);
  if (!date || `20${date[1] ?? ''}-${date[2] ?? ''}-${date[3] ?? ''}` !== data.dataDate) {
    throw new Error('The extract name disagrees with data.json');
  }
  if ((await sha256File(join(inputs, name))) !== sha256) {
    throw new Error(`${name} does not match SHA256SUMS`);
  }
  return { data, name, sha256 };
}

async function verifiedGraph(graphDirectory: string) {
  const graph = JSON.parse(await readFile(join(graphDirectory, 'graph.json'), 'utf8')) as {
    dataDate: string;
    graphId: string;
    valhallaVersion?: string;
    routingEngineVersion?: string;
  };
  if (!/^[0-9a-f]{64}$/.test(graph.graphId)) throw new Error('graph.json has no graph id');
  if ((await sha256File(join(graphDirectory, 'connected.tar'))) !== graph.graphId) {
    throw new Error('connected.tar does not match the graph id in graph.json');
  }
  const routingEngineVersion = graph.routingEngineVersion ?? graph.valhallaVersion;
  if (!routingEngineVersion) throw new Error('graph.json has no routing engine version');
  return { dataDate: graph.dataDate, graphId: graph.graphId, routingEngineVersion };
}

export async function buildDeadEndMask(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      graph: { type: 'string' },
      inputs: { type: 'string' },
      'keep-topology': { type: 'boolean', default: false },
      output: { type: 'string' },
    },
    strict: true,
  });
  if (!values.inputs || !values.graph || !values.output) {
    throw new Error(
      'usage: dead-end-mask.mts --inputs <inputs/YYMMDD> --graph <graph dir> --output <dir>',
    );
  }
  const inputs = resolve(values.inputs);
  const output = resolve(values.output);
  const scripts = resolve(import.meta.dirname);
  const started = performance.now();
  const timings: Record<string, number> = {};
  const lap = (name: string, since: number) => {
    timings[name] = Math.round(performance.now() - since) / 1000;
  };
  let since = performance.now();
  const input = await verifiedInputs(inputs);
  const graph = await verifiedGraph(resolve(values.graph));
  if (graph.dataDate !== input.data.dataDate)
    throw new Error('The graph is from another extract date');
  lap('verifyInputs', since);

  await mkdir(join(output, '.work'), { recursive: true });
  const work = await mkdtemp(join(output, '.work', 'dead-end-'));
  try {
    since = performance.now();
    const image = await builderImage(scripts);
    const { uid, gid } = userInfo();
    const extractScript = [
      'set -euo pipefail',
      `osmium tags-filter --no-progress -o /work/roads.osm.pbf /inputs/${input.name} w/highway w/route=ferry`,
      'osmium tags-filter --no-progress -R -o /work/barriers.osm.pbf /work/roads.osm.pbf n/barrier',
      'python3 /scripts/dead-end-extract.py --roads /work/roads.osm.pbf --barriers /work/barriers.osm.pbf --output /work/topology',
    ].join('\n');
    await exec(
      'docker',
      [
        'run',
        '--rm',
        '--name',
        `dead-end-mask-extract-${String(process.pid)}`,
        '--network',
        'none',
        '--cpus',
        '2',
        '--memory',
        '4g',
        '--user',
        `${String(uid)}:${String(gid)}`,
        '--env',
        'HOME=/tmp',
        '--volume',
        `${inputs}:/inputs:ro`,
        '--volume',
        `${scripts}:/scripts:ro`,
        '--volume',
        `${work}:/work`,
        image,
        'bash',
        '-c',
        extractScript,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    lap('extract', since);

    since = performance.now();
    const topology = await readTopology(join(work, 'topology'));
    const { mask } = createMask(topology, {
      graph,
      inputs: {
        extractPolicyVersion: topology.policyVersion,
        osmTimestamp: input.data.osmTimestamp,
        pbf: input.name,
        pbfSha256: input.sha256,
      },
    });
    lap('analyze', since);

    const directory = join(output, graph.graphId);
    await mkdir(directory, { recursive: true });
    const text = JSON.stringify(mask) + '\n';
    await writeFile(join(directory, 'dead-end-mask.json.partial'), text);
    await rename(
      join(directory, 'dead-end-mask.json.partial'),
      join(directory, 'dead-end-mask.json'),
    );
    const maskSha256 = createHash('sha256').update(text).digest('hex');
    const report = {
      graphId: graph.graphId,
      maskBytes: (await stat(join(directory, 'dead-end-mask.json'))).size,
      maskSha256,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      seconds: { ...timings, total: Math.round(performance.now() - started) / 1000 },
      summary: mask.summary,
    };
    await writeFile(join(directory, 'build-report.json'), JSON.stringify(report, null, 2) + '\n');
    if (values['keep-topology']) {
      // For local verification only: map data, but province-sized; never committed or deployed.
      await rm(join(directory, 'topology'), { recursive: true, force: true });
      await rename(join(work, 'topology'), join(directory, 'topology'));
    }
    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildDeadEndMask(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Dead-end mask build failed');
    process.exitCode = 1;
  });
}
