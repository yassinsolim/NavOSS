import type { Position } from './geo.js';
import type { MatchedEdge, MatchedTrace } from './map-matcher.js';
import type { ProbePoint } from './probe-validation.js';
import { isPublishableEdge } from './segments.js';
import type { TrafficSettings } from './settings.js';

/** Movement shorter than this between two fixes is standing still, not driving. */
const STATIONARY_METERS = 0.5;
// A jump back along the path by more than this breaks a run: it is GPS noise or a re-match.
const BACKWARD_JUMP_METERS = 5;
// Moving speed is measured over this much path around each step, so that snapping noise on a
// short edge does not decide its speed, while a jam still shows on the edges where it was.
const SPEED_WINDOW_METERS = 150;

/**
 * What one batch drove on one road edge. It carries no position from the upload and no time: the
 * line is the edge's whole map geometry, and positions are distances along the edge. The service
 * stamps the arrival epoch itself.
 */
export interface SegmentObservation {
  freeFlowKph: number;
  /** Parts of the edge the batch drove, as `[from, to]` metres from the edge's start. */
  intervals: [number, number][];
  /** Full length of the edge. */
  lengthMeters: number;
  /** The whole edge's map geometry. */
  line: Position[];
  /** Distance moved on the edge in this batch. */
  meters: number;
  roadClass: string;
  /** Time spent on the edge in this batch, including time standing still in a queue. */
  seconds: number;
  segmentKey: string;
}

interface MatchedFix {
  edgeIndex: number;
  meters: number;
  seconds: number;
}

