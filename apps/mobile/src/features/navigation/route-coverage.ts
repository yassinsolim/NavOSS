import {
  isCoordinateInBoundary,
  isCoordinateInBounds,
  isCoordinateInServiceCoverage,
  type Coordinate,
  type GeographicBounds,
  type ServiceArea,
} from '@navoss/contracts';

// Omitted coverage means the supported provinces. Bounds remain available for local overlays,
// while a configured service area always uses its polygon (never just its retrieval envelope).
export function isCoordinateInCoverage(
  coordinate: Coordinate,
  coverage?: GeographicBounds | ServiceArea,
): boolean {
  if (coverage === undefined) return isCoordinateInServiceCoverage(coordinate);
  if ('boundary' in coverage) {
    return (
      isCoordinateInBounds(coordinate, coverage.bounds) &&
      isCoordinateInBoundary(coordinate, coverage.boundary)
    );
  }
  return isCoordinateInBounds(coordinate, coverage);
}
