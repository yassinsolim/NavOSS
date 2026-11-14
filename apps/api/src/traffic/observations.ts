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

/** Movement along an edge between two fixes, in metres from the edge's start. */
export interface EdgeMove {
  from: number;
  /** Batch offset (seconds since its first point) when the vehicle was at `from`. */
  startSeconds: number;
  /** Moving time attributed to the step, from the average moving speed around it. */
  seconds: number;
  to: number;
  /** Batch offset when the vehicle was at `to`. */
  endSeconds: number;
}

/** Standing still at one place on an edge, during a span of batch offsets. */
export interface EdgeStop {
  at: number;
  endSeconds: number;
  startSeconds: number;
}

/**
 * What one batch drove on one road edge. It carries no position from the upload: the line is the
 * edge's whole map geometry, positions are distances along the edge and times are offsets within
 * the batch. The cohorts place the offsets in time with the batch's own minute-rounded start.
 */
export interface SegmentObservation {
  freeFlowKph: number;
  /** Full length of the edge. */
  lengthMeters: number;
  /** The whole edge's map geometry. */
  line: Position[];
  /** Each step the batch moved along the edge, in order. */
  moves: EdgeMove[];
  /**
   * GraphIds of the nodes the edge begins and ends at, when the graph confirmed both (see
   * `MatchedEdge.nodes`): what tells that one edge leads onto another.
   */
  nodes?: { begin: number; end: number };
  roadClass: string;
  segmentKey: string;
  /** Each span of standing still on the edge, in order: time in a queue is the signal. */
  stops: EdgeStop[];
}

interface MatchedFix {
  edgeIndex: number;
  meters: number;
  seconds: number;
}

/**
 * Turns one map-matched batch into what it drove on each eligible road edge: each step moved along
 * the edge and each stop on it, with when (as batch offsets) it happened. An edge is usually longer than a
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

  const pieces = new Map<number, { moves: EdgeMove[]; stops: EdgeStop[] }>();
  const piece = (edgeIndex: number) => {
    const existing = pieces.get(edgeIndex);
    if (existing !== undefined) return existing;
    const created = { moves: [] as EdgeMove[], stops: [] as EdgeStop[] };
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
        const standing = piece(from.edgeIndex).stops;
        const last = standing.at(-1);
        // Consecutive stationary steps are one stop, wherever jitter placed the later fixes.
        if (last?.endSeconds === from.seconds) last.endSeconds = to.seconds;
        else {
          standing.push({
            at: from.meters - start,
            endSeconds: to.seconds,
            startSeconds: from.seconds,
          });
        }
        continue;
      }
      for (let edgeIndex = from.edgeIndex; edgeIndex <= to.edgeIndex; edgeIndex += 1) {
        const start = edgeStartMeters[edgeIndex] ?? Number.NaN;
        const full = fullMeters[edgeIndex] ?? Number.NaN;
        if (!Number.isFinite(start) || !Number.isFinite(full)) continue;
        const enter = Math.max(from.meters, start);
        const leave = Math.min(to.meters, start + full);
        if (leave <= enter) continue;
        const elapsed = to.seconds - from.seconds;
        piece(edgeIndex).moves.push({
          endSeconds: from.seconds + (elapsed * (leave - from.meters)) / moved,
          from: enter - start,
          seconds: (seconds * (leave - enter)) / moved,
          startSeconds: from.seconds + (elapsed * (enter - from.meters)) / moved,
          to: leave - start,
        });
      }
    }
  }

  const observations = new Map<string, SegmentObservation>();
  for (const [edgeIndex, driven] of [...pieces].sort(([left], [right]) => left - right)) {
    const edge = matched.edges[edgeIndex];
    const full = fullMeters[edgeIndex] ?? Number.NaN;
    const seconds =
      driven.moves.reduce((sum, move) => sum + move.seconds, 0) +
      driven.stops.reduce((sum, stop) => sum + stop.endSeconds - stop.startSeconds, 0);
    if (edge === undefined || !Number.isFinite(full) || seconds <= 0) continue;
    const whole = wholeEdgeOf(edge);
    if (whole === undefined || !isPublishableEdge({ ...edge, lengthMeters: full })) continue;
    const merged = observations.get(whole.segmentKey);
    if (merged !== undefined) {
      merged.moves.push(...driven.moves);
      merged.stops.push(...driven.stops);
      continue;
    }
    observations.set(whole.segmentKey, {
      freeFlowKph: Math.min(200, Math.max(1, Math.round(edge.speedKph))),
      lengthMeters: full,
      line: whole.line,
      moves: driven.moves,
      ...(edge.nodes === undefined ? {} : { nodes: edge.nodes }),
      roadClass: edge.roadClass,
      segmentKey: whole.segmentKey,
      stops: driven.stops,
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
