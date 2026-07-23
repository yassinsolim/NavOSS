import type { Coordinate, GeographicBounds } from '@navoss/contracts';

export function isCoordinateInCoverage(coordinate: Coordinate, bounds: GeographicBounds): boolean {
  return (
    coordinate.latitude >= bounds.southWest.latitude &&
    coordinate.latitude <= bounds.northEast.latitude &&
    coordinate.longitude >= bounds.southWest.longitude &&
    coordinate.longitude <= bounds.northEast.longitude
  );
}
