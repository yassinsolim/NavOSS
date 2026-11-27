import { z } from 'zod/v4';

import type { RouteProvider } from '../route-provider.js';
import {
  cumulativeMeters,
  decodePolyline6,
  haversineMeters,
  type Position,
} from '../traffic/geo.js';
import type { ValhallaExcludeLocation } from '../valhalla-pbf.js';
import { canonicalClosureRoadName, type ClosureDirection, type ClosureEvent } from './events.js';

export const MAX_CLOSURE_EXCLUSIONS = 50;
const MAX_POINT_SNAP_METERS = 30;
const MAX_LINE_DEVIATION_METERS = 15;
const MIN_LINE_END_SHARE = 0.9;
const COMPASS_HEADINGS = { north: 0, east: 90, south: 180, west: 270 } as const;
const MAX_LINE_METERS = 200_000;
const CELL_METERS = 50;
const METERS_PER_DEGREE = 111_195;
const ROUTE_BARRIER_TOLERANCE_METERS = 3;

export type ClosurePlacementRejection =
  | 'no-graph-match'
  | 'road-name-mismatch'
  | 'ambiguous-edge'
  | 'direction-not-placeable'
  | 'geometry-mismatch'
  | 'exclusion-limit'
  | 'partial-line-end';

export class ClosurePlacementError extends Error {
  public constructor(public readonly reason: ClosurePlacementRejection) {
    super(reason);
    this.name = 'ClosurePlacementError';
  }
}

export interface PlacedBarrier {
  point: Position;
  headings: readonly number[];
  exclusion: ValhallaExcludeLocation;
  /** Public map geometry/name proof; no graph ids and no driver positions. */
  fingerprint: { way_id: number; shape: string; names: readonly string[] };
  pointProof?: {
    coordinate: Position;
    roadNames: readonly string[];
    direction: ClosureDirection;
  };
}
export interface PlacedClosure {
  barriers: readonly PlacedBarrier[];
  verifiedLine: boolean;
  droppedEndEdges: number;
}

type GraphQuery = NonNullable<RouteProvider['getClosureGraph']>;
const IdSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const LocatedSchema = z.array(
  z.object({
    edges: z
      .array(
        z.object({
          correlated_lat: z.number(),
          correlated_lon: z.number(),
          distance: z.number().nonnegative(),
          heading: z.number().min(0).lt(360),
          percent_along: z.number().min(0).max(1),
          edge_id: z.object({ value: IdSchema }),
          edge_info: z.object({
            way_id: IdSchema,
            names: z.array(z.string()),
            shape: z.string().min(1),
          }),
          edge: z.object({ access: z.object({ car: z.boolean() }) }),
        }),
      )
      .nullable()
      .optional(),
  }),
);
type LocatedEdge = NonNullable<z.infer<typeof LocatedSchema>[number]['edges']>[number];
const TraceSchema = z.object({
  units: z.literal('kilometers'),
  shape: z.string().min(1),
  edges: z
    .array(
      z.object({
        id: IdSchema,
        way_id: IdSchema,
        begin_shape_index: z.number().int().nonnegative(),
        end_shape_index: z.number().int().nonnegative(),
        length: z.number().nonnegative(),
        source_percent_along: z.number().min(0).max(1).optional(),
        target_percent_along: z.number().min(0).max(1).optional(),
      }),
    )
    .min(1),
  matched_points: z.array(z.object({ distance_from_trace_point: z.number().nonnegative() })),
});

function bearing(from: Position, to: Position): number {
  const a = (from[1] * Math.PI) / 180;
  const b = (to[1] * Math.PI) / 180;
  const longitude = ((to[0] - from[0]) * Math.PI) / 180;
  return (
    ((Math.atan2(
      Math.sin(longitude) * Math.cos(b),
      Math.cos(a) * Math.sin(b) - Math.sin(a) * Math.cos(b) * Math.cos(longitude),
    ) *
      180) /
      Math.PI +
      360) %
    360
  );
}

