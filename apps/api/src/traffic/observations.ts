import { speedBin } from './aggregation.js';
import type { Position } from './geo.js';
import type { MatchedEdge, MatchedTrace } from './map-matcher.js';
import type { ProbePoint } from './probe-validation.js';
import type { TrafficSettings } from './settings.js';

// Only through roads are aggregated. Residential streets, service roads, driveways and parking
// aisles are where trips begin and end, carry too few drivers to ever reach the publication
// threshold, and say nothing useful about congestion.
const AGGREGATED_ROAD_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
const AGGREGATED_USES = new Set(['road', 'ramp', 'turn_channel']);

export interface SegmentObservation {
  /** Start of the time bucket the sample falls in. */
  bucketStartMs: number;
  forward: boolean;
  freeFlowKph: number;
  /** Full-edge road geometry for this segment, taken from the map, not from the trace. */
  lines: Position[][];
  roadClass: string;
  /**
   * OSM way id plus travel direction relative to the way, e.g. `w142596972b`. It survives graph
   * rebuilds, can be checked against OpenStreetMap by hand, and is coarser than a graph edge,
   * which helps a thinly driven road reach the contributor threshold.
   */
  segmentKey: string;
  speedBin: number;
  speedLimitKph?: number;
  wayId: number;
}

/** Segment key of an edge, or undefined when the edge is not a road NavOSS aggregates. */
export function segmentKeyForEdge(
  edge: Pick<MatchedEdge, 'forward' | 'roadClass' | 'speedKph' | 'use' | 'wayId'>,
): string | undefined {
  return AGGREGATED_ROAD_CLASSES.has(edge.roadClass) &&
    AGGREGATED_USES.has(edge.use) &&
    edge.speedKph > 0
    ? `w${String(edge.wayId)}${edge.forward ? 'f' : 'b'}`
    : undefined;
}

interface Traversal {
  edgeIndexes: Set<number>;
  firstOffsetSeconds: number;
  meters: number;
  seconds: number;
}

/**
 * Turns one map-matched batch into at most one speed sample per road segment. Nothing in the
 * result is a position or a time finer than the bucket: speed is distance along the matched edges
 * divided by elapsed time between the first and last point on the segment.
 */
export function deriveObservations(
  matched: MatchedTrace,
  points: readonly ProbePoint[],
  capturedAtMs: number,
  settings: Pick<
    TrafficSettings,
    | 'bucketSeconds'
    | 'maxSampleSpeedKph'
    | 'minSampleMeters'
    | 'minSampleSeconds'
    | 'slowSampleSeconds'
  >,
): SegmentObservation[] {
  // Valhalla reports only the matched part of the first and last edge, so recover full lengths to
  // place points, whose positions are shares of the full edge.
  const edgeStartMeters: number[] = [];
  const fullMeters = matched.edges.map((edge) => {
    const share = edge.toFraction - edge.fromFraction;
    return share > 0.01 ? edge.lengthMeters / share : Number.NaN;
  });
  fullMeters.reduce((start, meters, index) => {
    edgeStartMeters[index] = start;
    return start + meters;
  }, 0);

  const traversals = new Map<string, Traversal>();
  let run:
    { key: string; lastMeters: number; lastSeconds: number; traversal: Traversal } | undefined;
  points.forEach((point, index) => {
    const match = matched.points[index];
    const edge = match === undefined ? undefined : matched.edges[match.edgeIndex];
    const key = edge === undefined ? undefined : segmentKeyForEdge(edge);
    const meters =
      match === undefined
        ? Number.NaN
        : (edgeStartMeters[match.edgeIndex] ?? Number.NaN) +
          match.edgeFraction * (fullMeters[match.edgeIndex] ?? Number.NaN);
    if (match === undefined || key === undefined || !Number.isFinite(meters)) {
      run = undefined;
      return;
    }
    // A new segment, a break in the matched path, or a backwards jump starts a fresh traversal
    // leg; only movement inside one continuous leg counts as distance.
    if (run?.key !== key || match.startsNewPath || meters < run.lastMeters - 5) {
      const traversal = traversals.get(key) ?? {
        edgeIndexes: new Set<number>(),
        firstOffsetSeconds: point.offsetSeconds,
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
    run.traversal.edgeIndexes.add(match.edgeIndex);
  });

  const bucketMs = settings.bucketSeconds * 1_000;
  const observations: SegmentObservation[] = [];
  for (const [segmentKey, traversal] of traversals) {
    // A sample needs real distance, or enough time on the segment to prove the vehicle was held
    // up there; otherwise one stationary fix pair would report a jam.
    if (
      traversal.seconds < settings.minSampleSeconds ||
      (traversal.meters < settings.minSampleMeters &&
        traversal.seconds < settings.slowSampleSeconds)
    ) {
      continue;
    }
    const speedKph = (traversal.meters / traversal.seconds) * 3.6;
    if (speedKph > settings.maxSampleSpeedKph) continue;
    const edges = [...traversal.edgeIndexes].flatMap((index) => matched.edges[index] ?? []);
    const weight = edges.reduce((sum, edge) => sum + edge.lengthMeters, 0);
    const freeFlowKph =
      weight > 0
        ? edges.reduce((sum, edge) => sum + edge.speedKph * edge.lengthMeters, 0) / weight
        : (edges[0]?.speedKph ?? 0);
    const first = edges[0];
    if (first === undefined || freeFlowKph < 1) continue;
    const speedLimitKph = edges.find((edge) => edge.speedLimitKph !== undefined)?.speedLimitKph;
    observations.push({
      bucketStartMs:
        Math.floor((capturedAtMs + traversal.firstOffsetSeconds * 1_000) / bucketMs) * bucketMs,
      forward: first.forward,
      freeFlowKph: Math.round(freeFlowKph),
      // Only edges driven end to end give geometry: a partly matched first or last edge would
      // start or stop where the trace did.
      lines: matched.edges
        .filter(
          (edge, index) =>
            index > 0 &&
            index < matched.edges.length - 1 &&
            index >= Math.min(...traversal.edgeIndexes) &&
            index <= Math.max(...traversal.edgeIndexes) &&
            edge.fromFraction === 0 &&
            edge.toFraction === 1 &&
            segmentKeyForEdge(edge) === segmentKey,
        )
        .map((edge) => matched.shape.slice(edge.beginShapeIndex, edge.endShapeIndex + 1))
        .filter((line) => line.length >= 2),
      roadClass: first.roadClass,
      segmentKey,
      speedBin: speedBin(speedKph),
      ...(speedLimitKph === undefined || speedLimitKph > 200
        ? {}
        : { speedLimitKph: Math.round(speedLimitKph) }),
      wayId: first.wayId,
    });
  }
  return observations.sort((left, right) => left.segmentKey.localeCompare(right.segmentKey));
}
