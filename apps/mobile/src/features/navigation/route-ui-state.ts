import {
  COMMUNITY_TRAFFIC_ATTRIBUTION,
  COMMUNITY_TRAFFIC_SOURCE_ID,
  RouteAlternativeV2Schema,
  RouteStepV2Schema,
  type Coordinate,
  type RouteAlternativeV2,
  type RouteResponseV2,
  type SearchResult,
} from '@navoss/contracts';

import {
  nativeDestinationToSearchResult,
  type NativeNavigationSnapshot,
} from './native-navigation';
import type { PhoneRouteStatus } from './phone-surface';
import { OFFLINE_ROUTE_SOURCE, type OfflineRouteSource } from '../offline/offline-copy';
import { NavOssApiError, routeRefusalTitle } from '../../lib/api';

/** Who routed a trip: the NavOSS service's provider, or the on-device offline engine. */
export type RouteSource = RouteResponseV2['source'] | OfflineRouteSource;

type NativeTrip = NonNullable<NativeNavigationSnapshot['trip']>;
type NativeTripEndReason = NonNullable<NativeNavigationSnapshot['tripEndReason']>;

/** The phone's route lifecycle: nothing, planning, a plan that failed, a preview, a trip. */
export type RouteUiState =
  | { type: 'idle' }
  | {
      destination: SearchResult;
      previewOrigin?: Coordinate;
      type: 'loading';
      waypoints: SearchResult[];
    }
  | ({
      destination: SearchResult;
      previewOrigin?: Coordinate;
      type: 'error';
      waypoints: SearchResult[];
    } & RouteError)
  | {
      destination: SearchResult;
      previewOrigin?: Coordinate;
      routes: RouteAlternativeV2[];
      selectedRouteId: string;
      type: 'preview';
      waypoints: SearchResult[];
    }
  | {
      destination: SearchResult;
      route: RouteAlternativeV2;
      routes: RouteAlternativeV2[];
      type: 'navigating';
      waypoints: SearchResult[];
    }
  | {
      destination: SearchResult;
      route: RouteAlternativeV2;
      routes: RouteAlternativeV2[];
      type: 'arrived';
      waypoints: SearchResult[];
    };

type AssertTrue<T extends true> = T;

/**
 * Compile-time check, in both directions, that route states and `phoneSurface` statuses are the
 * same set. Adding or removing a state on either side fails the build rather than leaving
 * `phoneSurface` silently deciding for a state it no longer knows about.
 */
export type RouteStatusParity = AssertTrue<
  PhoneRouteStatus extends RouteUiState['type']
    ? RouteUiState['type'] extends PhoneRouteStatus
      ? true
      : false
    : false
>;

export const IDLE_ROUTE: RouteUiState = { type: 'idle' };

/**
 * Why a route could not be planned. `refusalTitle` is the server's title when it refused the
 * route itself: asking again cannot help, so the phone offers another destination instead of a
 * retry. Without it the failure is an outage or a lost connection, and a retry may work.
 */
export interface RouteError {
  message: string;
  refusalTitle?: string;
}

export function routeErrorFrom(error: unknown): RouteError {
  if (!(error instanceof NavOssApiError)) {
    return { message: 'A route could not be calculated. Check the connection and try again.' };
  }
  const refusalTitle = routeRefusalTitle(error);
  return { message: error.message, ...(refusalTitle === undefined ? {} : { refusalTitle }) };
}

/** The route the map highlights and the panels describe, for any state that has one. */
export function selectedRouteOf(state: RouteUiState): RouteAlternativeV2 | undefined {
  if (state.type === 'preview') {
    return state.routes.find((route) => route.id === state.selectedRouteId);
  }
  return state.type === 'navigating' || state.type === 'arrived' ? state.route : undefined;
}

export interface NativeTripRoute {
  destination: SearchResult;
  route: RouteAlternativeV2;
  routeSource: RouteSource | undefined;
  waypoints: SearchResult[];
}

/**
 * Rebuilds the phone's view of a trip the navigation core owns. The core is the source of truth
 * while guidance runs (it may have rerouted, or CarPlay may have started the trip), so the phone
 * renders exactly what it reports, including which provider routed it and whether that provider
 * has live traffic.
 */
