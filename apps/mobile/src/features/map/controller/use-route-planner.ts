import {
  SERVICE_COVERAGE_NAME,
  type Coordinate,
  type RouteAlternativeV2,
  type RoutePreferences,
  type RouteResponseV2,
  type SearchResult,
} from '@navoss/contracts';
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react';

import { isSearchCoverageRegion, mapRegionForCoordinate } from '@/features/map/map-region';
import {
  getNavigationRoutePreferences,
  setNavigationRoutePreferences,
} from '@/features/navigation/native-navigation';
import type { RouteRequestOrigin } from '@/features/navigation/route-origin';
import { IDLE_ROUTE, type RouteUiState } from '@/features/navigation/route-ui-state';
import type { VehicleStyle } from '@/features/navigation/vehicle-puck';
import { fetchRoutes, NavOssApiError } from '@/lib/api';

export interface RoutePlanner {
  /** Aborts an in-flight route request without changing the route state. */
  abort: () => void;
  /**
   * Plans a route. `previewOrigin` plans from a fixed point instead of the driver's location;
   * such a route can be previewed but never started.
   */
  calculateRoute: (
    destination: SearchResult,
    preferences?: RoutePreferences,
    previewOrigin?: Coordinate,
    waypoints?: SearchResult[],
  ) => Promise<void>;
  routePreferences: RoutePreferences;
  routeSource: RouteResponseV2['source'] | undefined;
  routeState: RouteUiState;
  /** Adopts preferences changed elsewhere (CarPlay) without writing them back to native. */
  setRoutePreferences: (preferences: RoutePreferences) => void;
  setRouteSource: (source: RouteResponseV2['source'] | undefined) => void;
  setRouteState: Dispatch<SetStateAction<RouteUiState>>;
  setVehicleStyle: (style: VehicleStyle) => void;
  /** Persists changed avoidances to the navigation core, which shares them with CarPlay. */
  updateRoutePreferences: (preferences: RoutePreferences) => void;
  vehicleStyle: VehicleStyle;
}

/**
 * Route planning: the route lifecycle state, the request to the routing API and its failure
 * modes. Every failure lands in the `error` state with a message the driver can act on; a
 * superseded request never writes state.
 */
export function useRoutePlanner({
  getCurrentRouteOrigin,
  onPlanningStarted,
  onRoutePlanned,
  onServiceReachable,
}: {
  getCurrentRouteOrigin: (signal: AbortSignal) => Promise<RouteRequestOrigin | undefined>;
  onPlanningStarted: () => void;
  onRoutePlanned: (route: RouteAlternativeV2, demoOrigin: boolean) => void;
  onServiceReachable: () => void;
}): RoutePlanner {
  const abortControllerRef = useRef<AbortController>(null);
  const [routeState, setRouteState] = useState<RouteUiState>(IDLE_ROUTE);
  const [routePreferences, setRoutePreferences] = useState<RoutePreferences>(() =>
    getNavigationRoutePreferences(),
  );
  const [routeSource, setRouteSource] = useState<RouteResponseV2['source']>();
  const [vehicleStyle, setVehicleStyle] = useState<VehicleStyle>('arrow');

  useEffect(
    () => () => {
      abortControllerRef.current?.abort();
    },
    [],
  );

  const calculateRoute = async (
    destination: SearchResult,
    preferences: RoutePreferences = routePreferences,
    previewOrigin?: Coordinate,
    waypoints: SearchResult[] = [],
  ) => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    // Read through a function: the signal flips while this request is awaiting.
    const superseded = () => controller.signal.aborted;
    const plan = {
      destination,
      ...(previewOrigin === undefined ? {} : { previewOrigin }),
      waypoints,
    };
    onPlanningStarted();
    setRouteState({ ...plan, type: 'loading' });

    try {
      const routeOrigin =
        previewOrigin === undefined
          ? await getCurrentRouteOrigin(controller.signal)
          : { origin: previewOrigin };
      if (routeOrigin === undefined || superseded()) return;
      if (
        previewOrigin === undefined &&
        [
          routeOrigin.origin,
          ...waypoints.map((waypoint) => waypoint.center),
          destination.center,
        ].some((coordinate) => !isSearchCoverageRegion(mapRegionForCoordinate(coordinate)))
      ) {
        setRouteState({
          ...plan,
          message: `Directions cover ${SERVICE_COVERAGE_NAME}. This route includes a place outside that area.`,
          type: 'error',
        });
        return;
      }

      const response = await fetchRoutes(
        {
          alternatives: 2,
          destination: destination.center,
          ...routeOrigin,
          preferences,
          ...(waypoints.length === 0
            ? {}
            : { waypoints: waypoints.map((waypoint) => waypoint.center) }),
        },
        { signal: controller.signal },
      );
      if (superseded()) return;
      const fastestRoute = response.routes.at(0);
      if (fastestRoute === undefined) {
        setRouteState({ ...plan, message: 'No driving route was found.', type: 'error' });
        return;
      }

      onServiceReachable();
      setRouteSource(response.source);
      setRouteState({
        ...plan,
        routes: response.routes,
        selectedRouteId: fastestRoute.id,
        type: 'preview',
      });
      requestAnimationFrame(() => {
        onRoutePlanned(fastestRoute, previewOrigin !== undefined);
      });
    } catch (error: unknown) {
      if (superseded()) return;
      setRouteState({
        ...plan,
        message:
          error instanceof NavOssApiError
            ? error.message
            : 'A route could not be calculated. Check the connection and try again.',
        type: 'error',
      });
    }
  };

  return {
    abort: () => {
      abortControllerRef.current?.abort();
    },
    calculateRoute,
    routePreferences,
    routeSource,
    routeState,
    setRoutePreferences,
    setRouteSource,
    setRouteState,
    setVehicleStyle,
    updateRoutePreferences: (preferences) => {
      setRoutePreferences(preferences);
      setNavigationRoutePreferences(preferences);
    },
    vehicleStyle,
  };
}
