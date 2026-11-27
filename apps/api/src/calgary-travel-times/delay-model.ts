import type { RouteCongestionLevel, RouteTrafficAnnotation } from '@navoss/contracts';

import { cumulativeMeters, type Position } from '../traffic/geo.js';
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
  /** Road directions whose readings contradicted each other even as intervals. */
  contradictoryGroups: number;
  /** Corridors that took part (placed, with a fresh reading and a baseline). */
  corridors: number;
  /** City excess per corridor in seconds after the rounding allowance. */
  excessSeconds: ReadonlyMap<string, number>;
  /** Fitted delay a route driving each corridor end to end receives, in seconds. */
  fittedSeconds: ReadonlyMap<string, number>;
  latestUpdateMs: number;
  /** Road directions left without delay because the solver did not settle. */
  unconvergedGroups: number;
}

/**
 * What one corridor's reading says about its real excess, in seconds. Live and baseline are each
 * rounded to the minute, so the real excess lies within one minute either side of their
 * difference, and is never negative.
 */
export function corridorExcessBounds(
  reading: Pick<CorridorReading, 'baselineMinutes' | 'liveMinutes'>,
): ExcessBounds {
  const difference = reading.liveMinutes - reading.baselineMinutes;
  return {
    lower: Math.max(0, difference - ROUNDING_ALLOWANCE_MINUTES) * 60,
    upper: Math.max(0, difference + ROUNDING_ALLOWANCE_MINUTES) * 60,
  };
}

/** The least excess a corridor's reading proves: live minus baseline beyond rounding. */
export function corridorExcessSeconds(
  reading: Pick<CorridorReading, 'baselineMinutes' | 'liveMinutes'>,
): number {
  return corridorExcessBounds(reading).lower;
}

/**
 * Builds the per-section delay model.
 *
 * Corridors nest and overlap, so the road is cut into sections: stretches covered by the same set
 * of corridors. Each corridor's reading bounds the sum of its sections' delays (one minute of
 * rounding either side of live minus baseline); the sections get the least delay that meets those
 * bounds, none on a section a covering corridor reports clear unless the readings force it there
 * (`fitSectionDelays`). The delay is absolute City time, shared by length; the routing engine's
 * free-flow speed never enters it. Congestion levels come from live against baseline on the same
 * sections.
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

  const bounds = active.map((corridor) => {
    const reading = readings.get(corridor.segment);
    return reading === undefined ? { lower: 0, upper: 0 } : corridorExcessBounds(reading);
  });
  const excess = bounds.map((bound) => bound.lower);
  const membership = active.map(() => [] as number[]);
  sections.forEach((section, index) => {
    for (const corridor of section.corridors) membership[corridor]?.push(index);
  });
  const fit = fitSectionDelays(sections, bounds);
  const { delays } = fit;

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
    contradictoryGroups: fit.contradictory,
    corridors: active.length,
    excessSeconds: new Map(active.map((corridor, index) => [corridor.segment, excess[index] ?? 0])),
    fittedSeconds,
    unconvergedGroups: fit.unconverged,
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

// An excluded point stays this far from both ends of its edge.
export const END_CLEARANCE_METERS = 10;

export interface DelayedPoint {
  /** Direction of travel, degrees clockwise from north. */
  headingDegrees: number;
  latitude: number;
  longitude: number;
}

/**
 * Points along the stretches of a walked route that carry City delay, at least `spacingMeters`
 * apart and at most `limit`, each with the route's direction there: what an avoid request
 * excludes. Points are mid-edge so that each names one directed edge, not a junction.
 */
export function delayedRoutePoints(
  edges: readonly MatchedEdge[],
  model: DelayModel,
  spacingMeters: number,
  limit: number,
): DelayedPoint[] {
  const points: DelayedPoint[] = [];
  let sinceLast = Number.POSITIVE_INFINITY;
  for (const edge of edges) {
    const atoms = edge.graphId === undefined ? undefined : model.atoms.get(edge.graphId);
    const delayed = atoms?.some(
      (atom) =>
        atom.delaySecondsPerMeter > 0 &&
        atom.toFraction > edge.fromFraction &&
        atom.fromFraction < edge.toFraction,
    );
    if (delayed !== true) {
      sinceLast = Number.POSITIVE_INFINITY;
      continue;
    }
    sinceLast += edge.lengthMeters;
    // Each point lies at the middle of its edge and at least END_CLEARANCE_METERS from both ends,
    // so Valhalla snaps it to that edge, never to a node, where every edge within the heading
    // tolerance (a clear exit at a fork) would be excluded with it.
    if (
      sinceLast < spacingMeters ||
      points.length >= limit ||
      edge.lengthMeters < 2 * END_CLEARANCE_METERS
    ) {
      continue;
    }
    const middle = midpoint(edge.line);
    if (middle === undefined) continue;
    points.push({
      headingDegrees: bearingDegrees(middle.from, middle.to),
      latitude: middle.position[1],
      longitude: middle.position[0],
    });
    sinceLast = 0;
  }
  return points;
}

