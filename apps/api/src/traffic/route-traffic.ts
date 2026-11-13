import {
  compareRouteAlternatives,
  type RouteCongestionLevel,
  type RouteTrafficAnnotation,
} from '@navoss/contracts';

import { cumulativeMeters, type Position } from './geo.js';
import type { MatchedEdge } from './map-matcher.js';
import { classifyCongestion } from './segments.js';
import type { TrafficSettings } from './settings.js';

// A stationary estimate must not turn a short blocked segment into an unbounded delay.
const MIN_DELAY_SPEED_KPH = 3;
// Roads a detour through a neighbourhood is made of. Published traffic never covers them.
const THROUGH_ROAD_CLASSES: ReadonlySet<string> = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
]);
// Two routes between the same places differ by a few metres of minor road at each end.
const MINOR_ROAD_SLACK_METERS = 100;

export interface TrafficRouteInput {
  durationSeconds: number;
  geometry: readonly Position[];
  steps: readonly { durationSeconds: number; geometry: readonly Position[] }[];
}

/**
 * Applies published segment speeds to one route. Returns undefined, meaning traffic is unavailable
 * for this route, unless published flow covers at least `routeMinCoverage` of its length.
 *
 * Delay is counted only below the free-flow band: an observed speed already includes signals and
 * turns that the routing engine's base duration also accounts for, so a segment classed `free`
 * adds nothing and a slower one adds only its time beyond the edge of that band.
 */
export function annotateRouteTraffic(
  route: TrafficRouteInput,
  edges: readonly MatchedEdge[],
  publishedSpeedsKph: ReadonlyMap<string, number>,
  settings: Pick<
    TrafficSettings,
    'freeRatio' | 'heavyRatio' | 'routeMaxDelayRatio' | 'routeMinCoverage' | 'slowRatio'
  >,
): RouteTrafficAnnotation | undefined {
  const segmentCount = route.geometry.length - 1;
  const congestion = new Array<RouteCongestionLevel>(segmentCount).fill('unknown');
  const segmentDelays = new Array<number>(segmentCount).fill(0);
  const routeMeters = cumulativeMeters(route.geometry);
  let totalMeters = 0;
  let observedMeters = 0;
  for (const edge of edges) {
    if (edge.beginShapeIndex >= edge.endShapeIndex || edge.endShapeIndex > segmentCount) {
      return undefined;
    }
    totalMeters += edge.lengthMeters;
    const speedKph =
      edge.segmentKey === undefined ? undefined : publishedSpeedsKph.get(edge.segmentKey);
    if (speedKph === undefined) continue;
    observedMeters += edge.lengthMeters;
    congestion.fill(
      classifyCongestion(speedKph, edge.speedKph, settings),
      edge.beginShapeIndex,
      edge.endShapeIndex,
    );
    const delaySeconds = Math.max(
      0,
      (edge.lengthMeters * 3.6) / Math.max(speedKph, MIN_DELAY_SPEED_KPH) -
        (edge.lengthMeters * 3.6) / (edge.speedKph * settings.freeRatio),
    );
    if (delaySeconds === 0) continue;
    const lengths = routeMeters
      .slice(edge.beginShapeIndex + 1, edge.endShapeIndex + 1)
      .map((meters, offset) => meters - (routeMeters[edge.beginShapeIndex + offset] ?? meters));
    const shapeMeters = lengths.reduce((sum, meters) => sum + meters, 0);
    lengths.forEach((meters, offset) => {
      const index = edge.beginShapeIndex + offset;
      segmentDelays[index] =
        (segmentDelays[index] ?? 0) +
        delaySeconds * (shapeMeters > 0 ? meters / shapeMeters : 1 / lengths.length);
    });
  }
  if (totalMeters <= 0 || observedMeters / totalMeters < settings.routeMinCoverage) {
    return undefined;
  }

  // However slow the published speeds, traffic may only add a bounded share of the route's
  // typical duration. Published speeds come from a handful of contributors; a wrong or planted
  // jam must not be able to make a route look arbitrarily bad.
  const uncappedDelay = segmentDelays.reduce((sum, delay) => sum + delay, 0);
  const delayCap = route.durationSeconds * settings.routeMaxDelayRatio;
  if (uncappedDelay > delayCap) {
    const scale = delayCap / uncappedDelay;
    segmentDelays.forEach((delay, index) => {
      segmentDelays[index] = delay * scale;
    });
  }

  // Guidance sums step durations for the remaining time, so each step carries its own delay.
  // Steps tile the route geometry end to end; the arrival step is a repeated point.
  const stepDurationsSeconds: number[] = [];
  let segmentIndex = 0;
  for (const step of route.steps) {
    const stepSegments = step.geometry.length - 1;
    const start = step.geometry[0];
    const end = step.geometry[stepSegments];
    const zeroLength = start?.[0] === end?.[0] && start?.[1] === end?.[1] && stepSegments === 1;
    if (zeroLength) {
      stepDurationsSeconds.push(step.durationSeconds);
      continue;
    }
    const routeStart = route.geometry[segmentIndex];
    const routeEnd = route.geometry[segmentIndex + stepSegments];
    if (
      routeStart?.[0] !== start?.[0] ||
      routeStart?.[1] !== start?.[1] ||
      routeEnd?.[0] !== end?.[0] ||
      routeEnd?.[1] !== end?.[1]
    ) {
      return undefined;
    }
    stepDurationsSeconds.push(
      step.durationSeconds +
        segmentDelays
          .slice(segmentIndex, segmentIndex + stepSegments)
          .reduce((sum, delay) => sum + delay, 0),
    );
    segmentIndex += stepSegments;
  }
  if (segmentIndex !== segmentCount) return undefined;

  const delaySeconds = Math.round(segmentDelays.reduce((sum, delay) => sum + delay, 0) * 10) / 10;
  return {
    congestion,
    delaySeconds,
    durationSeconds: route.durationSeconds + delaySeconds,
    observedFraction: Math.min(1, Math.round((observedMeters / totalMeters) * 100) / 100),
    stepDurationsSeconds,
    typicalDurationSeconds: route.durationSeconds,
  };
}