export function routeFromNativeTrip(trip: NativeTrip): NativeTripRoute {
  const congestion = RouteAlternativeV2Schema.shape.congestion.safeParse(trip.congestion);
  const route: RouteAlternativeV2 = {
    ...(congestion.success && congestion.data !== undefined ? { congestion: congestion.data } : {}),
    distanceMeters: trip.distanceMeters,
    durationSeconds: trip.durationSeconds,
    geometry: trip.geometry.map(({ latitude, longitude }) => [longitude, latitude]),
    id: trip.id,
    label: 'fastest',
    ...(trip.speedLimitsKph === undefined ? {} : { speedLimitsKph: trip.speedLimitsKph }),
    steps: trip.steps.map((step) => {
      const base = {
        distanceMeters: step.distanceMeters,
        durationSeconds: step.durationSeconds,
        geometry: step.geometry.map(({ latitude, longitude }): [number, number] => [
          longitude,
          latitude,
        ]),
        instruction: step.instruction,
        maneuverType: step.maneuverType,
        roadName: step.roadName,
      };
      // Native echoes back what it was given; anything outside the contract is dropped rather
      // than drawn.
      const enriched = RouteStepV2Schema.safeParse({ ...step, ...base });
      return enriched.success ? enriched.data : base;
    }),
    ...(trip.traffic === undefined ? {} : { traffic: trip.traffic }),
  };
  const destination: SearchResult = {
    category: 'landmark',
    center: { latitude: trip.destination.latitude, longitude: trip.destination.longitude },
    confidence: 1,
    id: trip.destination.id,
    label: trip.destination.label,
    name: trip.destination.name,
  };
  return {
    destination,
    route,
    routeSource: routeSourceForNativeTrip(trip.source, trip.trafficSource),
    waypoints: (trip.waypoints ?? []).map(nativeDestinationToSearchResult),
  };
}

export function routeSourceForNativeTrip(
  source: string | undefined,
  trafficSource?: string,
): RouteSource | undefined {
  if (source === OFFLINE_ROUTE_SOURCE.id) return OFFLINE_ROUTE_SOURCE;
  if (
    trafficSource === COMMUNITY_TRAFFIC_SOURCE_ID &&
    (source === 'valhalla-self-hosted' || source === 'valhalla-development')
  ) {
    const routing = routeSourceForNativeTrip(source);
    return routing === undefined || routing.id === OFFLINE_ROUTE_SOURCE.id
      ? undefined
      : {
          ...routing,
          traffic: 'live',
          trafficSource: {
            attribution: COMMUNITY_TRAFFIC_ATTRIBUTION,
            id: COMMUNITY_TRAFFIC_SOURCE_ID,
          },
        };
  }
  if (source === 'mapbox-traffic') {
    return {
      attribution: 'Routing and traffic by Mapbox',
      id: 'mapbox-traffic',
      mode: 'production',
      traffic: 'live',
    };
  }
  if (source === 'valhalla-self-hosted') {
    return {
      attribution: 'Routing by Valhalla using OpenStreetMap data',
      id: 'valhalla-self-hosted',
      mode: 'production',
      traffic: 'unavailable',
    };
  }
  if (source === 'valhalla-development') {
    return {
      attribution: 'Routing by Valhalla using OpenStreetMap data',
      id: 'valhalla-development',
      mode: 'development',
      traffic: 'unavailable',
    };
  }
  return undefined;
}

const TRIP_END_MESSAGES: Record<NativeTripEndReason, string> = {
  'restored-trip-arrived': 'Your last trip had reached its destination, so it was ended.',
  'restored-trip-expired': 'Your last trip was more than 12 hours old, so it was ended.',
  'restored-trip-too-far': 'Your last trip was ended because you are now far from its route.',
  'restored-trip-unavailable':
    'Your last trip could not be restored. Choose the destination again.',
};

/**
 * What the phone says when the navigation core ended a trip on its own: a trip saved before the
 * app was closed that was not restored. Without a word the driver would see guidance vanish.
 */
export function tripEndNotice(
  reason: NativeTripEndReason | undefined,
): { message: string; title: string; tone: 'info' } | undefined {
  // A reason this build has no words for (sent by a newer core) says nothing.
  if (reason === undefined || !Object.hasOwn(TRIP_END_MESSAGES, reason)) return undefined;
  return { message: TRIP_END_MESSAGES[reason], title: 'Trip ended', tone: 'info' };
}