function angleDifference(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function distanceToSegment(point: Position, from: Position, to: Position): number {
  const xScale = Math.cos((point[1] * Math.PI) / 180);
  const x = (point[0] - from[0]) * xScale;
  const y = point[1] - from[1];
  const dx = (to[0] - from[0]) * xScale;
  const dy = to[1] - from[1];
  const length = dx * dx + dy * dy;
  const share = length === 0 ? 0 : Math.max(0, Math.min(1, (x * dx + y * dy) / length));
  return haversineMeters(point, [from[0] + (to[0] - from[0]) * share, from[1] + dy * share]);
}

/** A public-geometry grid, not a route index. Bounds work and memory on long/densely sampled feeds. */
export class ClosureProximity {
  private readonly cells = new Map<string, number[]>();
  private readonly longitudeScale: number;
  private readonly origin: Position;
  private readonly bounds: { west: number; east: number; south: number; north: number };

  public constructor(private readonly geometry: readonly Position[]) {
    const first = geometry[0];
    if (first === undefined) throw new ClosurePlacementError('geometry-mismatch');
    this.origin = first;
    this.longitudeScale = METERS_PER_DEGREE * Math.cos((first[1] * Math.PI) / 180);
    this.bounds = { west: first[0], east: first[0], south: first[1], north: first[1] };
    let total = 0;
    for (const point of geometry) {
      this.bounds.west = Math.min(this.bounds.west, point[0]);
      this.bounds.east = Math.max(this.bounds.east, point[0]);
      this.bounds.south = Math.min(this.bounds.south, point[1]);
      this.bounds.north = Math.max(this.bounds.north, point[1]);
    }
    for (let index = 0; index + 1 < geometry.length; index += 1) {
      const from = geometry[index];
      const to = geometry[index + 1];
      if (from === undefined || to === undefined)
        throw new ClosurePlacementError('geometry-mismatch');
      const length = haversineMeters(from, to);
      total += length;
      if (total > MAX_LINE_METERS) throw new ClosurePlacementError('geometry-mismatch');
      const steps = Math.max(1, Math.ceil(length / (CELL_METERS / 2)));
      for (let sample = 0; sample <= steps; sample += 1) {
        const share = sample / steps;
        const x = Math.floor(
          ((from[0] + (to[0] - from[0]) * share - first[0]) * this.longitudeScale) / CELL_METERS,
        );
        const y = Math.floor(
          ((from[1] + (to[1] - from[1]) * share - first[1]) * METERS_PER_DEGREE) / CELL_METERS,
        );
        const key = `${String(x)}:${String(y)}`;
        const indexes = this.cells.get(key);
        if (indexes === undefined) this.cells.set(key, [index]);
        else if (indexes.at(-1) !== index) indexes.push(index);
      }
    }
  }

  public distance(point: Position, maximum: number): number {
    if (this.geometry.length === 1) return haversineMeters(point, this.origin);
    const x = Math.floor(((point[0] - this.origin[0]) * this.longitudeScale) / CELL_METERS);
    const y = Math.floor(((point[1] - this.origin[1]) * METERS_PER_DEGREE) / CELL_METERS);
    const radius = Math.ceil((maximum + CELL_METERS / 4) / CELL_METERS);
    let minimum = Infinity;
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (const index of this.cells.get(`${String(x + dx)}:${String(y + dy)}`) ?? []) {
          const from = this.geometry[index];
          const to = this.geometry[index + 1];
          if (from !== undefined && to !== undefined)
            minimum = Math.min(minimum, distanceToSegment(point, from, to));
        }
      }
    }
    return minimum;
  }

  public nearRoute(geometry: readonly Position[]): boolean {
    const longitudePad = 40 / this.longitudeScale;
    const latitudePad = 40 / METERS_PER_DEGREE;
    const west = this.bounds.west - longitudePad;
    const east = this.bounds.east + longitudePad;
    const south = this.bounds.south - latitudePad;
    const north = this.bounds.north + latitudePad;
    for (let index = 1; index < geometry.length; index += 1) {
      const from = geometry[index - 1];
      const to = geometry[index];
      if (
        from === undefined ||
        to === undefined ||
        Math.max(from[0], to[0]) < west ||
        Math.min(from[0], to[0]) > east ||
        Math.max(from[1], to[1]) < south ||
        Math.min(from[1], to[1]) > north
      )
        continue;
      if (this.geometry.length === 1) {
        if (distanceToSegment(this.origin, from, to) <= 40) return true;
        continue;
      }
      // Liang–Barsky clips a possibly very long route segment to this public closure's envelope.
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      const limits = [
        [-dx, from[0] - west],
        [dx, east - from[0]],
        [-dy, from[1] - south],
        [dy, north - from[1]],
      ];
      let begin = 0;
      let end = 1;
      let outside = false;
      for (const [p, q] of limits) {
        if (p === undefined || q === undefined)
          throw new ClosurePlacementError('geometry-mismatch');
        if (p === 0) {
          if (q < 0) outside = true;
          continue;
        }
        const share = q / p;
        if (p < 0) begin = Math.max(begin, share);
        else end = Math.min(end, share);
      }
      if (outside || begin > end) continue;
      const steps = Math.max(1, Math.ceil((haversineMeters(from, to) * (end - begin)) / 10));
      for (let sample = 0; sample <= steps; sample += 1) {
        const share = begin + ((end - begin) * sample) / steps;
        if (this.distance([from[0] + dx * share, from[1] + dy * share], 40) <= 40) return true;
      }
    }
    return false;
  }
}

