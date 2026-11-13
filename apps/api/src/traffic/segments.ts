import { createHash } from 'node:crypto';

import type { TrafficCongestionLevel } from '@navoss/contracts';

import type { Position } from './geo.js';
import type { TrafficSettings } from './settings.js';

/**
 * Only through roads are aggregated, and the list is fixed in code. Tertiary and lower roads,
 * service roads, driveways, tracks, parking aisles and living streets are where trips begin and
 * end; on a sparse one, three contributors can still be one household. Tertiary roads stay out
 * until there is a way to tell a busy one from a rural one.
 *
 * Access is not checked: Valhalla 3.8.2 does not return `destination_only` from
 * `trace_attributes`. Private and destination-only roads are excluded only in so far as they are
 * mapped as service roads, tracks or minor classes, which is the usual case.
 */
const AGGREGATED_ROAD_CLASSES: ReadonlySet<string> = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
]);
const AGGREGATED_USES: ReadonlySet<string> = new Set(['road', 'ramp', 'turn_channel']);

export interface EdgeRoad {
  forward: boolean;
  roadClass: string;
  speedKph: number;
  use: string;
  wayId: number;
}

/** True when a matched edge is a through road NavOSS may aggregate. */
export function isAggregatedRoad(edge: EdgeRoad): boolean {
  return (
    AGGREGATED_ROAD_CLASSES.has(edge.roadClass) &&
    AGGREGATED_USES.has(edge.use) &&
    edge.speedKph > 0
  );
}

/** OSM way id plus travel direction relative to the way, e.g. `w142596972b`. */
export function wayDirectionKey(edge: Pick<EdgeRoad, 'forward' | 'wayId'>): string {
  return `w${String(edge.wayId)}${edge.forward ? 'f' : 'b'}`;
}

/**
 * Key of one whole directed graph edge: the way, the direction, and a digest of the edge's own map
 * geometry. The published unit is the edge, not the way, so the contributor threshold applies to
 * exactly the stretch of road that is drawn. The key commits to the geometry: every contributor
 * who drives the edge end to end derives the same key and the same line from the map, and nothing
 * a batch contains can extend or move it.
 */
export function edgeSegmentKey(
  edge: Pick<EdgeRoad, 'forward' | 'wayId'>,
  line: readonly Position[],
): string {
  const digest = createHash('sha256');
  for (const [longitude, latitude] of line) {
    digest.update(`${String(Math.round(longitude * 1e6))},${String(Math.round(latitude * 1e6))};`);
  }
  return `${wayDirectionKey(edge)}-${digest.digest('hex').slice(0, 12)}`;
}

export function classifyCongestion(
  speedKph: number,
  freeFlowKph: number,
  thresholds: Pick<TrafficSettings, 'freeRatio' | 'heavyRatio' | 'slowRatio'>,
): TrafficCongestionLevel {
  const ratio = freeFlowKph > 0 ? speedKph / freeFlowKph : 1;
  if (ratio >= thresholds.freeRatio) return 'free';
  if (ratio >= thresholds.slowRatio) return 'slow';
  if (ratio >= thresholds.heavyRatio) return 'heavy';
  return 'stopped';
}
