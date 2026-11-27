import { z } from 'zod/v4';

import { decodePolyline6, type Position } from '../traffic/geo.js';
import type { MapMatcher, MatchedEdge } from '../traffic/map-matcher.js';
import type { CorridorDefinition } from './corridors.js';
import type { CorridorPiece, PlacedCorridor } from './delay-model.js';

const PLACEMENT_TIMEOUT_MS = 8_000;
// A placed corridor must agree with the table: its length within this share (or 250 m, the size
// of an interchange) of the expected length, and nearly all of it on the expected roads.
export const PLACEMENT_LENGTH_TOLERANCE = 0.06;
const PLACEMENT_LENGTH_SLACK_METERS = 250;
export const PLACEMENT_MIN_ROAD_SHARE = 0.9;
// The City's quiet-hour time implies a speed; outside this range the placement or the label
// reading is wrong, whichever it is.
export const PLAUSIBLE_FREE_FLOW_KPH = { max: 130, min: 30 } as const;

const ValhallaRouteSchema = z.object({
  trip: z.object({
    legs: z
      .array(
        z.object({
          maneuvers: z.array(
            z.object({
              begin_shape_index: z.number().int().nonnegative(),
              end_shape_index: z.number().int().nonnegative(),
              length: z.number().nonnegative(),
              street_names: z.array(z.string()).optional(),
            }),
          ),
          shape: z.string().min(1),
        }),
      )
      .min(1),
    summary: z.object({ length: z.number().positive() }),
  }),
});

export type PlacementFailure =
  'length' | 'no-baseline' | 'no-route' | 'roads' | 'speed' | 'unavailable' | 'walk';

export interface PlacementCheck {
  lengthMeters: number;
  roadShare: number;
}

export type PlacementOutcome =
  | ({ corridor: PlacedCorridor; status: 'placed' } & PlacementCheck)
  | ({ reason: PlacementFailure; status: 'failed' } & Partial<PlacementCheck>);

export interface CorridorPlacer {
  place(definition: CorridorDefinition): Promise<PlacementOutcome>;
}

/**
 * Walks one leg. A leg that ends part-way along an edge can come back from Valhalla 3.8.2's
 * edge_walk with its last vertex moved to, or followed by, a point the route does not have
 * (measured on the Alberta/BC graph); `walkRoute` then refuses it. Such a leg is walked once more
 * without its last vertex, which gives up at most one shape segment at the corridor's end.
 */
async function walkLeg(
  mapMatcher: Pick<MapMatcher, 'walkRoute'>,
  shape: Position[],
): Promise<MatchedEdge[] | undefined> {
  const whole = await mapMatcher.walkRoute(shape);
  if (whole !== undefined || shape.length < 3) return whole;
  return mapMatcher.walkRoute(shape.slice(0, -1));
}

/** True when a Valhalla street name is one of the expected roads (exact, or with a suffix). */
export function matchesRoad(name: string, roads: readonly string[]): boolean {
  return roads.some((road) => name === road || name.startsWith(`${road} `));
}

/** Implied free-flow speed of a corridor, in km/h. */
export function impliedFreeFlowKph(meters: number, minutes: number): number {
  return meters / 1_000 / (minutes / 60);
}

/**
 * Places corridors on the graph a Valhalla serves: routes between the anchors (vias as `through`,
 * each snapped to a non-ramp edge of at least primary class in the anchor's direction), checks
 * the result against the table, then walks the route geometry to the directed edges it uses. The
 * request carries only the table's own coordinates.
 */
export function createCorridorPlacer(options: {
  fetchImplementation?: typeof fetch;
  mapMatcher: Pick<MapMatcher, 'walkRoute'>;
  /** Valhalla `/route` endpoint (JSON). */
  routeEndpoint: string;
}): CorridorPlacer {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  return {
    async place(definition) {
      let payload: unknown;
      try {
        const response = await fetchImplementation(options.routeEndpoint, {
          body: JSON.stringify({
            costing: 'auto',
            directions_type: 'maneuvers',
            // Every anchor is a break, so each leg is walked on its own: Valhalla 3.8.2's
            // edge_walk fails on a geometry that passes a through location (measured on the
            // Alberta/BC graph). The heading keeps a via on its carriageway without a U-turn.
            locations: definition.anchors.map((anchor) => ({
              heading: anchor.headingDegrees,
              heading_tolerance: 45,
              lat: anchor.latitude,
              lon: anchor.longitude,
              radius: 0,
              search_filter: { exclude_ramp: true, min_road_class: 'primary' },
            })),
            units: 'kilometers',
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(PLACEMENT_TIMEOUT_MS),
        });
        if (response.status === 400) return { reason: 'no-route', status: 'failed' };
        if (!response.ok) return { reason: 'unavailable', status: 'failed' };
        payload = await response.json();
      } catch {
        return { reason: 'unavailable', status: 'failed' };
      }
      const parsed = ValhallaRouteSchema.safeParse(payload);
      if (!parsed.success) return { reason: 'no-route', status: 'failed' };
      const { legs } = parsed.data.trip;
      const lengthMeters = parsed.data.trip.summary.length * 1_000;
      const maneuvers = legs.flatMap((leg) => leg.maneuvers);
      const total = maneuvers.reduce((sum, maneuver) => sum + maneuver.length, 0);
      const onRoads = maneuvers.reduce(
        (sum, maneuver) =>
          sum +
          ((maneuver.street_names ?? []).some((name) => matchesRoad(name, definition.roads))
            ? maneuver.length
            : 0),
        0,
      );
      const roadShare = total > 0 ? onRoads / total : 0;
      const check = { lengthMeters, roadShare };
      if (
        Math.abs(lengthMeters - definition.expectedMeters) >
        Math.max(
          PLACEMENT_LENGTH_SLACK_METERS,
          definition.expectedMeters * PLACEMENT_LENGTH_TOLERANCE,
        )
      ) {
        return { ...check, reason: 'length', status: 'failed' };
      }
      if (roadShare < PLACEMENT_MIN_ROAD_SHARE)
        return { ...check, reason: 'roads', status: 'failed' };
      if (definition.baselineMinutes === null) {
        return { ...check, reason: 'no-baseline', status: 'failed' };
      }
      const kph = impliedFreeFlowKph(lengthMeters, definition.baselineMinutes);
      if (kph < PLAUSIBLE_FREE_FLOW_KPH.min || kph > PLAUSIBLE_FREE_FLOW_KPH.max) {
        return { ...check, reason: 'speed', status: 'failed' };
      }
      const edges: MatchedEdge[] = [];
      for (const leg of legs) {
        let walked: MatchedEdge[] | undefined;
        try {
          walked = await walkLeg(options.mapMatcher, decodePolyline6(leg.shape));
        } catch {
          return { ...check, reason: 'unavailable', status: 'failed' };
        }
        if (walked === undefined || walked.some((edge) => edge.graphId === undefined)) {
          return { ...check, reason: 'walk', status: 'failed' };
        }
        edges.push(...walked);
      }
      const pieces: CorridorPiece[] = edges.flatMap((edge) => {
        const share = edge.toFraction - edge.fromFraction;
        return edge.graphId === undefined || share <= 0
          ? []
          : [
              {
                edgeMeters: edge.lengthMeters / share,
                fromFraction: edge.fromFraction,
                graphId: edge.graphId,
                toFraction: edge.toFraction,
              },
            ];
      });
      return {
        ...check,
        corridor: { lengthMeters, pieces, segment: definition.segment },
        status: 'placed',
      };
    },
  };
}
