import type {
  RouteAlternative,
  RouteRequest,
  SearchQuery,
  SearchResponse,
  SearchResult,
} from '@navoss/contracts';
import type { StyleSpecification } from '@maplibre/maplibre-react-native';
import { useEffect, useState } from 'react';

import NavOSSNavigation, {
  type NativeCarPlayTrip,
  type NativeOfflinePlace,
  type NativeOfflineState,
} from '../../../modules/navoss-navigation';
import { isStyleSpecification } from '../map/map-preferences';
import { OFFLINE_ROUTE_SOURCE, offlineRouteMessage } from './offline-copy';
import { routeFromNativeTrip, type RouteSource } from '../navigation/route-ui-state';
import { fetchRoutes, NavOssApiError, searchPlaces, type SearchPlacesOptions } from '../../lib/api';

export type { NativeOfflineRegion, NativeOfflineState } from '../../../modules/navoss-navigation';

export const EMPTY_OFFLINE_STATE: NativeOfflineState = {
  catalog: 'loading',
  networkAvailable: true,
  preferOffline: false,
  regions: [],
  stale: false,
  storageBytes: 0,
};

export function getOfflineState(): NativeOfflineState {
  try {
    return NavOSSNavigation.getOfflineState();
  } catch {
    // A dev client built before offline maps has no such function.
    return EMPTY_OFFLINE_STATE;
  }
}

/** Live offline state: regions, downloads, connectivity and the prefer-offline setting. */
export function useOfflineState(): NativeOfflineState {
  const [state, setState] = useState(getOfflineState);
  useEffect(() => {
    const subscription = NavOSSNavigation.addListener('onOfflineStateChanged', setState);
    setState(getOfflineState());
    return () => {
      subscription.remove();
    };
  }, []);
  return state;
}

export function hasInstalledOfflineRegion(state: NativeOfflineState): boolean {
  return state.regions.some((region) => region.installedVersion !== undefined);
}

/** Whether any region is installed; re-renders only when that answer changes. */
export function useOfflineMapsInstalled(): boolean {
  const [installed, setInstalled] = useState(() => hasInstalledOfflineRegion(getOfflineState()));
  useEffect(() => {
    const subscription = NavOSSNavigation.addListener('onOfflineStateChanged', (state) => {
      setInstalled(hasInstalledOfflineRegion(state));
    });
    setInstalled(hasInstalledOfflineRegion(getOfflineState()));
    return () => {
      subscription.remove();
    };
  }, []);
  return installed;
}

export function refreshOfflineManifest(): Promise<NativeOfflineState> {
  return NavOSSNavigation.refreshOfflineManifest();
}

export function downloadOfflineRegion(regionId: string): void {
  NavOSSNavigation.downloadOfflineRegion(regionId);
}

export function pauseOfflineRegion(regionId: string): void {
  NavOSSNavigation.pauseOfflineRegion(regionId);
}

export function deleteOfflineRegion(regionId: string): void {
  NavOSSNavigation.deleteOfflineRegion(regionId);
}

export function setPreferOfflineMaps(prefer: boolean): void {
  NavOSSNavigation.setPreferOfflineMaps(prefer);
}

/** An installed offline style, bound to local files, and whether the map should use it now. */
export interface OfflineStyleSource {
  style: (slug: string) => StyleSpecification | undefined;
  use: boolean;
}

export function offlineStyleSource(): OfflineStyleSource | undefined {
  let use = false;
  const cache = new Map<string, StyleSpecification | undefined>();
  const style = (slug: string) => {
    if (!cache.has(slug)) {
      let parsed: StyleSpecification | undefined;
      try {
        const bound = NavOSSNavigation.getOfflineMapStyle(slug, null, null);
        if (bound !== null) {
          use = bound.use;
          const value: unknown = JSON.parse(bound.style);
          parsed = isStyleSpecification(value) ? value : undefined;
        }
      } catch {
        parsed = undefined;
      }
      cache.set(slug, parsed);
    }
    return cache.get(slug);
  };
  if (style('liberty') === undefined) return undefined;
  return { style, use };
}

/** Whether an online failure means the service could not be reached (not a rejected request). */
export function isUnreachable(error: unknown): boolean {
  if (error instanceof NavOssApiError) return error.status === 0 || error.status >= 500;
  return error instanceof TypeError;
}

export interface PlannedRoutes {
  routes: RouteAlternative[];
  source: RouteSource;
}