/** Metres of a walked route on roads below tertiary class: residential, service and the like. */
export function minorRoadMeters(edges: readonly MatchedEdge[]): number {
  return edges.reduce(
    (sum, edge) => sum + (THROUGH_ROAD_CLASSES.has(edge.roadClass) ? 0 : edge.lengthMeters),
    0,
  );
}

export interface RankableRoute {
  distanceMeters: number;
  durationSeconds: number;
  /** `minorRoadMeters` of the route, or undefined when the route could not be walked. */
  minorMeters: number | undefined;
}

/**
 * Re-ranks routes on traffic-adjusted durations, starting from the routing engine's own order.
 * A route moves ahead of one the engine ranked above it only when it is faster with traffic and
 * does not use more minor-road distance than the route it overtakes. Traffic can therefore swap
 * one through-road route for another, but it can never be the reason a driver is sent down
 * residential or service streets, however slow a published speed claims the main road is.
 */
export function rankWithTraffic<Route extends RankableRoute>(routes: readonly Route[]): Route[] {
  const ranked = [...routes];
  let swapped = true;
  while (swapped) {
    swapped = false;
    for (let index = 0; index + 1 < ranked.length; index += 1) {
      const ahead = ranked[index];
      const behind = ranked[index + 1];
      if (
        ahead !== undefined &&
        behind !== undefined &&
        compareRouteAlternatives(behind, ahead) < 0 &&
        behind.minorMeters !== undefined &&
        ahead.minorMeters !== undefined &&
        behind.minorMeters <= ahead.minorMeters + MINOR_ROAD_SLACK_METERS
      ) {
        ranked[index] = behind;
        ranked[index + 1] = ahead;
        swapped = true;
      }
    }
  }
  return ranked;
}
