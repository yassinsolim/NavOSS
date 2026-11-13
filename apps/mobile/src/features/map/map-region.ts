import {
  isCoordinateInBounds,
  SERVICE_AREAS,
  serviceAreaForCoordinate,
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

export const ONTARIO_REGION_BOUNDS: GeographicBounds = {
  northEast: { latitude: 56.9, longitude: -74.32 },
  southWest: { latitude: 41.67, longitude: -95.16 },
};

const ONTARIO_REGION_POLYGON: readonly (readonly [number, number])[] = [
  [-95.16, 49],
  [-94.7, 48.7],
  [-89.6, 47.9],
  [-84.35, 46.508],
  [-83.8, 45.9],
  [-82.4, 43.1],
  [-82.7, 42.65],
  [-83.04, 42.323],
  [-83.14, 42.2],
  [-82.8, 41.7],
  [-79.1, 42.8],
  [-79, 43.25],
  [-76.5, 44],
  [-74.32, 45],
  [-74.32, 56.9],
  [-95.16, 56.9],
];

export const TORONTO_CAMERA_BOUNDS: GeographicBounds = {
  northEast: { latitude: 43.86, longitude: -79.1 },
  southWest: { latitude: 43.58, longitude: -79.64 },
};

// Regional context for overlays and time zones. Province ids come from the shared registry, not a
// second client-only region enum. Search and route eligibility never come from here: they follow
// the coverage the server declares (`lib/server-config.ts`).
export type MapRegion = string;

function isInOntario(coordinate: Coordinate): boolean {
  if (!isCoordinateInBounds(coordinate, ONTARIO_REGION_BOUNDS)) return false;
  let inside = false;
  for (
    let currentIndex = 0, previousIndex = ONTARIO_REGION_POLYGON.length - 1;
    currentIndex < ONTARIO_REGION_POLYGON.length;
    previousIndex = currentIndex++
  ) {
    const [currentLongitude, currentLatitude] = ONTARIO_REGION_POLYGON[currentIndex];
    const [previousLongitude, previousLatitude] = ONTARIO_REGION_POLYGON[previousIndex];
    const crossesLatitude =
      currentLatitude > coordinate.latitude !== previousLatitude > coordinate.latitude;
    const boundaryLongitude =
      ((previousLongitude - currentLongitude) * (coordinate.latitude - currentLatitude)) /
        (previousLatitude - currentLatitude) +
      currentLongitude;
    if (crossesLatitude && coordinate.longitude < boundaryLongitude) inside = !inside;
  }
  return inside;
}

export function mapRegionForCoordinate(coordinate: Coordinate | undefined): MapRegion {
  if (coordinate === undefined) return 'other';
  if (isCoordinateInBounds(coordinate, KELOWNA_REGION_BOUNDS)) return 'kelowna-bc';
  if (isCoordinateInBounds(coordinate, CALGARY_REGION_BOUNDS)) return 'calgary-ab';
  const serviceArea = serviceAreaForCoordinate(coordinate);
  if (serviceArea !== undefined) return serviceArea.id;
  // If Ontario is later added to the registry, only its sourced boundary may authorize search;
  // the older overlay polygon must not masquerade as a supported service area.
  if (isInOntario(coordinate) && !SERVICE_AREAS.some((area) => area.id === 'ontario'))
    return 'ontario';
  return 'other';
}
