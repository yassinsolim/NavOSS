import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  annotateCityRoute,
  buildDelayModel,
  delaySections,
  fitSectionDelays,
  corridorExcessSeconds,
  delayedRoutePoints,
  END_CLEARANCE_METERS,
  type CorridorReading,
  type PlacedCorridor,
} from '../src/calgary-travel-times/delay-model.js';
import { CORRIDOR_TABLE } from '../src/calgary-travel-times/corridors.js';
import {
  type LinearConstraint,
  solveLinearProgram,
} from '../src/calgary-travel-times/linear-program.js';
import { haversineMeters, type Position } from '../src/traffic/geo.js';
import type { MatchedEdge } from '../src/traffic/map-matcher.js';
import { DEFAULT_TRAFFIC_SETTINGS } from '../src/traffic/settings.js';

const thresholds = DEFAULT_TRAFFIC_SETTINGS;
const EDGE_METERS = 1_000;
// A straight road of ten 1 km edges, northbound ids 1..10, southbound ids 101..110.
const NB = (index: number) => index + 1;
const SB = (index: number) => 101 + index;

function corridor(
  segment: string,
  ids: number[],
  fromFraction = 0,
  toFraction = 1,
): PlacedCorridor {
  return {
    lengthMeters: ids.length * EDGE_METERS - (fromFraction + (1 - toFraction)) * EDGE_METERS,
    pieces: ids.map((graphId, index) => ({
      edgeMeters: EDGE_METERS,
      fromFraction: index === 0 ? fromFraction : 0,
      graphId,
      toFraction: index === ids.length - 1 ? toFraction : 1,
    })),
    segment,
  };
}

function reading(liveMinutes: number, baselineMinutes: number): CorridorReading {
  return { baselineMinutes, lastUpdateMs: Date.parse('2026-11-27T15:43:43Z'), liveMinutes };
}

/** A route that drives the given edges in order, one geometry segment each, at `speedKph`. */
function route(ids: number[], options: { fractions?: [number, number]; speedKph?: number } = {}) {
  const [first, last] = options.fractions ?? [0, 1];
  const geometry: Position[] = ids
    .map((_, index): Position => [-114, 51 + index * 0.009])
    .concat([[-114, 51 + ids.length * 0.009]]);
  // Slow enough that the delay cap (one route duration) never hides the tested delay.
  const speedKph = options.speedKph ?? 30;
  const edges: MatchedEdge[] = ids.map((graphId, index) => {
    const fromFraction = index === 0 ? first : 0;
    const toFraction = index === ids.length - 1 ? last : 1;
    return {
      beginShapeIndex: index,
      endShapeIndex: index + 1,
      forward: true,
      fromFraction,
      graphId,
      lengthMeters: (toFraction - fromFraction) * EDGE_METERS,
      line: [geometry[index] ?? [0, 0], geometry[index + 1] ?? [0, 0]],
      roadClass: 'motorway',
      speedKph,
      toFraction,
      use: 'road',
      wayId: 7,
    };
  });
  const engineSeconds = edges.reduce((sum, edge) => sum + (edge.lengthMeters * 3.6) / speedKph, 0);
  return {
    edges,
    route: {
      durationSeconds: engineSeconds,
      geometry,
      steps: [{ durationSeconds: engineSeconds, geometry }],
    },
  };
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, index) => from + index);

