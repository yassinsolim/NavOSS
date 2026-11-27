import type { RouteCongestionLevel, RouteTrafficAnnotation } from '@navoss/contracts';

import { cumulativeMeters } from '../traffic/geo.js';
import type { MatchedEdge } from '../traffic/map-matcher.js';
import {
  finishRouteTraffic,
  spreadEdgeDelay,
  type TrafficRouteInput,
} from '../traffic/route-traffic.js';
import { classifyCongestion } from '../traffic/segments.js';
import type { TrafficSettings } from '../traffic/settings.js';

/**
 * Whole-minute values are rounded on both sides: a corridor whose real time equals its baseline
 * can read up to one minute above it (live rounded up half a minute, baseline rounded down half a
 * minute). Only the excess beyond that minute is evidence of a delay.
 */
export const ROUNDING_ALLOWANCE_MINUTES = 1;
// Relative weight of the length prior (delay^2 / length, scaled by the mean section length). Small
// enough that the fit to the corridors dominates; it only decides how an excess that no corridor
// localises is shared, which is in proportion to length.
const LENGTH_PRIOR_WEIGHT = 1e-4;

/** One stretch of a directed graph edge a placed corridor runs along. */
export interface CorridorPiece {
  /** Full length of the directed edge in metres. */
  edgeMeters: number;
  fromFraction: number;
  /** The directed edge's GraphId on the serving graph. Never stored. */
  graphId: number;
  toFraction: number;
}

export interface PlacedCorridor {
  lengthMeters: number;
  pieces: readonly CorridorPiece[];
  segment: string;
}

export interface CorridorReading {
  baselineMinutes: number;
  lastUpdateMs: number;
  liveMinutes: number;
}

/** A stretch of one directed edge covered by the same set of corridors. */
export interface DelayAtom {
  /** Seconds of City delay per metre of this stretch. */
  delaySecondsPerMeter: number;
  fromFraction: number;
  level: RouteCongestionLevel;
  /** Oldest `last_update` of the corridors covering it. */
  oldestUpdateMs: number;
  toFraction: number;
}

export interface DelayModel {
  /** Atoms per directed edge, sorted by fraction. */
  atoms: ReadonlyMap<number, readonly DelayAtom[]>;
  /** Corridors that took part (placed, with a fresh reading and a baseline). */
  corridors: number;
  /** City excess per corridor in seconds after the rounding allowance. */
  excessSeconds: ReadonlyMap<string, number>;
  /** Fitted delay a route driving each corridor end to end receives, in seconds. */
  fittedSeconds: ReadonlyMap<string, number>;
  latestUpdateMs: number;
}

/** The City's excess for one corridor: live minus baseline, beyond rounding, never negative. */
export function corridorExcessSeconds(
  reading: Pick<CorridorReading, 'baselineMinutes' | 'liveMinutes'>,
): number {
  return (
    Math.max(0, reading.liveMinutes - reading.baselineMinutes - ROUNDING_ALLOWANCE_MINUTES) * 60
  );
}

/**
 * Builds the per-section delay model.
 *
 * Corridors nest and overlap, so the road is cut into sections: stretches covered by the same set
 * of corridors. Each section gets a delay in seconds; the delays are the non-negative least-squares
 * fit to every corridor's excess (the sum of its sections' delays should equal its excess), with
 * a vanishing prior that shares an excess no corridor localises in proportion to length. The
 * delay is absolute City time, shared by length; the routing engine's free-flow speed never
 * enters it. Congestion levels come from live against baseline on the same sections.
 */
