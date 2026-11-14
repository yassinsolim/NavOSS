import { createHmac, randomBytes } from 'node:crypto';

import type { Position } from './geo.js';
import type { SegmentObservation } from './observations.js';
import type { TrafficSettings } from './settings.js';

const PUBLISHED_SPEED_STEP_KPH = 5;

/** One published value for one road edge. Everything in it is map data or a k-supported speed. */
export interface TrafficRelease {
  /** Epoch boundary after which the value is no longer served. */
  expiresAtMs: number;
  freeFlowKph: number;
  line: Position[];
  /** Epoch boundary that released the value. */
  releasedAtMs: number;
  roadClass: string;
  segmentKey: string;
  /** Median across the cohort's contributors, rounded to 5 km/h. */
  speedKph: number;
}

/**
 * A contributor's sample is credited once the parts of the edge it drove cover this much of it:
 * 300 m, or half the edge when that is shorter. Coverage is the union of driven intervals, so a
 * repeated or overlapping batch adds nothing.
 */
export const CREDIT_COVERAGE_METERS = 300;
export const CREDIT_COVERAGE_SHARE = 0.5;

/**
 * `capturedAt` is the batch's first fix rounded down to the minute, so the absolute time of any
 * offset is known only to within this much. Two honest consecutive batches can therefore appear
 * to overlap in time by up to this amount; a larger overlap is the same time reported twice.
 */
export const CAPTURED_AT_ROUNDING_MS = 60_000;
/**
 * Stops this close along the edge are the same place. An honest contributor's stops in different
 * batches are at least the two 100 m batch trims apart, so only a repeat lands this close.
 */
export const SAME_STOP_METERS = 25;
/** A held dwell must lie this close to the edge's map geometry to be placed on it. */
export const DWELL_EDGE_METERS = 25;
/** Movement after a dwell must reach this far past it to show that the trip went on. */
export const DWELL_CONTINUATION_METERS = 50;

interface PendingSegment {
  freeFlowKph: number;
  /**
   * Cohort salts, newest last. Every tag and newcomer marker held for the segment is keyed by
   * one of them, so nothing held is equal across edges, and a consumed cohort's tags are not
   * equal to the next cohort's. A salt is replaced only when a cohort is consumed, never on a
   * clock, and kept while a pending sample or partial coverage still uses it.
   */
  generations: Buffer[];
  lengthMeters: number;
  line: Position[];
  /**
   * Cohort tag to what that contributor has driven of the edge, until it is enough to credit a
   * sample. Keyed like `samples`: it adds no identifier.
   */
  partial: Map<string, PartialCoverage>;
  roadClass: string;
  /** Cohort tag to that contributor's single sample in the current cohort. */
  samples: Map<string, PendingSample>;
}

/** A span of the edge one batch moved along, placed in claimed time. */
interface DrivenSpan {
  endMs: number;
  from: number;
  startMs: number;
  to: number;
}

/** Standing still at one place on the edge: claimed-time windows already counted there. */
interface StopEvidence {
  at: number;
  windows: [number, number][];
}

/** A whole stationary stretch at a batch boundary, waiting for the trip to be seen going on. */
interface HeldDwell {
  at: number;
  endMs: number;
  startMs: number;
}

interface PartialCoverage {
  /** Earliest driving start among the pieces; the partial state expires from it. */
  drivenAtMs: number;
  /** Arrival epoch of the earliest piece. */
  epochStartMs: number;
  /** The cohort salt the tag was derived with. */
  generation: Buffer;
  held: HeldDwell[];
  /** Union of driven intervals along the edge, sorted and disjoint. */
  intervals: [number, number][];
  /** Distance counted: each metre of the edge at most once. */
  meters: number;
  /** Time counted: moving time of new metres, and standing time not already counted. */
  seconds: number;
  spans: DrivenSpan[];
  stops: StopEvidence[];
}

interface PendingSample {
  /** When the driving began (the earliest piece's batch start), never later than its arrival. */
  drivenAtMs: number;
  /** Arrival epoch of the batch that completed the sample, from the server clock. */
  epochStartMs: number;
  generation: Buffer;
  /** Newcomer network marker under the sample's cohort salt, only for a new installation. */
  newcomerMarker: string | undefined;
  speedKph: number;
}