function routesFromTrips(trips: NativeCarPlayTrip[]): RouteAlternative[] {
  const routes = trips.map((trip) => routeFromNativeTrip({ ...trip }).route);
  let fastest = 0;
  routes.forEach((route, index) => {
    const best = routes.at(fastest);
    if (
      best !== undefined &&
      (route.durationSeconds < best.durationSeconds ||
        (route.durationSeconds === best.durationSeconds &&
          route.distanceMeters < best.distanceMeters))
    ) {
      fastest = index;
    }
  });
  return routes.map((route, index) => ({
    ...route,
    label: index === fastest ? 'fastest' : 'alternative',
  }));
}

/**
 * Online routes, or on-device routes from an installed region when the service cannot be
 * reached. Online is always tried first while the device has a network, so routing returns to
 * the service (with its traffic and closures) as soon as it answers again.
 */
export async function fetchRoutesWithOfflineFallback(
  request: RouteRequest,
  destination: SearchResult,
  waypoints: SearchResult[],
  options: { signal?: AbortSignal } = {},
): Promise<PlannedRoutes> {
  const state = getOfflineState();
  const offlineReady = hasInstalledOfflineRegion(state);
  const offline = async (cause: unknown): Promise<PlannedRoutes> => {
    const native = (result: SearchResult) => ({
      category: result.category,
      id: result.id,
      label: result.label,
      latitude: result.center.latitude,
      longitude: result.center.longitude,
      name: result.name,
    });
    const result = await NavOSSNavigation.planOfflineRoutes({
      alternatives: request.alternatives,
      destination: native(destination),
      origin: request.origin,
      ...(request.originHeadingDegrees === undefined
        ? {}
        : { originHeadingDegrees: request.originHeadingDegrees }),
      ...(request.originHorizontalAccuracyMeters === undefined
        ? {}
        : { originHorizontalAccuracyMeters: request.originHorizontalAccuracyMeters }),
      preferences: request.preferences,
      waypoints: waypoints.map(native),
    });
    if (!result.ok || result.trips.length === 0) {
      if (cause instanceof Error && !result.ok && result.code === 'engine-unavailable') throw cause;
      throw new NavOssApiError(offlineRouteMessage(result.ok ? 'no-route' : result.code), 0);
    }
    return { routes: routesFromTrips(result.trips), source: OFFLINE_ROUTE_SOURCE };
  };
  if (offlineReady && !state.networkAvailable) return offline(undefined);
  try {
    const response = await fetchRoutes(request, options);
    return { routes: response.routes, source: response.source };
  } catch (error: unknown) {
    if (options.signal?.aborted === true || !offlineReady || !isUnreachable(error)) throw error;
    return offline(error);
  }
}

export const OFFLINE_SEARCH_SOURCE_ID = 'offline-osm';

function offlineSearchResult(place: NativeOfflinePlace): SearchResult {
  return {
    category: place.category,
    center: { latitude: place.latitude, longitude: place.longitude },
    confidence: 1,
    ...(place.detailCategory === undefined && place.address === undefined
      ? {}
      : {
          details: {
            ...(place.address === undefined ? {} : { address: place.address }),
            ...(place.detailCategory === undefined ? {} : { category: place.detailCategory }),
          },
        }),
    distanceMeters: place.distanceMeters,
    id: place.id,
    label: place.label,
    name: place.name,
  };
}

/** Search the service, or the installed regions' offline index when it cannot be reached. */
export async function searchPlacesWithOfflineFallback(
  query: string,
  options: SearchPlacesOptions & { category?: SearchQuery['category'] } = {},
): Promise<SearchResponse> {
  const state = getOfflineState();
  const offlineReady = hasInstalledOfflineRegion(state);
  const offline = async (cause: unknown): Promise<SearchResponse> => {
    const result = await NavOSSNavigation.searchOffline(
      query,
      options.latitude ?? null,
      options.longitude ?? null,
      options.limit ?? 8,
      options.category ?? null,
    );
    if (!result.ok) throw cause instanceof Error ? cause : new NavOssApiError('Search failed.', 0);
    return {
      degraded: false,
      results: result.results.map(offlineSearchResult),
      source: {
        datasetVersion: result.bundleVersion,
        freshness: 'static',
        id: OFFLINE_SEARCH_SOURCE_ID,
        updatedAt: result.osmTimestamp,
      },
    };
  };
  if (offlineReady && !state.networkAvailable) return offline(undefined);
  try {
    return await searchPlaces(query, options);
  } catch (error: unknown) {
    if (options.signal?.aborted === true || !offlineReady || !isUnreachable(error)) throw error;
    return offline(error);
  }
}
