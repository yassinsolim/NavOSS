import type { SearchSource } from '@navoss/contracts';

import { offlineSearchSourceLabel } from '../offline/offline-copy';

export type ApiConnectionState = 'connecting' | 'offline' | 'online';

/** Names the data a result list came from, and says so when that data is not live. */
export function searchSourceLabel(source: SearchSource | undefined, degraded = false): string {
  return degraded
    ? `${searchSourceName(source)} · Some sources unavailable, results may be incomplete`
    : searchSourceName(source);
}

function searchSourceName(source: SearchSource | undefined): string {
  if (source === undefined) return 'Calgary place search';
  if (source.id === 'offline-osm') return offlineSearchSourceLabel(source.updatedAt);
  if (source.id === 'calgary-hybrid-search' || source.id === 'calgary-open-data-index') {
    return 'Calgary Open Data + OpenStreetMap';
  }
  if (source.freshness === 'static') return 'Calgary place data · Not live';
  return source.id === 'nominatim-self-hosted'
    ? 'OpenStreetMap search'
    : 'OpenStreetMap search · Preview data';
}

export interface ServiceNotice {
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
  locationState,
  nearbySearchEnabled,
  offlineMapsInstalled = false,
}: {
  apiConnection: ApiConnectionState;
  locationState: 'denied' | 'error' | 'idle' | 'locating' | 'visible';
  nearbySearchEnabled: boolean;
  /** A downloaded offline region can answer search and routing without the service. */
  offlineMapsInstalled?: boolean;
}): ServiceNotice | undefined {
  if (apiConnection === 'offline' && offlineMapsInstalled) {
    return {
      message:
        'Search and routes use your downloaded offline maps: OpenStreetMap places, no live traffic or closures.',
      title: 'Using offline maps',
      tone: 'warning',
    };
  }
  if (apiConnection === 'offline') {
    return {
      message: 'Search and routing need a connection to the NavOSS service. The map still works.',
      title: 'Service unavailable',
      tone: 'danger',
    };
  }
  if (locationState === 'denied') {
    return {
      message: 'Allow location in Settings to see your position and get directions from it.',
      title: 'Location access is off',
      tone: 'warning',
    };
  }
  if (locationState === 'error') {
    return {
      message: 'NavOSS could not get a location fix. Directions need your current position.',
      title: 'Current location unavailable',
      tone: 'warning',
    };
  }
  if (apiConnection === 'connecting') {
    return { message: 'Checking the NavOSS service.', title: 'Connecting', tone: 'neutral' };
  }
  if (locationState === 'visible' && !nearbySearchEnabled) {
    return {
      message: 'Nearby categories and directions are not available at your current location yet.',
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
  locationState,
  mapError,
  routeIsIdle,
}: {
  apiConnection: ApiConnectionState;
  locationState: 'denied' | 'error' | 'idle' | 'locating' | 'visible';
  mapError: boolean;
  routeIsIdle: boolean;
}): string[] {
  const labels: string[] = [];
  if (mapError) labels.push('Basemap unavailable');
  if (apiConnection === 'offline') labels.push('Service unavailable');
  if (routeIsIdle && locationState === 'denied') labels.push('Location access is off');
  if (routeIsIdle && locationState === 'error') labels.push('Current location unavailable');
  return labels;
}
