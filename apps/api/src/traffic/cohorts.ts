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

interface PendingSegment {
  freeFlowKph: number;
  lengthMeters: number;
  line: Position[];
  /**
   * Contributor tag to what that contributor has driven of the edge in this cohort, until it is
   * enough to credit a sample. Keyed by the same per-edge tag as `samples`: it adds no identifier.
   */
  partial: Map<string, PartialCoverage>;
  roadClass: string;
  /** Contributor tag to that contributor's single sample in the current cohort. */
  samples: Map<string, PendingSample>;
}

interface PartialCoverage {
  /** Earliest driving start among the pieces; the partial state expires from it. */
  drivenAtMs: number;
  /** Arrival epoch of the earliest piece. */
  epochStartMs: number;
  /** Union of driven intervals along the edge, sorted and disjoint. */
  intervals: [number, number][];
  meters: number;
  seconds: number;
}

interface PendingSample {
  /** When the driving began (the earliest piece's batch start), never later than its arrival. */
  drivenAtMs: number;
  /** Arrival epoch of the batch that completed the sample, from the server clock. */
  epochStartMs: number;
  /** Salted network marker, kept only for a newly registered installation. */
  newcomerNetwork: string | undefined;
  speedKph: number;
}

/** One contributor's batch, as the cohorts see it. */
export interface CohortContribution {
  /**
   * Start of the batch's driving (its `capturedAt`). It only ever makes a sample expire sooner:
   * it is capped at the arrival time and decides nothing about which epoch the sample counts in.
   */
  drivenAtMs: number;
  /**
   * Salted marker of the network the batch came from, set only while the contributor's
   * installation is newly registered. A cohort counts at most one newcomer per network.
   */
  newcomerNetwork?: string | undefined;
  tagFor(segmentKey: string): string;
}

export interface TrafficCohorts {
  /**
   * Adds what one batch drove to the pending cohorts and returns how many samples it completed
   * and how many pieces it could not count. A contributor's pieces of an edge accumulate, as the
   * union of driven intervals, until they cover `CREDIT_COVERAGE_METERS` or
   * `CREDIT_COVERAGE_SHARE` of the edge, whichever is less; then they become that contributor's
   * one sample, at their total distance over total time. A contributor already in a segment's
   * cohort is ignored, whatever time the batch claims: a sample is stamped with the epoch it
   * completed in, never with client time. A newly registered installation is not credited where
   * another newcomer from the same network is already in the cohort.
   */
  add(
    observations: readonly SegmentObservation[],
    contribution: CohortContribution,
    nowMs: number,
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

  return {
    add(observations, contribution, nowMs) {
      const epochStartMs = Math.floor(nowMs / epochMs) * epochMs;
      const drivenAtMs = Math.min(contribution.drivenAtMs, nowMs);
      const newcomerNetwork = contribution.newcomerNetwork;
      let credited = 0;
      let ignored = 0;
      for (const observation of observations) {
        const tag = contribution.tagFor(observation.segmentKey);
        const existing = segments.get(observation.segmentKey);
        if (existing?.samples.has(tag) === true) {
          ignored += 1;
          continue;
        }
        // Road attributes are fixed by the first observation. The key commits to the geometry,
        // so a later batch, counted or not, cannot change what would be drawn.
        const segment: PendingSegment = existing ?? {
          freeFlowKph: observation.freeFlowKph,
          lengthMeters: observation.lengthMeters,
          line: observation.line,
          partial: new Map<string, PartialCoverage>(),
          roadClass: observation.roadClass,
          samples: new Map<string, PendingSample>(),
        };
        segments.set(observation.segmentKey, segment);
        const previous = segment.partial.get(tag);
        const coverage: PartialCoverage = {
          drivenAtMs: Math.min(previous?.drivenAtMs ?? drivenAtMs, drivenAtMs),
          epochStartMs: Math.min(previous?.epochStartMs ?? epochStartMs, epochStartMs),
          intervals: unite([...(previous?.intervals ?? []), ...observation.intervals]),
          meters: (previous?.meters ?? 0) + observation.meters,
          seconds: (previous?.seconds ?? 0) + observation.seconds,
        };
        segment.partial.set(tag, coverage);
        const covered = coverage.intervals.reduce((sum, [from, to]) => sum + to - from, 0);
        const needed = Math.min(
          CREDIT_COVERAGE_METERS,
          segment.lengthMeters * CREDIT_COVERAGE_SHARE,
        );
        if (covered < needed || coverage.seconds <= 0) continue;
        const speedKph = (coverage.meters / coverage.seconds) * 3.6;
        if (
          speedKph > settings.maxSampleSpeedKph ||
          (newcomerNetwork !== undefined &&
            [...segment.samples.values()].some(
              (sample) => sample.newcomerNetwork === newcomerNetwork,
            ))
        ) {
          segment.partial.delete(tag);
          ignored += 1;
          continue;
        }
        segment.partial.delete(tag);
        segment.samples.set(tag, {
          drivenAtMs: coverage.drivenAtMs,
          epochStartMs,
          newcomerNetwork,
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
        }
        if (segment.samples.size === 0 && segment.partial.size === 0) segments.delete(segmentKey);
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
