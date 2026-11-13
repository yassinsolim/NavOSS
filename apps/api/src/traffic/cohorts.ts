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
  samples: Map<string, { epochStartMs: number; speedKph: number }>;
}

export interface TrafficCohorts {
  /**
   * Adds at most one sample per contributor per segment to the pending cohorts and returns how
   * many were new. A contributor already in a segment's cohort is ignored, whatever time the
   * batch claims: a sample is stamped with the epoch it arrived in, never with client time.
   */
  add(
    observations: readonly SegmentObservation[],
    tagFor: (segmentKey: string) => string,
    nowMs: number,
  ): number;
  clear(): void;
  /**
   * Closes the epoch ending at `tickMs`. Samples older than the cohort lifetime are dropped. Every
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
    add(observations, tagFor, nowMs) {
      const epochStartMs = Math.floor(nowMs / epochMs) * epochMs;
      let added = 0;
      for (const observation of observations) {
        const tag = tagFor(observation.segmentKey);
        const existing = segments.get(observation.segmentKey);
        if (existing?.samples.has(tag) === true) continue;
        // Road attributes are fixed by the first observation. The key commits to the geometry,
        // so a later batch, counted or not, cannot change what would be drawn.
        const segment = existing ?? {
          freeFlowKph: observation.freeFlowKph,
          line: observation.line,
          roadClass: observation.roadClass,
          samples: new Map<string, { epochStartMs: number; speedKph: number }>(),
        };
        segment.samples.set(tag, { epochStartMs, speedKph: observation.speedKph });
        segments.set(observation.segmentKey, segment);
        added += 1;
      }
      return added;
    },

    clear() {
      segments.clear();
    },

    closeEpoch(tickMs) {
      const oldestEpochMs = tickMs - settings.cohortSeconds * 1_000;
      const releases: TrafficRelease[] = [];
      for (const [segmentKey, segment] of segments) {
        const cohort: string[] = [];
        for (const [tag, sample] of segment.samples) {
          if (sample.epochStartMs < oldestEpochMs) segment.samples.delete(tag);
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
