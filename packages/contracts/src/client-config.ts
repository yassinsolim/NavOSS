import { z } from 'zod/v4';

import type { Coordinate, GeographicBounds } from './common.js';
import {
  isCoordinateInBoundary,
  isCoordinateInBounds,
  SERVICE_AREAS,
  type CoverageBoundary,
} from './coverage.js';

/*
 * A client's view of `/v2/config` (or `/v1/config`), from any server generation.
 *
 * `AppConfigResponseSchema` stays strict about what the current server emits. A shipped app
 * must keep working against older and newer servers, so this model parses leniently:
 * every field newer than the oldest deployed server is optional, unknown fields and endpoints are
 * ignored, and anything absent or malformed means "not available" rather than a failed launch.
 * Coverage comes from what the server declares, never from what this build bundles.
 */

export interface ServerCoverageArea {
  /**
   * The polygon that decides eligibility. Absent when the server declared only a rectangle;
   * then the rectangle itself is the declared area.
   */
  boundary: CoverageBoundary | undefined;
  /** Retrieval/view bounds: the clamp for nearby-search proximity. */
  bounds: GeographicBounds;
  displayName: string;
  id: string;
}

export interface ServerCoverage {
  areas: readonly ServerCoverageArea[];
  displayName: string;
  id: string;
}

export interface ServerCapabilities {
  communityReports: boolean;
  liveTraffic: boolean;
  officialSafetyCameras: boolean;
  productionSearch: boolean;
  /**
   * False only when the server declares `/v1/routes` (it predates `/v2/routes`). A server that
   * names a newer path, or none, is asked `/v2/routes` first and the client falls back on 404.
   */
  routesV2: boolean;
}

export interface ServerConfig {
  apiVersion: string;
  capabilities: ServerCapabilities;
  coverage: ServerCoverage;
}

const CoordinateSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
const BoundsSchema = z
  .object({ northEast: CoordinateSchema, southWest: CoordinateSchema })
  .refine(
    ({ northEast, southWest }) =>
      northEast.latitude > southWest.latitude && northEast.longitude > southWest.longitude,
  );
const RingSchema = z
  .array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]))
  .min(4)
  .refine((ring) => {
    const first = ring[0];
    const last = ring.at(-1);
    return first?.[0] === last?.[0] && first?.[1] === last?.[1];
  });
const BoundarySchema = z.object({
  coordinates: z.array(z.array(RingSchema).min(1)).min(1),
  type: z.literal('MultiPolygon'),
});
const AreaSchema = z.object({
  boundary: BoundarySchema.optional(),
  bounds: BoundsSchema,
  displayName: z.string().min(1),
  id: z.string().min(1),
});
const ConfigEnvelopeSchema = z.object({
  apiVersion: z.string().min(1),
  coverage: z.object({
    bounds: z.unknown().optional(),
    displayName: z.string().min(1),
    id: z.string().min(1),
    serviceAreas: z.array(z.unknown()).optional(),
  }),
  endpoints: z.record(z.string(), z.unknown()).optional().catch(undefined),
  features: z.record(z.string(), z.unknown()).optional().catch(undefined),
});

function parseArea(value: unknown): ServerCoverageArea | undefined {
  const parsed = AreaSchema.safeParse(value);
  // A malformed area is dropped, never widened to a rectangle the server did not mean.
  if (!parsed.success) return undefined;
  const { boundary, bounds, displayName, id } = parsed.data;
  // Bundled provincial polygons apply only to a province the server itself declares.
  return {
    boundary: boundary ?? SERVICE_AREAS.find((area) => area.id === id)?.boundary,
    bounds,
    displayName,
    id,
  };
}

/** Throws when the payload has no usable coverage, which no NavOSS server generation omits. */
export function serverConfigFromPayload(payload: unknown): ServerConfig {
  const envelope = ConfigEnvelopeSchema.parse(payload);
  const { coverage } = envelope;
  const areas =
    coverage.serviceAreas !== undefined
      ? coverage.serviceAreas.flatMap((value) => parseArea(value) ?? [])
      : // `/v1/config`: one rectangle names the whole coverage.
        [parseArea({ bounds: coverage.bounds, displayName: coverage.displayName, id: coverage.id })]
          .filter((area) => area !== undefined)
          // The v1 rectangle is the declared area itself, whatever its id matches in the bundle.
          .map((area) => ({ ...area, boundary: undefined }));
  if (areas.length === 0) throw new Error('The NavOSS service declared no usable coverage.');
  const feature = (name: string) => envelope.features?.[name] === true;
  return {
    apiVersion: envelope.apiVersion,
    capabilities: {
      communityReports: feature('communityReports'),
      liveTraffic: feature('liveTraffic'),
      officialSafetyCameras: feature('officialSafetyCameras'),
      productionSearch: feature('productionSearch'),
      routesV2: envelope.endpoints?.routes !== '/v1/routes',
    },
    coverage: { areas, displayName: coverage.displayName, id: coverage.id },
  };
}

function isCoordinateInServerArea(coordinate: Coordinate, area: ServerCoverageArea): boolean {
  if (!isCoordinateInBounds(coordinate, area.bounds)) return false;
  return area.boundary === undefined || isCoordinateInBoundary(coordinate, area.boundary);
}

export function serverAreaForCoordinate(
  coverage: ServerCoverage,
  coordinate: Coordinate | undefined,
): ServerCoverageArea | undefined {
  if (coordinate === undefined) return undefined;
  return coverage.areas.find((area) => isCoordinateInServerArea(coordinate, area));
}

/**
 * Whether the declared coverage allows a request at this place. Unknown coverage (the config
 * has not arrived) does not block: the server still refuses what it does not serve.
 */
export function isCoordinateServed(
  coverage: ServerCoverage | undefined,
  coordinate: Coordinate,
): boolean {
  return coverage === undefined || serverAreaForCoordinate(coverage, coordinate) !== undefined;
}
