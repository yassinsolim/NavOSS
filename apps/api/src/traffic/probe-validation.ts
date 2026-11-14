import {
  isCoordinateInServiceCoverage,
  type Coordinate,
  type TrafficProbeBatchRequest,
} from '@navoss/contracts';

import { cumulativeMeters, haversineMeters, type Position } from './geo.js';
import type { TrafficSettings } from './settings.js';

export interface ProbePoint {
  offsetSeconds: number;
  position: Position;
}

export type ProbeRejection = 'future' | 'implausible_speed' | 'outside_coverage' | 'stale';

/**
 * Checks that a schema-valid batch could have come from one real vehicle inside coverage just now.
 * Returns the reason it could not, or undefined when it is plausible.
 */
export function findProbeRejection(
  batch: TrafficProbeBatchRequest,
  nowMs: number,
  settings: Pick<
    TrafficSettings,
    'bounds' | 'maxBatchAgeSeconds' | 'maxFutureSeconds' | 'maxPointSpeedMetersPerSecond'
  >,
  isInCoverage: (coordinate: Coordinate) => boolean = isCoordinateInServiceCoverage,
): ProbeRejection | undefined {
  // The future check uses the batch's last point, the latest moment it claims to describe: a start
  // time inside the allowed skew must not carry later offsets into the future. The age check uses
  // its first point, the oldest driving in it, so no part of an accepted batch is older than the
  // limit when it arrives.
  const firstPointMs = Date.parse(batch.capturedAt);
  const lastPointMs = firstPointMs + (batch.points.at(-1)?.[2] ?? 0) * 1_000;
  if (lastPointMs > nowMs + settings.maxFutureSeconds * 1_000) return 'future';
  if (firstPointMs < nowMs - settings.maxBatchAgeSeconds * 1_000) return 'stale';
  const { east, north, south, west } = settings.bounds;
  let previous: TrafficProbeBatchRequest['points'][number] | undefined;
  for (const point of batch.points) {
    const [longitude, latitude, offsetSeconds] = point;
    if (
      longitude < west ||
      longitude > east ||
      latitude < south ||
      latitude > north ||
      !isInCoverage({ latitude, longitude })
    ) {
      return 'outside_coverage';
    }
    if (previous !== undefined) {
      const meters = haversineMeters([previous[0], previous[1]], [longitude, latitude]);
      // A fix that jumps faster than any road vehicle is a GPS teleport or a fabricated trace.
      if (meters / (offsetSeconds - previous[2]) > settings.maxPointSpeedMetersPerSecond) {
        return 'implausible_speed';
      }
    }
    previous = point;
  }
  return undefined;
}

/**
 * Drops every point within `trimMeters` of path distance from either end of the batch. The app
 * already excludes trip ends; the server repeats it on every batch because it cannot tell which
 * batch began or ended a trip. Returns an empty list when nothing survives.
 */
export function trimBatchEnds(
  points: TrafficProbeBatchRequest['points'],
  trimMeters: number,
): ProbePoint[] {
  const distances = cumulativeMeters(
    points.map(([longitude, latitude]): Position => [longitude, latitude]),
  );
  const total = distances.at(-1) ?? 0;
  return points.flatMap(([longitude, latitude, offsetSeconds], index) => {
    const distance = distances[index] ?? 0;
    return distance >= trimMeters && distance <= total - trimMeters
      ? [{ offsetSeconds, position: [longitude, latitude] satisfies Position }]
      : [];
  });
}

/** Fixes within this distance of a batch's first (or last) fix are the vehicle standing there. */
export const DWELL_RADIUS_METERS = 10;
/** Standing shorter than this at a batch end is not worth holding. */
export const MIN_DWELL_SECONDS = 10;

export interface BoundaryDwell {
  endSeconds: number;
  /** Mean of the standing fixes; used only to find the edge, then dropped. */
  position: Position;
  startSeconds: number;
}

/**
 * True when every fix stays within `DWELL_RADIUS_METERS` of the first: the vehicle never moved.
 * GPS jitter can add up to more path than the trim removes, but it is not driving, and is not
 * map matched.
 */
export function isStationaryBatch(points: TrafficProbeBatchRequest['points']): boolean {
  const first = points[0];
  return (
    first !== undefined &&
    points.every(
      ([longitude, latitude]) =>
        haversineMeters([first[0], first[1]], [longitude, latitude]) <= DWELL_RADIUS_METERS,
    )
  );
}

/**
 * The standing still the server does not map match: a whole stationary batch, or the run of
 * fixes `trimBatchEnds` removes at the start of the batch that stay within `DWELL_RADIUS_METERS`
 * of its first fix, and likewise at its end. Fixes the trim keeps from a moving batch are never
 * part of a dwell, so their time is counted once, through map matching.
 */
export function findBoundaryDwells(
  points: TrafficProbeBatchRequest['points'],
  trimMeters: number,
): BoundaryDwell[] {
  const positions = points.map(([longitude, latitude]): Position => [longitude, latitude]);
  const mean = (run: readonly Position[]): Position => [
    run.reduce((sum, [longitude]) => sum + longitude, 0) / run.length,
    run.reduce((sum, [, latitude]) => sum + latitude, 0) / run.length,
  ];
  if (isStationaryBatch(points)) {
    const endSeconds = points.at(-1)?.[2] ?? 0;
    return endSeconds < MIN_DWELL_SECONDS
      ? []
      : [{ endSeconds, position: mean(positions), startSeconds: 0 }];
  }
  const distances = cumulativeMeters(positions);
  const total = distances.at(-1) ?? 0;
  const trimmed = (index: number): boolean => {
    const distance = distances[index] ?? 0;
    return distance < trimMeters || distance > total - trimMeters;
  };
  const standing = (from: number, step: 1 | -1): number => {
    const anchor = positions[from];
    let index = from;
    while (
      anchor !== undefined &&
      index + step >= 0 &&
      index + step < positions.length &&
      trimmed(index + step) &&
      haversineMeters(anchor, positions[index + step] ?? anchor) <= DWELL_RADIUS_METERS
    ) {
      index += step;
    }
    return index;
  };
  const dwell = (first: number, last: number): BoundaryDwell[] => {
    const startSeconds = points[first]?.[2] ?? 0;
    const endSeconds = points[last]?.[2] ?? 0;
    if (!trimmed(first) || endSeconds - startSeconds < MIN_DWELL_SECONDS) return [];
    return [{ endSeconds, position: mean(positions.slice(first, last + 1)), startSeconds }];
  };
  const leadingEnd = standing(0, 1);
  const leading = dwell(0, leadingEnd);
  const trailingStart = standing(points.length - 1, -1);
  if (trailingStart <= leadingEnd) return leading;
  return [...leading, ...dwell(trailingStart, points.length - 1)];
}
