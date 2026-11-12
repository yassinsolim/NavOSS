import type { RouteCongestionLevel, RouteTrafficAnnotation } from '@navoss/contracts';

import { classifyCongestion } from './aggregation.js';
import { cumulativeMeters, type Position } from './geo.js';
import type { MatchedEdge } from './map-matcher.js';
import { segmentKeyForEdge } from './observations.js';
import type { TrafficSettings } from './settings.js';

// A stationary estimate must not turn a short blocked segment into an unbounded delay.
const MIN_DELAY_SPEED_KPH = 3;

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
  settings: Pick<TrafficSettings, 'freeRatio' | 'heavyRatio' | 'routeMinCoverage' | 'slowRatio'>,
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
    const key = segmentKeyForEdge(edge);
    const speedKph = key === undefined ? undefined : publishedSpeedsKph.get(key);
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
