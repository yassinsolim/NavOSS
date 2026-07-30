import {
  Camera,
  GeoJSONSource,
  Images,
  Layer,
  Map,
  Marker,
  UserLocation,
  type CameraRef,
  type MapRef,
  type StyleSpecification,
} from '@maplibre/maplibre-react-native';
import type {
  AppConfigResponse,
  Coordinate,
  GeographicBounds,
  OfficialRoadEvent,
  OfficialRoadEventResponse,
  OfficialSafetyCamera,
  RoadEvent,
  RoadEventResponse,
  RouteAlternative,
  RoutePreferences,
  RouteResponse,
  SafetyCamera,
  SearchResult,
  SearchSource,
} from '@navoss/contracts';
import { SymbolView } from 'expo-symbols';
import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import {
  Alert,
  Keyboard,
  Linking,
  Pressable,
  Share,
  StyleSheet,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react';
import type { FeatureCollection, LineString, Point } from 'geojson';

import { NavOssColors, NavOssFonts } from '@/constants/navoss-theme';
import { APP_TAB_BAR_HEIGHT, AppTabBar, type AppTab } from '@/features/map/app-tab-bar';
import { ContributeScreen } from '@/features/map/contribute-screen';
import { ExploreCategoryBar } from '@/features/map/explore-category-bar';
import type { ExploreCategory } from '@/features/map/explore-categories';
import { createLatestRequestGate } from '@/features/map/latest-request-gate';
import {
  enrichMapPlace,
  MAP_PLACE_LAYER_IDS,
  mapPlaceFromRenderedFeatures,
  placePhoneUrl,
  placeReviewsUrl,
  placeShareMessage,
  placeWebsiteLabel,
  placeWebsiteUrl,
} from '@/features/map/map-place';
import {
  DEFAULT_MAP_PREFERENCES,
  loadCustomizedMapStyle,
  loadMapPreferences,
  type MapPreferences,
  mapStyleUrl,
  ROUTE_COLORS,
  saveMapPreferences,
} from '@/features/map/map-preferences';
import { MapPreferencesPanel } from '@/features/map/map-preferences-panel';
import { PlaceSheet } from '@/features/map/place-sheet';
import {
  createRoadReportDraft,
  loadRoadReportDrafts,
  saveRoadReportDrafts,
  type RoadReportType,
} from '@/features/map/road-report-drafts';
import { RoadReportSheet } from '@/features/map/road-report-sheet';
import { SavedPlacesScreen } from '@/features/map/saved-places-screen';
import {
  rankCategoryResults,
  rankSearchResults,
  searchProximityOptions,
  searchResultBounds,
} from '@/features/map/search-proximity';
import {
  type ApiConnectionState,
  SearchPanel,
  type SearchState,
} from '@/features/map/search-panel';
import {
  ArrivalPanel,
  CarPlayCompanionPanel,
  NavigationBanner,
  type NavigationRouteStatus,
  NavigationStatusBar,
  RoutePlanningPanel,
  RoutePreviewPanel,
  SafetyCameraAlertBanner,
} from '@/features/navigation/route-panels';
import { RouteStopsEditor } from '@/features/navigation/route-stops-editor';
import {
  buildEtaShareMessage,
  findNearestStepIndex,
  getRemainingRouteGeometry,
  getRemainingRouteSummary,
  getRemainingStepSummary,
  getUpcomingGuidanceStep,
} from '@/features/navigation/route-progress';
import { isCoordinateInCoverage } from '@/features/navigation/route-coverage';
import {
  findUpcomingSafetyCamera,
  type UpcomingSafetyCamera,
} from '@/features/navigation/safety-camera-alert';
import {
  announceSafetyCamera,
  clearCarPlayTrip,
  clearDestinationHistory,
  clearNavigationRoute,
  clearRecentDestinations,
  getDestinationCatalog,
  getNavigationSnapshot,
  getCarPlayState,
  getRecentDestinationIds,
  isFavoriteDestination,
  isGooglePlaceRatingAvailable,
  nativeDestinationToSearchResult,
  type NativeDestinationCatalog,
  type NativeNavigationSnapshot,
  observeCarPlayNavigationEnded,
  observeCarPlayState,
  observeNavigationSnapshots,
  recordRecentDestination,
  setNavigationRoute,
  setHomeDestination,
  setWorkDestination,
  stopNavigationAnnouncements,
  toggleFavoriteDestination,
} from '@/features/navigation/native-navigation';
import {
  NAVIGATION_CAMERA_TRANSITION,
  navigationCameraBearing,
  toggleNavigationMapOrientation,
} from '@/features/navigation/navigation-camera';
import {
  type VehicleMatchStatus,
  VehiclePuck,
  type VehicleStyle,
} from '@/features/navigation/vehicle-puck';
import { mapAlignedHeadingDegrees } from '@/features/navigation/vehicle-heading';
import {
  fetchAppConfig,
  fetchOfficialRoadEvents,
  fetchOfficialSafetyCameras,
  fetchRoadEvents,
  fetchRoutes,
  fetchSafetyCameras,
  NavOssApiError,
  searchPlaces,
} from '@/lib/api';

const CALGARY_CENTER: [longitude: number, latitude: number] = [-114.0719, 51.0447];
const CALGARY_TOWER_ROUTE_ORIGIN: Coordinate = {
  latitude: 51.04427,
  longitude: -114.06309,
};
const ONTARIO_EVENT_BOUNDS: GeographicBounds = {
  northEast: { latitude: 56.9, longitude: -74.32 },
  southWest: { latitude: 41.67, longitude: -95.16 },
};
const TORONTO_CAMERA_BOUNDS: GeographicBounds = {
  northEast: { latitude: 43.86, longitude: -79.1 },
  southWest: { latitude: 43.58, longitude: -79.64 },
};
const EMPTY_FEATURE_COLLECTION: FeatureCollection<Point> = {
  features: [],
  type: 'FeatureCollection',
};
const ROAD_EVENT_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
const ROAD_EVENT_LAYER_IDS = [
  'official-construction-events',
  'road-closure-events',
  'road-incident-events',
] as const;
const MAP_IMAGES = {
  'safety-camera': require('@/assets/images/camera-marker.png'),
  'vehicle-arrow': require('@/assets/images/vehicle-arrow.png'),
  'vehicle-car': require('@/assets/images/vehicle-car.png'),
};

type LocationState = 'idle' | 'locating' | 'visible' | 'denied' | 'error';
type MapRoadEvent = RoadEvent | OfficialRoadEvent;
type RoadEventRegion = 'calgary' | 'ontario';
type RouteUiState =
  | { type: 'idle' }
  | {
      destination: SearchResult;
      previewOrigin?: Coordinate;
      type: 'loading';
      waypoints: SearchResult[];
    }
  | {
      destination: SearchResult;
      message: string;
      previewOrigin?: Coordinate;
      type: 'error';
      waypoints: SearchResult[];
    }
  | {
      destination: SearchResult;
      previewOrigin?: Coordinate;
      routes: RouteAlternative[];
      selectedRouteId: string;
      type: 'preview';
      waypoints: SearchResult[];
    }
  | {
      destination: SearchResult;
      route: RouteAlternative;
      routes: RouteAlternative[];
      type: 'navigating';
      waypoints: SearchResult[];
    }
  | {
      destination: SearchResult;
      route: RouteAlternative;
      routes: RouteAlternative[];
      type: 'arrived';
      waypoints: SearchResult[];
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

function droppedPinResult(coordinate: Coordinate): SearchResult {
  const latitude = coordinate.latitude.toFixed(5);
  const longitude = coordinate.longitude.toFixed(5);
  return {
    category: 'landmark',
    center: coordinate,
    confidence: 1,
    id: `dropped-pin:${latitude}:${longitude}`,
    label: `${latitude}, ${longitude}`,
    name: 'Dropped pin',
  };
}

function safetyCameraFeatures(
  cameras: readonly (Pick<SafetyCamera, 'coordinate' | 'id' | 'location'> &
    Partial<Pick<SafetyCamera, 'direction'>>)[],
): FeatureCollection<Point> {
  return {
    features: cameras.map((camera) => ({
      geometry: {
        coordinates: [camera.coordinate.longitude, camera.coordinate.latitude],
        type: 'Point',
      },
      properties: {
        ...(camera.direction === undefined ? {} : { direction: camera.direction }),
        id: camera.id,
        location: camera.location,
      },
      type: 'Feature',
    })),
    type: 'FeatureCollection',
  };
}

function roadEventFeatures(
  events: readonly MapRoadEvent[],
  type: MapRoadEvent['type'],
): FeatureCollection<Point> {
  return {
    features: events
      .filter((event) => event.type === type)
      .map((event) => ({
        geometry: {
          coordinates: [event.coordinate.longitude, event.coordinate.latitude],
          type: 'Point',
        },
        properties: { id: event.id },
        type: 'Feature',
      })),
    type: 'FeatureCollection',
  };
}

function roadEventAlertMessage(event: MapRoadEvent): string {
  if ('regionId' in event) {
    const end = event.endsAt === undefined ? '' : `\nEnds: ${event.endsAt.replace('T', ' ')}`;
    return `Official Ontario 511 road information\n\n${event.description}\n\nStarts: ${event.startsAt.replace('T', ' ')}${end}`;
  }

  const confidence =
    event.confidence === 'official'
      ? 'Official City of Calgary construction information'
      : 'Unverified current incident information';
  const end =
    event.endsAtLocal === undefined ? '' : `\nEnds: ${event.endsAtLocal.replace('T', ' ')}`;
  return `${confidence}\n\n${event.description}\n\nStarts: ${event.startsAtLocal.replace('T', ' ')}${end}\nTime zone: America/Edmonton`;
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

function persistMapPreferences(preferences: MapPreferences): void {
  void saveMapPreferences(preferences).catch(() => {
    console.warn('Map preferences could not be saved locally.');
  });
}

export function MapScreen() {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const { height } = useWindowDimensions();
  const cameraRef = useRef<CameraRef>(null);
  const mapRef = useRef<MapRef>(null);
  const announcedCameraIdsRef = useRef(new Set<string>());
  const cameraAlertTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const routeAbortControllerRef = useRef<AbortController>(null);
  const nativeStateVersionRef = useRef(-1);
  const hasCenteredOnUserRef = useRef(false);
  const placeAbortControllerRef = useRef<AbortController>(null);
  const placeInteractionRef = useRef(0);
  const searchAbortControllerRef = useRef<AbortController>(null);
  const searchRequestGateRef = useRef(createLatestRequestGate());
  const categorySearchActiveRef = useRef(false);
  const safetyCamerasRef = useRef<readonly SafetyCamera[]>([]);
  const [apiConnection, setApiConnection] = useState<ApiConnectionState>('connecting');
  const [activeTab, setActiveTab] = useState<AppTab>('explore');
  const [coverageName, setCoverageName] = useState('Calgary alpha');
  const [coverageBounds, setCoverageBounds] = useState<AppConfigResponse['coverage']['bounds']>();
  const [locationState, setLocationState] = useState<LocationState>('idle');
  const [mapError, setMapError] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [mapPreferences, setMapPreferences] = useState(DEFAULT_MAP_PREFERENCES);
  const [mapStyle, setMapStyle] = useState<string | StyleSpecification>(
    mapStyleUrl(DEFAULT_MAP_PREFERENCES.stylePreset, colorScheme),
  );
  const [isMapPreferencesVisible, setIsMapPreferencesVisible] = useState(false);
  const [isMoreCategoriesVisible, setIsMoreCategoriesVisible] = useState(false);
  const [isRoadReportSaving, setIsRoadReportSaving] = useState(false);
  const [isRoadReportVisible, setIsRoadReportVisible] = useState(false);
  const [isRouteStopsVisible, setIsRouteStopsVisible] = useState(false);
  const [placeDetailsLoading, setPlaceDetailsLoading] = useState(false);
  const [googlePlaceRatingAvailable] = useState(() => isGooglePlaceRatingAvailable());
  const [selectedPlaceSaved, setSelectedPlaceSaved] = useState(false);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchSource, setSearchSource] = useState<SearchSource>();
  const [searchState, setSearchState] = useState<SearchState>('idle');
  const [selectedResult, setSelectedResult] = useState<SearchResult>();
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>();
  const [shortcutBeingSet, setShortcutBeingSet] = useState<'home' | 'work'>();
  const [destinationCatalog, setDestinationCatalog] = useState<NativeDestinationCatalog>(() =>
    getDestinationCatalog(),
  );
  const [routeState, setRouteState] = useState<RouteUiState>({ type: 'idle' });
  const [routePreferences, setRoutePreferences] = useState<RoutePreferences>({
    avoidFerries: false,
    avoidHighways: false,
    avoidTolls: false,
    avoidUnpaved: false,
  });
  const [routeSource, setRouteSource] = useState<RouteResponse['source']>();
  const [cameraAnnouncementCount, setCameraAnnouncementCount] = useState(0);
  const [carPlayConnected, setCarPlayConnected] = useState(false);
  const [safetyCameraAlert, setSafetyCameraAlert] = useState<UpcomingSafetyCamera>();
  const [safetyCameras, setSafetyCameras] = useState<readonly SafetyCamera[]>([]);
  const [roadEventResponse, setRoadEventResponse] = useState<RoadEventResponse>();
  const [officialRoadEventResponse, setOfficialRoadEventResponse] =
    useState<OfficialRoadEventResponse>();
  const [roadEventRefreshDelayed, setRoadEventRefreshDelayed] = useState(false);
  const [torontoSafetyCameras, setTorontoSafetyCameras] = useState<readonly OfficialSafetyCamera[]>(
    [],
  );
  const [navigationSnapshot, setNavigationSnapshot] = useState<NativeNavigationSnapshot>();
  const [navigationRouteStatus, setNavigationRouteStatus] =
    useState<NavigationRouteStatus>('tracking');
  const [rerouteCount, setRerouteCount] = useState(0);
  const [navigationStepIndex, setNavigationStepIndex] = useState(0);
  const [isNavigationCameraFollowing, setIsNavigationCameraFollowing] = useState(true);
  const [userHeading, setUserHeading] = useState(0);
  const [mapBearing, setMapBearing] = useState(0);
  const [vehicleStyle, setVehicleStyle] = useState<VehicleStyle>('arrow');
  const [userCoordinate, setUserCoordinate] = useState<{
    latitude: number;
    longitude: number;
  }>();
  const roadEventRegion: RoadEventRegion =
    userCoordinate !== undefined && isCoordinateInCoverage(userCoordinate, ONTARIO_EVENT_BOUNDS)
      ? 'ontario'
      : 'calgary';
  const roadEventSnapshot =
    roadEventRegion === 'ontario' ? officialRoadEventResponse : roadEventResponse;
  const roadEvents: readonly MapRoadEvent[] = roadEventSnapshot?.events ?? [];

  const invalidatePlaceInteraction = () => {
    placeInteractionRef.current += 1;
    placeAbortControllerRef.current?.abort();
    placeAbortControllerRef.current = null;
    setPlaceDetailsLoading(false);
  };

  const refreshDestinationCatalog = () => {
    setDestinationCatalog(getDestinationCatalog());
  };

  const invalidateSearchRequest = (): number => {
    const requestGeneration = searchRequestGateRef.current.advance();
    searchAbortControllerRef.current?.abort();
    searchAbortControllerRef.current = null;
    return requestGeneration;
  };

  const runPlaceSearch = (
    normalizedQuery: string,
    fitResults: boolean,
    nearestFirst = false,
    category?: ExploreCategory,
  ): AbortController => {
    const requestGeneration = invalidateSearchRequest();
    const controller = new AbortController();
    searchAbortControllerRef.current = controller;
    setSearchState('loading');
    const proximityOptions = searchProximityOptions(userCoordinate);

    const categoryQueries = [normalizedQuery];
    void Promise.all(
      categoryQueries.map((query) =>
        searchPlaces(query, {
          ...proximityOptions,
          ...(category?.searchCategory === undefined
            ? {}
            : { category: category.searchCategory, includeDetails: true }),
          signal: controller.signal,
        }),
      ),
    )
      .then((responses) => {
        if (
          controller.signal.aborted ||
          !searchRequestGateRef.current.isCurrent(requestGeneration)
        ) {
          return;
        }
        const firstResponse = responses[0];
        if (firstResponse === undefined) return;
        const seenResultIds = new Set<string>();
        const mergedResults = responses
          .flatMap((response) => response.results)
          .filter((result) => {
            if (seenResultIds.has(result.id)) return false;
            seenResultIds.add(result.id);
            return true;
          });
        const rankedResults = nearestFirst
          ? rankCategoryResults(mergedResults, userCoordinate)
          : rankSearchResults(mergedResults, getRecentDestinationIds(), userCoordinate);
        startTransition(() => {
          setApiConnection('online');
          setResults(rankedResults);
          setSearchSource(firstResponse.source);
          setSearchState('success');
        });
        if (fitResults) {
          const bounds = searchResultBounds(rankedResults);
          if (bounds !== undefined) {
            requestAnimationFrame(() => {
              cameraRef.current?.fitBounds(bounds, {
                duration: 700,
                padding: {
                  bottom: APP_TAB_BAR_HEIGHT + insets.bottom + 34,
                  left: 54,
                  right: 54,
                  top: 282,
                },
              });
            });
          }
        }
      })
      .catch(() => {
        if (
          !controller.signal.aborted &&
          searchRequestGateRef.current.isCurrent(requestGeneration)
        ) {
          startTransition(() => {
            setApiConnection('offline');
            setResults([]);
            setSearchState('error');
          });
        }
      })
      .finally(() => {
        if (searchAbortControllerRef.current === controller) {
          searchAbortControllerRef.current = null;
        }
      });
    return controller;
  };

  useEffect(() => {
    let active = true;
    void loadMapPreferences().then((preferences) => {
      if (active) {
        setMapPreferences(preferences);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    void loadRoadReportDrafts()
      .then((reports) => saveRoadReportDrafts(reports))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (
      userCoordinate === undefined ||
      !isCoordinateInCoverage(userCoordinate, TORONTO_CAMERA_BOUNDS)
    ) {
      setTorontoSafetyCameras([]);
      return;
    }

    const controller = new AbortController();

    void fetchOfficialSafetyCameras({ region: 'toronto-on', signal: controller.signal })
      .then((response) => {
        startTransition(() => {
          setTorontoSafetyCameras(response.cameras);
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setTorontoSafetyCameras([]);
      });

    return () => {
      controller.abort();
    };
  }, [userCoordinate]);

  useEffect(() => {
    let active = true;
    const fallbackStyle = mapStyleUrl(mapPreferences.stylePreset, colorScheme);
    void loadCustomizedMapStyle(mapPreferences, colorScheme)
      .then((style) => {
        if (active) {
          setMapStyle(style);
        }
      })
      .catch(() => {
        if (active) {
          setMapStyle(fallbackStyle);
        }
      });
    return () => {
      active = false;
    };
  }, [colorScheme, mapPreferences]);

  useEffect(() => {
    const controller = new AbortController();

    void fetchAppConfig(controller.signal)
      .then((config) => {
        startTransition(() => {
          setApiConnection('online');
          setCoverageBounds(config.coverage.bounds);
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
    if (!mapPreferences.showRoadEvents) {
      return;
    }

    setRoadEventRefreshDelayed(false);
    let controller: AbortController | undefined;
    const refresh = () => {
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      const request =
        roadEventRegion === 'ontario'
          ? fetchOfficialRoadEvents({ region: 'ontario', signal: requestController.signal }).then(
              (response) => {
                startTransition(() => {
                  setOfficialRoadEventResponse(response);
                });
              },
            )
          : fetchRoadEvents({ signal: requestController.signal }).then((response) => {
              startTransition(() => {
                setRoadEventResponse(response);
              });
            });
      void request
        .then(() => {
          setRoadEventRefreshDelayed(false);
        })
        .catch(() => {
          if (!requestController.signal.aborted) {
            setRoadEventRefreshDelayed(true);
          }
        });
    };

    refresh();
    const interval = setInterval(refresh, ROAD_EVENT_REFRESH_INTERVAL_MS);
    return () => {
      clearInterval(interval);
      controller?.abort();
    };
  }, [mapPreferences.showRoadEvents, roadEventRegion]);

  useEffect(() => {
    let active = true;
    void Location.getForegroundPermissionsAsync()
      .then(async (permission) => {
        if (!permission.granted || !active) return;
        const lastKnown = await Location.getLastKnownPositionAsync({
          maxAge: 60_000,
          requiredAccuracy: 500,
        });
        const location =
          lastKnown ??
          (await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          }));
        if (!active) return;
        setUserCoordinate({
          latitude: location.coords.latitude,
          longitude: location.coords.longitude,
        });
        setLocationState('visible');
      })
      .catch(() => {
        if (active) setLocationState('error');
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (
      !mapReady ||
      userCoordinate === undefined ||
      hasCenteredOnUserRef.current ||
      routeState.type !== 'idle'
    ) {
      return;
    }
    hasCenteredOnUserRef.current = true;
    cameraRef.current?.flyTo({
      center: [userCoordinate.longitude, userCoordinate.latitude],
      duration: 750,
      zoom: 15,
    });
  }, [mapReady, routeState.type, userCoordinate]);

  useEffect(() => {
    const controller = new AbortController();

    void fetchSafetyCameras({ signal: controller.signal })
      .then((response) => {
        safetyCamerasRef.current = response.cameras;
        startTransition(() => {
          setSafetyCameras(response.cameras);
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          safetyCamerasRef.current = [];
          setSafetyCameras([]);
        }
      });

    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const normalizedQuery = deferredQuery.trim();

    if (
      categorySearchActiveRef.current ||
      normalizedQuery.length < 2 ||
      normalizedQuery.toLocaleLowerCase('en-CA') === selectedResult?.name.toLocaleLowerCase('en-CA')
    ) {
      return;
    }

    let searchController: AbortController | undefined;
    const timeout = setTimeout(() => {
      searchController = runPlaceSearch(normalizedQuery, false);
    }, 250);

    return () => {
      clearTimeout(timeout);
      searchController?.abort();
    };
  }, [deferredQuery, selectedResult?.name, userCoordinate?.latitude, userCoordinate?.longitude]);

  useEffect(() => {
    return () => {
      if (cameraAlertTimeoutRef.current !== undefined) {
        clearTimeout(cameraAlertTimeoutRef.current);
      }
      stopNavigationAnnouncements();
      routeAbortControllerRef.current?.abort();
      invalidateSearchRequest();
      placeInteractionRef.current += 1;
      placeAbortControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const applyNativeSnapshot = (snapshot: NativeNavigationSnapshot) => {
      if (snapshot.stateVersion < nativeStateVersionRef.current) {
        return;
      }
      nativeStateVersionRef.current = snapshot.stateVersion;
      setNavigationSnapshot(snapshot);
      setNavigationRouteStatus(snapshot.routeStatus);
      setRerouteCount(snapshot.rerouteCount);
      if (snapshot.rawCoordinate !== undefined) {
        setUserCoordinate(snapshot.rawCoordinate);
      }
      if (snapshot.matchedCourseDegrees !== undefined) {
        setUserHeading(snapshot.matchedCourseDegrees);
      }
      setNavigationStepIndex(snapshot.guidance?.stepIndex ?? 0);
      if (snapshot.trip === undefined) {
        setRouteState((current) =>
          current.type === 'navigating' || current.type === 'arrived' ? { type: 'idle' } : current,
        );
        return;
      }
      const route: RouteAlternative = {
        distanceMeters: snapshot.trip.distanceMeters,
        durationSeconds: snapshot.trip.durationSeconds,
        geometry: snapshot.trip.geometry.map(({ latitude, longitude }) => [longitude, latitude]),
        id: snapshot.trip.id,
        label: 'fastest',
        ...(snapshot.trip.speedLimitsKph === undefined
          ? {}
          : { speedLimitsKph: snapshot.trip.speedLimitsKph }),
        steps: snapshot.trip.steps.map((step) => ({
          distanceMeters: step.distanceMeters,
          durationSeconds: step.durationSeconds,
          geometry: step.geometry.map(({ latitude, longitude }) => [longitude, latitude]),
          instruction: step.instruction,
          maneuverType: step.maneuverType,
          roadName: step.roadName,
          ...(step.spokenInstruction === undefined
            ? {}
            : { spokenInstruction: step.spokenInstruction }),
        })),
        ...(snapshot.trip.traffic === undefined ? {} : { traffic: snapshot.trip.traffic }),
      };
      const destination: SearchResult = {
        category: 'landmark',
        center: {
          latitude: snapshot.trip.destination.latitude,
          longitude: snapshot.trip.destination.longitude,
        },
        confidence: 1,
        id: snapshot.trip.destination.id,
        label: snapshot.trip.destination.label,
        name: snapshot.trip.destination.name,
      };
      const waypoints = (snapshot.trip.waypoints ?? []).map(nativeDestinationToSearchResult);
      setRoutePreferences(snapshot.trip.preferences);
      if (snapshot.trip.source === 'mapbox-traffic') {
        setRouteSource({
          attribution: 'Routing and traffic by Mapbox',
          id: 'mapbox-traffic',
          mode: 'production',
          traffic: 'live',
        });
      } else if (snapshot.trip.source === 'valhalla-self-hosted') {
        setRouteSource({
          attribution: 'Routing by Valhalla using OpenStreetMap data',
          id: 'valhalla-self-hosted',
          mode: 'production',
          traffic: 'unavailable',
        });
      } else if (snapshot.trip.source === 'valhalla-development') {
        setRouteSource({
          attribution: 'Routing by Valhalla using OpenStreetMap data',
          id: 'valhalla-development',
          mode: 'development',
          traffic: 'unavailable',
        });
      } else {
        setRouteSource(undefined);
      }
      setRouteState((current) => {
        if (
          current.type === 'navigating' &&
          current.route.id === route.id &&
          snapshot.phase !== 'arrived'
        ) {
          return current;
        }
        return snapshot.phase === 'arrived'
          ? { destination, route, routes: [route], type: 'arrived', waypoints }
          : { destination, route, routes: [route], type: 'navigating', waypoints };
      });
    };
    const subscription = observeNavigationSnapshots(applyNativeSnapshot);
    applyNativeSnapshot(getNavigationSnapshot());
    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (routeState.type !== 'navigating') {
      return;
    }

    const route = routeState.route;
    const handleSnapshot = (snapshot: NativeNavigationSnapshot) => {
      if (snapshot.phase === 'arrived') {
        if (cameraAlertTimeoutRef.current !== undefined) {
          clearTimeout(cameraAlertTimeoutRef.current);
        }
        setSafetyCameraAlert(undefined);
        setNavigationStepIndex(Math.max(0, route.steps.length - 1));
        setRouteState({
          destination: routeState.destination,
          route,
          routes: routeState.routes,
          type: 'arrived',
          waypoints: routeState.waypoints,
        });
        return;
      }

      if (!snapshot.isOffRoute && snapshot.rawCoordinate !== undefined) {
        const upcomingCamera = findUpcomingSafetyCamera(
          safetyCamerasRef.current,
          route,
          snapshot.routeProgress,
          announcedCameraIdsRef.current,
        );
        if (upcomingCamera !== undefined) {
          announcedCameraIdsRef.current.add(upcomingCamera.camera.id);
          setCameraAnnouncementCount((currentCount) => currentCount + 1);
          setSafetyCameraAlert(upcomingCamera);
          announceSafetyCamera();
          if (cameraAlertTimeoutRef.current !== undefined) {
            clearTimeout(cameraAlertTimeoutRef.current);
          }
          cameraAlertTimeoutRef.current = setTimeout(() => {
            setSafetyCameraAlert(undefined);
            cameraAlertTimeoutRef.current = undefined;
          }, 6_000);
        }
      }
    };
    if (navigationSnapshot !== undefined) {
      handleSnapshot(navigationSnapshot);
    }
  }, [navigationSnapshot, routeState]);

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
    previewOrigin?: Coordinate,
    waypoints: SearchResult[] = [],
  ) => {
    routeAbortControllerRef.current?.abort();
    const controller = new AbortController();
    routeAbortControllerRef.current = controller;
    setRouteState({
      destination,
      ...(previewOrigin === undefined ? {} : { previewOrigin }),
      type: 'loading',
      waypoints,
    });

    try {
      const origin = previewOrigin ?? (await getCurrentRouteOrigin());
      if (origin === undefined || controller.signal.aborted) {
        if (!controller.signal.aborted) {
          setRouteState({
            destination,
            message: 'Location access is needed to calculate a driving route.',
            ...(previewOrigin === undefined ? {} : { previewOrigin }),
            type: 'error',
            waypoints,
          });
        }
        return;
      }
      let routeCoverageBounds = coverageBounds;
      if (previewOrigin === undefined && routeCoverageBounds === undefined) {
        const config = await fetchAppConfig(controller.signal);
        routeCoverageBounds = config.coverage.bounds;
        setCoverageBounds(routeCoverageBounds);
        setCoverageName(config.coverage.displayName);
      }
      if (
        previewOrigin === undefined &&
        routeCoverageBounds !== undefined &&
        !isCoordinateInCoverage(origin, routeCoverageBounds)
      ) {
        setRouteState({
          destination,
          message: 'Your current location is outside Calgary route coverage.',
          ...(previewOrigin === undefined ? {} : { previewOrigin }),
          type: 'error',
          waypoints,
        });
        return;
      }

      const response = await fetchRoutes(
        {
          alternatives: 2,
          destination: destination.center,
          origin,
          preferences,
          ...(waypoints.length === 0
            ? {}
            : { waypoints: waypoints.map((waypoint) => waypoint.center) }),
        },
        { signal: controller.signal },
      );
      const fastestRoute = response.routes[0];
      if (controller.signal.aborted) {
        return;
      }
      if (fastestRoute === undefined) {
        setRouteState({
          destination,
          message: 'No driving route was found.',
          ...(previewOrigin === undefined ? {} : { previewOrigin }),
          type: 'error',
          waypoints,
        });
        return;
      }

      setApiConnection('online');
      setRouteSource(response.source);
      setRouteState({
        destination,
        ...(previewOrigin === undefined ? {} : { previewOrigin }),
        routes: response.routes,
        selectedRouteId: fastestRoute.id,
        type: 'preview',
        waypoints,
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
        ...(previewOrigin === undefined ? {} : { previewOrigin }),
        type: 'error',
        waypoints,
      });
    }
  };

  const handleChangeQuery = (value: string) => {
    categorySearchActiveRef.current = false;
    invalidatePlaceInteraction();
    setSelectedCategoryId(undefined);
    setQuery(value);
    setSelectedResult(undefined);

    if (value.trim().length < 2) {
      setResults([]);
      setSearchState('idle');
    }
  };

  const handleClear = () => {
    announcedCameraIdsRef.current.clear();
    if (cameraAlertTimeoutRef.current !== undefined) {
      clearTimeout(cameraAlertTimeoutRef.current);
      cameraAlertTimeoutRef.current = undefined;
    }
    setSafetyCameraAlert(undefined);
    setCameraAnnouncementCount(0);
    stopNavigationAnnouncements();
    categorySearchActiveRef.current = false;
    invalidateSearchRequest();
    invalidatePlaceInteraction();
    routeAbortControllerRef.current?.abort();
    setIsNavigationCameraFollowing(true);
    setQuery('');
    setResults([]);
    setSearchState('idle');
    setSelectedCategoryId(undefined);
    setShortcutBeingSet(undefined);
    setSelectedResult(undefined);
    setRouteState({ type: 'idle' });
  };

  const handleSelectResult = (result: SearchResult) => {
    Keyboard.dismiss();
    categorySearchActiveRef.current = false;
    invalidateSearchRequest();
    invalidatePlaceInteraction();
    routeAbortControllerRef.current?.abort();
    setRouteState({ type: 'idle' });
    setQuery(result.name);
    setResults([]);
    setSearchState('idle');
    setSelectedCategoryId(undefined);
    setSelectedResult(result);
    if (shortcutBeingSet === 'home') {
      setHomeDestination(result);
      refreshDestinationCatalog();
      setShortcutBeingSet(undefined);
    } else if (shortcutBeingSet === 'work') {
      setWorkDestination(result);
      refreshDestinationCatalog();
      setShortcutBeingSet(undefined);
    }
    setSelectedPlaceSaved(isFavoriteDestination(result.id));
    setPlaceDetailsLoading(true);
    cameraRef.current?.flyTo({
      center: [result.center.longitude, result.center.latitude],
      duration: 650,
      zoom: 16,
    });

    const interactionId = placeInteractionRef.current;
    const controller = new AbortController();
    placeAbortControllerRef.current = controller;
    void searchPlaces(result.name, {
      includeDetails: true,
      latitude: result.center.latitude,
      limit: 20,
      longitude: result.center.longitude,
      signal: controller.signal,
    })
      .then((response) => {
        if (!controller.signal.aborted && placeInteractionRef.current === interactionId) {
          setSelectedResult((current) =>
            current?.id === result.id ? enrichMapPlace(result, response.results) : current,
          );
        }
      })
      .catch(() => {
        // The selected result remains usable when optional metadata is unavailable.
      })
      .finally(() => {
        if (
          placeAbortControllerRef.current === controller &&
          placeInteractionRef.current === interactionId
        ) {
          placeAbortControllerRef.current = null;
          setPlaceDetailsLoading(false);
        }
      });
  };

  const handleCategoryPress = (category: ExploreCategory) => {
    Keyboard.dismiss();
    categorySearchActiveRef.current = true;
    invalidatePlaceInteraction();
    routeAbortControllerRef.current?.abort();
    setActiveTab('explore');
    setIsMoreCategoriesVisible(false);
    setShortcutBeingSet(undefined);
    setSelectedCategoryId(category.id);
    setSelectedResult(undefined);
    setRouteState({ type: 'idle' });
    setQuery(category.label);
    setResults([]);
    runPlaceSearch(category.query, true, true, category);
  };

  const beginShortcutSetup = (shortcut: 'home' | 'work') => {
    categorySearchActiveRef.current = false;
    invalidateSearchRequest();
    setActiveTab('explore');
    setIsMoreCategoriesVisible(false);
    setSelectedCategoryId(undefined);
    setSelectedResult(undefined);
    setQuery('');
    setResults([]);
    setSearchState('idle');
    setShortcutBeingSet(shortcut);
  };

  const handleWorkPress = () => {
    if (destinationCatalog.work === undefined) {
      beginShortcutSetup('work');
      return;
    }
    setActiveTab('explore');
    handleSelectResult(nativeDestinationToSearchResult(destinationCatalog.work));
  };

  const handleSubmit = () => {
    Keyboard.dismiss();
    const bounds = searchResultBounds(results);
    if (bounds === undefined) return;

    invalidatePlaceInteraction();
    routeAbortControllerRef.current?.abort();
    setSelectedResult(undefined);
    setRouteState({ type: 'idle' });
    if (results.length === 1) {
      const result = results[0];
      if (result !== undefined) {
        cameraRef.current?.flyTo({
          center: [result.center.longitude, result.center.latitude],
          duration: 650,
          zoom: 15,
        });
      }
      return;
    }
    cameraRef.current?.fitBounds(bounds, {
      duration: 700,
      padding: { bottom: 120 + insets.bottom, left: 54, right: 54, top: 260 },
    });
  };

  const handleMapLongPress = (coordinate: Coordinate) => {
    if (routeState.type === 'navigating' || routeState.type === 'arrived') {
      return;
    }

    Keyboard.dismiss();
    invalidatePlaceInteraction();
    const destination = droppedPinResult(coordinate);
    setQuery('');
    setResults([]);
    setSearchState('idle');
    setSelectedResult(destination);
    void calculateRoute(destination);
  };

  const handleMapPress = async (point: [number, number], coordinate: Coordinate) => {
    if (
      routeState.type !== 'idle' ||
      (!mapPreferences.showPlaces && !mapPreferences.showRoadEvents) ||
      mapRef.current === null
    ) {
      return;
    }

    if (mapPreferences.showRoadEvents && roadEventSnapshot !== undefined) {
      try {
        const tapRadius = 18;
        const features = await mapRef.current.queryRenderedFeatures(
          [
            [point[0] - tapRadius, point[1] - tapRadius],
            [point[0] + tapRadius, point[1] + tapRadius],
          ],
          { layers: [...ROAD_EVENT_LAYER_IDS] },
        );
        const eventId = features
          .map((feature) => feature.properties?.id)
          .find((id): id is string => typeof id === 'string');
        const event = roadEvents.find((candidate) => candidate.id === eventId);
        if (event !== undefined) {
          Keyboard.dismiss();
          Alert.alert(event.title, roadEventAlertMessage(event), [{ text: 'Close' }]);
          return;
        }
      } catch {
        // Continue to place hit-testing while map event layers reload.
      }
    }

    if (!mapPreferences.showPlaces) {
      return;
    }

    const interactionId = placeInteractionRef.current + 1;
    placeInteractionRef.current = interactionId;
    placeAbortControllerRef.current?.abort();
    placeAbortControllerRef.current = null;
    setPlaceDetailsLoading(false);

    try {
      const tapRadius = 18;
      const features = await mapRef.current.queryRenderedFeatures(
        [
          [point[0] - tapRadius, point[1] - tapRadius],
          [point[0] + tapRadius, point[1] + tapRadius],
        ],
        { layers: [...MAP_PLACE_LAYER_IDS] },
      );
      if (placeInteractionRef.current !== interactionId) {
        return;
      }
      const place = mapPlaceFromRenderedFeatures(features, coordinate);

      if (place === undefined) {
        setPlaceDetailsLoading(false);
        setSelectedResult(undefined);
        return;
      }

      Keyboard.dismiss();
      setQuery('');
      setResults([]);
      setSearchState('idle');
      setSelectedResult(place);
      setSelectedPlaceSaved(isFavoriteDestination(place.id));
      setPlaceDetailsLoading(true);

      const controller = new AbortController();
      placeAbortControllerRef.current = controller;
      try {
        const response = await searchPlaces(place.name, {
          includeDetails: true,
          latitude: place.center.latitude,
          limit: 20,
          longitude: place.center.longitude,
          signal: controller.signal,
        });
        if (!controller.signal.aborted && placeInteractionRef.current === interactionId) {
          setSelectedResult((current) =>
            current?.id === place.id ? enrichMapPlace(place, response.results) : current,
          );
        }
      } catch {
        // The rendered map feature remains usable when optional metadata is unavailable.
      } finally {
        if (
          placeAbortControllerRef.current === controller &&
          placeInteractionRef.current === interactionId
        ) {
          placeAbortControllerRef.current = null;
          setPlaceDetailsLoading(false);
        }
      }
    } catch {
      if (placeInteractionRef.current === interactionId) {
        setPlaceDetailsLoading(false);
      }
    }
  };

  const handleClosePlace = () => {
    invalidatePlaceInteraction();
    setSelectedResult(undefined);
    setSelectedPlaceSaved(false);
  };

  const handleClearDestinationHistory = () => {
    clearDestinationHistory();
    setSelectedPlaceSaved(false);
    refreshDestinationCatalog();
  };

  const handlePlaceDirections = () => {
    if (selectedResult === undefined || routeState.type !== 'idle') {
      return;
    }

    const destination = selectedResult;
    invalidatePlaceInteraction();
    recordRecentDestination(destination);
    void calculateRoute(destination);
  };

  const openExternalPlaceUrl = (url: string) => {
    void Linking.openURL(url).catch(() => {
      console.warn('The external place link could not be opened.');
    });
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
    invalidatePlaceInteraction();
    announcedCameraIdsRef.current.clear();
    if (cameraAlertTimeoutRef.current !== undefined) {
      clearTimeout(cameraAlertTimeoutRef.current);
      cameraAlertTimeoutRef.current = undefined;
    }
    setSafetyCameraAlert(undefined);
    setCameraAnnouncementCount(0);
    stopNavigationAnnouncements();
    routeAbortControllerRef.current?.abort();
    setIsNavigationCameraFollowing(true);
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
    void calculateRoute(
      routeState.destination,
      preferences,
      routeState.previewOrigin,
      routeState.waypoints,
    );
  };

  const handleApplyRouteStops = (destinations: SearchResult[]) => {
    const destination = destinations.at(-1);
    if (routeState.type !== 'preview' || destination === undefined) return;
    const waypoints = destinations.slice(0, -1);
    setIsRouteStopsVisible(false);
    void calculateRoute(destination, routePreferences, routeState.previewOrigin, waypoints);
  };

  const selectedRoute =
    routeState.type === 'preview'
      ? routeState.routes.find((route) => route.id === routeState.selectedRouteId)
      : routeState.type === 'navigating' || routeState.type === 'arrived'
        ? routeState.route
        : undefined;
  const alternateRoutes =
    routeState.type === 'preview' && selectedRoute !== undefined
      ? routeState.routes.filter((route) => route.id !== selectedRoute.id)
      : [];
  const guidanceStep =
    routeState.type === 'navigating'
      ? getUpcomingGuidanceStep(routeState.route, navigationStepIndex)
      : undefined;
  const remainingRoute =
    routeState.type === 'navigating'
      ? getRemainingRouteSummary(
          routeState.route,
          navigationStepIndex,
          navigationSnapshot?.matchedCoordinate ?? userCoordinate,
        )
      : undefined;
  const remainingStep =
    routeState.type === 'navigating'
      ? getRemainingStepSummary(
          routeState.route,
          navigationStepIndex,
          navigationSnapshot?.matchedCoordinate ?? userCoordinate,
        )
      : undefined;
  const vehicleMatchStatus: VehicleMatchStatus =
    navigationSnapshot?.rawCoordinate === undefined
      ? 'acquiring'
      : navigationSnapshot.isOffRoute
        ? 'off-route'
        : 'matched';
  const navigationCameraCoordinate =
    routeState.type === 'navigating'
      ? (navigationSnapshot?.matchedCoordinate ?? userCoordinate)
      : undefined;
  const navigationCameraCenter: [longitude: number, latitude: number] | undefined =
    navigationCameraCoordinate === undefined
      ? undefined
      : [navigationCameraCoordinate.longitude, navigationCameraCoordinate.latitude];
  const navigationBearing =
    routeState.type === 'navigating'
      ? navigationCameraBearing(
          mapPreferences.navigationOrientation,
          navigationSnapshot?.matchedCourseDegrees,
          userHeading,
        )
      : undefined;
  const displayedSelectedRoute =
    routeState.type === 'navigating' && selectedRoute !== undefined
      ? {
          ...selectedRoute,
          geometry: getRemainingRouteGeometry(
            selectedRoute,
            navigationSnapshot?.routeProgress ?? 0,
            navigationSnapshot?.matchedCoordinate,
          ),
        }
      : routeState.type === 'arrived'
        ? undefined
        : selectedRoute;

  const handleStartNavigation = () => {
    if (
      routeState.type !== 'preview' ||
      routeState.previewOrigin !== undefined ||
      selectedRoute === undefined
    ) {
      return;
    }

    announcedCameraIdsRef.current.clear();
    if (cameraAlertTimeoutRef.current !== undefined) {
      clearTimeout(cameraAlertTimeoutRef.current);
      cameraAlertTimeoutRef.current = undefined;
    }
    setSafetyCameraAlert(undefined);
    setCameraAnnouncementCount(0);
    stopNavigationAnnouncements();
    setNavigationStepIndex(0);
    setNavigationRouteStatus('tracking');
    setRerouteCount(0);
    setIsNavigationCameraFollowing(true);
    const snapshot = setNavigationRoute(
      selectedRoute,
      routeState.destination,
      routePreferences,
      routeSource?.id,
      selectedRoute.traffic,
      routeState.waypoints,
    );
    nativeStateVersionRef.current = Math.max(nativeStateVersionRef.current, snapshot.stateVersion);
    setNavigationSnapshot(snapshot);
    setRouteState({
      destination: routeState.destination,
      route: selectedRoute,
      routes: routeState.routes,
      type: 'navigating',
      waypoints: routeState.waypoints,
    });
  };

  const handleShareEta = () => {
    if (routeState.type !== 'navigating' || remainingRoute === undefined) {
      return;
    }

    void Share.share({
      message: buildEtaShareMessage(
        routeState.destination.name,
        remainingRoute.durationSeconds,
        remainingRoute.distanceMeters,
      ),
      title: `ETA to ${routeState.destination.name}`,
    });
  };

  const handleOpenRoadReport = () => {
    if (navigationSnapshot?.matchedCoordinate === undefined && userCoordinate === undefined) {
      Alert.alert('Location unavailable', 'Wait for your location before recording a report.');
      return;
    }
    setIsRoadReportVisible(true);
  };

  const handleSaveRoadReport = async (type: RoadReportType) => {
    const coordinate = navigationSnapshot?.matchedCoordinate ?? userCoordinate;
    if (coordinate === undefined || isRoadReportSaving) return;

    setIsRoadReportSaving(true);
    try {
      const currentReports = await loadRoadReportDrafts();
      await saveRoadReportDrafts([createRoadReportDraft(type, coordinate), ...currentReports]);
      setIsRoadReportVisible(false);
      Alert.alert(
        'Saved for testing',
        'This report stays on this phone and is not shown to other drivers yet.',
      );
    } catch {
      Alert.alert('Report not saved', 'The report could not be stored on this phone.');
    } finally {
      setIsRoadReportSaving(false);
    }
  };

  const handleEndNavigation = () => {
    if (routeState.type !== 'navigating') {
      return;
    }

    if (cameraAlertTimeoutRef.current !== undefined) {
      clearTimeout(cameraAlertTimeoutRef.current);
      cameraAlertTimeoutRef.current = undefined;
    }
    setSafetyCameraAlert(undefined);
    setCameraAnnouncementCount(0);
    clearCarPlayTrip();
    stopNavigationAnnouncements();
    setNavigationStepIndex(0);
    setNavigationRouteStatus('tracking');
    setRerouteCount(0);
    setIsNavigationCameraFollowing(true);
    setRouteState({
      destination: routeState.destination,
      routes: routeState.routes,
      selectedRouteId: routeState.route.id,
      type: 'preview',
      waypoints: routeState.waypoints,
    });
    requestAnimationFrame(() => {
      fitRoute(routeState.route);
    });
  };

  const handleFinishArrival = () => {
    if (routeState.type !== 'arrived') {
      return;
    }

    announcedCameraIdsRef.current.clear();
    if (cameraAlertTimeoutRef.current !== undefined) {
      clearTimeout(cameraAlertTimeoutRef.current);
      cameraAlertTimeoutRef.current = undefined;
    }
    setSafetyCameraAlert(undefined);
    setCameraAnnouncementCount(0);
    clearCarPlayTrip();
    stopNavigationAnnouncements();
    setNavigationStepIndex(0);
    setNavigationRouteStatus('tracking');
    setRerouteCount(0);
    setIsNavigationCameraFollowing(true);
    setQuery('');
    setSelectedResult(undefined);
    setRouteState({ type: 'idle' });
  };

  const handleCarPlayNavigationEnded = useEffectEvent(() => {
    if (routeState.type === 'arrived') {
      handleFinishArrival();
      return;
    }
    handleEndNavigation();
  });

  useEffect(() => {
    setCarPlayConnected(getCarPlayState().connected);
    const stateSubscription = observeCarPlayState((state) => {
      setCarPlayConnected(state.connected);
    });
    const endedSubscription = observeCarPlayNavigationEnded(() => {
      handleCarPlayNavigationEnded();
    });
    return () => {
      stateSubscription.remove();
      endedSubscription.remove();
    };
  }, []);

  const placeSheetVisible = routeState.type === 'idle' && selectedResult !== undefined;
  const appShellVisible = routeState.type === 'idle' && selectedResult === undefined;
  const appTabBarHeight = appShellVisible ? APP_TAB_BAR_HEIGHT + insets.bottom : 0;
  const placeDetailRowCount =
    selectedResult === undefined
      ? 0
      : [
          selectedResult.details?.address,
          selectedResult.details?.openingHours,
          selectedResult.details?.phone,
          selectedResult.details?.website,
          selectedResult.details?.wheelchair,
        ].filter((value) => value !== undefined).length;
  const placeSheetHeight = Math.min(
    height * 0.56,
    242 +
      Math.max(1, placeDetailRowCount) * 48 +
      (selectedResult?.category === 'poi' ? 122 : 0) +
      insets.bottom,
  );
  const selectedPanelHeight =
    routeState.type === 'preview'
      ? (routeState.previewOrigin === undefined ? 360 : 428) + insets.bottom
      : routeState.type === 'loading'
        ? 156 + insets.bottom
        : routeState.type === 'error'
          ? 224 + insets.bottom
          : routeState.type === 'arrived'
            ? 170 + insets.bottom
            : routeState.type === 'navigating'
              ? 102 + insets.bottom
              : placeSheetVisible
                ? placeSheetHeight
                : 0;
  const controlBottom = selectedPanelHeight + appTabBarHeight + 18;
  const resultsHeight = Math.min(360, Math.max(180, height * 0.42));
  const darkMap =
    mapPreferences.stylePreset === 'night' ||
    (mapPreferences.stylePreset === 'automatic' && colorScheme === 'dark');
  const selectedPlacePhoneUrl = placePhoneUrl(selectedResult?.details?.phone);
  const selectedPlaceWebsiteUrl = placeWebsiteUrl(selectedResult?.details?.website);
  const selectedPlaceWebsiteLabel = placeWebsiteLabel(selectedResult?.details?.website);

  if (
    carPlayConnected &&
    routeState.type === 'navigating' &&
    guidanceStep !== undefined &&
    remainingRoute !== undefined &&
    remainingStep !== undefined
  ) {
    return (
      <View style={styles.container}>
        <StatusBar style="light" />
        <CarPlayCompanionPanel
          actionLabel="End"
          bottomInset={insets.bottom}
          destinationName={routeState.destination.name}
          distanceMeters={remainingStep.distanceMeters}
          durationSeconds={remainingRoute.durationSeconds}
          instruction={guidanceStep.instruction}
          maneuverType={guidanceStep.maneuverType}
          onAction={handleEndNavigation}
          remainingDistanceMeters={remainingRoute.distanceMeters}
          roadName={guidanceStep.roadName}
          safeAreaTop={insets.top}
        />
      </View>
    );
  }

  if (carPlayConnected && routeState.type === 'arrived') {
    return (
      <View style={styles.container}>
        <StatusBar style="light" />
        <CarPlayCompanionPanel
          actionLabel="Done"
          bottomInset={insets.bottom}
          destinationName={routeState.destination.name}
          distanceMeters={0}
          durationSeconds={0}
          instruction="You've arrived"
          maneuverType="arrive"
          onAction={handleFinishArrival}
          remainingDistanceMeters={0}
          roadName={routeState.destination.name}
          safeAreaTop={insets.top}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar style={activeTab === 'explore' && darkMap ? 'light' : 'dark'} />
      <Map
        accessibilityLabel={`Map with ${String(mapPreferences.showSafetyCameras ? safetyCameras.length : 0)} official safety camera symbols and ${String(mapPreferences.showRoadEvents ? roadEvents.length : 0)} road events`}
        accessibilityElementsHidden={activeTab !== 'explore'}
        attribution={false}
        compass={routeState.type !== 'navigating'}
        compassPosition={{ right: 14, top: insets.top + 118 }}
        logo={false}
        mapStyle={mapStyle}
        importantForAccessibility={activeTab === 'explore' ? 'auto' : 'no-hide-descendants'}
        onDidFailLoadingMap={() => {
          setMapError(true);
        }}
        onDidFinishLoadingMap={() => {
          setMapError(false);
          setMapReady(true);
        }}
        onLongPress={({ nativeEvent }) => {
          const [longitude, latitude] = nativeEvent.lngLat;
          handleMapLongPress({ latitude, longitude });
        }}
        onPress={({ nativeEvent }) => {
          const [longitude, latitude] = nativeEvent.lngLat;
          void handleMapPress(nativeEvent.point, { latitude, longitude });
        }}
        onRegionIsChanging={({ nativeEvent }) => {
          setMapBearing(nativeEvent.bearing);
          if (routeState.type === 'navigating' && nativeEvent.userInteraction) {
            setIsNavigationCameraFollowing(false);
          }
        }}
        preferredFramesPerSecond={60}
        ref={mapRef}
        style={styles.map}
        tintColor={NavOssColors.asphalt}
      >
        <Images images={MAP_IMAGES} />
        <Camera
          bearing={isNavigationCameraFollowing ? navigationBearing : undefined}
          center={isNavigationCameraFollowing ? navigationCameraCenter : undefined}
          duration={
            routeState.type === 'navigating' ? NAVIGATION_CAMERA_TRANSITION.duration : undefined
          }
          easing={
            routeState.type === 'navigating' ? NAVIGATION_CAMERA_TRANSITION.easing : undefined
          }
          initialViewState={{
            center: CALGARY_CENTER,
            zoom: 11.2,
          }}
          maxZoom={19}
          minZoom={8}
          padding={
            routeState.type === 'navigating'
              ? { bottom: 138 + insets.bottom, left: 24, right: 24, top: 170 }
              : undefined
          }
          pitch={
            routeState.type === 'navigating' && isNavigationCameraFollowing
              ? mapPreferences.navigationView === 'tilted'
                ? 42
                : 0
              : undefined
          }
          ref={cameraRef}
          zoom={routeState.type === 'navigating' && isNavigationCameraFollowing ? 16 : undefined}
        />
        {locationState === 'visible' && routeState.type !== 'navigating' && (
          <UserLocation accuracy heading />
        )}
        {routeState.type === 'navigating' && userCoordinate !== undefined && (
          <VehiclePuck
            coordinate={navigationSnapshot?.matchedCoordinate ?? userCoordinate}
            heading={mapAlignedHeadingDegrees(userHeading)}
            vehicleStyle={vehicleStyle}
          />
        )}
        {routeState.type === 'idle' &&
          results.map((result) => (
            <Marker
              anchor="bottom"
              id={`search-result:${result.id}`}
              key={result.id}
              lngLat={[result.center.longitude, result.center.latitude]}
              onPress={() => {
                handleSelectResult(result);
              }}
            >
              <View style={styles.searchResultMarker}>
                <SymbolView
                  name={{ android: 'location_on', ios: 'mappin.circle.fill' }}
                  size={25}
                  tintColor={NavOssColors.coral}
                />
              </View>
            </Marker>
          ))}
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
        {alternateRoutes.length > 0 && (
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
        )}
        {displayedSelectedRoute !== undefined && (
          <GeoJSONSource data={routeFeatures([displayedSelectedRoute])} id="selected-route">
            <Layer
              id="selected-route-casing"
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{ 'line-color': NavOssColors.white, 'line-width': 9 }}
              type="line"
            />
            <Layer
              id="selected-route-line"
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{ 'line-color': ROUTE_COLORS[mapPreferences.routeColor], 'line-width': 6 }}
              type="line"
            />
          </GeoJSONSource>
        )}
        {mapPreferences.showSafetyCameras && safetyCameras.length > 0 && (
          <GeoJSONSource data={safetyCameraFeatures(safetyCameras)} id="safety-cameras">
            <Layer
              id="safety-camera-symbols"
              layout={{
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
                'icon-image': 'safety-camera',
                'icon-size': 0.5,
              }}
              type="symbol"
            />
          </GeoJSONSource>
        )}
        {mapPreferences.showSafetyCameras && torontoSafetyCameras.length > 0 && (
          <GeoJSONSource
            data={safetyCameraFeatures(torontoSafetyCameras)}
            id="toronto-safety-cameras"
          >
            <Layer
              id="toronto-safety-camera-symbols"
              layout={{
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
                'icon-image': 'safety-camera',
                'icon-size': 0.5,
              }}
              type="symbol"
            />
          </GeoJSONSource>
        )}
        {mapPreferences.showRoadEvents && roadEventSnapshot !== undefined && (
          <>
            <GeoJSONSource
              data={roadEventFeatures(roadEvents, 'construction')}
              id="official-construction-events-source"
            >
              <Layer
                id="official-construction-events"
                paint={{
                  'circle-color': NavOssColors.sun,
                  'circle-opacity': 0.95,
                  'circle-radius': 8,
                  'circle-stroke-color': NavOssColors.asphalt,
                  'circle-stroke-width': 2,
                }}
                type="circle"
              />
            </GeoJSONSource>
            <GeoJSONSource
              data={roadEventFeatures(roadEvents, 'closure')}
              id="road-closure-events-source"
            >
              <Layer
                id="road-closure-events"
                paint={{
                  'circle-color': NavOssColors.asphalt,
                  'circle-opacity': 0.95,
                  'circle-radius': 8,
                  'circle-stroke-color': NavOssColors.white,
                  'circle-stroke-width': 3,
                }}
                type="circle"
              />
            </GeoJSONSource>
            <GeoJSONSource
              data={roadEventFeatures(roadEvents, 'incident')}
              id="road-incident-events-source"
            >
              <Layer
                id="road-incident-events"
                paint={{
                  'circle-color': NavOssColors.coral,
                  'circle-opacity': 0.82,
                  'circle-radius': 6,
                  'circle-stroke-color': NavOssColors.white,
                  'circle-stroke-width': 2,
                }}
                type="circle"
              />
            </GeoJSONSource>
          </>
        )}
      </Map>

      {routeState.type === 'navigating' && (
        <Pressable
          accessibilityHint="Toggles between keeping the road ahead at the top and keeping north at the top"
          accessibilityLabel={
            mapPreferences.navigationOrientation === 'heading-up'
              ? 'Switch map to north up'
              : 'Switch map to heading up'
          }
          onPress={() => {
            const navigationOrientation = toggleNavigationMapOrientation(
              mapPreferences.navigationOrientation,
            );
            const preferences = { ...mapPreferences, navigationOrientation };
            setMapPreferences(preferences);
            persistMapPreferences(preferences);
          }}
          style={({ pressed }) => [
            styles.compassButton,
            { top: insets.top + (safetyCameraAlert === undefined ? 136 : 210) },
            mapPreferences.navigationOrientation === 'north-up' && styles.compassButtonSelected,
            pressed && styles.controlPressed,
          ]}
        >
          <View style={{ transform: [{ rotate: `${String(-mapBearing)}deg` }] }}>
            <SymbolView
              name={{ android: 'navigation', ios: 'location.north.line.fill' }}
              size={23}
              tintColor={
                mapPreferences.navigationOrientation === 'north-up'
                  ? NavOssColors.white
                  : NavOssColors.asphalt
              }
            />
          </View>
        </Pressable>
      )}

      {routeState.type === 'navigating' && !isNavigationCameraFollowing && (
        <Pressable
          accessibilityLabel="Recenter map on vehicle"
          onPress={() => {
            setIsNavigationCameraFollowing(true);
          }}
          style={({ pressed }) => [
            styles.recenterButton,
            { bottom: selectedPanelHeight + 70 },
            pressed && styles.controlPressed,
          ]}
        >
          <SymbolView
            name={{ android: 'my_location', ios: 'location.fill' }}
            size={22}
            tintColor={NavOssColors.asphalt}
          />
        </Pressable>
      )}

      {(activeTab === 'explore' || !appShellVisible) && (
        <Pressable
          accessibilityLabel="Map appearance"
          onPress={() => {
            setIsMapPreferencesVisible(true);
          }}
          style={({ pressed }) => [
            styles.mapPreferencesButton,
            {
              bottom:
                routeState.type === 'navigating' || routeState.type === 'arrived'
                  ? selectedPanelHeight + 18
                  : controlBottom + 62,
            },
            pressed && styles.controlPressed,
          ]}
        >
          <SymbolView
            name={{ android: 'layers', ios: 'square.3.layers.3d' }}
            size={22}
            tintColor={NavOssColors.asphalt}
          />
        </Pressable>
      )}

      {(activeTab === 'explore' || !appShellVisible) &&
        mapPreferences.showRoadEvents &&
        (roadEventSnapshot !== undefined || roadEventRefreshDelayed) && (
          <View
            pointerEvents="none"
            style={[
              styles.roadEventAttribution,
              { bottom: selectedPanelHeight + appTabBarHeight + 34 },
            ]}
          >
            <Text style={styles.roadEventAttributionText}>
              {roadEventSnapshot === undefined
                ? 'Road events unavailable'
                : `${roadEventRegion === 'ontario' ? 'Road events · Ontario 511 · Official' : 'Road events · City of Calgary · Incidents unverified'}${roadEventSnapshot.stale ? ' · Stale snapshot' : ''}${roadEventRefreshDelayed ? ' · Refresh delayed' : ''}`}
            </Text>
          </View>
        )}

      <MapPreferencesPanel
        onChange={(preferences) => {
          setMapPreferences(preferences);
          persistMapPreferences(preferences);
        }}
        onClose={() => {
          setIsMapPreferencesVisible(false);
        }}
        preferences={mapPreferences}
        visible={isMapPreferencesVisible}
      />

      {routeState.type === 'idle' && selectedResult !== undefined && (
        <PlaceSheet
          bottomInset={insets.bottom}
          height={placeSheetHeight}
          loading={placeDetailsLoading}
          onClose={handleClosePlace}
          onDirections={handlePlaceDirections}
          onReadReviews={() => {
            openExternalPlaceUrl(placeReviewsUrl(selectedResult));
          }}
          onSave={() => {
            setSelectedPlaceSaved(toggleFavoriteDestination(selectedResult));
            refreshDestinationCatalog();
          }}
          onShare={() => {
            void Share.share({
              message: placeShareMessage(selectedResult),
              title: selectedResult.name,
            });
          }}
          {...(selectedPlacePhoneUrl === undefined
            ? {}
            : {
                onCall: () => {
                  openExternalPlaceUrl(selectedPlacePhoneUrl);
                },
              })}
          {...(selectedPlaceWebsiteUrl === undefined
            ? {}
            : {
                onWebsite: () => {
                  openExternalPlaceUrl(selectedPlaceWebsiteUrl);
                },
              })}
          place={selectedResult}
          ratingAvailable={googlePlaceRatingAvailable}
          saved={selectedPlaceSaved}
          websiteLabel={selectedPlaceWebsiteLabel}
        />
      )}

      {routeState.type !== 'navigating' &&
        routeState.type !== 'arrived' &&
        activeTab === 'explore' && (
          <View
            pointerEvents="box-none"
            style={[styles.topOverlay, { paddingTop: insets.top + 10 }]}
          >
            <SearchPanel
              apiConnection={apiConnection}
              coverageName={coverageName}
              darkMap={darkMap}
              discoveryActions={
                appShellVisible ? (
                  <ExploreCategoryBar
                    onCategoryPress={handleCategoryPress}
                    onCloseMore={() => {
                      setIsMoreCategoriesVisible(false);
                    }}
                    onOpenMore={() => {
                      setIsMoreCategoriesVisible(true);
                    }}
                    onWorkPress={handleWorkPress}
                    selectedCategoryId={selectedCategoryId}
                    settingWork={shortcutBeingSet === 'work'}
                    showMore={isMoreCategoriesVisible}
                    workSaved={destinationCatalog.work !== undefined}
                  />
                ) : undefined
              }
              maximumResultsHeight={resultsHeight}
              onChangeQuery={handleChangeQuery}
              onClear={handleClear}
              onClearDestinationHistory={handleClearDestinationHistory}
              onSelectResult={handleSelectResult}
              onSubmit={handleSubmit}
              query={query}
              results={results}
              searchPlaceholder={
                shortcutBeingSet === undefined
                  ? 'Where to?'
                  : `Search to set ${shortcutBeingSet === 'home' ? 'Home' : 'Work'}`
              }
              searchSource={searchSource}
              searchState={searchState}
            />
          </View>
        )}

      {appShellVisible && activeTab === 'saved' && (
        <SavedPlacesScreen
          bottomInset={insets.bottom}
          catalog={destinationCatalog}
          onChoose={(place) => {
            setActiveTab('explore');
            handleSelectResult(place);
          }}
          onChangeHome={() => {
            beginShortcutSetup('home');
          }}
          onChangeWork={() => {
            beginShortcutSetup('work');
          }}
          onClearHistory={() => {
            clearRecentDestinations();
            refreshDestinationCatalog();
          }}
          onRemoveHome={() => {
            setHomeDestination(undefined);
            refreshDestinationCatalog();
          }}
          onRemoveWork={() => {
            setWorkDestination(undefined);
            refreshDestinationCatalog();
          }}
          onSetHome={() => {
            beginShortcutSetup('home');
          }}
          onSetWork={() => {
            beginShortcutSetup('work');
          }}
          safeAreaTop={insets.top}
        />
      )}

      {appShellVisible && activeTab === 'contribute' && (
        <ContributeScreen bottomInset={insets.bottom} safeAreaTop={insets.top} />
      )}

      {activeTab === 'explore' &&
        (mapError ||
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

      {activeTab === 'explore' &&
        routeState.type !== 'navigating' &&
        routeState.type !== 'arrived' && (
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
              animationSpec={
                locationState === 'locating' ? { effect: { type: 'pulse' } } : undefined
              }
              name={{ android: 'my_location', ios: 'location.fill' }}
              size={23}
              tintColor={NavOssColors.asphalt}
            />
          </Pressable>
        )}

      {(activeTab === 'explore' || !appShellVisible) && (
        <Pressable
          accessibilityLabel="Map attribution"
          onPress={() => {
            void mapRef.current?.showAttribution();
          }}
          style={[styles.attribution, { bottom: selectedPanelHeight + appTabBarHeight + 8 }]}
        >
          <Text style={styles.attributionText}>
            © OpenMapTiles · © OpenStreetMap · © City of Calgary
            {torontoSafetyCameras.length > 0 ? ' · © City of Toronto' : ''}
            {roadEventRegion === 'ontario' ? ' · Ontario 511' : ''}
          </Text>
        </Pressable>
      )}

      {(routeState.type === 'loading' || routeState.type === 'error') && (
        <RoutePlanningPanel
          bottomInset={insets.bottom}
          destination={routeState.destination}
          errorMessage={routeState.type === 'error' ? routeState.message : undefined}
          onCancel={handleCancelRoute}
          onPreviewFromCalgary={() => {
            void calculateRoute(
              routeState.destination,
              routePreferences,
              CALGARY_TOWER_ROUTE_ORIGIN,
              routeState.waypoints,
            );
          }}
          onRetry={() => {
            void calculateRoute(
              routeState.destination,
              routePreferences,
              routeState.previewOrigin,
              routeState.waypoints,
            );
          }}
        />
      )}

      {routeState.type === 'preview' && selectedRoute !== undefined && (
        <RoutePreviewPanel
          avoidHighways={routePreferences.avoidHighways}
          bottomInset={insets.bottom}
          destination={routeState.destination}
          onCancel={handleCancelRoute}
          onEditStops={() => {
            setIsRouteStopsVisible(true);
          }}
          onSelectRoute={handleSelectRoute}
          onStart={handleStartNavigation}
          onToggleAvoidHighways={handleToggleAvoidHighways}
          onUseCurrentLocation={() => {
            void calculateRoute(
              routeState.destination,
              routePreferences,
              undefined,
              routeState.waypoints,
            );
          }}
          onVehicleStyleChange={setVehicleStyle}
          previewOriginLabel={routeState.previewOrigin === undefined ? undefined : 'Calgary Tower'}
          routes={routeState.routes}
          selectedRoute={selectedRoute}
          routeSource={routeSource}
          vehicleStyle={vehicleStyle}
          waypoints={routeState.waypoints}
        />
      )}

      {routeState.type === 'preview' && (
        <RouteStopsEditor
          destinations={[...routeState.waypoints, routeState.destination]}
          onApply={handleApplyRouteStops}
          onClose={() => {
            setIsRouteStopsVisible(false);
          }}
          origin={userCoordinate}
          visible={isRouteStopsVisible}
        />
      )}

      {routeState.type === 'navigating' &&
        guidanceStep !== undefined &&
        remainingRoute !== undefined &&
        remainingStep !== undefined && (
          <>
            <NavigationBanner
              distanceMeters={remainingStep.distanceMeters}
              instruction={guidanceStep.instruction}
              maneuverType={guidanceStep.maneuverType}
              roadName={guidanceStep.roadName}
              safeAreaTop={insets.top}
              status={navigationRouteStatus}
            />
            <NavigationStatusBar
              bottomInset={insets.bottom}
              cameraAnnouncementCount={cameraAnnouncementCount}
              distanceMeters={remainingRoute.distanceMeters}
              durationSeconds={remainingRoute.durationSeconds}
              matchStatus={vehicleMatchStatus}
              onEnd={handleEndNavigation}
              onReport={handleOpenRoadReport}
              onShare={handleShareEta}
              rerouteCount={rerouteCount}
            />
          </>
        )}

      <RoadReportSheet
        bottomInset={insets.bottom}
        isSaving={isRoadReportSaving}
        onCancel={() => {
          if (!isRoadReportSaving) setIsRoadReportVisible(false);
        }}
        onSelect={(type) => {
          void handleSaveRoadReport(type);
        }}
        visible={isRoadReportVisible}
      />

      {routeState.type === 'navigating' && safetyCameraAlert !== undefined && (
        <SafetyCameraAlertBanner
          camera={safetyCameraAlert.camera}
          distanceAheadMeters={safetyCameraAlert.distanceAheadMeters}
          safeAreaTop={insets.top}
        />
      )}

      {routeState.type === 'arrived' && (
        <ArrivalPanel
          bottomInset={insets.bottom}
          destination={routeState.destination}
          onDone={handleFinishArrival}
        />
      )}

      {appShellVisible && (
        <AppTabBar
          activeTab={activeTab}
          bottomInset={insets.bottom}
          onSelect={(tab) => {
            Keyboard.dismiss();
            if (tab !== 'explore') {
              categorySearchActiveRef.current = false;
              invalidateSearchRequest();
            }
            setActiveTab(tab);
            if (tab !== 'explore') {
              setShortcutBeingSet(undefined);
            }
            if (tab === 'saved') {
              refreshDestinationCatalog();
            }
          }}
        />
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
  roadEventAttribution: {
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderBottomRightRadius: 4,
    borderTopRightRadius: 4,
    left: 0,
    maxWidth: 310,
    paddingHorizontal: 8,
    paddingVertical: 5,
    position: 'absolute',
  },
  roadEventAttributionText: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.semibold,
    fontSize: 10,
    letterSpacing: 0,
  },
  container: {
    backgroundColor: NavOssColors.fog,
    flex: 1,
  },
  compassButton: {
    alignItems: 'center',
    backgroundColor: NavOssColors.white,
    borderColor: NavOssColors.border,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    height: 44,
    justifyContent: 'center',
    position: 'absolute',
    right: 14,
    shadowColor: '#000000',
    shadowOffset: { height: 3, width: 0 },
    shadowOpacity: 0.18,
    shadowRadius: 8,
    width: 44,
    zIndex: 28,
  },
  compassButtonSelected: {
    backgroundColor: NavOssColors.green,
    borderColor: NavOssColors.green,
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
  mapPreferencesButton: {
    alignItems: 'center',
    backgroundColor: NavOssColors.white,
    borderColor: NavOssColors.border,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    height: 44,
    justifyContent: 'center',
    position: 'absolute',
    right: 18,
    shadowColor: '#000000',
    shadowOffset: { height: 3, width: 0 },
    shadowOpacity: 0.18,
    shadowRadius: 8,
    width: 44,
    zIndex: 27,
  },
  recenterButton: {
    alignItems: 'center',
    backgroundColor: NavOssColors.white,
    borderColor: NavOssColors.border,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    height: 44,
    justifyContent: 'center',
    position: 'absolute',
    right: 18,
    shadowColor: '#000000',
    shadowOffset: { height: 3, width: 0 },
    shadowOpacity: 0.18,
    shadowRadius: 8,
    width: 44,
    zIndex: 28,
  },
  searchResultMarker: {
    alignItems: 'center',
    backgroundColor: NavOssColors.white,
    borderColor: NavOssColors.border,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    height: 36,
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOffset: { height: 2, width: 0 },
    shadowOpacity: 0.2,
    shadowRadius: 5,
    width: 36,
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
