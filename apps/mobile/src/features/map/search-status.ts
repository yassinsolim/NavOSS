import type { SearchSource } from '@navoss/contracts';
import type { NativeLocationAvailability } from '../../../modules/navoss-navigation';

import { offlineSearchSourceLabel } from '../offline/offline-copy';

export type ApiConnectionState = 'connecting' | 'offline' | 'online';

/**
 * Names the data a result list came from, and says so when that data is not live. A search that
 * combines OpenStreetMap with Calgary Open Data credits the City only when a listed result came
 * from its data (ids `calgary-…`): a search elsewhere, or one that found nothing, did not use it.
 */
export function searchSourceLabel(
  source: SearchSource | undefined,
  degraded = false,
  results: readonly { id: string }[] = [],
): string {
  const name = searchSourceName(source, results);
  if (source?.id === 'photon-development' && degraded) {
    return `${name} · Results may be incomplete`;
  }
  return degraded ? `${name} · Some sources unavailable, results may be incomplete` : name;
}

function searchSourceName(
  source: SearchSource | undefined,
  results: readonly { id: string }[],
): string {
  if (source === undefined) return 'Place search';
  if (source.id === 'offline-osm') return offlineSearchSourceLabel(source.updatedAt);
  if (source.id === 'calgary-hybrid-search' || source.id === 'calgary-open-data-index') {
    return results.some((result) => result.id.startsWith('calgary-'))
      ? 'Calgary Open Data + OpenStreetMap'
      : 'OpenStreetMap search';
  }
  if (source.freshness === 'static') {
    return source.id.startsWith('calgary-')
      ? 'Calgary place data · Not live'
      : 'Place data · Not live';
  }
  return source.id === 'nominatim-self-hosted'
    ? 'OpenStreetMap search'
    : 'OpenStreetMap search · Preview data';
}

export interface ServiceNotice {
  kind:
    | 'connecting'
    | 'location-denied'
    | 'location-error'
    | 'location-off'
    | 'no-gps'
    | 'offline-maps'
    | 'outside-coverage'
    | 'service-unavailable';
  message: string;
  title: string;
  tone: 'danger' | 'neutral' | 'warning';
}

/**
 * What the explore surface tells the driver when something it depends on is missing. Only one
 * notice shows at a time, most blocking first: no service, then no location permission, then no
 * fix, then a region without nearby search.
 */
export function exploreServiceNotice({
  apiConnection,
  coverageName,
  locationAvailability = 'available',
  locationState,
  nearbySearchEnabled,
  offlineMapsInstalled = false,
}: {
  apiConnection: ApiConnectionState;
  /**
   * Android only: why the device cannot have a position, so a failed fix names the true reason.
   * iOS never passes it.
   */
  locationAvailability?: NativeLocationAvailability;
  /** What the server declared, e.g. 'Alberta and British Columbia'. */
  coverageName: string;
  locationState: 'denied' | 'error' | 'idle' | 'locating' | 'visible';
  nearbySearchEnabled: boolean;
  /** A downloaded offline region can answer search and routing without the service. */
  offlineMapsInstalled?: boolean;
}): ServiceNotice | undefined {
  if (apiConnection === 'offline' && offlineMapsInstalled) {
    return {
      kind: 'offline-maps',
      message:
        'Search and routes use your downloaded offline maps: OpenStreetMap places, no live traffic or closures.',
      title: 'Using offline maps',
      tone: 'warning',
    };
  }
  if (apiConnection === 'offline') {
    return {
      kind: 'service-unavailable',
      message: 'Search and routing need a connection to the NavOSS service. The map still works.',
      title: 'Service unavailable',
      tone: 'danger',
    };
  }
  if (locationState === 'denied') {
    return {
      kind: 'location-denied',
      message: 'Allow location in Settings to see your position and get directions from it.',
      title: 'Location access is off',
      tone: 'warning',
    };
  }
  if (locationState === 'error' && locationAvailability === 'location-off') {
    return {
      kind: 'location-off',
      message:
        'Turn on Location in system settings to see your position and get directions from it.',
      title: 'Location is off',
      tone: 'warning',
    };
  }
  if (locationState === 'error' && locationAvailability === 'no-gps') {
    return {
      kind: 'no-gps',
      message:
        'This device cannot find its position. You can still search, preview a route from a start you choose and simulate the drive.',
      title: 'No GPS on this device',
      tone: 'neutral',
    };
  }
  if (locationState === 'error') {
    return {
      kind: 'location-error',
      message: 'NavOSS could not get a location fix. Directions need your current position.',
      title: 'Current location unavailable',
      tone: 'warning',
    };
  }
  if (apiConnection === 'connecting') {
    return {
      kind: 'connecting',
      message: 'Checking the NavOSS service.',
      title: 'Connecting',
      tone: 'neutral',
    };
  }
  if (locationState === 'visible' && !nearbySearchEnabled) {
    return {
      kind: 'outside-coverage',
      message: `NavOSS covers ${coverageName} today. Search and directions work only there.`,
      title: 'Outside current coverage',
      tone: 'neutral',
    };
  }
  return undefined;
}

/**
 * Short problem labels pinned to the map itself, where they stay visible at every sheet
 * position. The explore sheet explains each one; these only make sure it is never missed.
 */
export function mapProblemLabels({
  apiConnection,
  locationAvailability = 'available',
  locationState,
  mapError,
  routeIsIdle,
}: {
  apiConnection: ApiConnectionState;
  /** Android only, as in `exploreServiceNotice`. */
  locationAvailability?: NativeLocationAvailability;
  locationState: 'denied' | 'error' | 'idle' | 'locating' | 'visible';
  mapError: boolean;
  routeIsIdle: boolean;
}): string[] {
  const labels: string[] = [];
  if (mapError) labels.push('Basemap unavailable');
  if (apiConnection === 'offline') labels.push('Service unavailable');
  if (routeIsIdle && locationState === 'denied') labels.push('Location access is off');
  if (routeIsIdle && locationState === 'error')
    labels.push(locationErrorLabel(locationAvailability));
  return labels;
}

function locationErrorLabel(availability: NativeLocationAvailability): string {
  if (availability === 'location-off') return 'Location is off';
  if (availability === 'no-gps') return 'No GPS';
  return 'Current location unavailable';
}

/**
 * The empty state of a search. Outside coverage it names what the server covers today, since a
 * search for a place nearby is the one most likely to find nothing.
 */
export function noMatchesCopy({
  category,
  outsideCoverageName,
}: {
  /** A nearby-category search rather than a name search. */
  category: boolean;
  /** The server's coverage name when the current location is outside it. */
  outsideCoverageName?: string;
}): { message: string; title: string } {
  if (outsideCoverageName !== undefined) {
    return {
      message: `NavOSS covers ${outsideCoverageName} today. Search for a place there.`,
      title: 'Outside current coverage',
    };
  }
  return category
    ? { message: 'Try another category or search by name.', title: 'No places found nearby' }
    : { message: 'Try another place name or add a street.', title: 'No matches found' };
}
