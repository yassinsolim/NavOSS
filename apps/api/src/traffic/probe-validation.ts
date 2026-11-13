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