export function buildDelayModel(
  placed: readonly PlacedCorridor[],
  readings: ReadonlyMap<string, CorridorReading>,
  thresholds: Pick<TrafficSettings, 'freeRatio' | 'heavyRatio' | 'slowRatio'>,
): DelayModel {
  const active = placed.filter(
    (corridor) => readings.has(corridor.segment) && corridor.lengthMeters > 0,
  );
  // Breakpoints of every directed edge any active corridor touches.
  const byEdge = new Map<number, { corridor: number; piece: CorridorPiece }[]>();
  active.forEach((corridor, index) => {
    for (const piece of corridor.pieces) {
      if (piece.toFraction <= piece.fromFraction) continue;
      const list = byEdge.get(piece.graphId) ?? [];
      list.push({ corridor: index, piece });
      byEdge.set(piece.graphId, list);
    }
  });
  interface RawAtom {
    from: number;
    graphId: number;
    meters: number;
    section: number;
    to: number;
  }
  const rawAtoms: RawAtom[] = [];
  const sectionIds = new Map<string, number>();
  const sections: { corridors: number[]; meters: number }[] = [];
  for (const [graphId, list] of byEdge) {
    const cuts = [
      ...new Set(list.flatMap(({ piece }) => [piece.fromFraction, piece.toFraction])),
    ].sort((left, right) => left - right);
    for (let index = 0; index + 1 < cuts.length; index += 1) {
      const from = cuts[index] ?? 0;
      const to = cuts[index + 1] ?? 0;
      const covering = [
        ...new Set(
          list
            .filter(({ piece }) => piece.fromFraction <= from && piece.toFraction >= to)
            .map(({ corridor }) => corridor),
        ),
      ].sort((left, right) => left - right);
      if (covering.length === 0) continue;
      const edgeMeters = list[0]?.piece.edgeMeters ?? 0;
      const meters = (to - from) * edgeMeters;
      const key = covering.join(',');
      let section = sectionIds.get(key);
      if (section === undefined) {
        section = sections.length;
        sectionIds.set(key, section);
        sections.push({ corridors: covering, meters: 0 });
      }
      const target = sections[section];
      if (target !== undefined) target.meters += meters;
      rawAtoms.push({ from, graphId, meters, section, to });
    }
  }

  const excess = active.map((corridor) => {
    const reading = readings.get(corridor.segment);
    return reading === undefined ? 0 : corridorExcessSeconds(reading);
  });
  const membership = active.map(() => [] as number[]);
  sections.forEach((section, index) => {
    for (const corridor of section.corridors) membership[corridor]?.push(index);
  });
  const delays = fitSectionDelays(sections, excess);

  const levels = sections.map((section, index) => {
    // Baseline seconds per metre of the section: the mean of the corridors covering it.
    const baseline =
      section.corridors.reduce((sum, corridor) => {
        const reading = readings.get(active[corridor]?.segment ?? '');
        const length = active[corridor]?.lengthMeters ?? 0;
        return (
          sum + (reading === undefined || length <= 0 ? 0 : (reading.baselineMinutes * 60) / length)
        );
      }, 0) / section.corridors.length;
    const delayPerMeter = section.meters > 0 ? (delays[index] ?? 0) / section.meters : 0;
    if (baseline <= 0) return 'unknown' as const;
    // Speed against free flow is baseline time over congested time.
    return classifyCongestion(baseline, baseline + delayPerMeter, thresholds);
  });
  const oldest = sections.map((section) =>
    Math.min(
      ...section.corridors.map(
        (corridor) => readings.get(active[corridor]?.segment ?? '')?.lastUpdateMs ?? 0,
      ),
    ),
  );

  const atoms = new Map<number, DelayAtom[]>();
  for (const atom of rawAtoms) {
    const section = sections[atom.section];
    const list = atoms.get(atom.graphId) ?? [];
    list.push({
      delaySecondsPerMeter:
        section !== undefined && section.meters > 0
          ? (delays[atom.section] ?? 0) / section.meters
          : 0,
      fromFraction: atom.from,
      level: levels[atom.section] ?? 'unknown',
      oldestUpdateMs: oldest[atom.section] ?? 0,
      toFraction: atom.to,
    });
    atoms.set(atom.graphId, list);
  }
  const fittedSeconds = new Map(
    active.map((corridor, index) => [
      corridor.segment,
      (membership[index] ?? []).reduce((sum, section) => sum + (delays[section] ?? 0), 0),
    ]),
  );
  return {
    atoms,
    corridors: active.length,
    excessSeconds: new Map(active.map((corridor, index) => [corridor.segment, excess[index] ?? 0])),
    fittedSeconds,
    latestUpdateMs: Math.max(
      0,
      ...active.map((corridor) => readings.get(corridor.segment)?.lastUpdateMs ?? 0),
    ),
  };
}

// Below this much corridor length a route only crosses a corridor's end; it is not annotated.
export const MIN_OBSERVED_METERS = 100;
const LEVEL_ORDER: readonly RouteCongestionLevel[] = [
  'unknown',
  'free',
  'slow',
  'heavy',
  'stopped',
];

export interface CityRouteTraffic {
  annotation: RouteTrafficAnnotation;
  /** Oldest `last_update` of the corridors the route used. */
  oldestUpdateMs: number;
}