function midpoint(line: readonly Position[]): Position {
  const first = line[0];
  if (first === undefined || line.length < 2) throw new ClosurePlacementError('geometry-mismatch');
  const distances = cumulativeMeters(line);
  const half = (distances.at(-1) ?? 0) / 2;
  const index = Math.max(
    1,
    distances.findIndex((distance) => distance >= half),
  );
  const from = line[index - 1];
  const to = line[index];
  if (from === undefined || to === undefined) throw new ClosurePlacementError('geometry-mismatch');
  const span = (distances[index] ?? 0) - (distances[index - 1] ?? 0);
  const share = span > 0 ? (half - (distances[index - 1] ?? 0)) / span : 0;
  return [from[0] + (to[0] - from[0]) * share, from[1] + (to[1] - from[1]) * share];
}

/** Same options are used in validation and the actual exclusion request, including explicit zeros. */
function exactLocation(point: Position, heading?: number): ValhallaExcludeLocation {
  return {
    lat: point[1],
    lon: point[0],
    radius: 0,
    node_snap_tolerance: 0,
    minimum_reachability: 0,
    search_cutoff: 1,
    ...(heading === undefined ? {} : { heading: Math.round(heading) % 360, heading_tolerance: 5 }),
  };
}

function assertOnePhysicalEdge(edges: readonly LocatedEdge[]): void {
  const first = edges[0];
  if (first === undefined) throw new ClosurePlacementError('no-graph-match');
  if (
    edges.some(
      (edge) =>
        !edge.edge.access.car ||
        edge.edge_info.way_id !== first.edge_info.way_id ||
        edge.edge_info.shape !== first.edge_info.shape,
    )
  )
    throw new ClosurePlacementError('ambiguous-edge');
}

function assertBothDirections(edges: readonly LocatedEdge[]): void {
  if (!edges.some((from) => edges.some((to) => angleDifference(from.heading, to.heading) >= 150)))
    throw new ClosurePlacementError('direction-not-placeable');
}

async function assertPointWays(
  point: Position,
  roadNames: readonly string[],
  direction: ClosureDirection,
  expectedWay: number,
  query: GraphQuery,
  signal: AbortSignal,
): Promise<void> {
  const nearby = LocatedSchema.parse(
    await query(
      'locate',
      {
        costing: 'auto',
        verbose: true,
        locations: [
          {
            lat: point[1],
            lon: point[0],
            radius: MAX_POINT_SNAP_METERS,
            search_cutoff: MAX_POINT_SNAP_METERS,
            node_snap_tolerance: 0,
            minimum_reachability: 0,
          },
        ],
      },
      signal,
    ),
  )[0]?.edges;
  if (nearby == null) throw new ClosurePlacementError('no-graph-match');
  const matching = nearby.filter(
    (edge) =>
      edge.edge.access.car &&
      edge.distance <= MAX_POINT_SNAP_METERS &&
      edge.edge_info.names.some((name) =>
        roadNames.some(
          (expected) => canonicalClosureRoadName(name) === canonicalClosureRoadName(expected),
        ),
      ) &&
      (direction === 'both' || angleDifference(edge.heading, COMPASS_HEADINGS[direction]) <= 60),
  );
  if (matching.length === 0) throw new ClosurePlacementError('no-graph-match');
  if (matching.some((edge) => edge.edge_info.way_id !== expectedWay))
    throw new ClosurePlacementError('ambiguous-edge');
}