/** The point half way along a line, with the line segment it lies on. */
function midpoint(
  line: readonly Position[],
): { from: Position; position: Position; to: Position } | undefined {
  const along = cumulativeMeters(line);
  const total = along.at(-1) ?? 0;
  if (total < 2 * END_CLEARANCE_METERS) return undefined;
  const target = total / 2;
  for (let index = 1; index < line.length; index += 1) {
    const end = along[index] ?? 0;
    if (end < target && index < line.length - 1) continue;
    const start = along[index - 1] ?? 0;
    const from = line[index - 1];
    const to = line[index];
    if (from === undefined || to === undefined) return undefined;
    const share = end > start ? (target - start) / (end - start) : 0;
    return {
      from,
      position: [from[0] + (to[0] - from[0]) * share, from[1] + (to[1] - from[1]) * share],
      to,
    };
  }
  return undefined;
}

function bearingDegrees(from: Position, to: Position): number {
  const radians = Math.PI / 180;
  const y = Math.sin((to[0] - from[0]) * radians) * Math.cos(to[1] * radians);
  const x =
    Math.cos(from[1] * radians) * Math.sin(to[1] * radians) -
    Math.sin(from[1] * radians) * Math.cos(to[1] * radians) * Math.cos((to[0] - from[0]) * radians);
  return (Math.round(Math.atan2(y, x) / radians) + 360) % 360;
}

export interface ExcessBounds {
  lower: number;
  upper: number;
}

/**
 * Places delay on sections within what every corridor's rounded reading allows. Corridors that
 * share no section are independent and solved apart (in practice, one direction of one road).
 *
 * 1. Sections covered by a corridor whose reading allows zero delay are held at zero, and the
 *    least delay meeting every lower bound within every upper bound is found on the others,
 *    shared in proportion to length where the rows do not pin it.
 * 2. If that cannot meet the lower bounds, the held sections join in: some consistent solution
 *    needs them.
 * 3. If no solution meets every row even then, the rows contradict each other; upper bounds stay
 *    hard and every lower bound is scaled down by the same factor until all rows agree, so no
 *    stretch gets more delay than any row covering it supports.
 */
interface SectionFit {
  /** Road directions whose rows contradicted each other even as intervals. */
  contradictory: number;
  delays: number[];
  /** Road directions given no delay because the solver did not settle. */
  unconverged: number;
}

function fitSectionDelays(
  sections: readonly { corridors: readonly number[]; meters: number }[],
  bounds: readonly ExcessBounds[],
): SectionFit {
  const delays = sections.map(() => 0);
  if (bounds.every((bound) => bound.lower === 0))
    return { contradictory: 0, delays, unconverged: 0 };
  const parent = bounds.map((_, index) => index);
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
  let contradictory = 0;
  let unconverged = 0;
  for (const members of groups.values()) {
    const corridors = [...new Set(members.flatMap((index) => sections[index]?.corridors ?? []))];
    if (corridors.every((corridor) => (bounds[corridor]?.lower ?? 0) === 0)) continue;
    const held = members.filter((index) =>
      (sections[index]?.corridors ?? []).some((corridor) => (bounds[corridor]?.lower ?? 0) === 0),
    );
    const free = members.filter((index) => !held.includes(index));
    const solve = (
      variables: readonly number[],
      scale: number,
      options: SolveOptions = {},
    ): BoundedFit => solveBounded(variables, corridors, sections, bounds, scale, options);
    let fit = solve(free, 1);
    if (fit.status !== 'met') {
      // The held sections are needed. First the least delay on them that keeps every row
      // satisfiable (the other sections are nearly free), fixed there; then the rest by length.
      const least = solve(members, 1, { cheap: new Set(free) });
      if (least.status === 'met') {
        const fixed = new Map(held.map((index) => [index, least.delays.get(index) ?? 0]));
        const rest = solve(free, 1, { fixed });
        fit =
          rest.status === 'met' ? { ...rest, delays: new Map([...fixed, ...rest.delays]) } : least;
      } else {
        fit = least;
      }
    }
    if (fit.status === 'infeasible') {
      // Contradictory rows: the largest share of every lower bound that all rows allow
      // together (zero always does), found by bisection.
      contradictory += 1;
      let low = 0;
      let high = 1;
      fit = solve(members, 0);
      for (let step = 0; step < SCALE_STEPS; step += 1) {
        const middle = (low + high) / 2;
        const trial = solve(members, middle);
        if (trial.status === 'met') {
          low = middle;
          fit = trial;
        } else {
          high = middle;
        }
      }
    }
    if (fit.status !== 'met') {
      // The solver stopped without settling: no City delay on this road direction this time.
      unconverged += 1;
      continue;
    }
    for (const [index, value] of fit.delays) delays[index] = value;
  }
  return { contradictory, delays, unconverged };
}

