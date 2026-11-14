import { z } from 'zod/v4';

import type { DeadEndMask } from './dead-end-mask.js';
import { cumulativeMeters, decodePolyline6, type Position } from './geo.js';
import type { ProbePoint } from './probe-validation.js';
import { edgeSegmentKey, isAggregatedRoad, MIN_PUBLISHED_EDGE_METERS } from './segments.js';

const TRACE_TIMEOUT_MS = 4_000;
// Valhalla's default trace limits are 200 km and 16,000 shape points per request.
const WALK_CHUNK_METERS = 100_000;
const WALK_CHUNK_POINTS = 5_000;
const WALK_MAX_CHUNKS = 12;
// A fix this far from the road it was snapped to is not evidence about that road.
const MAX_SNAP_METERS = 35;
// Route geometry and Valhalla's polyline both carry six decimals; allow one unit of rounding.
const VERTEX_TOLERANCE_DEGREES = 1.5e-6;

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

/**
 * The part of a verbose `/locate` answer the access check reads. `trace_attributes` in Valhalla
 * 3.8.2 does not return these flags (checked against a real instance), but `/locate` reports them
 * for the graph edges at a point.
 */
const ValhallaLocateSchema = z.array(
  z.object({
    edges: z
      .array(
        z.object({
          /** Metres from the located point to the edge. */
          distance: z.number().nonnegative().optional(),
          edge: z.object({
            access: z.object({ car: z.boolean() }),
            deadend: z.boolean(),
            destination_only: z.boolean(),
            forward: z.boolean(),
            not_thru: z.boolean(),
          }),
          edge_info: z.object({
            /** The whole edge's shape (polyline6) in the way's direction. */
            shape: z.string().min(1).optional(),
            way_id: z.number().int(),
          }),
        }),
      )
      .nullable()
      .optional(),
  }),
);

