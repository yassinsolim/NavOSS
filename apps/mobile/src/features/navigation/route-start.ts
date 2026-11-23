import type { SearchResult } from '@navoss/contracts';

import type { NativeDestinationCatalog } from '../../../modules/navoss-navigation';
import { nativeDestinationToSearchResult } from './native-navigation';

export interface SavedRouteStart {
  kind: 'Home' | 'Recent' | 'Saved' | 'Work';
  place: SearchResult;
}

/**
 * The saved places a route can be previewed from when the device has no location fix: Home,
 * Work, favourites, then recents, each place once. The destination is left out; the routing
 * service rejects a route that starts where it ends.
 */
export function savedRouteStarts(
  catalog: Partial<NativeDestinationCatalog>,
  destinationId: string,
): SavedRouteStart[] {
  const candidates: {
    destination: NativeDestinationCatalog['recents'][number];
    kind: SavedRouteStart['kind'];
  }[] = [
    ...(catalog.home === undefined ? [] : [{ destination: catalog.home, kind: 'Home' as const }]),
    ...(catalog.work === undefined ? [] : [{ destination: catalog.work, kind: 'Work' as const }]),
    ...(catalog.favorites ?? []).map((destination) => ({ destination, kind: 'Saved' as const })),
    ...(catalog.recents ?? []).map((destination) => ({ destination, kind: 'Recent' as const })),
  ];
  const seen = new Set([destinationId]);
  const starts: SavedRouteStart[] = [];
  for (const { destination, kind } of candidates) {
    if (seen.has(destination.id)) continue;
    seen.add(destination.id);
    starts.push({ kind, place: nativeDestinationToSearchResult(destination) });
  }
  return starts;
}
