import {
  isCoordinateInBounds,
  provinceForCoordinate,
  type Coordinate,
  type GeographicBounds,
} from '@navoss/contracts';

export const CALGARY_REGION_BOUNDS: GeographicBounds = {
  northEast: { latitude: 51.212, longitude: -113.859 },
  southWest: { latitude: 50.842, longitude: -114.316 },
};

export const KELOWNA_REGION_BOUNDS: GeographicBounds = {
  northEast: { latitude: 50.15, longitude: -119.2 },
  southWest: { latitude: 49.7, longitude: -119.65 },
};

export const TORONTO_CAMERA_BOUNDS: GeographicBounds = {
  northEast: { latitude: 43.86, longitude: -79.1 },
  southWest: { latitude: 43.58, longitude: -79.64 },
};

// Regional context for overlays and time zones. Province ids come from the shared registry, not a
// second client-only region enum. Search and route eligibility never come from here: they follow
// the coverage the server declares (`lib/server-config.ts`).
export type MapRegion = string;

export function mapRegionForCoordinate(coordinate: Coordinate | undefined): MapRegion {
  if (coordinate === undefined) return 'other';
  if (isCoordinateInBounds(coordinate, KELOWNA_REGION_BOUNDS)) return 'kelowna-bc';
  if (isCoordinateInBounds(coordinate, CALGARY_REGION_BOUNDS)) return 'calgary-ab';
  // The registered province (StatCan boundary), whether or not the server serves it.
  return provinceForCoordinate(coordinate)?.area.id ?? 'other';
}
