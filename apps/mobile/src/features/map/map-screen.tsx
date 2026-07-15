import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
  UserLocation,
  type CameraRef,
  type MapRef,
} from '@maplibre/maplibre-react-native';
import type {
  Coordinate,
  RouteAlternative,
  RoutePreferences,
  RouteResponse,
  SearchResult,
  SearchSource,
} from '@navoss/contracts';
import { SymbolView } from 'expo-symbols';
import * as Location from 'expo-location';
import { Keyboard, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { startTransition, useDeferredValue, useEffect, useRef, useState } from 'react';
import type { FeatureCollection, LineString, Point } from 'geojson';

import { NavOssColors, NavOssFonts } from '@/constants/navoss-theme';
import {
  type ApiConnectionState,
  SearchPanel,
  type SearchState,
} from '@/features/map/search-panel';
import {
  NavigationBanner,
  NavigationStatusBar,
  RoutePlanningPanel,
  RoutePreviewPanel,
} from '@/features/navigation/route-panels';
import {
  findNearestStepIndex,
  getRemainingRouteSummary,
} from '@/features/navigation/route-progress';
import { VehiclePuck, type VehicleStyle } from '@/features/navigation/vehicle-puck';
import { fetchAppConfig, fetchRoutes, NavOssApiError, searchPlaces } from '@/lib/api';

const CALGARY_CENTER: [longitude: number, latitude: number] = [-114.0719, 51.0447];
const DEVELOPMENT_MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const EMPTY_FEATURE_COLLECTION: FeatureCollection<Point> = {
  features: [],
  type: 'FeatureCollection',
};
const EMPTY_ROUTE_COLLECTION: FeatureCollection<LineString> = {
  features: [],
  type: 'FeatureCollection',
};

type LocationState = 'idle' | 'locating' | 'visible' | 'denied' | 'error';
type RouteUiState =
  | { type: 'idle' }
  | { destination: SearchResult; type: 'loading' }
  | { destination: SearchResult; message: string; type: 'error' }
  | {
      destination: SearchResult;
      routes: RouteAlternative[];
      selectedRouteId: string;
      type: 'preview';
    }
  | {
      destination: SearchResult;
      route: RouteAlternative;
      routes: RouteAlternative[];
      type: 'navigating';
    };

function selectedFeature(result: SearchResult | undefined): FeatureCollection<Point> {
  if (result === undefined) {
    return EMPTY_FEATURE_COLLECTION;
  }

  return {
    features: [
      {
        geometry: {
          coordinates: [result.center.longitude, result.center.latitude],
          type: 'Point',
        },
        properties: { id: result.id },
        type: 'Feature',
      },
    ],
    type: 'FeatureCollection',
  };
}

function routeFeatures(routes: RouteAlternative[]): FeatureCollection<LineString> {
  if (routes.length === 0) {
    return EMPTY_ROUTE_COLLECTION;
  }

  return {
    features: routes.map((route) => ({
      geometry: {
        coordinates: route.geometry,
        type: 'LineString',
      },
      properties: { id: route.id },
      type: 'Feature',
    })),
    type: 'FeatureCollection',
  };
}

function routeBounds(
  route: RouteAlternative,
): [west: number, south: number, east: number, north: number] {
  return route.geometry.reduce<[number, number, number, number]>(
    (bounds, position) => [
      Math.min(bounds[0], position[0]),
      Math.min(bounds[1], position[1]),
      Math.max(bounds[2], position[0]),
      Math.max(bounds[3], position[1]),
    ],
    [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ],
  );
}

export function MapScreen() {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const cameraRef = useRef<CameraRef>(null);
  const mapRef = useRef<MapRef>(null);
  const routeAbortControllerRef = useRef<AbortController>(null);
  const [apiConnection, setApiConnection] = useState<ApiConnectionState>('connecting');
  const [coverageName, setCoverageName] = useState('Calgary alpha');
  const [locationState, setLocationState] = useState<LocationState>('idle');
  const [mapError, setMapError] = useState(false);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchSource, setSearchSource] = useState<SearchSource>();
  const [searchState, setSearchState] = useState<SearchState>('idle');
  const [selectedResult, setSelectedResult] = useState<SearchResult>();
  const [routeState, setRouteState] = useState<RouteUiState>({ type: 'idle' });
  const [routePreferences, setRoutePreferences] = useState<RoutePreferences>({
    avoidFerries: false,
    avoidHighways: false,
    avoidTolls: false,
    avoidUnpaved: false,
  });
  const [routeTrafficStatus, setRouteTrafficStatus] =
    useState<RouteResponse['source']['traffic']>('unavailable');
  const [navigationStepIndex, setNavigationStepIndex] = useState(0);
  const [userHeading, setUserHeading] = useState(0);
  const [vehicleStyle, setVehicleStyle] = useState<VehicleStyle>('arrow');
  const [userCoordinate, setUserCoordinate] = useState<{
    latitude: number;
    longitude: number;
  }>();

  useEffect(() => {
    const controller = new AbortController();

    void fetchAppConfig(controller.signal)
      .then((config) => {
        startTransition(() => {
          setApiConnection('online');
          setCoverageName(config.coverage.displayName);
        });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          startTransition(() => {
            setApiConnection('offline');
          });
        }
      });

    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const normalizedQuery = deferredQuery.trim();

    if (
      normalizedQuery.length < 2 ||
      normalizedQuery.toLocaleLowerCase('en-CA') === selectedResult?.name.toLocaleLowerCase('en-CA')
    ) {
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      setSearchState('loading');

      void searchPlaces(normalizedQuery, {
        latitude: userCoordinate?.latitude,
        limit: 8,
        longitude: userCoordinate?.longitude,
        signal: controller.signal,
      })
        .then((response) => {
          startTransition(() => {
            setApiConnection('online');
            setResults(response.results);
            setSearchSource(response.source);
            setSearchState('success');
          });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            startTransition(() => {
              setApiConnection('offline');
              setResults([]);
              setSearchState('error');
            });
          }
        });
    }, 250);

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [deferredQuery, selectedResult?.name, userCoordinate?.latitude, userCoordinate?.longitude]);

  useEffect(() => {
    return () => {
      routeAbortControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (routeState.type !== 'navigating') {
      return;
    }

    const route = routeState.route;
    let cancelled = false;
    let subscription: Location.LocationSubscription | undefined;

    void Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        distanceInterval: 5,
      },
      (location) => {
        const coordinate = {
          latitude: location.coords.latitude,
          longitude: location.coords.longitude,
        };
        setUserCoordinate(coordinate);
        if (location.coords.heading !== null && location.coords.heading >= 0) {
          setUserHeading(location.coords.heading);
        }
        setNavigationStepIndex((currentStep) =>
          Math.max(currentStep, findNearestStepIndex(route, coordinate)),
        );
      },
    ).then((locationSubscription) => {
      if (cancelled) {
        locationSubscription.remove();
        return;
      }

      subscription = locationSubscription;
    });

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [routeState]);

  const fitRoute = (route: RouteAlternative) => {
    cameraRef.current?.fitBounds(routeBounds(route), {
      duration: 750,
      padding: { bottom: 280 + insets.bottom, left: 34, right: 34, top: 170 },
    });
  };

  const getCurrentRouteOrigin = async (): Promise<Coordinate | undefined> => {
    if (userCoordinate !== undefined) {
      return userCoordinate;
    }

    setLocationState('locating');
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) {
      setLocationState('denied');
      return undefined;
    }

    const lastKnown = await Location.getLastKnownPositionAsync({
      maxAge: 30_000,
      requiredAccuracy: 250,
    });
    const location =
      lastKnown ??
      (await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      }));
    const coordinate = {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
    };
    setUserCoordinate(coordinate);
    setLocationState('visible');
    return coordinate;
  };

  const calculateRoute = async (
    destination: SearchResult,
    preferences: RoutePreferences = routePreferences,
  ) => {
    routeAbortControllerRef.current?.abort();
    const controller = new AbortController();
    routeAbortControllerRef.current = controller;
    setRouteState({ destination, type: 'loading' });

    try {
      const origin = await getCurrentRouteOrigin();
      if (origin === undefined || controller.signal.aborted) {
        if (!controller.signal.aborted) {
          setRouteState({
            destination,
            message: 'Location access is needed to calculate a driving route.',
            type: 'error',
          });
        }
        return;
      }

      const response = await fetchRoutes(
        {
          alternatives: 1,
          destination: destination.center,
          origin,
          preferences,
        },
        { signal: controller.signal },
      );
      const fastestRoute = response.routes[0];
      if (fastestRoute === undefined || controller.signal.aborted) {
        return;
      }

      setApiConnection('online');
      setRouteTrafficStatus(response.source.traffic);
      setRouteState({
        destination,
        routes: response.routes,
        selectedRouteId: fastestRoute.id,
        type: 'preview',
      });
      requestAnimationFrame(() => {
        fitRoute(fastestRoute);
      });
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        return;
      }

      setRouteState({
        destination,
        message:
          error instanceof NavOssApiError
            ? error.message
            : 'A route could not be calculated. Check the connection and try again.',
        type: 'error',
      });
    }
  };

  const handleChangeQuery = (value: string) => {
    setQuery(value);
    setSelectedResult(undefined);

    if (value.trim().length < 2) {
      setResults([]);
      setSearchState('idle');
    }
  };

  const handleClear = () => {
    routeAbortControllerRef.current?.abort();
    setQuery('');
    setResults([]);
    setSearchState('idle');
    setSelectedResult(undefined);
    setRouteState({ type: 'idle' });
  };

  const handleSelectResult = (result: SearchResult) => {
    Keyboard.dismiss();
    setQuery(result.name);
    setResults([]);
    setSearchState('idle');
    setSelectedResult(result);
    void calculateRoute(result);
  };

  const handleSubmit = () => {
    const firstResult = results[0];
    if (firstResult !== undefined) {
      handleSelectResult(firstResult);
    }
  };

  const handleLocate = async () => {
    setLocationState('locating');

    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        setLocationState('denied');
        return;
      }

      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const coordinate = {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
      };

      setUserCoordinate(coordinate);
      setLocationState('visible');
      cameraRef.current?.flyTo({
        center: [coordinate.longitude, coordinate.latitude],
        duration: 750,
        zoom: 15,
      });
    } catch (error: unknown) {
      setLocationState('error');
    }
  };

  const handleCancelRoute = () => {
    routeAbortControllerRef.current?.abort();
    setRouteState({ type: 'idle' });
    setSelectedResult(undefined);
    setQuery('');
    cameraRef.current?.flyTo({ center: CALGARY_CENTER, duration: 650, zoom: 11.2 });
  };

  const handleSelectRoute = (route: RouteAlternative) => {
    if (routeState.type !== 'preview') {
      return;
    }

    setRouteState({ ...routeState, selectedRouteId: route.id });
    fitRoute(route);
  };

  const handleToggleAvoidHighways = () => {
    if (routeState.type !== 'preview') {
      return;
    }

    const preferences = {
      ...routePreferences,
      avoidHighways: !routePreferences.avoidHighways,
    };
    setRoutePreferences(preferences);
    void calculateRoute(routeState.destination, preferences);
  };

  const selectedRoute =
    routeState.type === 'preview'
      ? routeState.routes.find((route) => route.id === routeState.selectedRouteId)
      : routeState.type === 'navigating'
        ? routeState.route
        : undefined;
  const alternateRoutes =
    routeState.type === 'preview' && selectedRoute !== undefined
      ? routeState.routes.filter((route) => route.id !== selectedRoute.id)
      : [];
  const currentStep =
    routeState.type === 'navigating'
      ? routeState.route.steps[Math.min(navigationStepIndex, routeState.route.steps.length - 1)]
      : undefined;
  const remainingRoute =
    routeState.type === 'navigating'
      ? getRemainingRouteSummary(routeState.route, navigationStepIndex, userCoordinate)
      : undefined;

  const handleStartNavigation = () => {
    if (routeState.type !== 'preview' || selectedRoute === undefined) {
      return;
    }

    setNavigationStepIndex(0);
    setRouteState({
      destination: routeState.destination,
      route: selectedRoute,
      routes: routeState.routes,
      type: 'navigating',
    });
  };

  const handleEndNavigation = () => {
    if (routeState.type !== 'navigating') {
      return;
    }

    setNavigationStepIndex(0);
    setRouteState({
      destination: routeState.destination,
      routes: routeState.routes,
      selectedRouteId: routeState.route.id,
      type: 'preview',
    });
    requestAnimationFrame(() => {
      fitRoute(routeState.route);
    });
  };

  const selectedPanelHeight =
    routeState.type === 'preview'
      ? 314 + insets.bottom
      : routeState.type === 'loading' || routeState.type === 'error'
        ? 156 + insets.bottom
        : routeState.type === 'navigating'
          ? 86 + insets.bottom
          : 0;
  const controlBottom = selectedPanelHeight + 18;
  const resultsHeight = Math.min(360, Math.max(180, height * 0.42));

  return (
    <View style={styles.container}>
      <Map
        attribution={false}
        compass
        compassPosition={{ right: 14, top: insets.top + 118 }}
        logo={false}
        mapStyle={DEVELOPMENT_MAP_STYLE_URL}
        onDidFailLoadingMap={() => {
          setMapError(true);
        }}
        onDidFinishLoadingMap={() => {
          setMapError(false);
        }}
        preferredFramesPerSecond={60}
        ref={mapRef}
        style={styles.map}
        tintColor={NavOssColors.asphalt}
      >
        <Camera
          duration={routeState.type === 'navigating' ? 700 : undefined}
          easing={routeState.type === 'navigating' ? 'ease' : undefined}
          initialViewState={{
            center: CALGARY_CENTER,
            zoom: 11.2,
          }}
          maxZoom={19}
          minZoom={8}
          padding={
            routeState.type === 'navigating'
              ? { bottom: 120 + insets.bottom, left: 24, right: 24, top: 150 }
              : undefined
          }
          pitch={routeState.type === 'navigating' ? 42 : undefined}
          ref={cameraRef}
          trackUserLocation={routeState.type === 'navigating' ? 'course' : undefined}
          zoom={routeState.type === 'navigating' ? 16 : undefined}
        />
        {locationState === 'visible' && routeState.type !== 'navigating' && (
          <UserLocation accuracy heading />
        )}
        {routeState.type === 'navigating' && userCoordinate !== undefined && (
          <VehiclePuck
            coordinate={userCoordinate}
            heading={userHeading}
            vehicleStyle={vehicleStyle}
          />
        )}
        <GeoJSONSource data={selectedFeature(selectedResult)} id="selected-place">
          <Layer
            id="selected-place-halo"
            paint={{
              'circle-color': NavOssColors.coral,
              'circle-opacity': 0.2,
              'circle-radius': 18,
            }}
            type="circle"
          />
          <Layer
            id="selected-place-dot"
            paint={{
              'circle-color': NavOssColors.coral,
              'circle-radius': 8,
              'circle-stroke-color': NavOssColors.white,
              'circle-stroke-width': 3,
            }}
            type="circle"
          />
        </GeoJSONSource>
        <GeoJSONSource data={routeFeatures(alternateRoutes)} id="alternate-routes">
          <Layer
            id="alternate-route-lines"
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{
              'line-color': '#81908E',
              'line-opacity': 0.65,
              'line-width': 4,
            }}
            type="line"
          />
        </GeoJSONSource>
        <GeoJSONSource
          data={routeFeatures(selectedRoute === undefined ? [] : [selectedRoute])}
          id="selected-route"
        >
          <Layer
            id="selected-route-casing"
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': NavOssColors.white, 'line-width': 9 }}
            type="line"
          />
          <Layer
            id="selected-route-line"
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': NavOssColors.green, 'line-width': 6 }}
            type="line"
          />
        </GeoJSONSource>
      </Map>

      {routeState.type !== 'navigating' && (
        <View pointerEvents="box-none" style={[styles.topOverlay, { paddingTop: insets.top + 10 }]}>
          <SearchPanel
            apiConnection={apiConnection}
            coverageName={coverageName}
            maximumResultsHeight={resultsHeight}
            onChangeQuery={handleChangeQuery}
            onClear={handleClear}
            onSelectResult={handleSelectResult}
            onSubmit={handleSubmit}
            query={query}
            results={results}
            searchSource={searchSource}
            searchState={searchState}
          />
        </View>
      )}

      {(mapError ||
        (routeState.type === 'idle' &&
          (locationState === 'denied' || locationState === 'error'))) && (
        <View style={[styles.notice, { bottom: controlBottom + 66 }]}>
          <SymbolView
            name={{ android: 'warning', ios: 'exclamationmark.triangle.fill' }}
            size={17}
            tintColor={NavOssColors.coral}
          />
          <Text style={styles.noticeText}>
            {mapError
              ? 'Basemap unavailable'
              : locationState === 'denied'
                ? 'Location access is off'
                : 'Current location unavailable'}
          </Text>
        </View>
      )}

      {routeState.type !== 'navigating' && (
        <Pressable
          accessibilityLabel="Center map on my location"
          disabled={locationState === 'locating'}
          onPress={() => {
            void handleLocate();
          }}
          style={({ pressed }) => [
            styles.locationButton,
            { bottom: controlBottom },
            pressed && styles.controlPressed,
          ]}
        >
          <SymbolView
            animationSpec={locationState === 'locating' ? { effect: { type: 'pulse' } } : undefined}
            name={{ android: 'my_location', ios: 'location.fill' }}
            size={23}
            tintColor={NavOssColors.asphalt}
          />
        </Pressable>
      )}

      <Pressable
        accessibilityLabel="Map attribution"
        onPress={() => {
          void mapRef.current?.showAttribution();
        }}
        style={[styles.attribution, { bottom: selectedPanelHeight + 8 }]}
      >
        <Text style={styles.attributionText}>© OpenMapTiles · © OpenStreetMap</Text>
      </Pressable>

      {(routeState.type === 'loading' || routeState.type === 'error') && (
        <RoutePlanningPanel
          bottomInset={insets.bottom}
          destination={routeState.destination}
          errorMessage={routeState.type === 'error' ? routeState.message : undefined}
          onCancel={handleCancelRoute}
          onRetry={() => {
            void calculateRoute(routeState.destination);
          }}
        />
      )}

      {routeState.type === 'preview' && selectedRoute !== undefined && (
        <RoutePreviewPanel
          avoidHighways={routePreferences.avoidHighways}
          bottomInset={insets.bottom}
          destination={routeState.destination}
          onCancel={handleCancelRoute}
          onSelectRoute={handleSelectRoute}
          onStart={handleStartNavigation}
          onToggleAvoidHighways={handleToggleAvoidHighways}
          onVehicleStyleChange={setVehicleStyle}
          routes={routeState.routes}
          selectedRoute={selectedRoute}
          trafficStatus={routeTrafficStatus}
          vehicleStyle={vehicleStyle}
        />
      )}

      {routeState.type === 'navigating' &&
        currentStep !== undefined &&
        remainingRoute !== undefined && (
          <>
            <NavigationBanner
              instruction={currentStep.instruction}
              roadName={currentStep.roadName}
              safeAreaTop={insets.top}
            />
            <NavigationStatusBar
              bottomInset={insets.bottom}
              distanceMeters={remainingRoute.distanceMeters}
              durationSeconds={remainingRoute.durationSeconds}
              onEnd={handleEndNavigation}
            />
          </>
        )}
    </View>
  );
}