export async function placeClosure(
  event: ClosureEvent,
  query: GraphQuery,
  proximity: ClosureProximity,
  signal: AbortSignal,
): Promise<PlacedClosure> {
  if (event.geometryType === 'point') {
    const point = event.geometry[0];
    if (point === undefined) throw new ClosurePlacementError('geometry-mismatch');
    const located = LocatedSchema.parse(
      await query(
        'locate',
        {
          costing: 'auto',
          verbose: true,
          locations: [
            {
              lat: point[1],
              lon: point[0],
              radius: 0,
              node_snap_tolerance: 0,
              minimum_reachability: 0,
              search_cutoff: MAX_POINT_SNAP_METERS,
            },
          ],
        },
        signal,
      ),
    );
    const edges = located[0]?.edges;
    if (edges == null || edges.length === 0) throw new ClosurePlacementError('no-graph-match');
    const named = edges.filter(
      (edge) =>
        edge.distance <= MAX_POINT_SNAP_METERS &&
        edge.edge_info.names.some((name) =>
          event.roadNames.some(
            (sourceName) => canonicalClosureRoadName(name) === canonicalClosureRoadName(sourceName),
          ),
        ),
    );
    if (named.length === 0) throw new ClosurePlacementError('road-name-mismatch');
    const desired = COMPASS_HEADINGS;
    const directed =
      event.direction === 'both'
        ? named
        : named.filter(
            (edge) =>
              angleDifference(edge.heading, desired[event.direction as keyof typeof desired]) <= 60,
          );
    if (directed.length === 0) throw new ClosurePlacementError('direction-not-placeable');
    assertOnePhysicalEdge(directed);
    const first = directed[0];
    if (first === undefined) throw new ClosurePlacementError('direction-not-placeable');
    // A point at a junction does not say which adjacent section of the road is closed.
    if (directed.some((edge) => edge.percent_along <= 0.01 || edge.percent_along >= 0.99))
      throw new ClosurePlacementError('ambiguous-edge');
    // A zero-radius nearest match alone cannot distinguish express and collector carriageways.
    await assertPointWays(
      point,
      event.roadNames,
      event.direction,
      first.edge_info.way_id,
      query,
      signal,
    );
    const snapped: Position = [first.correlated_lon, first.correlated_lat];
    const exclusion = exactLocation(
      snapped,
      event.direction === 'both' ? undefined : first.heading,
    );
    const confirmed = LocatedSchema.parse(
      await query('locate', { costing: 'auto', verbose: true, locations: [exclusion] }, signal),
    )[0]?.edges;
    if (confirmed == null) throw new ClosurePlacementError('no-graph-match');
    assertOnePhysicalEdge(confirmed);
    if (event.direction === 'both') assertBothDirections(confirmed);
    const intended = new Set(directed.map((edge) => edge.edge_id.value));
    if (confirmed.some((edge) => !intended.has(edge.edge_id.value)))
      throw new ClosurePlacementError('ambiguous-edge');
    return {
      verifiedLine: false,
      droppedEndEdges: 0,
      barriers: [
        {
          point: snapped,
          exclusion,
          headings: confirmed.map((edge) => edge.heading),
          fingerprint: first.edge_info,
          pointProof: { coordinate: point, roadNames: event.roadNames, direction: event.direction },
        },
      ],
    };
  }
  let shape = event.geometry;
  const first = shape[0];
  const last = shape.at(-1);
  if (first === undefined || last === undefined)
    throw new ClosurePlacementError('geometry-mismatch');
  if (event.direction !== 'both') {
    const desired = COMPASS_HEADINGS[event.direction];
    const forward = bearing(first, last);
    if (angleDifference(forward, desired) > 60) {
      if (angleDifference((forward + 180) % 360, desired) > 60)
        throw new ClosurePlacementError('direction-not-placeable');
      shape = [...shape].reverse();
    }
  }
  const trace = TraceSchema.parse(
    await query(
      'trace_attributes',
      {
        costing: 'auto',
        // Source lines have no guaranteed vertex ordering. This changes placement, never driver costing.
        costing_options: { auto: { ignore_oneways: true } },
        shape_match: 'map_snap',
        gps_accuracy: MAX_LINE_DEVIATION_METERS,
        search_radius: MAX_POINT_SNAP_METERS,
        shape: shape.map(([lon, lat]) => ({ lon, lat })),
        units: 'kilometers',
        filters: {
          action: 'include',
          attributes: [
            'edge.id',
            'edge.way_id',
            'edge.begin_shape_index',
            'edge.end_shape_index',
            'edge.length',
            'edge.source_percent_along',
            'edge.target_percent_along',
            'matched.point',
            'matched.distance_from_trace_point',
            'shape',
          ],
        },
      },
      signal,
    ),
  );
  // Only the two end edges can be omitted for insufficient published coverage.
  if (trace.edges.length > MAX_CLOSURE_EXCLUSIONS)
    throw new ClosurePlacementError('exclusion-limit');
  const matched = decodePolyline6(trace.shape);
  if (
    trace.matched_points.length !== shape.length ||
    trace.matched_points.some(
      (point) => point.distance_from_trace_point > MAX_LINE_DEVIATION_METERS,
    ) ||
    matched.some(
      (point) => proximity.distance(point, MAX_LINE_DEVIATION_METERS) > MAX_LINE_DEVIATION_METERS,
    )
  )
    throw new ClosurePlacementError('geometry-mismatch');
  const targets: {
    edge: (typeof trace.edges)[number];
    point: Position;
    exclusion: ValhallaExcludeLocation;
  }[] = [];
  let droppedEndEdges = 0;
  for (let index = 0; index < trace.edges.length; index += 1) {
    const edge = trace.edges[index];
    if (
      edge === undefined ||
      edge.begin_shape_index >= edge.end_shape_index ||
      edge.end_shape_index >= matched.length ||
      (index > 0 && trace.edges[index - 1]?.end_shape_index !== edge.begin_shape_index)
    )
      throw new ClosurePlacementError('geometry-mismatch');
    if (index === 0 || index === trace.edges.length - 1) {
      const share = Math.abs((edge.target_percent_along ?? 1) - (edge.source_percent_along ?? 0));
      const matchedMeters = edge.length * 1_000;
      if (
        share < MIN_LINE_END_SHARE ||
        (matchedMeters * (1 - share)) / share > MAX_LINE_DEVIATION_METERS
      ) {
        droppedEndEdges += 1;
        continue;
      }
    }
    const line = matched.slice(edge.begin_shape_index, edge.end_shape_index + 1);
    const point = midpoint(line);
    // Tangent at this barrier, rather than the road's overall compass bearing on a bend.
    let heading: number | undefined;
    if (event.direction !== 'both') {
      const segment = line.findIndex(
        (to, position) =>
          position > 0 && distanceToSegment(point, line[position - 1] ?? to, to) < 0.5,
      );
      const from = line[segment - 1];
      const to = line[segment];
      if (from === undefined || to === undefined)
        throw new ClosurePlacementError('direction-not-placeable');
      heading = bearing(from, to);
    }
    targets.push({ edge, point, exclusion: exactLocation(point, heading) });
  }
  if (targets.length === 0) throw new ClosurePlacementError('partial-line-end');
  if (targets.length > MAX_CLOSURE_EXCLUSIONS) throw new ClosurePlacementError('exclusion-limit');
  const located = LocatedSchema.parse(
    await query(
      'locate',
      { costing: 'auto', verbose: true, locations: targets.map((target) => target.exclusion) },
      signal,
    ),
  );
  if (located.length !== targets.length) throw new ClosurePlacementError('no-graph-match');
  const barriers = targets.map((target, index): PlacedBarrier => {
    const edges = located[index]?.edges;
    if (edges == null) throw new ClosurePlacementError('no-graph-match');
    assertOnePhysicalEdge(edges);
    if (event.direction === 'both') assertBothDirections(edges);
    if (edges.some((edge) => edge.distance > 1 || edge.edge_info.way_id !== target.edge.way_id))
      throw new ClosurePlacementError('ambiguous-edge');
    const first = edges[0];
    if (first === undefined) throw new ClosurePlacementError('no-graph-match');
    return {
      point: target.point,
      exclusion: target.exclusion,
      headings: edges.map((edge) => edge.heading),
      fingerprint: first.edge_info,
    };
  });
  return { verifiedLine: true, barriers, droppedEndEdges };
}

