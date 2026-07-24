import type { Coordinate } from '@navoss/contracts';
import type { SearchResult } from '@navoss/contracts';

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
): SearchResult[] {
  const recentRank = new Map(recentDestinationIds.map((id, index) => [id, index]));
  return [...results].sort((left, right) => {
    const leftRank = recentRank.get(left.id);
    const rightRank = recentRank.get(right.id);
    if (leftRank === undefined) return rightRank === undefined ? 0 : 1;
    if (rightRank === undefined) return -1;
    return leftRank - rightRank;
  });
}