/**
 * A stationary stretch the server trimmed off the start or end of a batch: where the vehicle
 * stood (used to find the edge, then dropped) and the batch offsets during which it stood.
 */
export interface DwellObservation {
  endSeconds: number;
  position: Position;
  startSeconds: number;
}

/** One contributor's batch, as the cohorts see it. */
export interface CohortContribution {
  /**
   * Start of the batch's driving (its `capturedAt`). Offsets are placed in time from it, to tell a
   * repeat from new evidence. It only ever makes a sample expire sooner: it is capped at the
   * arrival time and decides nothing about which epoch the sample counts in.
   */
  drivenAtMs: number;
  /**
   * Keyed marker of the network the batch came from, set only while the contributor's
   * installation is newly registered. A cohort counts at most one newcomer per network. It is
   * re-keyed under each edge's cohort salt before anything is kept.
   */
  newcomerNetwork?: string | undefined;
  /** Per-edge contributor tag; re-keyed under the edge's cohort salt before anything is kept. */
  tagFor(segmentKey: string): string;
}

export interface TrafficCohorts {
  /**
   * Adds what one batch drove to the pending cohorts and returns how many samples it completed
   * and how many pieces it could not count. A contributor's pieces of an edge accumulate until
   * the union of driven intervals covers `CREDIT_COVERAGE_METERS` or `CREDIT_COVERAGE_SHARE` of
   * the edge, whichever is less; then they become that contributor's one sample.
   *
   * Evidence counts once. A metre of the edge adds distance, and its moving time, only the first
   * time it is driven; standing time at one place counts only for claimed time not already
   * counted there. Dwells, trimmed off a batch's ends, are held on the edge the contributor was
   * already driving and count only once its own movement on that edge is seen both before and
   * after them. A contributor already in a segment's cohort is ignored, whatever time the batch
   * claims: a sample is stamped with the epoch it completed in, never with client time. A newly
   * registered installation is not credited where another newcomer from the same network is
   * already in the cohort.
   */
  add(
    observations: readonly SegmentObservation[],
    contribution: CohortContribution,
    nowMs: number,
    dwells?: readonly DwellObservation[],
  ): { credited: number; ignored: number };
  clear(): void;
  /**
   * Closes the epoch ending at `tickMs`. Samples and partial coverage whose driving began, or
   * which arrived, more than the cohort lifetime before the boundary are dropped, so a release
   * only ever rests on driving from that window. Every segment whose cohort then holds at least k
   * contributors is released and its cohort is consumed, so the next release needs k
   * contributions of its own.
   */
  closeEpoch(tickMs: number): TrafficRelease[];
  /** Operator-only totals of what is held in memory. */
  pending(): { partial: number; samples: number; segments: number };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Union of intervals, sorted and disjoint. */
function unite(intervals: readonly [number, number][]): [number, number][] {
  const sorted = [...intervals].sort((left, right) => left[0] - right[0]);
  const united: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = united.at(-1);
    if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to);
    else united.push([from, to]);
  }
  return united;
}

/** Length of `[from, to]` that lies inside the sorted, disjoint `intervals`. */
function overlapLength(intervals: readonly [number, number][], from: number, to: number): number {
  let inside = 0;
  for (const [start, end] of intervals) {
    inside += Math.max(0, Math.min(end, to) - Math.max(start, from));
  }
  return inside;
}

function scoped(salt: Buffer, value: string): string {
  return createHmac('sha256', salt).update(value).digest('base64url').slice(0, 16);
}

/**
 * Distance along `line`, as a share of its length, of the point of the line nearest `point`, and
 * how far `point` is from it. Local equirectangular metres: edges are at most a few kilometres.
 */
