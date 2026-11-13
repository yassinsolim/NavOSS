import type { CameraRef, MapRef } from '@maplibre/maplibre-react-native';
import type {
  Coordinate,
  RouteAlternative,
  RoutePreferences,
  SearchResult,
} from '@navoss/contracts';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import {
  AppState,
  Keyboard,
  Linking,
  Share,
  useColorScheme,
  useWindowDimensions,
} from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { AppTab } from '@/features/map/app-tab-bar';
import { useMapPreferences, useMapStyle } from '@/features/map/controller/use-map-preferences';
import { useNavigationSession } from '@/features/map/controller/use-navigation-session';
import { useOverlayData } from '@/features/map/controller/use-overlay-data';
import { usePlaceSearch } from '@/features/map/controller/use-place-search';
import { useRoutePlanner } from '@/features/map/controller/use-route-planner';
import { useLocationWatches, useUserLocation } from '@/features/map/controller/use-user-location';
import { exploreCategoryById, type ExploreCategory } from '@/features/map/explore-categories';
import {
  idleCameraCenterForFollow,
  idleCameraFollowIntentAfterRegionChange,
  shouldFollowIdleCamera,
  shouldWatchPhoneIdleLocation,
} from '@/features/map/idle-camera-follow';
import { createLatestRequestGate } from '@/features/map/latest-request-gate';
import {
  cameraDetailMessage,
  droppedPinResult,
  renderedFeatureId,
  ROAD_EVENT_LAYER_IDS,
  roadEventMessage,
  routeBounds,
  SAFETY_CAMERA_LAYER_IDS,
  SAFETY_FACILITY_LAYER_IDS,
  SEARCH_RESULT_LAYER_IDS,
  TRAFFIC_CAMERA_LAYER_IDS,
} from '@/features/map/map-features';
import {
  enrichMapPlace,
  MAP_PLACE_LAYER_IDS,
  mapPlaceFromRenderedFeatures,
  placeShareMessage,
} from '@/features/map/map-place';
import { isSearchCoverageRegion, mapRegionForCoordinate } from '@/features/map/map-region';
import {
  routePreviewCameraPadding,
  type ScreenMetrics,
  searchResultsCameraPadding,
} from '@/features/map/overlay-layout';
import {
  createRoadReportDraft,
  loadRoadReportDrafts,
  type RoadReportType,
  saveRoadReportDrafts,
} from '@/features/map/road-report-drafts';
import { searchResultBounds } from '@/features/map/search-proximity';
import type { ApiConnectionState } from '@/features/map/search-status';
import {
  clearCarPlayTrip,
  clearDestinationHistory,
  clearRecentDestinations,
  getCarPlayState,
  getDestinationCatalog,
  getNavigationAudioMode,
  getNavigationPreferences,
  isFavoriteDestination,
  isGooglePlaceRatingAvailable,
  type NativeDestinationCatalog,
  nativeDestinationToSearchResult,
  type NavigationAudioMode,
  observeCarPlayNavigationEnded,
  observeCarPlayState,
  observeNavigationPreferences,
  recordRecentDestination,
  setHomeDestination,
  setNavigationAudioMode,
  setNavigationRoute,
  setWorkDestination,
  stopNavigationAnnouncements,
  toggleFavoriteDestination,
} from '@/features/navigation/native-navigation';
import {
  navigationCameraBearing,
  toggleNavigationMapOrientation,
} from '@/features/navigation/navigation-camera';
import {
  phoneSurface,
  releasesPhoneRouteOnCarPlayConnect,
} from '@/features/navigation/phone-surface';
import {
  buildEtaShareMessage,
  getRemainingRouteGeometry,
  getRemainingRouteSummary,
  getRemainingStepSummary,
  getUpcomingGuidanceStep,
  getUpcomingManeuvers,
} from '@/features/navigation/route-progress';
import { selectedRouteOf } from '@/features/navigation/route-ui-state';
import { useSafetyCameraAlert } from '@/features/navigation/use-safety-camera-alert';
import type { VehicleMatchStatus } from '@/features/navigation/vehicle-puck';
import { fetchAppConfig, searchPlaces } from '@/lib/api';
import { useStableCallback } from '@/lib/use-stable-callback';
import { createValueStore } from '@/lib/value-store';
import { haptics } from '@/theme/haptics';
import type { SymbolName } from '@/ui/button';
import type { BottomSheetRef } from '@/ui/sheet/bottom-sheet';

const CANADA_CENTER: [longitude: number, latitude: number] = [-106.3468, 56.1304];
const CALGARY_TOWER_ROUTE_ORIGIN: Coordinate = { latitude: 51.04427, longitude: -114.06309 };
const TAP_RADIUS = 18;
const NOTICE_VISIBLE_MS = 5_000;

/** Details of a tapped overlay feature, shown in the map-feature sheet. */
export interface MapFeatureDetail {
  body: string;
  eyebrow: string;
  icon: SymbolName;
  link?: { label: string; url: string };
  title: string;
}

/** A short confirmation or failure message that appears over the map and dismisses itself. */
export interface MapNotice {
  id: number;
  message: string;
  title: string;
  tone: 'danger' | 'info' | 'warning';
}

export interface CameraChange {
  bearing: number;
  userInteraction: boolean;
  zoom: number;
}

/**
 * The map screen's state and behaviour, composed from focused hooks. Components receive plain
 * values and callbacks from here and hold no map logic of their own.
 *
 * Nothing in this hook updates per camera frame: the camera's bearing goes to a shared value and
 * its zoom to a quantised store, so panning and zooming re-render no React component above the
 * one layer that subscribes.
 */