/**
 * Applies the model to one walked route. Every metre the route drives on a placed corridor
 * stretch gets that stretch's delay per metre; nothing else changes. Returns undefined when the
 * route drives less than `MIN_OBSERVED_METERS` of placed corridors (it is left untouched) or the
 * walk does not tile the route. A route on corridors with no delay is annotated with zero delay
 * and `free` congestion there: the City reports those roads clear.
 */
export function annotateCityRoute(
  route: TrafficRouteInput,
  edges: readonly MatchedEdge[],
  model: DelayModel,
  routeMaxDelayRatio: number,
): CityRouteTraffic | undefined {
  const segmentCount = route.geometry.length - 1;
  const congestion = new Array<RouteCongestionLevel>(segmentCount).fill('unknown');
  const segmentDelays = new Array<number>(segmentCount).fill(0);
  const routeMeters = cumulativeMeters(route.geometry);
  let totalMeters = 0;
  let observedMeters = 0;
  let oldestUpdateMs = Number.POSITIVE_INFINITY;
  for (const edge of edges) {
    if (edge.beginShapeIndex >= edge.endShapeIndex || edge.endShapeIndex > segmentCount) {
      return undefined;
    }
    totalMeters += edge.lengthMeters;
    const atoms = edge.graphId === undefined ? undefined : model.atoms.get(edge.graphId);
    const share = edge.toFraction - edge.fromFraction;
    if (atoms === undefined || share <= 0) continue;
    const edgeMeters = edge.lengthMeters / share;
    let delaySeconds = 0;
    let level: RouteCongestionLevel = 'unknown';
    let levelMeters = 0;
    for (const atom of atoms) {
      const overlap =
        (Math.min(edge.toFraction, atom.toFraction) -
          Math.max(edge.fromFraction, atom.fromFraction)) *
        edgeMeters;
      if (overlap <= 0) continue;
      observedMeters += overlap;
      delaySeconds += overlap * atom.delaySecondsPerMeter;
      oldestUpdateMs = Math.min(oldestUpdateMs, atom.oldestUpdateMs);
      if (
        overlap > levelMeters ||
        (overlap === levelMeters && LEVEL_ORDER.indexOf(atom.level) > LEVEL_ORDER.indexOf(level))
      ) {
        level = atom.level;
        levelMeters = overlap;
      }
    }
    if (levelMeters === 0) continue;
    congestion.fill(level, edge.beginShapeIndex, edge.endShapeIndex);
    spreadEdgeDelay(segmentDelays, routeMeters, edge, delaySeconds);
  }
  if (totalMeters <= 0 || observedMeters < MIN_OBSERVED_METERS) return undefined;
  const annotation = finishRouteTraffic(
    route,
    segmentDelays,
    congestion,
    Math.min(1, observedMeters / totalMeters),
    routeMaxDelayRatio,
  );
  return annotation === undefined ? undefined : { annotation, oldestUpdateMs };
}

/**
 * Minimises the sum over corridors of (sum of its section delays - its excess)^2 plus a vanishing
 * length prior, every delay non-negative. Corridors that share no section are independent, so
 * each connected group (in practice one direction of one road) is solved on its own with the
 * Lawson-Hanson active-set method on the normal equations, which terminates exactly.
 */
function fitSectionDelays(
  sections: readonly { corridors: readonly number[]; meters: number }[],
  excess: readonly number[],
): number[] {
  const delays = sections.map(() => 0);
  if (excess.every((value) => value === 0)) return delays;
  // Group sections by connectivity through shared corridors.
  const parent = excess.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] ?? root;
    parent[index] = root;
    return root;
  };
  for (const section of sections) {
    const [first, ...rest] = section.corridors;
    if (first === undefined) continue;
    for (const other of rest) parent[find(other)] = find(first);
  }
  const groups = new Map<number, number[]>();
  sections.forEach((section, index) => {
    const root = find(section.corridors[0] ?? 0);
    const list = groups.get(root) ?? [];
    list.push(index);
    groups.set(root, list);
  });
  for (const members of groups.values()) {
    if (
      members.every((index) => (sections[index]?.corridors ?? []).every((c) => excess[c] === 0))
    ) {
      continue;
    }
    const meanMeters =
      members.reduce((sum, index) => sum + Math.max(sections[index]?.meters ?? 0, 1), 0) /
      members.length;
    const size = members.length;
    // Q = A'A + prior, b = A'e over this group's sections.
    const q = members.map((row) =>
      members.map((column) => {
        const left = sections[row]?.corridors ?? [];
        const right = new Set(sections[column]?.corridors ?? []);
        return left.filter((corridor) => right.has(corridor)).length;
      }),
    );
    members.forEach((index, position) => {
      const row = q[position];
      if (row !== undefined) {
        row[position] =
          (row[position] ?? 0) +
          (LENGTH_PRIOR_WEIGHT * meanMeters) / Math.max(sections[index]?.meters ?? 0, 1);
      }
    });
    const b = members.map((index) =>
      (sections[index]?.corridors ?? []).reduce(
        (sum, corridor) => sum + (excess[corridor] ?? 0),
        0,
      ),
    );
    const solution = nonNegativeQuadratic(q, b, size);
    members.forEach((index, position) => {
      delays[index] = solution[position] ?? 0;
    });
  }
  return delays;
}

