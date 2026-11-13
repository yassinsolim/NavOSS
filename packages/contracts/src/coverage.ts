import { z } from 'zod/v4';

import {
  GeographicBoundsSchema,
  LatitudeSchema,
  LongitudeSchema,
  type Coordinate,
  type GeographicBounds,
} from './common.js';
import { COVERAGE_DEFINITION, SERVICE_AREA_DATA } from './coverage-data.js';

const BoundaryPositionSchema = z.tuple([LongitudeSchema, LatitudeSchema]);
const BoundaryRingSchema = z
  .array(BoundaryPositionSchema)
  .min(4)
  .superRefine((ring, context) => {
    const first = ring[0];
    const last = ring.at(-1);
    if (first?.[0] !== last?.[0] || first?.[1] !== last?.[1]) {
      context.addIssue({ code: 'custom', message: 'boundary rings must be closed' });
    }
  });

export const CoverageBoundarySchema = z
  .object({
    coordinates: z.array(z.array(BoundaryRingSchema).min(1)).min(1),
    type: z.literal('MultiPolygon'),
  })
  .strict();

export const ServiceAreaSchema = z
  .object({
    boundary: CoverageBoundarySchema,
    bounds: GeographicBoundsSchema.describe(
      'Retrieval/view bounds only; eligibility uses the boundary',
    ),
    countryCode: z.string().regex(/^[A-Z]{2}$/),
    displayName: z.string().min(1),
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    provinceCode: z.string().min(1),
  })
  .strict();

export type CoverageBoundary = z.infer<typeof CoverageBoundarySchema>;
export type ServiceArea = z.infer<typeof ServiceAreaSchema>;

export const CoverageBoundarySourceSchema = z
  .object({
    attribution: z.string().min(1),
    datasetVersion: z.string().min(1),
    licenseUrl: z.url(),
    simplificationToleranceDegrees: z.number().nonnegative(),
    url: z.url(),
  })
  .strict();

export const SERVICE_AREAS: readonly ServiceArea[] = SERVICE_AREA_DATA;
export const SERVICE_COVERAGE_ID = COVERAGE_DEFINITION.id;
export const SERVICE_COVERAGE_NAME = COVERAGE_DEFINITION.displayName;
export const COVERAGE_BOUNDARY_SOURCE = COVERAGE_DEFINITION.boundarySource;

// This envelope is only for upstream retrieval. It must never authorize a search result or route.
export const SERVICE_COVERAGE_BOUNDS: GeographicBounds = SERVICE_AREAS.reduce(
  (bounds, area) => ({
    northEast: {
      latitude: Math.max(bounds.northEast.latitude, area.bounds.northEast.latitude),
      longitude: Math.max(bounds.northEast.longitude, area.bounds.northEast.longitude),
    },
    southWest: {
      latitude: Math.min(bounds.southWest.latitude, area.bounds.southWest.latitude),
      longitude: Math.min(bounds.southWest.longitude, area.bounds.southWest.longitude),
    },
  }),
  {
    northEast: { latitude: -90, longitude: -180 },
    southWest: { latitude: 90, longitude: 180 },
  },
);

export function isCoordinateInBounds(coordinate: Coordinate, bounds: GeographicBounds): boolean {
  return (
    coordinate.latitude >= bounds.southWest.latitude &&
    coordinate.latitude <= bounds.northEast.latitude &&
    coordinate.longitude >= bounds.southWest.longitude &&
    coordinate.longitude <= bounds.northEast.longitude
  );
}

function isCoordinateInRing(
  coordinate: Coordinate,
  ring: CoverageBoundary['coordinates'][number][number],
): boolean {
  let inside = false;
  for (let index = 1; index < ring.length; index += 1) {
    const previous = ring[index - 1];
    const current = ring[index];
    if (previous === undefined || current === undefined) continue;
    const [x1, y1] = previous;
    const [x2, y2] = current;
    const x = coordinate.longitude;
    const y = coordinate.latitude;
    // Include the recorded boundary itself, without buffering it into neighbouring jurisdictions.
    const cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1);
    if (
      Math.abs(cross) <= 1e-10 &&
      x >= Math.min(x1, x2) &&
      x <= Math.max(x1, x2) &&
      y >= Math.min(y1, y2) &&
      y <= Math.max(y1, y2)
    )
      return true;
    if (y1 > y !== y2 > y && x < x1 + ((y - y1) * (x2 - x1)) / (y2 - y1)) {
      inside = !inside;
    }
  }
  return inside;
}

export function isCoordinateInBoundary(
  coordinate: Coordinate,
  boundary: CoverageBoundary,
): boolean {
  for (const polygon of boundary.coordinates) {
    const exterior = polygon[0];
    if (exterior === undefined || !isCoordinateInRing(coordinate, exterior)) continue;
    let inHole = false;
    for (let index = 1; index < polygon.length; index += 1) {
      const hole = polygon[index];
      if (hole !== undefined && isCoordinateInRing(coordinate, hole)) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

export function serviceAreaForCoordinate(coordinate: Coordinate): ServiceArea | undefined {
  return SERVICE_AREAS.find(
    (area) =>
      isCoordinateInBounds(coordinate, area.bounds) &&
      isCoordinateInBoundary(coordinate, area.boundary),
  );
}

export function isCoordinateInServiceCoverage(coordinate: Coordinate): boolean {
  return serviceAreaForCoordinate(coordinate) !== undefined;
}

export const CoverageOverlaySchema = z
  .object({
    bounds: GeographicBoundsSchema,
    displayName: z.string().min(1),
    id: z.string().min(1),
    serviceAreaId: z.string().min(1),
    scope: z.literal('local-overlay'),
    services: z
      .array(
        z.enum([
          'civic-search',
          'safety-cameras',
          'road-events',
          'traffic-cameras',
          'safety-facilities',
        ]),
      )
      .min(1),
  })
  .strict();

// These municipal overlays are not province-wide routing/search coverage.
export const CALGARY_REGION_BOUNDS: GeographicBounds = {
  northEast: { latitude: 51.212, longitude: -113.859 },
  southWest: { latitude: 50.842, longitude: -114.316 },
};
export const KELOWNA_REGION_BOUNDS: GeographicBounds = {
  northEast: { latitude: 50.15, longitude: -119.2 },
  southWest: { latitude: 49.7, longitude: -119.65 },
};
export const LOCAL_OVERLAY_AREAS: z.infer<typeof CoverageOverlaySchema>[] = [
  {
    bounds: CALGARY_REGION_BOUNDS,
    displayName: 'Calgary municipal overlays',
    id: 'calgary-ab',
    serviceAreaId: 'alberta',
    scope: 'local-overlay',
    services: ['civic-search', 'safety-cameras', 'road-events'],
  },
  {
    bounds: KELOWNA_REGION_BOUNDS,
    displayName: 'Kelowna local overlays',
    id: 'kelowna-bc',
    serviceAreaId: 'british-columbia',
    scope: 'local-overlay',
    services: ['road-events', 'traffic-cameras', 'safety-facilities'],
  },
];