describe('City of Calgary delay model', () => {
  it('never makes a delay from rounding alone, however nested corridors read', () => {
    // A (edges 0-3) nests in B (0-9); C (5-9) overlaps B. Every live value within the rounding
    // band of its baseline, including +1 minute (live rounded up, baseline rounded down).
    const placed = [
      corridor('A', range(0, 4).map(NB)),
      corridor('B', range(0, 10).map(NB)),
      corridor('C', range(5, 10).map(NB)),
    ];
    for (const offsets of [
      [1, 1, 1],
      [1, -1, 1],
      [0, 1, 0],
      [-1, 1, 1],
    ]) {
      const readings = new Map([
        ['A', reading(4 + (offsets[0] ?? 0), 4)],
        ['B', reading(9 + (offsets[1] ?? 0), 9)],
        ['C', reading(5 + (offsets[2] ?? 0), 5)],
      ]);
      const model = buildDelayModel(placed, readings, thresholds);
      const { edges, route: input } = route(range(0, 10).map(NB));
      expect(annotateCityRoute(input, edges, model, 1)?.annotation.delaySeconds).toBe(0);
    }
    expect(corridorExcessSeconds({ baselineMinutes: 9, liveMinutes: 10 })).toBe(0);
  });

  it('gives a route along a whole corridor about its live minus baseline', () => {
    const placed = [
      corridor('A', range(0, 4).map(NB)),
      corridor('B', range(0, 10).map(NB)),
      corridor('C', range(5, 10).map(NB)),
    ];
    // A real 6-minute jam on edges 1-2: A and B both read it, C does not.
    const model = buildDelayModel(
      placed,
      new Map([
        ['A', reading(10, 4)],
        ['B', reading(15, 9)],
        ['C', reading(5, 5)],
      ]),
      thresholds,
    );
    for (const [ids, excessMinutes] of [
      [range(0, 4), 6],
      [range(0, 10), 6],
      [range(5, 10), 0],
    ] as const) {
      const { edges, route: input } = route(ids.map(NB));
      const delay = annotateCityRoute(input, edges, model, 1)?.annotation.delaySeconds ?? 0;
      expect(Math.abs(delay - excessMinutes * 60)).toBeLessThanOrEqual(60);
    }
    // The jam is localised to A's stretch: the part of B beyond A gets nothing.
    const beyond = route(range(4, 10).map(NB));
    expect(annotateCityRoute(beyond.route, beyond.edges, model, 1)?.annotation.delaySeconds).toBe(
      0,
    );
  });

  it('shares a corridor delay by length for a route using part of it', () => {
    const model = buildDelayModel(
      [corridor('X', range(0, 10).map(NB))],
      new Map([['X', reading(21, 10)]]),
      thresholds,
    );
    const full = route(range(0, 10).map(NB));
    const fullDelay = annotateCityRoute(full.route, full.edges, model, 1)?.annotation.delaySeconds;
    expect(fullDelay).toBeCloseTo(600, 0);
    // 2.5 km of 10 km, starting and ending part-way along edges.
    const part = route(range(3, 6).map(NB), { fractions: [0.5, 1] });
    const partDelay = annotateCityRoute(part.route, part.edges, model, 1)?.annotation.delaySeconds;
    expect(partDelay).toBeCloseTo(150, 0);
  });

  it('a 5 km jammed stretch of a 25 km route gets its delay: there is no coverage minimum', () => {
    const model = buildDelayModel(
      [corridor('X', range(0, 5).map(NB))],
      new Map([['X', reading(15, 4)]]),
      thresholds,
    );
    const ids = [...range(0, 5).map(NB), ...range(200, 220)];
    const { edges, route: input } = route(ids);
    const annotation = annotateCityRoute(input, edges, model, 1)?.annotation;
    expect(annotation?.observedFraction).toBe(0.2);
    expect(annotation?.delaySeconds).toBeCloseTo(600, 0);
    expect(annotation?.congestion.slice(0, 5).every((level) => level !== 'free')).toBe(true);
    expect(annotation?.congestion.slice(5).every((level) => level === 'unknown')).toBe(true);
  });

  it('never gives one direction the delay of the other', () => {
    const model = buildDelayModel(
      [corridor('NB', range(0, 10).map(NB)), corridor('SB', range(0, 10).map(SB))],
      new Map([
        ['NB', reading(30, 10)],
        ['SB', reading(10, 10)],
      ]),
      thresholds,
    );
    const southbound = route(range(0, 10).map(SB));
    const annotation = annotateCityRoute(southbound.route, southbound.edges, model, 1)?.annotation;
    expect(annotation?.delaySeconds).toBe(0);
    expect(annotation?.congestion.every((level) => level === 'free')).toBe(true);
  });

  it('adds the City excess to the engine time whatever the engine free-flow speed is', () => {
    const model = buildDelayModel(
      [corridor('X', range(0, 10).map(NB))],
      new Map([['X', reading(14, 10)]]),
      thresholds,
    );
    for (const speedKph of [40, 90, 120]) {
      const { edges, route: input } = route(range(0, 10).map(NB), { speedKph });
      const annotation = annotateCityRoute(input, edges, model, 1)?.annotation;
      expect(annotation?.delaySeconds).toBeCloseTo(180, 0);
      expect(annotation?.typicalDurationSeconds).toBeCloseTo(input.durationSeconds, 6);
      expect(annotation?.durationSeconds).toBeCloseTo(input.durationSeconds + 180, 0);
      expect(annotation?.stepDurationsSeconds[0]).toBeCloseTo(input.durationSeconds + 180, 0);
    }
  });

  it('keeps the community delay cap and treats live below baseline as clear', () => {
    const capped = buildDelayModel(
      [corridor('X', range(0, 2).map(NB))],
      new Map([['X', reading(120, 2)]]),
      thresholds,
    );
    const short = route(range(0, 2).map(NB));
    const annotation = annotateCityRoute(short.route, short.edges, capped, 1)?.annotation;
    expect(annotation?.delaySeconds).toBeCloseTo(short.route.durationSeconds, 0);
    const faster = buildDelayModel(
      [corridor('X', range(0, 2).map(NB))],
      new Map([['X', reading(1, 6)]]),
      thresholds,
    );
    expect(annotateCityRoute(short.route, short.edges, faster, 1)?.annotation.delaySeconds).toBe(0);
  });

  it('leaves a route that only touches a corridor end unannotated', () => {
    const model = buildDelayModel(
      [corridor('X', range(0, 10).map(NB))],
      new Map([['X', reading(20, 10)]]),
      thresholds,
    );
    const touching = route([NB(9), 300, 301], { fractions: [0.95, 1] });
    expect(annotateCityRoute(touching.route, touching.edges, model, 1)).toBeUndefined();
  });

  it('does not invent delay from conflicting whole-minute rows (NB Stoney partition)', () => {
    // Peigan -> McKnight (edges 0-3), McKnight -> Deerfoot (4-9), and the whole (0-9):
    // baselines 6/9/14, live 8/9/17. As intervals: [60, 180], [0, 60], [120, 240] seconds.
    const model = buildDelayModel(
      [
        corridor('Peigan-McKnight', range(0, 4).map(NB)),
        corridor('McKnight-Deerfoot', range(4, 10).map(NB)),
        corridor('Peigan-Deerfoot', range(0, 10).map(NB)),
      ],
      new Map([
        ['Peigan-McKnight', reading(8, 6)],
        ['McKnight-Deerfoot', reading(9, 9)],
        ['Peigan-Deerfoot', reading(17, 14)],
      ]),
      thresholds,
    );
    const delay = (ids: number[]) => {
      const { edges, route: input } = route(ids.map(NB));
      return annotateCityRoute(input, edges, model, 1)?.annotation.delaySeconds ?? 0;
    };
    expect(delay(range(4, 10))).toBe(0);
    expect(delay(range(0, 10))).toBeCloseTo(120, 0);
    expect(delay(range(0, 4))).toBeLessThanOrEqual(180);
    expect(delay(range(0, 4))).toBeGreaterThanOrEqual(60);
  });

  it('degrades contradictory rows to the conservative reading', () => {
    // The short corridor reads 6 minutes over; the long one containing it reads clear. No
    // delay satisfies both even as intervals: no stretch may exceed what any covering row allows.
    const model = buildDelayModel(
      [corridor('Short', range(0, 3).map(NB)), corridor('Long', range(0, 10).map(NB))],
      new Map([
        ['Short', reading(10, 4)],
        ['Long', reading(9, 9)],
      ]),
      thresholds,
    );
    for (const ids of [range(0, 3), range(0, 10), range(3, 10)]) {
      const { edges, route: input } = route(ids.map(NB));
      const delay = annotateCityRoute(input, edges, model, 1)?.annotation.delaySeconds ?? 0;
      expect(delay).toBeLessThanOrEqual(60 + 0.01);
    }
  });

  it('samples avoid points mid-edge, clear of both edge ends, never on a short edge', () => {
    // A delayed 1 km edge whose shape has a vertex 2 m after its start (the gore of a fork), and a
    // delayed 12 m connector.
    const model = buildDelayModel(
      [corridor('X', [NB(0), NB(1)])],
      new Map([['X', reading(12, 2)]]),
      thresholds,
    );
    const start: Position = [-114, 51];
    const gore: Position = [-114, 51.000018];
    const end: Position = [-114, 51.009];
    const connectorEnd: Position = [-114, 51.009108];
    const edges: MatchedEdge[] = [
      {
        beginShapeIndex: 0,
        endShapeIndex: 2,
        forward: true,
        fromFraction: 0,
        graphId: NB(0),
        lengthMeters: haversineMeters(start, end),
        line: [start, gore, end],
        roadClass: 'motorway',
        speedKph: 90,
        toFraction: 1,
        use: 'road',
        wayId: 7,
      },
      {
        beginShapeIndex: 2,
        endShapeIndex: 3,
        forward: true,
        fromFraction: 0,
        graphId: NB(1),
        lengthMeters: haversineMeters(end, connectorEnd),
        line: [end, connectorEnd],
        roadClass: 'motorway',
        speedKph: 90,
        toFraction: 1,
        use: 'road',
        wayId: 7,
      },
    ];
    const points = delayedRoutePoints(edges, model, 0, 10);
    expect(points).toHaveLength(1);
    const [point] = points;
    const position: Position = [point?.longitude ?? 0, point?.latitude ?? 0];
    expect(haversineMeters(position, start)).toBeGreaterThan(END_CLEARANCE_METERS);
    expect(haversineMeters(position, end)).toBeGreaterThan(END_CLEARANCE_METERS);
    expect(haversineMeters(position, start)).toBeCloseTo(haversineMeters(start, end) / 2, -1);
    expect(point?.headingDegrees).toBe(0);
  });

  it('puts no delay on a held section when the bounds can be met without it (SB Deerfoot)', () => {
    // Airport -> 64 Ave (edges 0-2), 64 Ave -> Memorial (3-4), Memorial -> Anderson (5-9).
    // Baseline -> live: Airport->Memorial 8 -> 9, 64 Ave->Memorial 5 -> 7, Airport->Anderson
    // 17 -> 23. Delays 0 / 60 / 240 s satisfy every row.
    const model = buildDelayModel(
      [
        corridor('Airport-Memorial', range(0, 5).map(NB)),
        corridor('64Ave-Memorial', range(3, 5).map(NB)),
        corridor('Airport-Anderson', range(0, 10).map(NB)),
      ],
      new Map([
        ['Airport-Memorial', reading(9, 8)],
        ['64Ave-Memorial', reading(7, 5)],
        ['Airport-Anderson', reading(23, 17)],
      ]),
      thresholds,
    );
    const delay = (ids: number[]) => {
      const { edges, route: input } = route(ids.map(NB));
      return annotateCityRoute(input, edges, model, 1)?.annotation.delaySeconds ?? 0;
    };
    expect(delay(range(0, 3))).toBe(0);
    expect(delay(range(3, 5))).toBeCloseTo(60, 0);
    expect(delay(range(0, 10))).toBeCloseTo(300, 0);
    expect(model.safetyStoppedGroups).toBe(0);
  });

  it('fixes the held section at its least feasible delay (NB Stoney, 7/11/19)', () => {
    // Baseline -> live: Peigan -> McKnight 6 -> 7 (allows zero), McKnight -> Deerfoot 9 -> 11,
    // the whole 14 -> 19. McKnight -> Deerfoot may carry at most 180 s, so the whole's 240 s
    // needs 60 s on Peigan -> McKnight and no more.
    const model = buildDelayModel(
      [
        corridor('Peigan-McKnight', range(0, 4).map(NB)),
        corridor('McKnight-Deerfoot', range(4, 10).map(NB)),
        corridor('Peigan-Deerfoot', range(0, 10).map(NB)),
      ],
      new Map([
        ['Peigan-McKnight', reading(7, 6)],
        ['McKnight-Deerfoot', reading(11, 9)],
        ['Peigan-Deerfoot', reading(19, 14)],
      ]),
      thresholds,
    );
    expect(model.fittedSeconds.get('Peigan-McKnight')).toBeCloseTo(60, 3);
    expect(model.fittedSeconds.get('McKnight-Deerfoot')).toBeCloseTo(180, 3);
    expect(model.fittedSeconds.get('Peigan-Deerfoot')).toBeCloseTo(240, 3);
    expect(model.contradictoryGroups).toBe(0);
  });

  it('retains required traffic delay when section rates are nearly tied', () => {
    // Whole-minute-derived bounds force a 240 s minimum across three adjoining sections.
    // The second section is within the pinning tolerance of the first rate, but pinning its
    // rate ceiling (120.0006 s) would contradict the fixed total and discard the whole delay.
    const fit = fitSectionDelays(
      [
        { corridors: [0, 3], meters: 1_000 },
        { corridors: [1, 3], meters: 2_000.01 },
        { corridors: [2, 3], meters: 3_000 },
      ],
      [
        { lower: 60, upper: 180 },
        { lower: 120, upper: 240 },
        { lower: 60, upper: 180 },
        { lower: 240, upper: 360 },
      ],
    );
    expect(fit.safetyStops).toBe(0);
    expect(fit.contradictory).toBe(0);
    for (const [index, seconds] of [60, 120, 60].entries()) {
      expect(fit.delays[index]).toBeCloseTo(seconds, 4);
    }
    expect(fit.delays.reduce((total, seconds) => total + seconds, 0)).toBeCloseTo(240, 4);
  });

  describe('on the 56 placed corridors of the real table', () => {
    // How the corridors nest and overlap on the local Alberta/BC graph, edges renumbered.
    const topology = JSON.parse(
      readFileSync(
        new URL('./fixtures/calgary-travel-times/placed-topology.json', import.meta.url),
        'utf8',
      ),
    ) as {
      corridors: {
        lengthMeters: number;
        pieces: [number, number, number, number][];
        segment: string;
      }[];
    };
    const placed: PlacedCorridor[] = topology.corridors.map((entry) => ({
      lengthMeters: entry.lengthMeters,
      pieces: entry.pieces.map(([graphId, edgeMeters, fromFraction, toFraction]) => ({
        edgeMeters,
        fromFraction,
        graphId,
        toFraction,
      })),
      segment: entry.segment,
    }));
    const baselines = new Map(
      CORRIDOR_TABLE.corridors.flatMap((definition) =>
        definition.baselineMinutes === null
          ? []
          : [[definition.segment, definition.baselineMinutes] as const],
      ),
    );
    const baseline = (segment: string) => baselines.get(segment) ?? 0;

    // Park-Miller, reproducible.
    function seeded(seed: number) {
      let state = seed;
      return () => {
        state = (state * 48_271) % 2_147_483_647;
        return state / 2_147_483_647;
      };
    }
    function shuffled<T>(items: readonly T[], random: () => number): T[] {
      const copy = [...items];
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const other = Math.floor(random() * (index + 1));
        [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
      }
      return copy;
    }
    // Whole-minute rush-hour readings: most corridors near baseline, some jammed.
    function readingsFor(random: () => number) {
      const readings = new Map<string, CorridorReading>();
      for (const corridor of placed) {
        const minutes = baseline(corridor.segment);
        const excess = random() < 0.6 ? Math.floor(random() * 3) - 1 : Math.floor(random() * 26);
        readings.set(corridor.segment, reading(Math.max(1, minutes + excess), minutes));
      }
      return readings;
    }
    const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
    // Readings a real jam would give: a random true delay per section (a third of them jammed,
    // up to 0.05 s per metre), each corridor's live time the baseline plus its sections' sum,
    // rounded to the minute. These are always consistent as intervals.
    function consistentReadingsFor(random: () => number) {
      const { sections } = delaySections(
        placed,
        new Map(
          placed.map((corridor) => [
            corridor.segment,
            reading(baseline(corridor.segment), baseline(corridor.segment)),
          ]),
        ),
      );
      const truth = sections.map((section) =>
        random() < 1 / 3 ? random() * 0.05 * section.meters : 0,
      );
      return new Map(
        placed.map((corridor, index): [string, CorridorReading] => {
          const excess = sum(
            sections.flatMap((section, position) =>
              section.corridors.includes(index) ? [truth[position] ?? 0] : [],
            ),
          );
          const minutes = baseline(corridor.segment);
          return [corridor.segment, reading(minutes + Math.round(excess / 60), minutes)];
        }),
      );
    }
    const TOLERANCE = 1e-4;

    it('places every corridor of the fixture and knows its baseline', () => {
      expect(placed).toHaveLength(56);
      expect(placed.every((corridor) => baselines.has(corridor.segment))).toBe(true);
    });

    it('gives every section zero when every corridor reads its baseline', () => {
      const model = buildDelayModel(
        placed,
        new Map(
          placed.map((corridor) => [
            corridor.segment,
            reading(baseline(corridor.segment), baseline(corridor.segment)),
          ]),
        ),
        thresholds,
      );
      for (const atoms of model.atoms.values()) {
        for (const atom of atoms) expect(atom.delaySecondsPerMeter).toBe(0);
      }
    });

    it('meets the linear-program optima for random readings, in any order', () => {
      let feasibleSeeds = 0;
      for (let seed = 1; seed <= 200; seed += 1) {
        const random = seeded(seed);
        // Odd seeds: independent random rows; even seeds: rows a real jam would give.
        const readings = seed % 2 === 0 ? consistentReadingsFor(random) : readingsFor(random);
        const { bounds, sections } = delaySections(placed, readings);
        const fit = fitSectionDelays(sections, bounds);
        expect(fit.safetyStops).toBe(0);
        for (const value of fit.delays) expect(value).toBeGreaterThanOrEqual(0);
        const rowSum = (corridor: number, delays: readonly number[]) =>
          sum(
            sections.flatMap((section, index) =>
              section.corridors.includes(corridor) ? [delays[index] ?? 0] : [],
            ),
          );
        // Upper bounds always hold.
        bounds.forEach((bound, corridor) => {
          expect(rowSum(corridor, fit.delays)).toBeLessThanOrEqual(bound.upper + TOLERANCE);
        });

        const indicator = (pick: (index: number) => boolean) =>
          sections.map((_, index) => (pick(index) ? 1 : 0));
        const constraints: LinearConstraint[] = bounds.flatMap((bound, corridor) => {
          const coefficients = indicator(
            (index) => sections[index]?.corridors.includes(corridor) === true,
          );
          return [
            { coefficients, relation: '<=' as const, value: bound.upper },
            { coefficients, relation: '>=' as const, value: bound.lower },
          ];
        });
        const feasible =
          solveLinearProgram({ constraints, objective: indicator(() => false) }).status ===
          'optimal';
        // Contradiction is reported exactly when the feasibility program has no solution.
        expect(fit.contradictory > 0).toBe(!feasible);
        if (feasible) {
          feasibleSeeds += 1;
          bounds.forEach((bound, corridor) => {
            expect(rowSum(corridor, fit.delays)).toBeGreaterThanOrEqual(bound.lower - TOLERANCE);
          });
          const held = (index: number) =>
            sections[index]?.corridors.some((corridor) => (bounds[corridor]?.lower ?? 0) <= 0) ===
            true;
          const leastHeld = solveLinearProgram({ constraints, objective: indicator(held) });
          if (leastHeld.status !== 'optimal') throw new Error('held program');
          expect(sum(fit.delays.filter((_, index) => held(index)))).toBeCloseTo(leastHeld.value, 3);
          const leastTotal = solveLinearProgram({
            constraints: [
              ...constraints,
              { coefficients: indicator(held), relation: '<=', value: leastHeld.value + 1e-6 },
            ],
            objective: indicator(() => true),
          });
          if (leastTotal.status !== 'optimal') throw new Error('total program');
          expect(sum(fit.delays)).toBeCloseTo(leastTotal.value, 3);
        }

        // The same answer with the rows (corridors) and the sections in another order.
        const order = shuffled(
          sections.map((_, index) => index),
          random,
        );
        const corridorOrder = shuffled(
          bounds.map((_, index) => index),
          random,
        );
        const newIndex = new Map(corridorOrder.map((corridor, position) => [corridor, position]));
        const permuted = fitSectionDelays(
          order.map((index) => ({
            corridors: (sections[index]?.corridors ?? []).map(
              (corridor) => newIndex.get(corridor) ?? 0,
            ),
            meters: sections[index]?.meters ?? 0,
          })),
          corridorOrder.map((corridor) => bounds[corridor] ?? { lower: 0, upper: 0 }),
        );
        order.forEach((index, position) => {
          expect(permuted.delays[position] ?? 0).toBeCloseTo(fit.delays[index] ?? 0, 3);
        });
      }
      // The seeds exercise both outcomes.
      expect(feasibleSeeds).toBeGreaterThanOrEqual(100);
      expect(feasibleSeeds).toBeLessThan(200);
    }, 120_000);
  });
});