const ValhallaTraceSchema = z.object({
  edges: z.array(ValhallaEdgeSchema).min(1),
  matched_points: z
    .array(
      z.object({
        begin_route_discontinuity: z.boolean().optional(),
        distance_along_edge: z.number().min(0).max(1).optional(),
        distance_from_trace_point: z.number().nonnegative().optional(),
        // Valhalla 3.8.2 sends 2^64 - 1 (no edge) for some interpolated points in a crawl; that
        // is past the safe-integer range, so it is accepted here and treated as unmatched below.
        edge_index: z.number().nonnegative().optional(),
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
  /**
   * Set by `matchTrace` for an aggregated edge whose full length is at least
   * `MIN_PUBLISHED_EDGE_METERS`, whole or partly matched: true only when the graph confirms the
   * way is open to cars, not destination-only (Valhalla's reading of `access=private` or
   * `destination`), and in neither direction a dead end or the way into a no-through region, and,
   * for a partly matched edge, when its whole geometry could be confirmed. Unset or false means
   * the edge must not be published.
   */
  openThroughRoad?: boolean;
  /**
   * The whole edge's map geometry and key, for an edge the batch matched only partly, set by
   * `matchTrace` together with `openThroughRoad`. It is the same key and line a batch that
   * matched the edge whole derives.
   */
  wholeEdge?: { line: Position[]; segmentKey: string };
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
  /**
   * Topology-derived dead-end mask bound to the graph `endpoint` serves. When set, an edge is an
   * open through road only if the mask places its whole map geometry on the main network. Live
   * publication requires it (`readDeadEndMaskSettings`); without it only the graph's own access
   * and bounded no-through flags are checked.
   */
  deadEndMask?: DeadEndMask;
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

/**
 * Valhalla 3.8.2 `edge_walk` repeats the walk's first or last vertex when the walk starts or
 * ends part-way along an edge: it appends the interpolated end of that partial edge, which is the
 * route vertex itself (observed on the Alberta/BC graph for nearly every 100 km chunk boundary).
 * Drops such a repeat, only where the walk returned more vertices than it was sent and the route
 * itself does not repeat that vertex, and re-addresses the edges so indexes refer to the route's
 * own vertices.
 * Returns undefined when an edge with any length would be left with no extent.
 */
function withoutEndpointRepeats(
  shape: Position[],
  edges: z.infer<typeof ValhallaTraceSchema>['edges'],
  sent: readonly Position[],
): { edges: z.infer<typeof ValhallaTraceSchema>['edges']; shape: Position[] } | undefined {
  const same = (left: Position | undefined, right: Position | undefined): boolean =>
    left !== undefined && left[0] === right?.[0] && left[1] === right[1];
  let trimmed = shape;
  let adjusted = edges;
  if (trimmed.length > sent.length && same(trimmed[0], trimmed[1]) && !same(sent[0], sent[1])) {
    trimmed = trimmed.slice(1);
    adjusted = adjusted.map((edge) => ({
      ...edge,
      begin_shape_index: Math.max(0, edge.begin_shape_index - 1),
      end_shape_index: Math.max(0, edge.end_shape_index - 1),
    }));
  }
  if (
    trimmed.length > sent.length &&
    same(trimmed.at(-1), trimmed.at(-2)) &&
    !same(sent.at(-1), sent.at(-2))
  ) {
    trimmed = trimmed.slice(0, -1);
    const last = trimmed.length - 1;
    adjusted = adjusted.map((edge) => ({
      ...edge,
      begin_shape_index: Math.min(last, edge.begin_shape_index),
      end_shape_index: Math.min(last, edge.end_shape_index),
    }));
  }
  // A walk that ends exactly on a node can also carry a zero-length edge entered at 0%; after the
  // repeat is dropped it spans no vertex and carries no distance.
  adjusted = adjusted.filter(
    (edge) => edge.end_shape_index > edge.begin_shape_index || edge.length > 0,
  );
  if (adjusted.some((edge) => edge.end_shape_index <= edge.begin_shape_index)) return undefined;
  return { edges: adjusted, shape: trimmed };
}

/**
 * True when `whole` is the edge a partly matched edge lies on: the matched part's vertices other
 * than an interpolated end are vertices of `whole`, a matched end at a node is that end of
 * `whole`, and the lengths agree with the matched share.
 */
function containsPart(whole: readonly Position[], part: MatchedEdge): boolean {
  const same = (left: Position | undefined, right: Position | undefined): boolean =>
    left !== undefined &&
    right !== undefined &&
    Math.abs(left[0] - right[0]) <= VERTEX_TOLERANCE_DEGREES &&
    Math.abs(left[1] - right[1]) <= VERTEX_TOLERANCE_DEGREES;
  if (whole.length < 2) return false;
  if (part.fromFraction === 0 && !same(part.line[0], whole[0])) return false;
  if (part.toFraction === 1 && !same(part.line.at(-1), whole.at(-1))) return false;
  const interior = part.line.slice(1, -1);
  if (!interior.every((vertex) => whole.some((candidate) => same(candidate, vertex)))) {
    return false;
  }
  const wholeMeters = cumulativeMeters(whole).at(-1) ?? 0;
  const expectedMeters = part.lengthMeters / (part.toFraction - part.fromFraction);
  return Math.abs(wholeMeters - expectedMeters) <= Math.max(5, expectedMeters * 0.05);
}

/** The point halfway along a line by distance. */
function midpoint(line: readonly Position[]): Position {
  const distances = cumulativeMeters(line);
  const half = (distances.at(-1) ?? 0) / 2;
  const index = Math.max(
    1,
    distances.findIndex((distance) => distance >= half),
  );
  const from = line[index - 1] ?? line[0] ?? [0, 0];
  const to = line[index] ?? from;
  const span = (distances[index] ?? 0) - (distances[index - 1] ?? 0);
  const share = span > 0 ? (half - (distances[index - 1] ?? 0)) / span : 0;
  return [from[0] + (to[0] - from[0]) * share, from[1] + (to[1] - from[1]) * share];
}

export function createValhallaMapMatcher(options: ValhallaMapMatcherOptions): MapMatcher {
  const fetchImplementation = options.fetchImplementation ?? fetch;

  const locateEndpoint = new URL('locate', options.endpoint).toString();

  // Errors deliberately carry no request or response content: both contain positions.
  async function post<Schema extends z.ZodType>(
    endpoint: string,
    body: Record<string, unknown>,
    schema: Schema,
  ): Promise<z.infer<Schema> | undefined> {
    let response: Response;
    try {
      response = await fetchImplementation(endpoint, {
        body: JSON.stringify(body),
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
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new MapMatcherError('The map matcher response failed validation.');
    }
    return parsed.data;
  }

  const trace = (body: Record<string, unknown>) =>
    post(options.endpoint, { ...body, costing: 'auto', units: 'kilometers' }, ValhallaTraceSchema);

  /**
   * Marks each aggregated edge whose full length is long enough, whole or partly matched, with
   * whether the graph confirms it is an open through road, and gives a partly matched edge its
   * whole geometry and key. One `/locate` request per batch, carrying only map geometry: the midpoint of
   * each candidate edge's own shape, never an uploaded position. Anything the answer does not
   * confirm stays unpublishable.
   */
  async function screenEdges(edges: MatchedEdge[]): Promise<void> {
    const candidates = edges.filter((edge) => {
      const share = edge.toFraction - edge.fromFraction;
      return (
        isAggregatedRoad(edge) &&
        edge.line.length >= 2 &&
        share > 0.01 &&
        edge.lengthMeters / share >= MIN_PUBLISHED_EDGE_METERS
      );
    });
    if (candidates.length === 0) return;
    const located = await post(
      locateEndpoint,
      {
        costing: 'auto',
        locations: candidates.map((edge) => {
          const [longitude, latitude] = midpoint(edge.line);
          return { lat: latitude, lon: longitude };
        }),
        verbose: true,
      },
      ValhallaLocateSchema,
    );
    candidates.forEach((edge, index) => {
      const sameWay = (located?.[index]?.edges ?? []).filter(
        (candidate) => candidate.edge_info.way_id === edge.wayId,
      );
      const driven = sameWay.filter((candidate) => candidate.edge.forward === edge.forward);
      const open =
        driven.length > 0 &&
        driven.every((candidate) => candidate.edge.access.car) &&
        sameWay
          .filter((candidate) => candidate.edge.access.car)
          .every(
            (candidate) =>
              !candidate.edge.destination_only &&
              !candidate.edge.deadend &&
              !candidate.edge.not_thru,
          );
      // The mask is consulted with the edge's whole map geometry only: the trace's line for an
      // edge matched end to end, the `/locate` shape for a partly matched one. Never a position
      // from the batch.
      const onMainNetwork = (line: readonly Position[]) =>
        options.deadEndMask === undefined ||
        options.deadEndMask.status({ forward: edge.forward, wayId: edge.wayId }, line) ===
          'eligible';
      if (!open || edge.segmentKey !== undefined) {
        edge.openThroughRoad = open && onMainNetwork(edge.line);
        return;
      }
      // A partly matched edge is published under the key of the whole edge it lies on, so its
      // whole geometry must be confirmed: the `/locate` edge of the same way and direction whose
      // shape contains the matched part.
      const wholeLine = [...driven]
        .sort((left, right) => (left.distance ?? Infinity) - (right.distance ?? Infinity))
        .map((candidate) => {
          if (candidate.edge_info.shape === undefined) return undefined;
          const shape = decodePolyline6(candidate.edge_info.shape);
          return candidate.edge.forward ? shape : shape.reverse();
        })
        .find((line) => line !== undefined && containsPart(line, edge));
      edge.openThroughRoad = wholeLine !== undefined && onMainNetwork(wholeLine);
      if (wholeLine !== undefined) {
        edge.wholeEdge = {
          line: wholeLine,
          segmentKey: edgeSegmentKey({ forward: edge.forward, wayId: edge.wayId }, wholeLine),
        };
      }
    });
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
      await screenEdges(edges);
      let pathBroken = false;
      const matched = payload.matched_points.map((point): MatchedPoint | undefined => {
        const startsNewPath = pathBroken || point.begin_route_discontinuity === true;
        pathBroken = point.end_route_discontinuity === true;
        if (
          point.type === 'unmatched' ||
          point.edge_index === undefined ||
          !Number.isSafeInteger(point.edge_index) ||
          point.distance_along_edge === undefined ||
          point.edge_index >= edges.length ||
          // Valhalla 3.8.2 returns this distance, in metres, for every matched point. A point
          // without it is not evidence about the road.
          point.distance_from_trace_point === undefined ||
          point.distance_from_trace_point > MAX_SNAP_METERS
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
        const chunk = geometry.slice(start, end + 1);
        const echoed = withoutEndpointRepeats(decodePolyline6(payload.shape), payload.edges, chunk);
        if (echoed === undefined) return undefined;
        const { shape } = echoed;
        const edges = normalizeEdges(echoed.edges, shape);
        // The walk is only usable when Valhalla echoes the chunk's own vertices and its edges
        // tile them without a gap, so that edge shape indexes address the route geometry.
        if (
          shape.length !== chunk.length ||
          shape.some(([longitude, latitude], index) => {
            const [routeLongitude = Number.NaN, routeLatitude = Number.NaN] = chunk[index] ?? [];
            return (
              Math.abs(longitude - routeLongitude) > VERTEX_TOLERANCE_DEGREES ||
              Math.abs(latitude - routeLatitude) > VERTEX_TOLERANCE_DEGREES
            );
          })
        ) {
          return undefined;
        }
        let expectedBegin = 0;
        for (const edge of edges) {
          if (edge.beginShapeIndex !== expectedBegin || edge.endShapeIndex <= expectedBegin) {
            return undefined;
          }
          expectedBegin = edge.endShapeIndex;
        }
        if (expectedBegin !== end - start) return undefined;
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