function projectOnto(
  line: readonly Position[],
  point: Position,
): { offMeters: number; share: number } {
  const metersPerDegree = 111_195;
  const scaleX = Math.cos((point[1] * Math.PI) / 180) * metersPerDegree;
  const xy = ([longitude, latitude]: Position): [number, number] => [
    (longitude - point[0]) * scaleX,
    (latitude - point[1]) * metersPerDegree,
  ];
  let total = 0;
  let best = { along: 0, off: Number.POSITIVE_INFINITY };
  for (let index = 1; index < line.length; index += 1) {
    const [ax, ay] = xy(line[index - 1] ?? point);
    const [bx, by] = xy(line[index] ?? point);
    const length = Math.hypot(bx - ax, by - ay);
    const t =
      length === 0 ? 0 : Math.min(1, Math.max(0, -(ax * (bx - ax) + ay * (by - ay)) / length ** 2));
    const off = Math.hypot(ax + t * (bx - ax), ay + t * (by - ay));
    if (off < best.off) best = { along: total + t * length, off };
    total += length;
  }
  return { offMeters: best.off, share: total > 0 ? best.along / total : 0 };
}

/**
 * Counts standing still at `at` during the claimed window `[startMs, endMs]`, returning the
 * seconds not already counted at that place. A window wholly inside what was counted there is a
 * repeat and adds nothing. An overlap shorter than the `capturedAt` rounding is what two honest
 * consecutive batches of one long stop can show, so the window counts in full; a longer overlap
 * cannot be honest, and only the time outside what was counted is added.
 */
function countStop(partial: PartialCoverage, at: number, startMs: number, endMs: number): number {
  if (endMs <= startMs) return 0;
  let place = partial.stops.find((stop) => Math.abs(stop.at - at) <= SAME_STOP_METERS);
  if (place === undefined) {
    place = { at, windows: [] };
    partial.stops.push(place);
  }
  const overlap = overlapLength(place.windows, startMs, endMs);
  place.windows = unite([...place.windows, [startMs, endMs]]);
  const length = endMs - startMs;
  if (overlap >= length) return 0;
  return (overlap < CAPTURED_AT_ROUNDING_MS ? length : length - overlap) / 1_000;
}

/**
 * Counts held dwells the contributor's own movement on the edge now brackets: movement that ended
 * before the dwell and movement that began after it and went at least
 * `DWELL_CONTINUATION_METERS` beyond it. A dwell contradicted by movement that had already passed
 * it before it began is dropped. One that is never followed by movement, such as a trip that
 * ended at the stop, is never counted and expires with the partial coverage.
 */
function confirmHeldDwells(partial: PartialCoverage): void {
  partial.held = partial.held.filter((dwell) => {
    const passedBefore = partial.spans.some(
      (span) =>
        span.to > dwell.at + SAME_STOP_METERS &&
        span.endMs < dwell.startMs - CAPTURED_AT_ROUNDING_MS,
    );
    if (passedBefore) return false;
    const approached = partial.spans.some(
      (span) =>
        span.to <= dwell.at + SAME_STOP_METERS &&
        span.endMs <= dwell.startMs + CAPTURED_AT_ROUNDING_MS,
    );
    const continued = partial.spans.some(
      (span) =>
        span.from >= dwell.at - SAME_STOP_METERS &&
        span.to >= dwell.at + DWELL_CONTINUATION_METERS &&
        span.startMs >= dwell.endMs - CAPTURED_AT_ROUNDING_MS,
    );
    if (!approached || !continued) return true;
    partial.seconds += countStop(partial, dwell.at, dwell.startMs, dwell.endMs);
    return false;
  });
}

/**
 * Unpublished observations, held only in process memory. A segment's cohort is a set of
 * contributors with one speed each, plus what contributors have driven of it so far. Nothing
 * leaves this module below the threshold, and what leaves is one coarse median per cohort at an
 * epoch boundary.
 */
