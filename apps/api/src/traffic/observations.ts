import type { Position } from './geo.js';
import type { MatchedTrace } from './map-matcher.js';
import type { ProbePoint } from './probe-validation.js';
import { isAggregatedRoad, wayDirectionKey } from './segments.js';
import type { TrafficSettings } from './settings.js';

/**
 * One speed sample for one whole road edge. It carries no position from the upload and no time:
 * the line is the edge's map geometry, and the service stamps the arrival epoch itself.
 */
export interface SegmentObservation {
  freeFlowKph: number;
  line: Position[];
  roadClass: string;
  segmentKey: string;
  speedKph: number;
}

interface Traversal {
  firstEdgeIndex: number;
  lastEdgeIndex: number;
  meters: number;
  seconds: number;
}

/**
 * Turns one map-matched batch into at most one speed sample per road edge that the batch drove
 * end to end on an aggregated road. Speed is measured over the batch's whole run on the edge's
 * way (distance along the matched edges divided by the time between the first and last point on
 * it), because single edges are often shorter than the distance between two fixes.
 */
export function deriveObservations(
  matched: MatchedTrace,
  points: readonly ProbePoint[],
  settings: Pick<
    TrafficSettings,
    'maxSampleSpeedKph' | 'minSampleMeters' | 'minSampleSeconds' | 'slowSampleSeconds'
  >,
): SegmentObservation[] {
  // Valhalla reports only the matched part of the first and last edge, so recover full lengths to
  // place points, whose positions are shares of the full edge. A sliver of an edge gives no
  // stable full length: points on it are unusable, but it must not poison the edges after it.
  const edgeStartMeters: number[] = [];
  const fullMeters: number[] = [];
  let pathMeters = 0;
  for (const edge of matched.edges) {
    const share = edge.toFraction - edge.fromFraction;
    const full = share > 0.01 ? edge.lengthMeters / share : Number.NaN;
    edgeStartMeters.push(pathMeters);
    fullMeters.push(full);
    pathMeters += Number.isFinite(full) ? full : edge.lengthMeters;
  }

  const traversals = new Map<string, Traversal>();
  let run:
    { key: string; lastMeters: number; lastSeconds: number; traversal: Traversal } | undefined;
  points.forEach((point, index) => {
    const match = matched.points[index];
    const edge = match === undefined ? undefined : matched.edges[match.edgeIndex];
    const key = edge === undefined || !isAggregatedRoad(edge) ? undefined : wayDirectionKey(edge);
    const meters =
      match === undefined
        ? Number.NaN
        : (edgeStartMeters[match.edgeIndex] ?? Number.NaN) +
          match.edgeFraction * (fullMeters[match.edgeIndex] ?? Number.NaN);
    if (match === undefined || key === undefined || !Number.isFinite(meters)) {
      run = undefined;
      return;
    }
    // A new way, a break in the matched path, or a backwards jump starts a fresh traversal leg;
    // only movement inside one continuous leg counts as distance.
    if (run?.key !== key || match.startsNewPath || meters < run.lastMeters - 5) {
      const traversal = traversals.get(key) ?? {
        firstEdgeIndex: match.edgeIndex,
        lastEdgeIndex: match.edgeIndex,
        meters: 0,
        seconds: 0,
      };
      traversals.set(key, traversal);
      run = { key, lastMeters: meters, lastSeconds: point.offsetSeconds, traversal };
    } else {
      run.traversal.meters += Math.max(0, meters - run.lastMeters);
      run.traversal.seconds += point.offsetSeconds - run.lastSeconds;
      run.lastMeters = meters;
      run.lastSeconds = point.offsetSeconds;
    }
    run.traversal.firstEdgeIndex = Math.min(run.traversal.firstEdgeIndex, match.edgeIndex);
    run.traversal.lastEdgeIndex = Math.max(run.traversal.lastEdgeIndex, match.edgeIndex);
  });

  const observations = new Map<string, SegmentObservation>();
  for (const [wayKey, traversal] of traversals) {
    // A sample needs real distance, or enough time on the way to prove the vehicle was held up
    // there; otherwise one stationary fix pair would report a jam.
    if (
      traversal.seconds < settings.minSampleSeconds ||
      (traversal.meters < settings.minSampleMeters &&
        traversal.seconds < settings.slowSampleSeconds)
    ) {
      continue;
    }
    const speedKph = (traversal.meters / traversal.seconds) * 3.6;
    if (speedKph > settings.maxSampleSpeedKph) continue;
    matched.edges.forEach((edge, index) => {
      // Only edges driven end to end count. The first and last matched edge start or stop where
      // the trimmed trace did, so they are never credited, and an edge has no segment key at all
      // unless Valhalla returned it whole.
      if (
        index === 0 ||
        index === matched.edges.length - 1 ||
        index < traversal.firstEdgeIndex ||
        index > traversal.lastEdgeIndex ||
        edge.segmentKey === undefined ||
        !isAggregatedRoad(edge) ||
        wayDirectionKey(edge) !== wayKey
      ) {
        return;
      }
      observations.set(edge.segmentKey, {
        freeFlowKph: Math.min(200, Math.max(1, Math.round(edge.speedKph))),
        line: edge.line,
        roadClass: edge.roadClass,
        segmentKey: edge.segmentKey,
        speedKph,
      });
    });
  }
  return [...observations.values()].sort((left, right) =>
    left.segmentKey.localeCompare(right.segmentKey),
  );
}
