import { z } from 'zod/v4';

import {
  GeographicBoundsSchema,
  LatitudeSchema,
  LongitudeSchema,
  type Coordinate,
  type GeographicBounds,
} from './common.js';
import {
  COVERAGE_BOUNDARY_SOURCE_DATA,
  loadServiceAreaData,
  PROVINCE_PROFILES,
} from './coverage-data.js';

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

export interface ProvinceTimeZone {
  timeZone: string;
  /** The part of the province where `timeZone` is certain; absent means the whole province. */
  within?: GeographicBounds;
}

export interface ProvinceProfile {
  /** Registered neighbours a public road or scheduled vehicle ferry joins directly. */
  connectsTo: readonly string[];
  readinessProbe: Coordinate;
  timeZones: readonly ProvinceTimeZone[];
}

export interface ProvinceRegistration extends ProvinceProfile {
  area: ServiceArea;
}

const PROFILES: Readonly<Record<string, ProvinceProfile>> = PROVINCE_PROFILES;

let registry: readonly ProvinceRegistration[] | undefined;
let registeredAreas: readonly ServiceArea[] | undefined;

/**
 * Every province NavOSS has a sourced boundary for. Registration alone serves nothing. Built on the
 * first call, not when the module loads: the boundaries are 1.1 MB of source the app must not
 * evaluate at start.
 */
export function provinceRegistry(): readonly ProvinceRegistration[] {
  registry ??= loadServiceAreaData().map((area) => {
    const profile = PROFILES[area.id];
    if (profile === undefined) throw new Error(`Province ${area.id} has no registry profile.`);
    return { ...profile, area };
  });
  return registry;
}

/** The registered provinces' service areas, in registration order (see `provinceRegistry`). */
export function registeredServiceAreas(): readonly ServiceArea[] {
  registeredAreas ??= provinceRegistry().map(({ area }) => area);
  return registeredAreas;
}
export const COVERAGE_BOUNDARY_SOURCE = COVERAGE_BOUNDARY_SOURCE_DATA;
/** What a server declares when it is not told otherwise: the deployed Alberta+BC data. */
export const DEFAULT_SERVICE_AREA_IDS: readonly string[] = ['alberta', 'british-columbia'];

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

function isCoordinateInArea(coordinate: Coordinate, area: ServiceArea): boolean {
  return (
    isCoordinateInBounds(coordinate, area.bounds) &&
    isCoordinateInBoundary(coordinate, area.boundary)
  );
}

/** The registered province containing a coordinate, whether or not this server serves it. */
export function provinceForCoordinate(coordinate: Coordinate): ProvinceRegistration | undefined {
  return provinceRegistry().find(({ area }) => isCoordinateInArea(coordinate, area));
}

/** The IANA zone that certainly applies at a coordinate, or `undefined` where it is not certain. */
export function provinceTimeZone(coordinate: Coordinate): string | undefined {
  return provinceForCoordinate(coordinate)?.timeZones.find(
    ({ within }) => within === undefined || isCoordinateInBounds(coordinate, within),
  )?.timeZone;
}

/** "Alberta", "Alberta and British Columbia", "Alberta, British Columbia and Ontario". */
export function listDisplayNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${String(names.at(-1))}`;
}

export interface DisconnectedAreas {
  from: ServiceArea;
  to: ServiceArea;
}

/** The provinces one server declares, with the eligibility rules every request follows. */
export interface ServiceCoverage {
  readonly areas: readonly ServiceArea[];
  /** Retrieval envelope only. It must never authorize a search result or route. */
  readonly bounds: GeographicBounds;
  readonly displayName: string;
  readonly id: string;
  readonly areaForCoordinate: (coordinate: Coordinate) => ServiceArea | undefined;
  readonly contains: (coordinate: Coordinate) => boolean;
  /** The first pair of served places whose provinces no declared road connects. */
  readonly disconnectedAreas: (coordinates: readonly Coordinate[]) => DisconnectedAreas | undefined;
}

/**
 * Fails closed: an unknown, repeated or empty list throws, so a server never declares a province
 * it has no boundary for. The coverage id and name follow registry order, not the input order.
 */
export function createServiceCoverage(ids: readonly string[]): ServiceCoverage {
  if (ids.length === 0) throw new Error('At least one service area must be declared.');
  const requested = new Set<string>();
  for (const id of ids) {
    if (requested.has(id)) throw new Error(`Service area ${id} is declared twice.`);
    if (!provinceRegistry().some(({ area }) => area.id === id)) {
      throw new Error(`Service area ${id} is not in the province registry.`);
    }
    requested.add(id);
  }
  const registrations = provinceRegistry().filter(({ area }) => requested.has(area.id));
  const areas = registrations.map(({ area }) => area);
  // Declared provinces joined only through declared neighbours share a component.
  const component = new Map<string, number>();
  for (const { area } of registrations) {
    if (component.has(area.id)) continue;
    const label = component.size;
    const pending = [area.id];
    for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
      if (component.has(id)) continue;
      component.set(id, label);
      const neighbours = provinceRegistry().find((entry) => entry.area.id === id)?.connectsTo ?? [];
      pending.push(...neighbours.filter((next) => requested.has(next)));
    }
  }
  const areaForCoordinate = (coordinate: Coordinate) =>
    areas.find((area) => isCoordinateInArea(coordinate, area));
  const everyRegisteredArea = areas.length === provinceRegistry().length;
  return {
    areaForCoordinate,
    areas,
    bounds: areas.reduce(
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
    ),
    contains: (coordinate) => areaForCoordinate(coordinate) !== undefined,
    disconnectedAreas: (coordinates) => {
      let first: ServiceArea | undefined;
      for (const coordinate of coordinates) {
        const area = areaForCoordinate(coordinate);
        if (area === undefined) continue;
        if (first === undefined) first = area;
        else if (component.get(area.id) !== component.get(first.id))
          return { from: first, to: area };
      }
      return undefined;
    },
    // Every registered province is all of Canada; name it so rather than listing thirteen.
    displayName: everyRegisteredArea
      ? 'Canada'
      : listDisplayNames(areas.map(({ displayName }) => displayName)),
    id: everyRegisteredArea ? 'canada' : areas.map(({ id }) => id).join('-'),
  };
}

/** Reads a comma-separated declaration such as `alberta,british-columbia,ontario`. */
export function parseServiceAreaIds(value: string | undefined): readonly string[] {
  if (value === undefined) return DEFAULT_SERVICE_AREA_IDS;
  return value.split(',').map((id) => id.trim());
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
