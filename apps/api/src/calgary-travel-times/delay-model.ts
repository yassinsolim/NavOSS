import type { RouteCongestionLevel, RouteTrafficAnnotation } from '@navoss/contracts';

import { cumulativeMeters, type Position } from '../traffic/geo.js';
import type { MatchedEdge } from '../traffic/map-matcher.js';
import {
  finishRouteTraffic,
  spreadEdgeDelay,
  type TrafficRouteInput,
} from '../traffic/route-traffic.js';
import { classifyCongestion } from '../traffic/segments.js';
import { type LinearConstraint, SimplexSafetyError, solveLinearProgram } from './linear-program.js';
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
  /** Road directions whose readings are certified to contradict each other even as intervals. */
  contradictoryGroups: number;
  /** Corridors that took part (placed, with a fresh reading and a baseline). */
  corridors: number;
  /** City excess per corridor in seconds after the rounding allowance. */
  excessSeconds: ReadonlyMap<string, number>;
  /** Fitted delay a route driving each corridor end to end receives, in seconds. */
  fittedSeconds: ReadonlyMap<string, number>;
  latestUpdateMs: number;
  /** Road directions left without delay because the simplex hit its safety bound (a bug). */
  safetyStoppedGroups: number;
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
  const { active, bounds, rawAtoms, sections } = delaySections(placed, readings);
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
    safetyStoppedGroups: fit.safetyStops,
    latestUpdateMs: Math.max(
      0,
      ...active.map((corridor) => readings.get(corridor.segment)?.lastUpdateMs ?? 0),
    ),
  };
}

interface RawAtom {
  from: number;
  graphId: number;
  meters: number;
  section: number;
  to: number;
}

/**
 * The fit's input: the active corridors (placed, with a reading), their excess bounds, and the
 * sections, stretches of directed edges covered by the same set of them.
 */
export function delaySections(
  placed: readonly PlacedCorridor[],
  readings: ReadonlyMap<string, CorridorReading>,
): {
  active: PlacedCorridor[];
  bounds: ExcessBounds[];
  rawAtoms: RawAtom[];
  sections: { corridors: number[]; meters: number }[];
} {
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
  return { active, bounds, rawAtoms, sections };
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

export interface DelaySection {
  /** Indexes of the corridors covering the section. */
  corridors: readonly number[];
  meters: number;
}

export interface SectionFit {
  /** Road directions whose rows are certified infeasible even as intervals. */
  contradictory: number;
  /** Delay in seconds per section. */
  delays: number[];
  /** Road directions given no delay because the simplex hit its safety bound (a bug). */
  safetyStops: number;
}

// Slack, in seconds, when an optimum found by one program is fixed as a constraint of the next.
const FIX_SLACK_SECONDS = 1e-6;
// A section whose least delay is within this of its level is pinned at the level.
const PIN_TOLERANCE_SECONDS = 1e-3;

/**
 * Places delay on sections within what every corridor's rounded reading allows, exactly, by small
 * linear programs per road direction (corridors that share no section are solved apart). With
 * `x` the delay per section, each corridor `c` requires `lower_c <= sum of its sections' x <=
 * upper_c`, and `x >= 0`.
 *
 * 1. Feasibility. If no `x` meets every row, the rows contradict each other (certified by the
 *    phase-one optimum); then upper bounds stay hard and every lower bound is scaled by the
 *    largest common share `t` in [0, 1] that all rows allow, itself a linear program.
 * 2. Held sections, those covered by a corridor whose reading allows zero delay: their total
 *    delay is minimised and fixed there.
 * 3. Total delay is minimised and fixed there, so the model never reports more than the rows
 *    force.
 * 4. Within those totals the delay is shared by length: lexicographic min-max of delay per metre
 *    (the largest delay per metre is minimised, the sections that cannot go below it are fixed,
 *    and the rest repeat), first over the held sections, then over the others. That allocation
 *    is unique, so the answer does not depend on the order of rows or sections.
 */
export function fitSectionDelays(
  sections: readonly DelaySection[],
  bounds: readonly ExcessBounds[],
): SectionFit {
  const delays = sections.map(() => 0);
  const fit: SectionFit = { contradictory: 0, delays, safetyStops: 0 };
  if (bounds.every((bound) => bound.lower <= 0)) return fit;
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
    const [first] = section.corridors;
    if (first === undefined) return;
    const root = find(first);
    const list = groups.get(root) ?? [];
    list.push(index);
    groups.set(root, list);
  });
  for (const members of groups.values()) {
    const corridors = [...new Set(members.flatMap((index) => sections[index]?.corridors ?? []))];
    if (corridors.every((corridor) => (bounds[corridor]?.lower ?? 0) <= 0)) continue;
    try {
      const group = fitGroup(
        members.map((index) => sections[index] ?? { corridors: [], meters: 0 }),
        corridors,
        bounds,
      );
      if (group.contradictory) fit.contradictory += 1;
      group.delays.forEach((value, position) => {
        delays[members[position] ?? 0] = value;
      });
    } catch (error: unknown) {
      if (!(error instanceof SimplexSafetyError)) throw error;
      fit.safetyStops += 1;
    }
  }
  return fit;
}

