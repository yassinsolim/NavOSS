import {
  CALGARY_TRAVEL_TIMES_ATTRIBUTION,
  CALGARY_TRAVEL_TIMES_SOURCE_ID,
  COMMUNITY_TRAFFIC_ATTRIBUTION,
  COMMUNITY_TRAFFIC_SOURCE_ID,
  RouteAlternativeV2Schema,
  RouteStepV2Schema,
  type Coordinate,
  type RouteAlternativeV2,
  type RouteResponseV2,
  type RouteTrafficSource,
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

/**
 * A fixed start a route is previewed from instead of the driver's location (a place chosen on a
 * device without a location fix, or the supported-route demo). Such a route is never started.
 */
export interface RoutePreviewOrigin {
  coordinate: Coordinate;
  /** The place's name, as the preview sheet says where the preview starts. */
  label: string;
}

/** The phone's route lifecycle: nothing, planning, a plan that failed, a preview, a trip. */
export type RouteUiState =
  | { type: 'idle' }
  | {
      destination: SearchResult;
      previewOrigin?: RoutePreviewOrigin;
      type: 'loading';
      waypoints: SearchResult[];
    }
  | ({
      destination: SearchResult;
      previewOrigin?: RoutePreviewOrigin;
      type: 'error';
      waypoints: SearchResult[];
    } & RouteError)
  | {
      destination: SearchResult;
      previewOrigin?: RoutePreviewOrigin;
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
 * `originUnavailable` marks a route that failed because the device's location could not be used
 * (denied, off, no fix, too old): another start place can still be previewed.
 */
export interface RouteError {
  message: string;
  originUnavailable?: true;
  refusalTitle?: string;
}

/** The device's location cannot start this route; the message says why and what to do. */
export class RouteOriginUnavailableError extends NavOssApiError {
  public constructor(message: string) {
    super(message, 0);
    this.name = 'RouteOriginUnavailableError';
  }
}

export function routeErrorFrom(error: unknown): RouteError {
  if (error instanceof RouteOriginUnavailableError) {
    return { message: error.message, originUnavailable: true };
  }
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
 * renders exactly what it reports, including which provider routed it and whose traffic it
 * carries. Traffic from a source the phone does not present is dropped, never shown as another's.
 */
export function routeFromNativeTrip(trip: NativeTrip): NativeTripRoute {
  const unknownTrafficSource =
    trip.trafficSource !== undefined && routeTrafficSourceForId(trip.trafficSource) === undefined;
  const congestion = RouteAlternativeV2Schema.shape.congestion.safeParse(trip.congestion);
  const route: RouteAlternativeV2 = {
    ...(!unknownTrafficSource && congestion.success && congestion.data !== undefined
      ? { congestion: congestion.data }
      : {}),
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
    ...(unknownTrafficSource || trip.traffic === undefined ? {} : { traffic: trip.traffic }),
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

/**
 * The route traffic source a native trip names. The trip keeps only the id (a trip restored after
 * a relaunch has nothing else), so the attribution is the contract's fixed text for that source.
 * `undefined` without an id and for an id the phone does not present.
 */
function routeTrafficSourceForId(id: string | undefined): RouteTrafficSource | undefined {
  switch (id) {
    case COMMUNITY_TRAFFIC_SOURCE_ID:
      return { attribution: COMMUNITY_TRAFFIC_ATTRIBUTION, id: COMMUNITY_TRAFFIC_SOURCE_ID };
    case CALGARY_TRAVEL_TIMES_SOURCE_ID:
      return { attribution: CALGARY_TRAVEL_TIMES_ATTRIBUTION, id: CALGARY_TRAVEL_TIMES_SOURCE_ID };
    default:
      return undefined;
  }
}

export function routeSourceForNativeTrip(
  source: string | undefined,
  trafficSourceId?: string,
): RouteSource | undefined {
  if (source === OFFLINE_ROUTE_SOURCE.id) return OFFLINE_ROUTE_SOURCE;
  const trafficSource = routeTrafficSourceForId(trafficSourceId);
  if (
    trafficSource !== undefined &&
    (source === 'valhalla-self-hosted' || source === 'valhalla-development')
  ) {
    const routing = routeSourceForNativeTrip(source);
    return routing === undefined || routing.id === OFFLINE_ROUTE_SOURCE.id
      ? undefined
      : { ...routing, traffic: 'live', trafficSource };
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
 * app was closed that was not restored. Without a word the driver would see guidance vanish. On
 * Android the notice stays until it is dismissed: a relaunch lands straight on the map, often
 * while the driver is still looking elsewhere, and a five-second toast is easily missed. iOS
 * keeps the toast that leaves on its own.
 */
export function tripEndNotice(
  reason: NativeTripEndReason | undefined,
  platform: 'android' | 'ios',
): { message: string; title: string; tone: 'info'; untilDismissed: boolean } | undefined {
  // A reason this build has no words for (sent by a newer core) says nothing.
  if (reason === undefined || !Object.hasOwn(TRIP_END_MESSAGES, reason)) return undefined;
  return {
    message: TRIP_END_MESSAGES[reason],
    title: 'Trip ended',
    tone: 'info',
    untilDismissed: platform === 'android',
  };
}

/**
 * Whether the updater should hold installs for a trip. Until the navigation session has applied
 * its first native snapshot the route state is still idle, so the native snapshot read at mount
 * decides: a trip restored into a new JS instance is held from the first render, and a hold left
 * by an earlier JS instance (End from the notification with JS dead) is released.
 */
export function updaterTripActive({
  initialNativeTrip,
  routeIsIdle,
  snapshotApplied,
}: {
  initialNativeTrip: boolean;
  routeIsIdle: boolean;
  snapshotApplied: boolean;
}): boolean {
  return snapshotApplied ? !routeIsIdle : initialNativeTrip || !routeIsIdle;
}