export function createTrafficCohorts(
  settings: Pick<
    TrafficSettings,
    | 'cohortSeconds'
    | 'epochSeconds'
    | 'maxSampleSpeedKph'
    | 'minimumContributors'
    | 'releaseSeconds'
  >,
): TrafficCohorts {
  const epochMs = settings.epochSeconds * 1_000;
  const segments = new Map<string, PendingSegment>();

  /** The contributor's state on a segment, under whichever live cohort salt it was keyed by. */
  const lookup = (
    segment: PendingSegment,
    base: string,
  ): { partial?: PartialCoverage; sampled: boolean; tag: string } => {
    let partial: { partial: PartialCoverage; tag: string } | undefined;
    for (const salt of segment.generations) {
      const tag = scoped(salt, base);
      if (segment.samples.has(tag)) return { sampled: true, tag };
      const found = segment.partial.get(tag);
      if (found !== undefined) partial = { partial: found, tag };
    }
    const current = segment.generations.at(-1) ?? randomBytes(32);
    return partial === undefined
      ? { sampled: false, tag: scoped(current, base) }
      : { ...partial, sampled: false };
  };

  return {
    add(observations, contribution, nowMs, dwells = []) {
      const epochStartMs = Math.floor(nowMs / epochMs) * epochMs;
      const claimedStartMs = contribution.drivenAtMs;
      const drivenAtMs = Math.min(contribution.drivenAtMs, nowMs);
      const claimed = (seconds: number): number => claimedStartMs + seconds * 1_000;
      const touched = new Map<string, { partial: PartialCoverage; tag: string }>();
      let ignored = 0;

      const startPartial = (segment: PendingSegment, tag: string, generation: Buffer) => {
        const partial: PartialCoverage = {
          drivenAtMs,
          epochStartMs,
          generation,
          held: [],
          intervals: [],
          meters: 0,
          seconds: 0,
          spans: [],
          stops: [],
        };
        segment.partial.set(tag, partial);
        return partial;
      };

      for (const observation of observations) {
        const base = contribution.tagFor(observation.segmentKey);
        // Road attributes are fixed by the first observation. The key commits to the geometry,
        // so a later batch, counted or not, cannot change what would be drawn.
        const segment: PendingSegment = segments.get(observation.segmentKey) ?? {
          freeFlowKph: observation.freeFlowKph,
          generations: [randomBytes(32)],
          lengthMeters: observation.lengthMeters,
          line: observation.line,
          partial: new Map<string, PartialCoverage>(),
          roadClass: observation.roadClass,
          samples: new Map<string, PendingSample>(),
        };
        segments.set(observation.segmentKey, segment);
        const found = lookup(segment, base);
        if (found.sampled) {
          ignored += 1;
          continue;
        }
        const partial =
          found.partial ??
          startPartial(segment, found.tag, segment.generations.at(-1) ?? randomBytes(32));
        partial.drivenAtMs = Math.min(partial.drivenAtMs, drivenAtMs);
        partial.epochStartMs = Math.min(partial.epochStartMs, epochStartMs);
        // Each metre once: a step adds only the part of the edge not driven before, and only
        // that part's share of its moving time.
        for (const move of observation.moves) {
          const length = move.to - move.from;
          if (length <= 0) continue;
          const fresh = length - overlapLength(partial.intervals, move.from, move.to);
          partial.meters += fresh;
          partial.seconds += (move.seconds * fresh) / length;
          partial.intervals = unite([...partial.intervals, [move.from, move.to]]);
        }
        for (const stop of observation.stops) {
          partial.seconds += countStop(
            partial,
            stop.at,
            claimed(stop.startSeconds),
            claimed(stop.endSeconds),
          );
        }
        if (observation.moves.length > 0) {
          partial.spans.push({
            endMs: claimed(Math.max(...observation.moves.map((move) => move.endSeconds))),
            from: Math.min(...observation.moves.map((move) => move.from)),
            startMs: claimed(Math.min(...observation.moves.map((move) => move.startSeconds))),
            to: Math.max(...observation.moves.map((move) => move.to)),
          });
        }
        touched.set(observation.segmentKey, { partial, tag: found.tag });
      }

      // A dwell is placed only on an edge where the contributor already has movement pending:
      // the nearest such edge to where it stood. It never starts coverage of its own.
      for (const dwell of dwells) {
        let best:
          { at: number; key: string; offMeters: number; partial: PartialCoverage } | undefined;
        for (const [segmentKey, segment] of segments) {
          if (segment.partial.size === 0) continue;
          const { offMeters, share } = projectOnto(segment.line, dwell.position);
          if (
            offMeters > DWELL_EDGE_METERS ||
            (best !== undefined && offMeters >= best.offMeters)
          ) {
            continue;
          }
          const found = lookup(segment, contribution.tagFor(segmentKey));
          if (found.partial === undefined) continue;
          best = {
            at: share * segment.lengthMeters,
            key: segmentKey,
            offMeters,
            partial: found.partial,
          };
          touched.set(segmentKey, { partial: found.partial, tag: found.tag });
        }
        if (best === undefined) continue;
        const held = {
          at: best.at,
          endMs: claimed(dwell.endSeconds),
          startMs: claimed(dwell.startSeconds),
        };
        if (
          !best.partial.held.some(
            (other) => other.startMs === held.startMs && other.endMs === held.endMs,
          )
        ) {
          best.partial.held.push(held);
        }
      }

      let credited = 0;
      for (const [segmentKey, { partial, tag }] of touched) {
        const segment = segments.get(segmentKey);
        if (segment === undefined) continue;
        if (segment.partial.get(tag) !== partial) continue;
        confirmHeldDwells(partial);
        const covered = partial.intervals.reduce((sum, [from, to]) => sum + to - from, 0);
        const needed = Math.min(
          CREDIT_COVERAGE_METERS,
          segment.lengthMeters * CREDIT_COVERAGE_SHARE,
        );
        if (covered < needed || partial.seconds <= 0) continue;
        segment.partial.delete(tag);
        const speedKph = (partial.meters / partial.seconds) * 3.6;
        const newcomerMarker =
          contribution.newcomerNetwork === undefined
            ? undefined
            : scoped(partial.generation, contribution.newcomerNetwork);
        if (
          speedKph > settings.maxSampleSpeedKph ||
          (contribution.newcomerNetwork !== undefined &&
            [...segment.samples.values()].some(
              (sample) =>
                sample.newcomerMarker !== undefined &&
                sample.newcomerMarker ===
                  scoped(sample.generation, contribution.newcomerNetwork ?? ''),
            ))
        ) {
          ignored += 1;
          continue;
        }
        segment.samples.set(tag, {
          drivenAtMs: partial.drivenAtMs,
          epochStartMs,
          generation: partial.generation,
          newcomerMarker,
          speedKph,
        });
        credited += 1;
      }
      return { credited, ignored };
    },

    clear() {
      segments.clear();
    },

    closeEpoch(tickMs) {
      const oldestMs = tickMs - settings.cohortSeconds * 1_000;
      const releases: TrafficRelease[] = [];
      for (const [segmentKey, segment] of segments) {
        for (const [tag, coverage] of segment.partial) {
          if (coverage.epochStartMs < oldestMs || coverage.drivenAtMs < oldestMs) {
            segment.partial.delete(tag);
          }
        }
        const cohort: string[] = [];
        for (const [tag, sample] of segment.samples) {
          if (sample.epochStartMs < oldestMs || sample.drivenAtMs < oldestMs) {
            segment.samples.delete(tag);
          }
          // A sample completed after the boundary belongs to the epoch that is still open.
          else if (sample.epochStartMs < tickMs) cohort.push(tag);
        }
        if (cohort.length >= settings.minimumContributors) {
          const speeds = cohort.map((tag) => segment.samples.get(tag)?.speedKph ?? 0);
          releases.push({
            expiresAtMs: tickMs + settings.releaseSeconds * 1_000,
            freeFlowKph: segment.freeFlowKph,
            line: segment.line,
            releasedAtMs: tickMs,
            roadClass: segment.roadClass,
            segmentKey,
            speedKph:
              Math.round(median(speeds) / PUBLISHED_SPEED_STEP_KPH) * PUBLISHED_SPEED_STEP_KPH,
          });
          for (const tag of cohort) segment.samples.delete(tag);
          // The next cohort is keyed afresh; older salts stay only while something uses them.
          segment.generations.push(randomBytes(32));
        }
        if (segment.samples.size === 0 && segment.partial.size === 0) {
          segments.delete(segmentKey);
          continue;
        }
        const inUse = new Set<Buffer>([
          ...[...segment.samples.values()].map((sample) => sample.generation),
          ...[...segment.partial.values()].map((coverage) => coverage.generation),
        ]);
        segment.generations = segment.generations.filter(
          (salt, index) => index === segment.generations.length - 1 || inUse.has(salt),
        );
      }
      // Sorted so neither storage order nor response order follows arrival order.
      return releases.sort((left, right) => (left.segmentKey < right.segmentKey ? -1 : 1));
    },

    pending() {
      let samples = 0;
      let partial = 0;
      for (const segment of segments.values()) {
        samples += segment.samples.size;
        partial += segment.partial.size;
      }
      return { partial, samples, segments: segments.size };
    },
  };
}
