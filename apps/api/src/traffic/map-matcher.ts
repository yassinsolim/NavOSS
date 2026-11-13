import { z } from 'zod/v4';

import { cumulativeMeters, decodePolyline6, type Position } from './geo.js';
import type { ProbePoint } from './probe-validation.js';
import { edgeSegmentKey } from './segments.js';

const TRACE_TIMEOUT_MS = 4_000;
// Valhalla's default trace limits are 200 km and 16,000 shape points per request.
const WALK_CHUNK_METERS = 100_000;
const WALK_CHUNK_POINTS = 5_000;
const WALK_MAX_CHUNKS = 12;
// A fix this far from the road it was snapped to is not evidence about that road.
const MAX_SNAP_METERS = 35;

const EDGE_ATTRIBUTES = [
  'edge.begin_shape_index',
  'edge.end_shape_index',
  'edge.forward',
  'edge.length',
  'edge.road_class',
  'edge.source_percent_along',
  'edge.speed',
  'edge.speed_limit',
  'edge.target_percent_along',
  'edge.use',
  'edge.way_id',
];

const ValhallaEdgeSchema = z.object({
  begin_shape_index: z.number().int().nonnegative(),
  end_shape_index: z.number().int().nonnegative(),
  forward: z.boolean(),
  length: z.number().nonnegative(),
  road_class: z.string(),
  source_percent_along: z.number().min(0).max(1).optional(),
  speed: z.number().nonnegative(),
  speed_limit: z.number().positive().optional(),
  target_percent_along: z.number().min(0).max(1).optional(),
  use: z.string(),
  way_id: z.number().int().positive(),
});

const ValhallaTraceSchema = z.object({
  edges: z.array(ValhallaEdgeSchema).min(1),
  matched_points: z
    .array(
      z.object({
        begin_route_discontinuity: z.boolean().optional(),
        distance_along_edge: z.number().min(0).max(1).optional(),
        distance_from_trace_point: z.number().nonnegative().optional(),
        edge_index: z.number().int().nonnegative().optional(),
        end_route_discontinuity: z.boolean().optional(),
        type: z.enum(['matched', 'interpolated', 'unmatched']),
      }),
    )
    .optional(),
  shape: z.string().min(1),
  units: z.literal('kilometers'),
});

export interface MatchedEdge {
  beginShapeIndex: number;
  endShapeIndex: number;
  forward: boolean;
  /** Share of the full edge where the match enters it; 0 unless this is the first matched edge. */
  fromFraction: number;
  /** Length of the matched part of the edge, which is the whole edge except at the two ends. */
  lengthMeters: number;
  /** Road geometry of the matched part of the edge. This is map data, never uploaded positions. */
  line: Position[];
  roadClass: string;
  /** Present only when the whole edge was matched; see `edgeSegmentKey`. */
  segmentKey?: string;
  speedKph: number;
  toFraction: number;
  use: string;
  wayId: number;
}

export interface MatchedPoint {
  /** Position of the point along its edge as a share of the full edge length. */
  edgeFraction: number;
  edgeIndex: number;
  /** True when the match could not connect this point to the one before it. */
  startsNewPath: boolean;
}

export interface MatchedTrace {
  edges: MatchedEdge[];
  /** One entry per input point, in order; undefined where Valhalla matched nothing. */
  points: (MatchedPoint | undefined)[];
}

export class MapMatcherError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MapMatcherError';
  }
}

export interface MapMatcher {
  /** Returns undefined when the trace does not match the road network. */
  matchTrace(points: readonly ProbePoint[]): Promise<MatchedTrace | undefined>;
  /**
   * Resolves a route's own geometry to graph edges whose shape indexes refer to that geometry.
   * Returns undefined when the geometry cannot be walked exactly or is too long.
   */
  walkRoute(geometry: readonly Position[]): Promise<MatchedEdge[] | undefined>;
}

export interface ValhallaMapMatcherOptions {
  endpoint: string;
  fetchImplementation?: typeof fetch;
}

function normalizeEdges(
  edges: z.infer<typeof ValhallaTraceSchema>['edges'],
  shape: readonly Position[],
): MatchedEdge[] {
  return edges.map((edge) => {
    const fromFraction = edge.source_percent_along ?? 0;
    const toFraction = edge.target_percent_along ?? 1;
    const line = shape.slice(edge.begin_shape_index, edge.end_shape_index + 1);
    return {
      beginShapeIndex: edge.begin_shape_index,
      endShapeIndex: edge.end_shape_index,
      forward: edge.forward,
      fromFraction,
      lengthMeters: edge.length * 1_000,
      line,
      roadClass: edge.road_class,
      ...(fromFraction === 0 && toFraction === 1 && line.length >= 2
        ? { segmentKey: edgeSegmentKey({ forward: edge.forward, wayId: edge.way_id }, line) }
        : {}),
      speedKph: edge.speed,
      toFraction,
      use: edge.use,
      wayId: edge.way_id,
    };
  });
}