function fitGroup(
  sections: readonly DelaySection[],
  corridors: readonly number[],
  bounds: readonly ExcessBounds[],
): { contradictory: boolean; delays: number[] } {
  const count = sections.length;
  const row = (corridor: number, extra = 0) => [
    ...sections.map((section) => (section.corridors.includes(corridor) ? 1 : 0)),
    ...new Array<number>(extra).fill(0),
  ];
  const boundRows = (lowers: readonly number[]): LinearConstraint[] =>
    corridors.flatMap((corridor, index) => {
      const upper: LinearConstraint = {
        coefficients: row(corridor),
        relation: '<=',
        value: bounds[corridor]?.upper ?? 0,
      };
      const lower = lowers[index] ?? 0;
      return lower > 0
        ? [upper, { coefficients: row(corridor), relation: '>=', value: lower }]
        : [upper];
    });
  const solve = (objective: readonly number[], constraints: readonly LinearConstraint[]) => {
    const solution = solveLinearProgram({ constraints, objective });
    if (solution.status !== 'optimal') throw new SimplexSafetyError();
    return solution;
  };

  let lowers = corridors.map((corridor) => bounds[corridor]?.lower ?? 0);
  let contradictory = false;
  if (
    solveLinearProgram({
      constraints: boundRows(lowers),
      objective: new Array<number>(count).fill(0),
    }).status === 'infeasible'
  ) {
    contradictory = true;
    // Variables: the sections, then the share t. Maximise t with t * lower_c <= sum <= upper_c.
    const share = solve(
      [...new Array<number>(count).fill(0), -1],
      [
        ...corridors.flatMap((corridor, index): LinearConstraint[] => [
          { coefficients: row(corridor, 1), relation: '<=', value: bounds[corridor]?.upper ?? 0 },
          {
            coefficients: [...row(corridor), -(lowers[index] ?? 0)],
            relation: '>=',
            value: 0,
          },
        ]),
        { coefficients: [...new Array<number>(count).fill(0), 1], relation: '<=', value: 1 },
      ],
    );
    const t = share.x[count] ?? 0;
    lowers = lowers.map((lower) => Math.max(0, t * lower - FIX_SLACK_SECONDS));
  }
  const constraints = boundRows(lowers);

  const held = sections.map((section) =>
    section.corridors.some((corridor) => (bounds[corridor]?.lower ?? 0) <= 0),
  );
  const indicator = (pick: (index: number) => boolean) =>
    sections.map((_, index) => (pick(index) ? 1 : 0));
  // Stages 2 and 3: least held delay, then least total delay, each fixed for what follows.
  for (const pick of [(index: number) => held[index] === true, () => true]) {
    const objective = indicator(pick);
    if (objective.every((value) => value === 0)) continue;
    const least = solve(objective, constraints);
    constraints.push({
      coefficients: objective,
      relation: '<=',
      value: least.value + FIX_SLACK_SECONDS,
    });
  }

  // Stage 4: lexicographic min-max of delay per metre, held sections first.
  const meters = sections.map((section) => Math.max(section.meters, 1));
  const delays = new Array<number>(count).fill(0);
  for (const pick of [
    (index: number) => held[index] === true,
    (index: number) => held[index] !== true,
  ]) {
    let open = sections.map((_, index) => index).filter(pick);
    while (open.length > 0) {
      // Variables: the sections, then r. Minimise r with x_k <= r * m_k for every open k.
      const level = solve(
        [...new Array<number>(count).fill(0), 1],
        [
          ...constraints.map((constraint) => ({
            ...constraint,
            coefficients: [...constraint.coefficients, 0],
          })),
          ...open.map((index): LinearConstraint => {
            const coefficients = new Array<number>(count + 1).fill(0);
            coefficients[index] = 1;
            coefficients[count] = -(meters[index] ?? 1);
            return { coefficients, relation: '<=', value: 0 };
          }),
        ],
      );
      const r = level.x[count] ?? 0;
      const caps = open.map((index): LinearConstraint => {
        const coefficients = new Array<number>(count).fill(0);
        coefficients[index] = 1;
        return {
          coefficients,
          relation: '<=',
          value: r * (meters[index] ?? 1) + FIX_SLACK_SECONDS,
        };
      });
      // A section is pinned when it cannot go below the level; a section already below it in
      // this solution is not, so only those at the level are tested. The optima above were fixed
      // with a little slack, so "cannot go below" allows `PIN_TOLERANCE_SECONDS`.
      const candidates = open.flatMap((index) => {
        const target = r * (meters[index] ?? 1);
        if ((level.x[index] ?? 0) < target - PIN_TOLERANCE_SECONDS) return [];
        const objective = new Array<number>(count).fill(0);
        objective[index] = 1;
        return [{ gap: solve(objective, [...constraints, ...caps]).value - target, index }];
      });
      const pinned = candidates
        .filter((candidate) => candidate.gap >= -PIN_TOLERANCE_SECONDS)
        .map((candidate) => candidate.index);
      // Some section always sits at the optimal level; should tolerance hide it, the one that
      // can drop least is it.
      const closest = [...candidates].sort((left, right) => right.gap - left.gap)[0];
      // No section at the level at all would be a solver bug.
      if (closest === undefined) throw new SimplexSafetyError();
      const fixed = pinned.length > 0 ? pinned : [closest.index];
      for (const index of fixed) {
        const value = r * (meters[index] ?? 1);
        delays[index] = value;
        const coefficients = new Array<number>(count).fill(0);
        coefficients[index] = 1;
        constraints.push(
          { coefficients, relation: '<=', value: value + FIX_SLACK_SECONDS },
          { coefficients, relation: '>=', value: Math.max(0, value - FIX_SLACK_SECONDS) },
        );
      }
      open = open.filter((index) => !fixed.includes(index));
    }
  }
  return { contradictory, delays };
}