/** Exempt only travel away from a nearby barrier, never an endpoint approaching it. */
export function barrierForEndpoints(
  barrier: PlacedBarrier,
  endpoints: readonly Position[],
): PlacedBarrier | undefined {
  if (!endpoints.some((point) => haversineMeters(barrier.point, point) <= 20)) return barrier;
  const longitudeScale = Math.cos((barrier.point[1] * Math.PI) / 180);
  const headings = barrier.headings.filter((heading) => {
    const radians = (heading * Math.PI) / 180;
    return endpoints.some((point) => {
      const east = (point[0] - barrier.point[0]) * METERS_PER_DEGREE * longitudeScale;
      const north = (point[1] - barrier.point[1]) * METERS_PER_DEGREE;
      return east * Math.sin(radians) + north * Math.cos(radians) <= 0.01;
    });
  });
  if (headings.length === barrier.headings.length) return barrier;
  const heading = headings[0];
  if (heading === undefined) return undefined;
  return { ...barrier, headings, exclusion: exactLocation(barrier.point, heading) };
}

/** Rechecks cached public placement immediately before use, including graph replacement/name changes. */
export async function validateClosureBarriers(
  barriers: readonly PlacedBarrier[],
  query: GraphQuery,
  signal: AbortSignal,
): Promise<void> {
  const located = LocatedSchema.parse(
    await query(
      'locate',
      {
        costing: 'auto',
        verbose: true,
        locations: barriers.map((barrier) => barrier.exclusion),
      },
      signal,
    ),
  );
  if (located.length !== barriers.length) throw new ClosurePlacementError('no-graph-match');
  for (const [index, barrier] of barriers.entries()) {
    const edges = located[index]?.edges;
    if (edges == null) throw new ClosurePlacementError('no-graph-match');
    assertOnePhysicalEdge(edges);
    if (
      edges.some(
        (edge) =>
          edge.distance > 1 ||
          edge.edge_info.way_id !== barrier.fingerprint.way_id ||
          edge.edge_info.shape !== barrier.fingerprint.shape ||
          (barrier.fingerprint.names.length > 0 &&
            !edge.edge_info.names.some((name) =>
              barrier.fingerprint.names.some(
                (expected) => canonicalClosureRoadName(name) === canonicalClosureRoadName(expected),
              ),
            )),
      ) ||
      barrier.headings.some(
        (heading) => !edges.some((edge) => angleDifference(edge.heading, heading) <= 5),
      )
    ) {
      throw new ClosurePlacementError('geometry-mismatch');
    }
    if (barrier.pointProof !== undefined) {
      await assertPointWays(
        barrier.pointProof.coordinate,
        barrier.pointProof.roadNames,
        barrier.pointProof.direction,
        barrier.fingerprint.way_id,
        query,
        signal,
      );
    }
  }
}

/** Uses only the transient route, never stores it, and checks direction on two-way roads. */
export function routeCrossesBarrier(
  geometry: readonly Position[],
  barrier: PlacedBarrier,
): boolean {
  const latitudePad = ROUTE_BARRIER_TOLERANCE_METERS / METERS_PER_DEGREE;
  const longitudePad = latitudePad / Math.cos((barrier.point[1] * Math.PI) / 180);
  for (let index = 1; index < geometry.length; index += 1) {
    const from = geometry[index - 1];
    const to = geometry[index];
    if (
      from === undefined ||
      to === undefined ||
      Math.max(from[0], to[0]) < barrier.point[0] - longitudePad ||
      Math.min(from[0], to[0]) > barrier.point[0] + longitudePad ||
      Math.max(from[1], to[1]) < barrier.point[1] - latitudePad ||
      Math.min(from[1], to[1]) > barrier.point[1] + latitudePad
    )
      continue;
    if (
      distanceToSegment(barrier.point, from, to) <= ROUTE_BARRIER_TOLERANCE_METERS &&
      barrier.headings.some((heading) => angleDifference(bearing(from, to), heading) <= 60)
    )
      return true;
  }
  return false;
}