export function useMapController() {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const { height: windowHeight } = useWindowDimensions();
  const metrics: ScreenMetrics = useMemo(
    () => ({ bottomInset: insets.bottom, topInset: insets.top, windowHeight }),
    [insets.bottom, insets.top, windowHeight],
  );
  const cameraRef = useRef<CameraRef>(null);
  const mapRef = useRef<MapRef>(null);
  const exploreSheetRef = useRef<BottomSheetRef>(null);
  const placeAbortControllerRef = useRef<AbortController>(null);
  const placeInteractionRef = useRef(createLatestRequestGate());
  const noticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const noticeIdRef = useRef(0);
  // Where the driver left the route preview sheet, kept across the re-plan that remounts it.
  const [previewDetent, setPreviewDetent] = useState<number>();

  // Camera motion lives outside React state. See the hook comment.
  const mapBearing = useSharedValue(0);
  const [zoomStepStore] = useState(() => createValueStore<number | undefined>(undefined));
  /** Distance from the bottom of the screen to the top of the active sheet, on the UI thread. */
  const sheetPosition = useSharedValue(0);

  const [apiConnection, setApiConnection] = useState<ApiConnectionState>('connecting');
  const [coverageName, setCoverageName] = useState('Loading route coverage');
  const [isAppActive, setIsAppActive] = useState(() => AppState.currentState === 'active');
  const [activeTab, setActiveTab] = useState<AppTab>('explore');
  const [mapError, setMapError] = useState(false);
  const [isAboutVisible, setIsAboutVisible] = useState(false);
  const [isMapPreferencesVisible, setIsMapPreferencesVisible] = useState(false);
  const [isMoreCategoriesVisible, setIsMoreCategoriesVisible] = useState(false);
  const [isRoadReportSaving, setIsRoadReportSaving] = useState(false);
  const [isRoadReportVisible, setIsRoadReportVisible] = useState(false);
  const [isRouteStopsVisible, setIsRouteStopsVisible] = useState(false);
  const [isAudioModeVisible, setIsAudioModeVisible] = useState(false);
  const [featureDetail, setFeatureDetail] = useState<MapFeatureDetail>();
  const [notice, setNotice] = useState<MapNotice>();
  const [placeDetailsLoading, setPlaceDetailsLoading] = useState(false);
  const [googlePlaceRatingAvailable] = useState(() => isGooglePlaceRatingAvailable());
  const [selectedPlaceSaved, setSelectedPlaceSaved] = useState(false);
  const [selectedResult, setSelectedResult] = useState<SearchResult>();
  const [shortcutBeingSet, setShortcutBeingSet] = useState<'home' | 'work'>();
  const [destinationCatalog, setDestinationCatalog] = useState<NativeDestinationCatalog>(() =>
    getDestinationCatalog(),
  );
  const [navigationAudioMode, setNavigationAudioModeState] = useState<NavigationAudioMode>(() =>
    getNavigationAudioMode(),
  );
  const [carPlayConnected, setCarPlayConnected] = useState(false);
  const [isNavigationCameraFollowing, setIsNavigationCameraFollowing] = useState(true);
  const [isIdleCameraFollowing, setIsIdleCameraFollowing] = useState(true);

  const { preferences: mapPreferences, updatePreferences } = useMapPreferences();
  const { darkMap, mapStyle } = useMapStyle(mapPreferences, colorScheme);

  const showNotice = (next: Omit<MapNotice, 'id'>) => {
    clearTimeout(noticeTimeoutRef.current);
    noticeIdRef.current += 1;
    setNotice({ ...next, id: noticeIdRef.current });
    noticeTimeoutRef.current = setTimeout(() => {
      setNotice(undefined);
    }, NOTICE_VISIBLE_MS);
  };

  // --- Route planning and the navigation session -------------------------------------------

  const location = useUserLocation();
  const { locationState, mapRegion, searchOrigin, userCoordinate, userHeading } = location;

  const planner = useRoutePlanner({
    getCurrentRouteOrigin: location.getCurrentRouteOrigin,
    onPlanningStarted: () => {
      setIsIdleCameraFollowing(false);
    },
    onRoutePlanned: (route, demoOrigin) => {
      fitRoute(route, demoOrigin);
    },
    onServiceReachable: () => {
      setApiConnection('online');
    },
  });
  const { routeState, setRouteState } = planner;
  const routeIsIdle = routeState.type === 'idle';

  const session = useNavigationSession({
    onFix: location.setNavigationFix,
    onTripEnded: () => {
      setIsIdleCameraFollowing(true);
    },
    routeState,
    setRouteSource: planner.setRouteSource,
    setRouteState,
  });
  const navigationSnapshot = session.snapshot;
  const navigationStepIndex = session.stepIndex;

  // --- Which surface the handset shows ------------------------------------------------------

  const progressCoordinate = navigationSnapshot?.matchedCoordinate ?? userCoordinate;
  const guidanceStep =
    routeState.type === 'navigating'
      ? getUpcomingGuidanceStep(routeState.route, navigationStepIndex)
      : undefined;
  const remainingRoute =
    routeState.type === 'navigating'
      ? getRemainingRouteSummary(routeState.route, navigationStepIndex, progressCoordinate)
      : undefined;
  const remainingStep =
    routeState.type === 'navigating'
      ? getRemainingStepSummary(routeState.route, navigationStepIndex, progressCoordinate)
      : undefined;
  // The companion mirrors the car screen, so it prefers the native guidance CarPlay renders.
  const nativeGuidance =
    navigationSnapshot?.guidance?.phase === 'navigating' &&
    navigationSnapshot.guidance.stepIndex === navigationStepIndex
      ? navigationSnapshot.guidance
      : undefined;
  const upcomingManeuvers =
    routeState.type === 'navigating' && remainingStep !== undefined
      ? getUpcomingManeuvers(
          routeState.route,
          navigationStepIndex,
          nativeGuidance?.distanceToManeuverMeters ?? remainingStep.distanceMeters,
        )
      : undefined;
  const carPlayGuidance =
    routeState.type === 'navigating' &&
    carPlayConnected &&
    guidanceStep !== undefined &&
    remainingRoute !== undefined &&
    upcomingManeuvers !== undefined
      ? {
          destination: routeState.destination,
          maneuvers: upcomingManeuvers,
          remainingDistanceMeters:
            nativeGuidance?.remainingDistanceMeters ?? remainingRoute.distanceMeters,
          remainingDurationSeconds:
            nativeGuidance?.remainingDurationSeconds ?? remainingRoute.durationSeconds,
        }
      : undefined;
  const surface = phoneSurface({
    carPlayConnected,
    guidanceResolved: carPlayGuidance !== undefined,
    routeStatus: routeState.type,
  });
  const phoneMapVisible =
    isAppActive && surface === 'map' && (!routeIsIdle || activeTab === 'explore');

  // --- Location, overlays, search -----------------------------------------------------------

  // CarPlay owns location only while it owns the handset surface; its connected planning map
  // needs the foreground watch for a live puck and idle camera follow.
  useLocationWatches(location, {
    phoneMapVisible,
    watchIdlePosition: shouldWatchPhoneIdleLocation({
      appIsActive: isAppActive,
      carPlayConnected: carPlayConnected && surface !== 'map',
      locationIsVisible: locationState === 'visible',
      mapTabIsVisible: activeTab === 'explore',
      routeIsIdle,
    }),
  });

  const overlays = useOverlayData({
    inTorontoCameraBounds: location.inTorontoCameraBounds,
    mapRegion,
    showRoadEvents: mapPreferences.showRoadEvents,
  });

  const search = usePlaceSearch({
    onConnectionChange: setApiConnection,
    onFitResults: (bounds) => {
      cameraRef.current?.fitBounds(bounds, {
        duration: 700,
        padding: searchResultsCameraPadding(metrics, 1),
      });
    },
    searchOrigin,
    selectedResultName: selectedResult?.name,
  });
  const nearbySearchEnabled = searchOrigin !== undefined;

  const cameraAlerts = useSafetyCameraAlert({
    cameras: overlays.safetyCameras,
    route: routeState.type === 'navigating' ? routeState.route : undefined,
    snapshot: navigationSnapshot,
  });

  // --- Camera follow ------------------------------------------------------------------------

  const hasTransientDestination =
    selectedResult !== undefined || search.query.trim().length > 0 || search.searchState !== 'idle';
  const idleCameraShouldFollow = shouldFollowIdleCamera({
    appIsActive: isAppActive,
    hasTransientDestination,
    hasUserCoordinate: userCoordinate !== undefined,
    intent: isIdleCameraFollowing,
    phoneMapVisible,
    routeIsIdle,
  });
  const idleCameraCenter = useMemo(
    () => idleCameraCenterForFollow(userCoordinate, idleCameraShouldFollow),
    [idleCameraShouldFollow, userCoordinate],
  );

  /** Runs for every camera frame. It must never set React state unless a value changes. */
  const handleCameraChange = useStableCallback(
    ({ bearing, userInteraction, zoom }: CameraChange) => {
      mapBearing.value = bearing;
      // Quantised: the heading cone only needs to resize perceptibly.
      zoomStepStore.set(Math.round(zoom * 4) / 4);
      if (!userInteraction) return;
      if (routeState.type === 'navigating') {
        if (isNavigationCameraFollowing) setIsNavigationCameraFollowing(false);
      } else if (routeIsIdle) {
        const nextIntent = idleCameraFollowIntentAfterRegionChange(isIdleCameraFollowing, true);
        if (nextIntent !== isIdleCameraFollowing) setIsIdleCameraFollowing(nextIntent);
      }
    },
  );

  function fitRoute(route: RouteAlternative, demoOrigin: boolean) {
    cameraRef.current?.fitBounds(routeBounds(route), {
      duration: 750,
      padding: routePreviewCameraPadding(metrics, { demoOrigin }),
    });
  }

  // --- Lifecycle effects --------------------------------------------------------------------

  useEffect(() => {
    // Expired local report drafts are pruned once per launch.
    void loadRoadReportDrafts()
      .then((reports) => saveRoadReportDrafts(reports))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchAppConfig(controller.signal)
      .then((config) => {
        setApiConnection('online');
        setCoverageName(config.coverage.displayName);
      })
      .catch(() => {
        if (!controller.signal.aborted) setApiConnection('offline');
      });
    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      setIsAppActive(nextAppState === 'active');
    });
    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(
    () => () => {
      clearTimeout(noticeTimeoutRef.current);
      stopNavigationAnnouncements();
      placeInteractionRef.current.advance();
      placeAbortControllerRef.current?.abort();
    },
    [],
  );

  // --- Place selection ----------------------------------------------------------------------

  const invalidatePlaceInteraction = (): number => {
    const interactionGeneration = placeInteractionRef.current.advance();
    placeAbortControllerRef.current?.abort();
    placeAbortControllerRef.current = null;
    setPlaceDetailsLoading(false);
    return interactionGeneration;
  };

  const refreshDestinationCatalog = () => {
    setDestinationCatalog(getDestinationCatalog());
  };

  /** Loads optional metadata for a place that is already on screen. Failure leaves it usable. */
  const loadPlaceDetails = (place: SearchResult, interactionId: number) => {
    setPlaceDetailsLoading(true);
    const controller = new AbortController();
    placeAbortControllerRef.current = controller;
    void searchPlaces(place.name, {
      includeDetails: true,
      latitude: place.center.latitude,
      limit: 20,
      longitude: place.center.longitude,
      signal: controller.signal,
    })
      .then((response) => {
        if (!controller.signal.aborted && placeInteractionRef.current.isCurrent(interactionId)) {
          setSelectedResult((current) =>
            current?.id === place.id ? enrichMapPlace(place, response.results) : current,
          );
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (
          placeAbortControllerRef.current === controller &&
          placeInteractionRef.current.isCurrent(interactionId)
        ) {
          placeAbortControllerRef.current = null;
          setPlaceDetailsLoading(false);
        }
      });
  };

  const handleChangeQuery = (value: string) => {
    search.setCategorySearchActive(false);
    invalidatePlaceInteraction();
    search.setSelectedCategoryId(undefined);
    search.setQuery(value);
    setSelectedResult(undefined);
    if (value.trim().length > 0) setIsIdleCameraFollowing(false);
    if (value.trim().length < 2) search.resetResults();
  };

  const resetTrip = () => {
    stopNavigationAnnouncements();
    session.resetProgress();
    setIsNavigationCameraFollowing(true);
  };

  const handleClear = () => {
    cameraAlerts.reset();
    stopNavigationAnnouncements();
    search.setCategorySearchActive(false);
    search.invalidate();
    invalidatePlaceInteraction();
    planner.abort();
    setIsNavigationCameraFollowing(true);
    setIsIdleCameraFollowing(true);
    search.setQuery('');
    search.resetResults();
    search.setSelectedCategoryId(undefined);
    setShortcutBeingSet(undefined);
    setSelectedResult(undefined);
    setRouteState({ type: 'idle' });
  };

  const handleSelectResult = (result: SearchResult) => {
    Keyboard.dismiss();
    search.setCategorySearchActive(false);
    search.invalidate();
    const interactionId = invalidatePlaceInteraction();
    planner.abort();
    setIsIdleCameraFollowing(false);
    setRouteState({ type: 'idle' });
    search.setQuery(result.name);
    search.resetResults();
    search.setSelectedCategoryId(undefined);
    setSelectedResult(result);
    if (shortcutBeingSet !== undefined) {
      if (shortcutBeingSet === 'home') setHomeDestination(result);
      else setWorkDestination(result);
      refreshDestinationCatalog();
      setShortcutBeingSet(undefined);
      haptics.success();
    }
    setSelectedPlaceSaved(isFavoriteDestination(result.id));
    cameraRef.current?.flyTo({
      center: [result.center.longitude, result.center.latitude],
      duration: 650,
      zoom: 16,
    });
    loadPlaceDetails(result, interactionId);
  };

  const handleCategoryPress = (category: ExploreCategory) => {
    if (!nearbySearchEnabled) {
      showNotice({
        message: 'Nearby place categories are not available at your current location yet.',
        title: 'Nearby search is unavailable here',
        tone: 'warning',
      });
      return;
    }
    Keyboard.dismiss();
    search.setCategorySearchActive(true);
    invalidatePlaceInteraction();
    planner.abort();
    setIsIdleCameraFollowing(false);
    setActiveTab('explore');
    setIsMoreCategoriesVisible(false);
    setShortcutBeingSet(undefined);
    search.setSelectedCategoryId(category.id);
    setSelectedResult(undefined);
    setRouteState({ type: 'idle' });
    search.setQuery(category.label);
    search.resetResults();
    exploreSheetRef.current?.snapTo(1);
    search.run(category.query, { category, fitResults: true, nearestFirst: true });
  };

  const beginShortcutSetup = (shortcut: 'home' | 'work') => {
    search.setCategorySearchActive(false);
    search.invalidate();
    setActiveTab('explore');
    setIsMoreCategoriesVisible(false);
    search.setSelectedCategoryId(undefined);
    setSelectedResult(undefined);
    setIsIdleCameraFollowing(false);
    search.setQuery('');
    search.resetResults();
    setShortcutBeingSet(shortcut);
  };

  const chooseSavedPlace = (place: SearchResult) => {
    setActiveTab('explore');
    handleSelectResult(place);
  };

  const handleShortcutPress = (shortcut: 'home' | 'work') => {
    const destination = destinationCatalog[shortcut];
    if (destination === undefined) {
      beginShortcutSetup(shortcut);
      return;
    }
    chooseSavedPlace(nativeDestinationToSearchResult(destination));
  };

  const handleSubmitSearch = () => {
    Keyboard.dismiss();
    const bounds = searchResultBounds(search.results);
    if (bounds === undefined) return;

    invalidatePlaceInteraction();
    planner.abort();
    setIsIdleCameraFollowing(false);
    setSelectedResult(undefined);
    setRouteState({ type: 'idle' });
    // Collapse to the map so the results can be explored where they are.
    exploreSheetRef.current?.snapTo(0);
    const onlyResult = search.results.at(0);
    if (search.results.length === 1 && onlyResult !== undefined) {
      cameraRef.current?.flyTo({
        center: [onlyResult.center.longitude, onlyResult.center.latitude],
        duration: 650,
        zoom: 15,
      });
      return;
    }
    cameraRef.current?.fitBounds(bounds, {
      duration: 700,
      padding: searchResultsCameraPadding(metrics, 0),
    });
  };

  const handleMapLongPress = (coordinate: Coordinate) => {
    if (routeState.type === 'navigating' || routeState.type === 'arrived') return;
    Keyboard.dismiss();
    invalidatePlaceInteraction();
    const destination = droppedPinResult(coordinate);
    search.setQuery('');
    search.resetResults();
    setSelectedResult(destination);
    haptics.impact();
    void planner.calculateRoute(destination);
  };

  const handleMapPress = async (point: [number, number], coordinate: Coordinate) => {
    const map = mapRef.current;
    if (!routeIsIdle || map === null) return;

    // Reserved once, before the first native hit-test await, so a newer interaction (another tap,
    // a search selection, or clearing the sheet) can never be overtaken by this tap resolving late.
    const interactionId = invalidatePlaceInteraction();
    const isCurrentInteraction = () => placeInteractionRef.current.isCurrent(interactionId);
    const hitBox: [[number, number], [number, number]] = [
      [point[0] - TAP_RADIUS, point[1] - TAP_RADIUS],
      [point[0] + TAP_RADIUS, point[1] + TAP_RADIUS],
    ];
    /** Rendered features in the tap box, or none while a layer is still loading. */
    const hitTest = async (layers: readonly string[]) => {
      try {
        return await map.queryRenderedFeatures(hitBox, { layers: [...layers] });
      } catch {
        return [];
      }
    };

    if (search.results.length > 0) {
      const resultId = renderedFeatureId(await hitTest(SEARCH_RESULT_LAYER_IDS));
      if (!isCurrentInteraction()) return;
      const result = search.results.find((candidate) => candidate.id === resultId);
      if (result !== undefined) {
        handleSelectResult(result);
        return;
      }
    }

    if (mapPreferences.showSafetyCameras) {
      const cameraFeatures = await hitTest(SAFETY_CAMERA_LAYER_IDS);
      if (!isCurrentInteraction()) return;
      const properties = cameraFeatures.at(0)?.properties;
      if (properties != null) {
        Keyboard.dismiss();
        setFeatureDetail({
          body: cameraDetailMessage(
            typeof properties.enforcement === 'string' ? properties.enforcement.split(',') : [],
            typeof properties.direction === 'string' ? properties.direction : undefined,
          ),
          eyebrow: 'Enforcement camera',
          icon: { android: 'photo_camera', ios: 'camera.fill' },
          title: typeof properties.location === 'string' ? properties.location : 'Camera',
        });
        return;
      }

      if (overlays.kelownaTrafficCameras.length > 0) {
        const cameraId = renderedFeatureId(await hitTest(TRAFFIC_CAMERA_LAYER_IDS));
        if (!isCurrentInteraction()) return;
        const camera = overlays.kelownaTrafficCameras.find(({ id }) => id === cameraId);
        if (camera !== undefined) {
          Keyboard.dismiss();
          setFeatureDetail({
            body: `${camera.caption}\n\nThis is a DriveBC traffic webcam, not an enforcement camera.`,
            eyebrow: 'Traffic webcam',
            icon: { android: 'videocam', ios: 'video.fill' },
            link: { label: 'View camera', url: camera.pageUrl },
            title: camera.name,
          });
          return;
        }
      }
    }

    if (mapPreferences.showRoadEvents && overlays.roadEventSnapshot !== undefined) {
      const eventId = renderedFeatureId(await hitTest(ROAD_EVENT_LAYER_IDS));
      if (!isCurrentInteraction()) return;
      const event = overlays.roadEvents.find((candidate) => candidate.id === eventId);
      if (event !== undefined) {
        Keyboard.dismiss();
        // Wave 2 seam: community reports are hit-tested here, beside official road events, and
        // open the same detail sheet with their own confirm/dismiss actions.
        setFeatureDetail({
          body: roadEventMessage(event),
          eyebrow: 'Road event',
          icon: { android: 'warning', ios: 'exclamationmark.triangle.fill' },
          title: event.title,
        });
        return;
      }
    }

    if (!mapPreferences.showPlaces) return;

    if (overlays.kelownaSafetyFacilities.length > 0) {
      const facilityId = renderedFeatureId(await hitTest(SAFETY_FACILITY_LAYER_IDS));
      if (!isCurrentInteraction()) return;
      const facility = overlays.kelownaSafetyFacilities.find(({ id }) => id === facilityId);
      if (facility !== undefined) {
        Keyboard.dismiss();
        setFeatureDetail({
          body: `${facility.address}\n${facility.phone}\n\nFixed public facility. This is not a live police location.`,
          eyebrow: 'RCMP facility',
          icon: { android: 'local_police', ios: 'building.2.fill' },
          link: { label: 'Official details', url: facility.pageUrl },
          title: facility.name,
        });
        return;
      }
    }

    const place = mapPlaceFromRenderedFeatures(await hitTest(MAP_PLACE_LAYER_IDS), coordinate);
    if (!isCurrentInteraction()) return;
    if (place === undefined) {
      setSelectedResult(undefined);
      return;
    }

    Keyboard.dismiss();
    search.setQuery('');
    search.resetResults();
    setSelectedResult(place);
    setIsIdleCameraFollowing(false);
    setSelectedPlaceSaved(isFavoriteDestination(place.id));
    loadPlaceDetails(place, interactionId);
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
    haptics.success();
  };

  const handlePlaceDirections = () => {
    if (selectedResult === undefined || !routeIsIdle) return;
    invalidatePlaceInteraction();
    recordRecentDestination(selectedResult);
    refreshDestinationCatalog();
    void planner.calculateRoute(selectedResult);
  };

  const handleFindParking = () => {
    if (selectedResult === undefined || !routeIsIdle) return;
    const parkingOrigin = selectedResult.center;
    if (!isSearchCoverageRegion(mapRegionForCoordinate(parkingOrigin))) {
      showNotice({
        message: 'Nearby parking search is not available for this location yet.',
        title: 'Parking search is unavailable here',
        tone: 'warning',
      });
      return;
    }
    const parkingCategory = exploreCategoryById('parking');
    Keyboard.dismiss();
    search.setCategorySearchActive(true);
    invalidatePlaceInteraction();
    setSelectedPlaceSaved(false);
    setSelectedResult(undefined);
    search.setSelectedCategoryId(parkingCategory?.id);
    search.setQuery(parkingCategory?.label ?? 'Parking');
    search.resetResults();
    search.run(parkingCategory?.query ?? 'parking', {
      fitResults: true,
      nearestFirst: true,
      proximityOrigin: parkingOrigin,
      ...(parkingCategory === undefined ? {} : { category: parkingCategory }),
    });
  };

  const openExternalUrl = (url: string) => {
    void Linking.openURL(url).catch(() => {
      console.warn('The external link could not be opened.');
    });
  };

  const handleToggleSaved = () => {
    if (selectedResult === undefined) return;
    const saved = toggleFavoriteDestination(selectedResult);
    setSelectedPlaceSaved(saved);
    refreshDestinationCatalog();
    if (saved) haptics.success();
    else haptics.selection();
  };

  const handleSharePlace = () => {
    if (selectedResult === undefined) return;
    void Share.share({ message: placeShareMessage(selectedResult), title: selectedResult.name });
  };

  const handleLocate = async () => {
    setIsIdleCameraFollowing(true);
    const coordinate = await location.locate();
    if (coordinate !== undefined && hasTransientDestination) {
      cameraRef.current?.flyTo({
        center: [coordinate.longitude, coordinate.latitude],
        duration: 750,
        zoom: 15,
      });
    }
  };

  // --- Route preview and navigation ---------------------------------------------------------

  const handleCancelRoute = () => {
    setPreviewDetent(undefined);
    invalidatePlaceInteraction();
    cameraAlerts.reset();
    stopNavigationAnnouncements();
    planner.abort();
    setIsNavigationCameraFollowing(true);
    setIsIdleCameraFollowing(true);
    setRouteState({ type: 'idle' });
    setSelectedResult(undefined);
    search.setQuery('');
    if (userCoordinate === undefined) {
      cameraRef.current?.flyTo({ center: CANADA_CENTER, duration: 650, zoom: 3.2 });
    }
  };

  const handleSelectRoute = (route: RouteAlternative) => {
    if (routeState.type !== 'preview') return;
    if (route.id !== routeState.selectedRouteId) haptics.selection();
    setRouteState({ ...routeState, selectedRouteId: route.id });
    fitRoute(route, routeState.previewOrigin !== undefined);
  };

  const handleToggleRoutePreference = (preference: keyof RoutePreferences) => {
    if (routeState.type !== 'preview') return;
    const preferences = {
      ...planner.routePreferences,
      [preference]: !planner.routePreferences[preference],
    };
    haptics.selection();
    planner.updateRoutePreferences(preferences);
    void planner.calculateRoute(
      routeState.destination,
      preferences,
      routeState.previewOrigin,
      routeState.waypoints,
    );
  };

  const handleApplyRouteStops = (destinations: SearchResult[]) => {
    const destination = destinations.at(-1);
    if (routeState.type !== 'preview' || destination === undefined) return;
    setIsRouteStopsVisible(false);
    void planner.calculateRoute(
      destination,
      planner.routePreferences,
      routeState.previewOrigin,
      destinations.slice(0, -1),
    );
  };

  const handleRetryRoute = () => {
    if (routeState.type !== 'error' && routeState.type !== 'loading') return;
    void planner.calculateRoute(
      routeState.destination,
      planner.routePreferences,
      routeState.previewOrigin,
      routeState.waypoints,
    );
  };

  const handlePreviewSupportedRoute = () => {
    if (routeState.type !== 'error' && routeState.type !== 'loading') return;
    void planner.calculateRoute(
      routeState.destination,
      planner.routePreferences,
      CALGARY_TOWER_ROUTE_ORIGIN,
      routeState.waypoints,
    );
  };

  const handleUseCurrentLocation = () => {
    if (routeState.type !== 'preview') return;
    void planner.calculateRoute(
      routeState.destination,
      planner.routePreferences,
      undefined,
      routeState.waypoints,
    );
  };

  const selectedRoute = selectedRouteOf(routeState);

  const handleStartNavigation = () => {
    if (
      routeState.type !== 'preview' ||
      routeState.previewOrigin !== undefined ||
      selectedRoute === undefined
    ) {
      return;
    }
    cameraAlerts.reset();
    resetTrip();
    setPreviewDetent(undefined);
    const snapshot = setNavigationRoute(
      selectedRoute,
      routeState.destination,
      planner.routePreferences,
      planner.routeSource?.id,
      selectedRoute.traffic,
      routeState.waypoints,
    );
    session.adoptSnapshot(snapshot);
    setRouteState({
      destination: routeState.destination,
      route: selectedRoute,
      routes: routeState.routes,
      type: 'navigating',
      waypoints: routeState.waypoints,
    });
    haptics.success();
  };

  const handleShareEta = () => {
    if (routeState.type !== 'navigating' || remainingRoute === undefined) return;
    void Share.share({
      message: buildEtaShareMessage(
        routeState.destination.name,
        remainingRoute.durationSeconds,
        remainingRoute.distanceMeters,
      ),
      title: `ETA to ${routeState.destination.name}`,
    });
  };

  const reportCoordinate = navigationSnapshot?.matchedCoordinate ?? userCoordinate;

  const handleOpenRoadReport = () => {
    if (reportCoordinate === undefined) {
      showNotice({
        message: 'Wait for your location before recording a report.',
        title: 'Location unavailable',
        tone: 'warning',
      });
      return;
    }
    setIsRoadReportVisible(true);
  };

  /**
   * Wave 2 seam: this is the one place a road report is committed. Sharing reports replaces the
   * local draft write with the attested submit call and keeps the draft as the offline fallback;
   * the notice copy must change in the same commit, because it states what happens to a report.
   */
  const handleSaveRoadReport = async (type: RoadReportType) => {
    if (reportCoordinate === undefined || isRoadReportSaving) return;
    setIsRoadReportSaving(true);
    try {
      const currentReports = await loadRoadReportDrafts();
      await saveRoadReportDrafts([
        createRoadReportDraft(type, reportCoordinate),
        ...currentReports,
      ]);
      setIsRoadReportVisible(false);
      haptics.success();
      showNotice({
        message: 'This report stays on this phone and is not shown to other drivers yet.',
        title: 'Saved for testing',
        tone: 'info',
      });
    } catch {
      haptics.error();
      showNotice({
        message: 'The report could not be stored on this phone.',
        title: 'Report not saved',
        tone: 'danger',
      });
    } finally {
      setIsRoadReportSaving(false);
    }
  };

  const endTrip = () => {
    clearCarPlayTrip();
    resetTrip();
    setIsIdleCameraFollowing(true);
    setSelectedResult(undefined);
    search.setQuery('');
    setRouteState({ type: 'idle' });
  };

  const handleEndNavigation = () => {
    if (routeState.type !== 'navigating') return;
    cameraAlerts.dismiss();
    endTrip();
  };

  const handleFinishArrival = () => {
    if (routeState.type !== 'arrived') return;
    cameraAlerts.reset();
    endTrip();
  };

  const handleChooseAudioMode = (mode: NavigationAudioMode) => {
    setNavigationAudioMode(mode);
    setNavigationAudioModeState(mode);
    haptics.selection();
    setIsAudioModeVisible(false);
  };

  const handleToggleOrientation = () => {
    haptics.selection();
    updatePreferences({
      ...mapPreferences,
      navigationOrientation: toggleNavigationMapOrientation(mapPreferences.navigationOrientation),
    });
  };

  const handleSelectTab = (tab: AppTab) => {
    Keyboard.dismiss();
    if (tab !== 'explore') {
      search.setCategorySearchActive(false);
      search.invalidate();
      setShortcutBeingSet(undefined);
    }
    setActiveTab(tab);
    if (tab === 'saved') refreshDestinationCatalog();
  };

  // --- CarPlay ------------------------------------------------------------------------------

  const handleCarPlayNavigationEnded = useEffectEvent(() => {
    if (routeState.type === 'arrived') handleFinishArrival();
    else handleEndNavigation();
  });

  const handleCarPlayStateChanged = useEffectEvent((connected: boolean) => {
    const justConnected = connected && !carPlayConnected;
    setCarPlayConnected(connected);
    // The connected handset keeps planning controls, so this policy must retain its in-flight
    // route rather than discarding work the driver can still finish on the phone.
    if (justConnected && releasesPhoneRouteOnCarPlayConnect(routeState.type)) handleCancelRoute();
  });

  const adoptRoutePreferences = planner.setRoutePreferences;
  useEffect(() => {
    const initialPreferences = getNavigationPreferences();
    setCarPlayConnected(getCarPlayState().connected);
    setNavigationAudioModeState(initialPreferences.audioMode);
    adoptRoutePreferences(initialPreferences.routePreferences);
    const stateSubscription = observeCarPlayState((state) => {
      handleCarPlayStateChanged(state.connected);
    });
    const preferencesSubscription = observeNavigationPreferences((preferences) => {
      setNavigationAudioModeState(preferences.audioMode);
      adoptRoutePreferences(preferences.routePreferences);
    });
    const endedSubscription = observeCarPlayNavigationEnded(() => {
      handleCarPlayNavigationEnded();
    });
    return () => {
      stateSubscription.remove();
      preferencesSubscription.remove();
      endedSubscription.remove();
    };
  }, [adoptRoutePreferences]);

  // --- Derived view state -------------------------------------------------------------------

  const alternateRoutes = useMemo(
    () =>
      routeState.type === 'preview'
        ? routeState.routes.filter((route) => route.id !== routeState.selectedRouteId)
        : [],
    [routeState],
  );
  const routeProgress = navigationSnapshot?.routeProgress ?? 0;
  const matchedCoordinate = navigationSnapshot?.matchedCoordinate;
  const displayedSelectedRoute = useMemo(() => {
    if (selectedRoute === undefined || routeState.type === 'arrived') return undefined;
    if (routeState.type !== 'navigating') return selectedRoute;
    return {
      ...selectedRoute,
      geometry: getRemainingRouteGeometry(selectedRoute, routeProgress, matchedCoordinate),
    };
  }, [matchedCoordinate, routeProgress, routeState.type, selectedRoute]);
  const vehicleMatchStatus: VehicleMatchStatus =
    navigationSnapshot?.rawCoordinate === undefined
      ? 'acquiring'
      : navigationSnapshot.isOffRoute
        ? 'off-route'
        : 'matched';
  const vehicleCoordinate = matchedCoordinate ?? userCoordinate;
  const navigationBearing =
    routeState.type === 'navigating'
      ? navigationCameraBearing(
          mapPreferences.navigationOrientation,
          navigationSnapshot?.matchedCourseDegrees,
          userHeading,
        )
      : undefined;
  const placeSheetVisible = routeIsIdle && selectedResult !== undefined;
  const appShellVisible = routeIsIdle && selectedResult === undefined;

  // Handlers that reach memoised map chrome keep one identity, so the canvas and the floating
  // controls re-render for new data only, never because a closure was rebuilt.
  const stable = {
    closeAbout: useStableCallback(() => {
      setIsAboutVisible(false);
    }),
    locate: useStableCallback(() => {
      void handleLocate();
    }),
    onMapError: useStableCallback(setMapError),
    onMapLongPress: useStableCallback(handleMapLongPress),
    onMapPress: useStableCallback((point: [number, number], coordinate: Coordinate) => {
      void handleMapPress(point, coordinate);
    }),
    openAbout: useStableCallback(() => {
      setIsAboutVisible(true);
    }),
    openMapPreferences: useStableCallback(() => {
      setIsMapPreferencesVisible(true);
    }),
    openRoadReport: useStableCallback(handleOpenRoadReport),
    recenter: useStableCallback(() => {
      setIsNavigationCameraFollowing(true);
    }),
    showAttribution: useStableCallback(() => {
      void mapRef.current?.showAttribution();
    }),
    toggleOrientation: useStableCallback(handleToggleOrientation),
  };

  return {
    about: {
      close: stable.closeAbout,
      open: stable.openAbout,
      visible: isAboutVisible,
    },
    activeTab,
    apiConnection,
    appShellVisible,
    audioMode: {
      choose: handleChooseAudioMode,
      close: () => {
        setIsAudioModeVisible(false);
      },
      mode: navigationAudioMode,
      open: () => {
        setIsAudioModeVisible(true);
      },
      visible: isAudioModeVisible,
    },
    camera: {
      idleCenter: idleCameraCenter,
      idleShouldFollow: idleCameraShouldFollow,
      isNavigationFollowing: isNavigationCameraFollowing,
      matchedCoordinate,
      navigationBearing,
      onChange: handleCameraChange,
      recenter: stable.recenter,
      routeProgress,
      vehicleCoordinate,
    },
    cameraAlert: cameraAlerts.alert,
    cameraAnnouncementCount: cameraAlerts.announcementCount,
    cameraRef,
    carPlayGuidance,
    categories: {
      close: () => {
        setIsMoreCategoriesVisible(false);
      },
      onPress: handleCategoryPress,
      open: () => {
        setIsMoreCategoriesVisible(true);
      },
      visible: isMoreCategoriesVisible,
    },
    coverageName,
    darkMap,
    destinationCatalog,
    exploreSheetRef,
    featureDetail,
    googlePlaceRatingAvailable,
    guidance: {
      remainingRoute,
      remainingStep,
      rerouteCount: session.rerouteCount,
      routeStatus: session.routeStatus,
      step: guidanceStep,
      upcomingManeuvers,
      vehicleMatchStatus,
    },
    location: {
      deviceHeadingStore: location.deviceHeadingStore,
      locate: stable.locate,
      locationState,
      mapRegion,
      nearbySearchEnabled,
      userCoordinate,
      userHeading,
    },
    mapBearing,
    mapError,
    mapPreferences,
    mapPreferencesSheet: {
      close: () => {
        setIsMapPreferencesVisible(false);
      },
      open: stable.openMapPreferences,
      visible: isMapPreferencesVisible,
    },
    mapRef,
    mapStyle,
    metrics,
    notice,
    onApplyRouteStops: handleApplyRouteStops,
    onBeginShortcutSetup: beginShortcutSetup,
    onCancelRoute: handleCancelRoute,
    onChangeQuery: handleChangeQuery,
    onChooseSavedPlace: chooseSavedPlace,
    onClearDestinationHistory: handleClearDestinationHistory,
    onClearRecents: () => {
      clearRecentDestinations();
      refreshDestinationCatalog();
    },
    onClearSearch: handleClear,
    onCloseFeatureDetail: () => {
      setFeatureDetail(undefined);
    },
    onClosePlace: handleClosePlace,
    onDismissNotice: () => {
      clearTimeout(noticeTimeoutRef.current);
      setNotice(undefined);
    },
    onEndNavigation: handleEndNavigation,
    onFindParking: handleFindParking,
    onFinishArrival: handleFinishArrival,
    onMapError: stable.onMapError,
    onMapLongPress: stable.onMapLongPress,
    onMapPress: stable.onMapPress,
    onShowAttribution: stable.showAttribution,
    onOpenExternalUrl: openExternalUrl,
    onPlaceDirections: handlePlaceDirections,
    onPreviewSupportedRoute: handlePreviewSupportedRoute,
    onRemoveShortcut: (shortcut: 'home' | 'work') => {
      if (shortcut === 'home') setHomeDestination(undefined);
      else setWorkDestination(undefined);
      refreshDestinationCatalog();
    },
    onRetryRoute: handleRetryRoute,
    onSelectResult: handleSelectResult,
    onSelectRoute: handleSelectRoute,
    onSelectTab: handleSelectTab,
    onShareEta: handleShareEta,
    onSharePlace: handleSharePlace,
    onShortcutPress: handleShortcutPress,
    onStartNavigation: handleStartNavigation,
    onSubmitSearch: handleSubmitSearch,
    onToggleOrientation: stable.toggleOrientation,
    onToggleRoutePreference: handleToggleRoutePreference,
    onToggleSaved: handleToggleSaved,
    onUpdateMapPreferences: updatePreferences,
    onUseCurrentLocation: handleUseCurrentLocation,
    overlays,
    phoneMapVisible,
    placeDetailsLoading,
    placeSheetVisible,
    roadReport: {
      close: () => {
        if (!isRoadReportSaving) setIsRoadReportVisible(false);
      },
      open: stable.openRoadReport,
      save: (type: RoadReportType) => {
        void handleSaveRoadReport(type);
      },
      saving: isRoadReportSaving,
      visible: isRoadReportVisible,
    },
    route: {
      alternateRoutes,
      onPreviewDetentChange: setPreviewDetent,
      previewDetent,
      displayedSelectedRoute,
      preferences: planner.routePreferences,
      selectedRoute,
      setVehicleStyle: planner.setVehicleStyle,
      source: planner.routeSource,
      state: routeState,
      vehicleStyle: planner.vehicleStyle,
    },
    routeStops: {
      close: () => {
        setIsRouteStopsVisible(false);
      },
      open: () => {
        setIsRouteStopsVisible(true);
      },
      visible: isRouteStopsVisible,
    },
    search,
    selectedPlaceSaved,
    selectedResult,
    sheetPosition,
    shortcutBeingSet,
    surface,
    zoomStepStore,
  };
}

export type MapController = ReturnType<typeof useMapController>;