// A lower bound missed by less than this is met; an upper bound may not be exceeded by more than
// the solver's precision.
const MET_TOLERANCE_SECONDS = 0.5;
const UPPER_TOLERANCE_SECONDS = 0.01;
const MAX_SWEEPS = 1_500;
const SCALE_STEPS = 12;

interface SolveOptions {
  /** Sections whose delay costs almost nothing: the delay is put on the others first. */
  cheap?: ReadonlySet<number>;
  /** Sections whose delay is already decided; they count towards every row they lie in. */
  fixed?: ReadonlyMap<number, number>;
}

interface BoundedFit {
  delays: Map<number, number>;
  /** `met`: settled within every bound; `infeasible`: a bound stays violated; else unsettled. */
  status: 'infeasible' | 'met' | 'unconverged';
}

// Relative cost of delay on a `cheap` section.
const CHEAP_WEIGHT = 1e-4;
// A violation left after the sweeps larger than this means the rows cannot all be met.
const INFEASIBLE_SECONDS = 1;

/**
 * The least delay (sum of delay^2 x mean length / length, `cheap` sections nearly free) on
 * `variables` such that every corridor's sum lies between `scale` x its lower bound and its upper
 * bound, by Hildreth's dual coordinate ascent, which converges for a feasible strictly convex
 * problem and keeps violating a bound for an infeasible one.
 */
function solveBounded(
  variables: readonly number[],
  corridors: readonly number[],
  sections: readonly { corridors: readonly number[]; meters: number }[],
  bounds: readonly ExcessBounds[],
  scale: number,
  options: SolveOptions = {},
): BoundedFit {
  const meanMeters =
    variables.reduce((sum, index) => sum + Math.max(sections[index]?.meters ?? 0, 1), 0) /
    Math.max(variables.length, 1);
  const curvature = variables.map(
    (index) =>
      (meanMeters / Math.max(sections[index]?.meters ?? 0, 1)) *
      (options.cheap?.has(index) === true ? CHEAP_WEIGHT : 1),
  );
  interface Row {
    columns: number[];
    limit: number;
    sign: 1 | -1;
  }
  const rows: Row[] = [];
  for (const corridor of corridors) {
    const own = variables.flatMap((index, position) =>
      (sections[index]?.corridors ?? []).includes(corridor) ? [position] : [],
    );
    let decided = 0;
    for (const [index, value] of options.fixed ?? []) {
      if ((sections[index]?.corridors ?? []).includes(corridor)) decided += value;
    }
    const bound = bounds[corridor] ?? { lower: 0, upper: 0 };
    const lower = bound.lower * scale - decided;
    const upper = bound.upper - decided;
    if (own.length === 0) {
      if (lower > MET_TOLERANCE_SECONDS || upper < -UPPER_TOLERANCE_SECONDS) {
        return { delays: new Map(), status: 'infeasible' };
      }
      continue;
    }
    rows.push({ columns: own, limit: upper, sign: 1 });
    if (lower > 0) rows.push({ columns: own, limit: -lower, sign: -1 });
  }
  curvature.forEach((_, position) => {
    rows.push({ columns: [position], limit: 0, sign: -1 });
  });
  const z = curvature.map(() => 0);
  const multipliers = rows.map(() => 0);
  const norms = rows.map((row) =>
    row.columns.reduce((sum, column) => sum + 1 / (curvature[column] ?? 1), 0),
  );
  const value = (row: Row) =>
    row.sign * row.columns.reduce((sum, column) => sum + (z[column] ?? 0), 0);
  let settled = false;
  for (let sweep = 0; sweep < MAX_SWEEPS && !settled; sweep += 1) {
    let largest = 0;
    rows.forEach((row, index) => {
      const current = multipliers[index] ?? 0;
      const next = Math.max(0, current + (value(row) - row.limit) / (norms[index] ?? 1));
      const step = next - current;
      if (step === 0) return;
      multipliers[index] = next;
      for (const column of row.columns) {
        const change = (row.sign * step) / (curvature[column] ?? 1);
        z[column] = (z[column] ?? 0) - change;
        largest = Math.max(largest, Math.abs(change));
      }
    });
    settled = largest < 1e-7;
  }
  // An upper bound is never knowingly exceeded; a lower bound may be missed by rounding noise.
  const worst = Math.max(
    0,
    ...rows.map(
      (row) =>
        value(row) - row.limit - (row.sign === 1 ? UPPER_TOLERANCE_SECONDS : MET_TOLERANCE_SECONDS),
    ),
  );
  return {
    delays: new Map(variables.map((index, position) => [index, Math.max(0, z[position] ?? 0)])),
    status:
      worst > INFEASIBLE_SECONDS ? 'infeasible' : settled && worst <= 0 ? 'met' : 'unconverged',
  };
}