export function createValhallaMapMatcher(options: ValhallaMapMatcherOptions): MapMatcher {
  const fetchImplementation = options.fetchImplementation ?? fetch;

  // Errors deliberately carry no request or response content: both contain positions.
  async function trace(
    body: Record<string, unknown>,
  ): Promise<z.infer<typeof ValhallaTraceSchema> | undefined> {
    let response: Response;
    try {
      response = await fetchImplementation(options.endpoint, {
        body: JSON.stringify({ ...body, costing: 'auto', units: 'kilometers' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        // The matcher is local; a redirect could only send positions somewhere else.
        redirect: 'error',
        signal: AbortSignal.timeout(TRACE_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      throw new MapMatcherError('The map matcher could not be reached.', { cause: error });
    }
    // Valhalla answers 400 when a trace has no match; that is an outcome, not an outage.
    if (response.status === 400) return undefined;
    if (!response.ok) {
      throw new MapMatcherError(`The map matcher returned status ${String(response.status)}.`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new MapMatcherError('The map matcher returned invalid JSON.');
    }
    const parsed = ValhallaTraceSchema.safeParse(payload);
    if (!parsed.success) {
      throw new MapMatcherError('The map matcher response failed validation.');
    }
    return parsed.data;
  }

  return {
    async matchTrace(points) {
      const payload = await trace({
        filters: {
          action: 'include',
          attributes: [
            ...EDGE_ATTRIBUTES,
            'matched.begin_route_discontinuity',
            'matched.distance_along_edge',
            'matched.distance_from_trace_point',
            'matched.edge_index',
            'matched.end_route_discontinuity',
            'matched.type',
            'shape',
          ],
        },
        shape: points.map(({ offsetSeconds, position }) => ({
          lat: position[1],
          lon: position[0],
          time: offsetSeconds,
        })),
        shape_match: 'map_snap',
      });
      if (payload?.matched_points?.length !== points.length) return undefined;
      const edges = normalizeEdges(payload.edges, decodePolyline6(payload.shape));
      let pathBroken = false;
      const matched = payload.matched_points.map((point): MatchedPoint | undefined => {
        const startsNewPath = pathBroken || point.begin_route_discontinuity === true;
        pathBroken = point.end_route_discontinuity === true;
        if (
          point.type === 'unmatched' ||
          point.edge_index === undefined ||
          point.distance_along_edge === undefined ||
          point.edge_index >= edges.length ||
          (point.distance_from_trace_point ?? 0) > MAX_SNAP_METERS
        ) {
          pathBroken = true;
          return undefined;
        }
        return {
          edgeFraction: point.distance_along_edge,
          edgeIndex: point.edge_index,
          startsNewPath,
        };
      });
      return { edges, points: matched };
    },

    async walkRoute(geometry) {
      const chunkStarts = [0];
      let chunkStartMeters = 0;
      cumulativeMeters(geometry).forEach((meters, index) => {
        if (index === 0 || index >= geometry.length - 1) return;
        if (
          meters - chunkStartMeters >= WALK_CHUNK_METERS ||
          index - (chunkStarts.at(-1) ?? 0) >= WALK_CHUNK_POINTS
        ) {
          chunkStarts.push(index);
          chunkStartMeters = meters;
        }
      });
      if (chunkStarts.length > WALK_MAX_CHUNKS) return undefined;
      // One request at a time: a long route must not occupy both of Valhalla's worker threads.
      const walked: MatchedEdge[] = [];
      for (const [chunkIndex, start] of chunkStarts.entries()) {
        const end = chunkStarts[chunkIndex + 1] ?? geometry.length - 1;
        const payload = await trace({
          filters: { action: 'include', attributes: [...EDGE_ATTRIBUTES, 'shape'] },
          shape: geometry
            .slice(start, end + 1)
            .map(([longitude, latitude]) => ({ lat: latitude, lon: longitude })),
          shape_match: 'edge_walk',
        });
        if (payload === undefined) return undefined;
        const shape = decodePolyline6(payload.shape);
        const edges = normalizeEdges(payload.edges, shape);
        // The walk is only usable when Valhalla echoes the chunk's own vertices and its edges
        // tile them without a gap, so that edge shape indexes address the route geometry.
        let expectedBegin = 0;
        for (const edge of edges) {
          if (edge.beginShapeIndex !== expectedBegin || edge.endShapeIndex <= expectedBegin) {
            return undefined;
          }
          expectedBegin = edge.endShapeIndex;
        }
        if (shape.length !== end - start + 1 || expectedBegin !== end - start) return undefined;
        for (const edge of edges) {
          walked.push({
            ...edge,
            beginShapeIndex: edge.beginShapeIndex + start,
            endShapeIndex: edge.endShapeIndex + start,
          });
        }
      }
      return walked;
    },
  };
}