const styles = StyleSheet.create({
  attribution: {
    backgroundColor: 'rgba(255,255,255,0.88)',
    borderBottomRightRadius: 4,
    borderTopRightRadius: 4,
    left: 0,
    paddingLeft: 8,
    paddingRight: 6,
    paddingVertical: 4,
    position: 'absolute',
  },
  attributionText: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.medium,
    fontSize: 10,
    letterSpacing: 0,
  },
  container: {
    backgroundColor: NavOssColors.fog,
    flex: 1,
  },
  controlPressed: {
    opacity: 0.72,
    transform: [{ scale: 0.97 }],
  },
  locationButton: {
    alignItems: 'center',
    backgroundColor: NavOssColors.white,
    borderColor: NavOssColors.border,
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    height: 52,
    justifyContent: 'center',
    position: 'absolute',
    right: 14,
    shadowColor: '#000000',
    shadowOffset: { height: 3, width: 0 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    width: 52,
  },
  map: {
    flex: 1,
  },
  notice: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: NavOssColors.white,
    borderColor: NavOssColors.border,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 8,
    maxWidth: '82%',
    paddingHorizontal: 12,
    paddingVertical: 9,
    position: 'absolute',
  },
  noticeText: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.medium,
    fontSize: 14,
    letterSpacing: 0,
  },
  topOverlay: {
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
});