/**
 * Turns one map-matched batch into what it drove on each eligible road edge: the intervals of the
 * edge covered, the distance moved and the time spent there. An edge is usually longer than a
 * batch drives of it, so these are pieces; the cohorts join one contributor's pieces of an edge
 * across batches until enough of it is covered to credit one sample (see `TrafficCohorts.add`).
 *
 * Movement between two consecutive fixes is spread over the edges between them by distance, so
 * an edge crossed between two fixes is covered too. Time between two fixes that did not move is
 * time spent standing on the edge where the vehicle stood: a stopped queue is the signal.
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

  // Continuous runs of matched fixes along the path.
  const runs: MatchedFix[][] = [];
  let run: MatchedFix[] | undefined;
  points.forEach((point, index) => {
    const match = matched.points[index];
    const meters =
      match === undefined
        ? Number.NaN
        : (edgeStartMeters[match.edgeIndex] ?? Number.NaN) +
          match.edgeFraction * (fullMeters[match.edgeIndex] ?? Number.NaN);
    if (match === undefined || !Number.isFinite(meters)) {
      run = undefined;
      return;
    }
    const last = run?.at(-1);
    if (
      run === undefined ||
      last === undefined ||
      match.startsNewPath ||
      meters < last.meters - BACKWARD_JUMP_METERS
    ) {
      run = [];
      runs.push(run);
    }
    run.push({ edgeIndex: match.edgeIndex, meters, seconds: point.offsetSeconds });
  });

  const pieces = new Map<
    number,
    { intervals: [number, number][]; meters: number; seconds: number }
  >();
  const piece = (edgeIndex: number) => {
    const existing = pieces.get(edgeIndex);
    if (existing !== undefined) return existing;
    const created = { intervals: [] as [number, number][], meters: 0, seconds: 0 };
    pieces.set(edgeIndex, created);
    return created;
  };
  for (const fixes of runs) {
    const first = fixes[0];
    const last = fixes.at(-1);
    if (first === undefined || last === undefined) continue;
    const runMeters = last.meters - first.meters;
    const runSeconds = last.seconds - first.seconds;
    // A run needs real distance, or enough time to prove the vehicle was held up; otherwise one
    // stationary fix pair would report a jam. Faster than any road vehicle is a bad match.
    if (
      runSeconds < settings.minSampleSeconds ||
      (runMeters < settings.minSampleMeters && runSeconds < settings.slowSampleSeconds) ||
      (runMeters / runSeconds) * 3.6 > settings.maxSampleSpeedKph
    ) {
      continue;
    }
    const steps = fixes.slice(1).map((to, index) => {
      const from = fixes[index] ?? to;
      return { from, moved: to.meters - from.meters, seconds: to.seconds - from.seconds, to };
    });
    // Moving time of each step from the average moving speed over the window around it.
    const movingSeconds = steps.map((step) => {
      if (step.moved < STATIONARY_METERS) return step.seconds;
      const middle = (step.from.meters + step.to.meters) / 2;
      let meters = 0;
      let seconds = 0;
      for (const other of steps) {
        if (other.moved < STATIONARY_METERS) continue;
        const otherMiddle = (other.from.meters + other.to.meters) / 2;
        if (Math.abs(otherMiddle - middle) > SPEED_WINDOW_METERS / 2) continue;
        meters += other.moved;
        seconds += other.seconds;
      }
      return seconds > 0 && meters > 0 ? (step.moved * seconds) / meters : step.seconds;
    });
    for (const [index, step] of steps.entries()) {
      const { from, moved, to } = step;
      const seconds = movingSeconds[index] ?? step.seconds;
      // Standing still, or GPS jitter backwards within a run: the time belongs to the edge the
      // vehicle stood on, and the next step measures distance from where this fix was matched.
      if (moved < STATIONARY_METERS) {
        const start = edgeStartMeters[from.edgeIndex] ?? 0;
        const at = from.meters - start;
        const standing = piece(from.edgeIndex);
        standing.intervals.push([at, at]);
        standing.seconds += seconds;
        continue;
      }
      for (let edgeIndex = from.edgeIndex; edgeIndex <= to.edgeIndex; edgeIndex += 1) {
        const start = edgeStartMeters[edgeIndex] ?? Number.NaN;
        const full = fullMeters[edgeIndex] ?? Number.NaN;
        if (!Number.isFinite(start) || !Number.isFinite(full)) continue;
        const enter = Math.max(from.meters, start);
        const leave = Math.min(to.meters, start + full);
        if (leave <= enter) continue;
        const driven = piece(edgeIndex);
        driven.intervals.push([enter - start, leave - start]);
        driven.meters += leave - enter;
        driven.seconds += (seconds * (leave - enter)) / moved;
      }
    }
  }

  const observations = new Map<string, SegmentObservation>();
  for (const [edgeIndex, driven] of pieces) {
    const edge = matched.edges[edgeIndex];
    const full = fullMeters[edgeIndex] ?? Number.NaN;
    if (edge === undefined || !Number.isFinite(full) || driven.seconds <= 0) continue;
    const whole = wholeEdgeOf(edge);
    if (whole === undefined || !isPublishableEdge({ ...edge, lengthMeters: full })) continue;
    const merged = observations.get(whole.segmentKey);
    if (merged !== undefined) {
      merged.intervals.push(...driven.intervals);
      merged.meters += driven.meters;
      merged.seconds += driven.seconds;
      continue;
    }
    observations.set(whole.segmentKey, {
      freeFlowKph: Math.min(200, Math.max(1, Math.round(edge.speedKph))),
      intervals: driven.intervals,
      lengthMeters: full,
      line: whole.line,
      meters: driven.meters,
      roadClass: edge.roadClass,
      seconds: driven.seconds,
      segmentKey: whole.segmentKey,
    });
  }
  return [...observations.values()].sort((left, right) =>
    left.segmentKey.localeCompare(right.segmentKey),
  );
}

/** The key and whole geometry of the edge a matched edge lies on, when they are known. */
function wholeEdgeOf(edge: MatchedEdge): { line: Position[]; segmentKey: string } | undefined {
  if (edge.segmentKey !== undefined) return { line: edge.line, segmentKey: edge.segmentKey };
  return edge.wholeEdge;
}