/** Lawson-Hanson: minimise x'Qx/2 - b'x subject to x >= 0, Q symmetric positive definite. */
function nonNegativeQuadratic(
  q: readonly number[][],
  b: readonly number[],
  size: number,
): number[] {
  const tolerance = 1e-9;
  let x = new Array<number>(size).fill(0);
  const passive = new Set<number>();
  const gradient = (point: readonly number[]): number[] =>
    b.map((value, row) =>
      (q[row] ?? []).reduce((sum, entry, column) => sum - entry * (point[column] ?? 0), value),
    );
  for (let outer = 0; outer < 4 * size + 10; outer += 1) {
    const w = gradient(x);
    let best = -1;
    let bestValue = tolerance;
    w.forEach((value, index) => {
      if (!passive.has(index) && value > bestValue) {
        best = index;
        bestValue = value;
      }
    });
    if (best < 0) break;
    passive.add(best);
    for (let inner = 0; inner < 4 * size + 10; inner += 1) {
      const z = solvePassive(q, b, passive, size);
      const negative = [...passive].filter((index) => (z[index] ?? 0) <= tolerance);
      if (negative.length === 0) {
        x = z;
        break;
      }
      let alpha = 1;
      for (const index of negative) {
        const current = x[index] ?? 0;
        const step = current - (z[index] ?? 0);
        if (step > 0) alpha = Math.min(alpha, current / step);
      }
      x = x.map((value, index) => value + alpha * ((z[index] ?? 0) - value));
      for (const index of [...passive]) {
        if ((x[index] ?? 0) <= tolerance) {
          passive.delete(index);
          x[index] = 0;
        }
      }
    }
  }
  return x.map((value) => Math.max(0, value));
}

/** Solves Q_PP z_P = b_P by Gaussian elimination with partial pivoting; z is zero elsewhere. */
function solvePassive(
  q: readonly number[][],
  b: readonly number[],
  passive: ReadonlySet<number>,
  size: number,
): number[] {
  const indexes = [...passive].sort((left, right) => left - right);
  const matrix = indexes.map((row) => [
    ...indexes.map((column) => q[row]?.[column] ?? 0),
    b[row] ?? 0,
  ]);
  const n = indexes.length;
  for (let pivot = 0; pivot < n; pivot += 1) {
    let best = pivot;
    for (let row = pivot + 1; row < n; row += 1) {
      if (Math.abs(matrix[row]?.[pivot] ?? 0) > Math.abs(matrix[best]?.[pivot] ?? 0)) best = row;
    }
    const swap = matrix[pivot];
    matrix[pivot] = matrix[best] ?? [];
    matrix[best] = swap ?? [];
    const pivotRow = matrix[pivot] ?? [];
    const divisor = pivotRow[pivot] ?? 0;
    if (Math.abs(divisor) < 1e-15) continue;
    for (let row = pivot + 1; row < n; row += 1) {
      const target = matrix[row] ?? [];
      const factor = (target[pivot] ?? 0) / divisor;
      for (let column = pivot; column <= n; column += 1) {
        target[column] = (target[column] ?? 0) - factor * (pivotRow[column] ?? 0);
      }
    }
  }
  const solution = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    const current = matrix[row] ?? [];
    let value = current[n] ?? 0;
    for (let column = row + 1; column < n; column += 1) {
      value -= (current[column] ?? 0) * (solution[column] ?? 0);
    }
    const divisor = current[row] ?? 0;
    solution[row] = Math.abs(divisor) < 1e-15 ? 0 : value / divisor;
  }
  const z = new Array<number>(size).fill(0);
  indexes.forEach((index, position) => {
    z[index] = solution[position] ?? 0;
  });
  return z;
}
