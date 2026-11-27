import { describe, expect, it } from 'vitest';

import {
  annotateCityRoute,
  buildDelayModel,
  corridorExcessSeconds,
  type CorridorReading,
  type PlacedCorridor,
} from '../src/calgary-travel-times/delay-model.js';
import type { Position } from '../src/traffic/geo.js';
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
});
