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

interface PendingSegment {
  freeFlowKph: number;
  line: Position[];
  roadClass: string;
  /** Contributor tag to that contributor's single sample in the current cohort. */
  samples: Map<string, PendingSample>;
}

interface PendingSample {
  /** When the batch's driving began (its first point), never later than its arrival. */
  drivenAtMs: number;
  /** Arrival epoch, from the server clock. */
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
   * Adds at most one sample per contributor per segment to the pending cohorts and returns how
   * many were new. A contributor already in a segment's cohort is ignored, whatever time the
   * batch claims: a sample is stamped with the epoch it arrived in, never with client time. A
   * newly registered installation is also ignored where another newcomer from the same network is
   * already in the cohort.
   */
  add(
    observations: readonly SegmentObservation[],
    contribution: CohortContribution,
    nowMs: number,
  ): number;
  clear(): void;
  /**
   * Closes the epoch ending at `tickMs`. Samples whose driving began, or which arrived, more than
   * the cohort lifetime before the boundary are dropped, so a release only ever rests on driving
   * from that window. Every
   * segment whose cohort then holds at least k contributors is released and its cohort is
   * consumed, so the next release needs k contributions of its own.
   */
  closeEpoch(tickMs: number): TrafficRelease[];
  /** Operator-only totals of what is held in memory. */
  pending(): { samples: number; segments: number };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Unpublished observations, held only in process memory. A segment's cohort is a set of
 * contributors with one speed each. Nothing leaves this module below the threshold, and what
 * leaves is one coarse median per cohort at an epoch boundary.
 */
export function createTrafficCohorts(
  settings: Pick<
    TrafficSettings,
    'cohortSeconds' | 'epochSeconds' | 'minimumContributors' | 'releaseSeconds'
  >,
): TrafficCohorts {
  const epochMs = settings.epochSeconds * 1_000;
  const segments = new Map<string, PendingSegment>();

  return {
    add(observations, contribution, nowMs) {
      const epochStartMs = Math.floor(nowMs / epochMs) * epochMs;
      const drivenAtMs = Math.min(contribution.drivenAtMs, nowMs);
      const newcomerNetwork = contribution.newcomerNetwork;
      let added = 0;
      for (const observation of observations) {
        const tag = contribution.tagFor(observation.segmentKey);
        const existing = segments.get(observation.segmentKey);
        if (existing?.samples.has(tag) === true) continue;
        if (
          newcomerNetwork !== undefined &&
          existing !== undefined &&
          [...existing.samples.values()].some(
            (sample) => sample.newcomerNetwork === newcomerNetwork,
          )
        ) {
          continue;
        }
        // Road attributes are fixed by the first observation. The key commits to the geometry,
        // so a later batch, counted or not, cannot change what would be drawn.
        const segment = existing ?? {
          freeFlowKph: observation.freeFlowKph,
          line: observation.line,
          roadClass: observation.roadClass,
          samples: new Map<string, PendingSample>(),
        };
        segment.samples.set(tag, {
          drivenAtMs,
          epochStartMs,
          newcomerNetwork,
          speedKph: observation.speedKph,
        });
        segments.set(observation.segmentKey, segment);
        added += 1;
      }
      return added;
    },

    clear() {
      segments.clear();
    },

    closeEpoch(tickMs) {
      const oldestMs = tickMs - settings.cohortSeconds * 1_000;
      const releases: TrafficRelease[] = [];
      for (const [segmentKey, segment] of segments) {
        const cohort: string[] = [];
        for (const [tag, sample] of segment.samples) {
          if (sample.epochStartMs < oldestMs || sample.drivenAtMs < oldestMs) {
            segment.samples.delete(tag);
          }
          // A sample that arrived after the boundary belongs to the epoch that is still open.
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
        if (segment.samples.size === 0) segments.delete(segmentKey);
      }
      // Sorted so neither storage order nor response order follows arrival order.
      return releases.sort((left, right) => (left.segmentKey < right.segmentKey ? -1 : 1));
    },

    pending() {
      let samples = 0;
      for (const segment of segments.values()) samples += segment.samples.size;
      return { samples, segments: segments.size };
    },
  };
}
