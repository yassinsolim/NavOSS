import type { Coordinate } from '@navoss/contracts';
import type { SearchResult } from '@navoss/contracts';

const SEARCH_PROXIMITY_DECIMAL_PLACES = 3;
const SEARCH_PROXIMITY_SCALE = 10 ** SEARCH_PROXIMITY_DECIMAL_PLACES;
const EARTH_RADIUS_METERS = 6_371_000;

function coordinateDistanceMeters(left: Coordinate, right: Coordinate): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(right.latitude - left.latitude);
  const longitudeDelta = toRadians(right.longitude - left.longitude);
  const leftLatitude = toRadians(left.latitude);
  const rightLatitude = toRadians(right.latitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(haversine));
}

export function approximateSearchCoordinate(
  coordinate: Coordinate | undefined,
): Coordinate | undefined {
  if (coordinate === undefined) return undefined;
  return {
    latitude: Math.round(coordinate.latitude * SEARCH_PROXIMITY_SCALE) / SEARCH_PROXIMITY_SCALE,
    longitude: Math.round(coordinate.longitude * SEARCH_PROXIMITY_SCALE) / SEARCH_PROXIMITY_SCALE,
  };
}

export function searchProximityOptions(origin: Coordinate | undefined) {
  const approximateOrigin = approximateSearchCoordinate(origin);
  return {
    ...(approximateOrigin === undefined
      ? {}
      : {
          latitude: approximateOrigin.latitude,
          longitude: approximateOrigin.longitude,
          sort: 'distance' as const,
        }),
    limit: approximateOrigin === undefined ? 8 : 20,
  };
}

export function formatSearchDistance(distanceMeters: number | undefined): string | undefined {
  if (distanceMeters === undefined) return undefined;
  if (distanceMeters < 1_000) {
    return `${String(Math.max(10, Math.round(distanceMeters / 10) * 10))} m`;
  }
  return `${(distanceMeters / 1_000).toFixed(distanceMeters < 10_000 ? 1 : 0)} km`;
}

export function searchResultContext(result: SearchResult): string {
  const prefix = `${result.name},`;
  return result.label.toLocaleLowerCase('en-CA').startsWith(prefix.toLocaleLowerCase('en-CA'))
    ? result.label.slice(prefix.length).trim()
    : result.label;
}

export function searchResultBounds(
  results: readonly SearchResult[],
): [west: number, south: number, east: number, north: number] | undefined {
  const first = results.at(0);
  if (first === undefined) return undefined;
  return results
    .slice(1)
    .reduce<[number, number, number, number]>(
      (bounds, result) => [
        Math.min(bounds[0], result.center.longitude),
        Math.min(bounds[1], result.center.latitude),
        Math.max(bounds[2], result.center.longitude),
        Math.max(bounds[3], result.center.latitude),
      ],
      [
        first.center.longitude,
        first.center.latitude,
        first.center.longitude,
        first.center.latitude,
      ],
    );
}

export function rankSearchResults(
  results: readonly SearchResult[],
  recentDestinationIds: readonly string[],
  origin?: Coordinate,
  limit = 8,
): SearchResult[] {
  const recentRank = new Map(recentDestinationIds.map((id, index) => [id, index]));
  return results
    .map((result) =>
      origin === undefined
        ? result
        : {
            ...result,
            distanceMeters: Math.round(coordinateDistanceMeters(origin, result.center)),
          },
    )
    .sort((left, right) => {
      if (origin !== undefined) {
        if (left.distanceMeters === undefined) {
          return right.distanceMeters === undefined ? 0 : 1;
        }
        if (right.distanceMeters === undefined) return -1;
        const distanceDelta = left.distanceMeters - right.distanceMeters;
        if (distanceDelta !== 0) return distanceDelta;
      }

      const leftRank = recentRank.get(left.id);
      const rightRank = recentRank.get(right.id);
      if (leftRank === undefined) return rightRank === undefined ? 0 : 1;
      if (rightRank === undefined) return -1;
      return leftRank - rightRank;
    })
    .slice(0, limit);
}

export function rankCategoryResults(
  results: readonly SearchResult[],
  origin: Coordinate | undefined,
  limit = 8,
): SearchResult[] {
  return results
    .map((result) =>
      origin === undefined
        ? result
        : {
            ...result,
            distanceMeters: Math.round(coordinateDistanceMeters(origin, result.center)),
          },
    )
    .sort((left, right) => {
      if (left.distanceMeters === undefined) {
        return right.distanceMeters === undefined ? 0 : 1;
      }
      if (right.distanceMeters === undefined) return -1;
      return (
        left.distanceMeters - right.distanceMeters ||
        right.confidence - left.confidence ||
        left.name.localeCompare(right.name, 'en-CA')
      );
    })
    .slice(0, limit);
}
