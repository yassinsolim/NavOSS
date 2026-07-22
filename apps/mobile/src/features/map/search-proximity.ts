import type { Coordinate } from '@navoss/contracts';

const SEARCH_PROXIMITY_DECIMAL_PLACES = 3;
const SEARCH_PROXIMITY_SCALE = 10 ** SEARCH_PROXIMITY_DECIMAL_PLACES;

export function approximateSearchCoordinate(
  coordinate: Coordinate | undefined,
): Coordinate | undefined {
  if (coordinate === undefined) return undefined;
  return {
    latitude: Math.round(coordinate.latitude * SEARCH_PROXIMITY_SCALE) / SEARCH_PROXIMITY_SCALE,
    longitude: Math.round(coordinate.longitude * SEARCH_PROXIMITY_SCALE) / SEARCH_PROXIMITY_SCALE,
  };
}
