import type { CameraRef, MapRef } from '@maplibre/maplibre-react-native';
import {
  isCoordinateServed,
  type Coordinate,
  type RouteAlternativeV2,
  type RoutePreferences,
  type SearchResult,
  type ServerConfig,
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

import {
  COMMUNITY_REPORT_LAYER_IDS,
  type CommunityNotice,
  communityReportDetail,
  communityReportSymbol,
  type CommunityReportAction,
  type GeographicBox,
  privateDraftNotice,
  reportFetchBounds,
  snapViewBox,
} from '@/features/community/community';
import type { CommunitySettingsProps } from '@/features/community/community-sheets';
import { useCommunityGuidance } from '@/features/community/community-guidance';
import {
  trafficFlowFeatures,
  trafficFlowQuery,
  trafficFlowStatus,
} from '@/features/community/traffic-flow';
import { useCommunity } from '@/features/community/use-community';
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
  congestionFeatures,
  droppedPinResult,
  itemsNearRoute,
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
import {
  GUIDANCE_BANNER_HEIGHT,
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
  acceptRerouteProposal,
  clearRecentDestinations,
  declineRerouteProposal,
  getCarPlayState,
  getDestinationCatalog,
  getNavigationPreferences,
  isFavoriteDestination,
  isGooglePlaceRatingAvailable,
  type NativeCommunityReport,
  type NativeDestinationCatalog,
  nativeDestinationToSearchResult,
  observeCarPlayNavigationEnded,
  observeCarPlayState,
  observeNavigationPreferences,
  recordRecentDestination,
  setHomeDestination,
  setNavigationAudioMode,
  setNavigationRerouteMode,
  setNavigationRoute,
  setNavigationSpeedingWarning,
  setWorkDestination,
  stopNavigationAnnouncements,
  toggleFavoriteDestination,
} from '@/features/navigation/native-navigation';
import {
  DEFAULT_GUIDANCE_SETTINGS,
  type GuidanceSettings,
  guidanceSettingsFromNative,
  speedReadout,
} from '@/features/navigation/guidance-settings';
import { laneStrip } from '@/features/navigation/lane-guidance';
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
const CAMERA_ROUTE_CORRIDOR_METERS = 60;
const NOTICE_VISIBLE_MS = 5_000;

/** Details of a tapped overlay feature, shown in the map-feature sheet. */
export interface MapFeatureDetail {
  /** Why the actions are what they are (driver reports only). */
  actionHint?: string | undefined;
  /** Driver reports: answer or withdraw. */
  actions?: readonly CommunityReportAction[];
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
  const guidanceSettingsQueuedRef = useRef(false);
  // Measured height of the maneuver banner; it grows when an instruction wraps.
  const [guidanceBannerHeight, setGuidanceBannerHeight] = useState(GUIDANCE_BANNER_HEIGHT);
  // Where the driver left the route preview sheet, kept across the re-plan that remounts it.
  const [previewDetent, setPreviewDetent] = useState<number>();

  // Camera motion lives outside React state. See the hook comment.
  const mapBearing = useSharedValue(0);
  const [zoomStepStore] = useState(() => createValueStore<number | undefined>(undefined));
  /** Distance from the bottom of the screen to the top of the active sheet, on the UI thread. */
  const sheetPosition = useSharedValue(0);

  const [apiConnection, setApiConnection] = useState<ApiConnectionState>('connecting');
  const [serverConfig, setServerConfig] = useState<ServerConfig>();
  const coverageName = serverConfig?.coverage.displayName ?? 'Loading route coverage';
  const [isAppActive, setIsAppActive] = useState(() => AppState.currentState === 'active');
  const [activeTab, setActiveTab] = useState<AppTab>('explore');
  const [mapError, setMapError] = useState(false);
  const [isAboutVisible, setIsAboutVisible] = useState(false);
  const [isMapPreferencesVisible, setIsMapPreferencesVisible] = useState(false);
  const [isMoreCategoriesVisible, setIsMoreCategoriesVisible] = useState(false);
  const [isRoadReportSaving, setIsRoadReportSaving] = useState(false);
  const [isRoadReportVisible, setIsRoadReportVisible] = useState(false);
  const [isRouteStopsVisible, setIsRouteStopsVisible] = useState(false);
  const [isGuidanceSettingsVisible, setIsGuidanceSettingsVisible] = useState(false);
  const [featureDetail, setFeatureDetail] = useState<MapFeatureDetail>();
  // A tapped driver report; its detail is rebuilt from live state so counts stay current.
  const [selectedCommunityReport, setSelectedCommunityReport] = useState<NativeCommunityReport>();
  const [communityActionBusy, setCommunityActionBusy] = useState<CommunityReportAction>();
  const [stillThereBusy, setStillThereBusy] = useState(false);
  // A report near Home/Work or a trip end, waiting for "Keep it private" or "Share anyway".
  const [nearPrivateReport, setNearPrivateReport] = useState<{
    coordinate: Coordinate;
    type: RoadReportType;
  }>();
  // The visible area on the 0.05° grid; changes only when the view crosses a grid line.
  const [viewBox, setViewBox] = useState<GeographicBox>();
  const [notice, setNotice] = useState<MapNotice>();
  const [placeDetailsLoading, setPlaceDetailsLoading] = useState(false);
  const [googlePlaceRatingAvailable] = useState(() => isGooglePlaceRatingAvailable());
  const [selectedPlaceSaved, setSelectedPlaceSaved] = useState(false);
  const [selectedResult, setSelectedResult] = useState<SearchResult>();
  const [shortcutBeingSet, setShortcutBeingSet] = useState<'home' | 'work'>();
  const [destinationCatalog, setDestinationCatalog] = useState<NativeDestinationCatalog>(() =>
    getDestinationCatalog(),
  );
  const [guidanceSettings, setGuidanceSettings] = useState<GuidanceSettings>(() =>
    guidanceSettingsFromNative(DEFAULT_GUIDANCE_SETTINGS, getNavigationPreferences()),
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

  const location = useUserLocation(serverConfig?.coverage);
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
    serverConfig,
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
  const guidanceLanes = guidanceStep?.lanes;
  const guidanceLaneStrip = useMemo(() => laneStrip(guidanceLanes), [guidanceLanes]);
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

  const serverLiveTraffic = serverConfig?.capabilities.liveTraffic;
  const trafficLayerWanted =
    serverLiveTraffic === true && mapPreferences.showTraffic && phoneMapVisible;
  const flowQuery = trafficLayerWanted ? trafficFlowQuery(viewBox) : undefined;
  const overlays = useOverlayData({
    inTorontoCameraBounds: location.inTorontoCameraBounds,
    mapRegion,
    showRoadEvents: mapPreferences.showRoadEvents,
    trafficFlowQuery: flowQuery,
  });

  const community = useCommunity({
    appActive: isAppActive,
    fetchBounds: phoneMapVisible ? reportFetchBounds(viewBox) : undefined,
    serverLiveTraffic,
    showReports: mapPreferences.showCommunityReports,
  });
  const sharesRoadReports = community.state?.preferences.sharesRoadReports === true;

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

  const cameraAlerts = useSafetyCameraAlert(
    routeState.type === 'navigating' ? navigationSnapshot : undefined,
  );

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

  /** Runs when the camera settles. State changes only when the view crosses a grid line. */
  const handleRegionDidChange = useStableCallback(
    (bounds: [west: number, south: number, east: number, north: number]) => {
      const next = snapViewBox(bounds);
      setViewBox((current) =>
        current?.west === next?.west &&
        current?.south === next?.south &&
        current?.east === next?.east &&
        current?.north === next?.north
          ? current
          : next,
      );
    },
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

  function fitRoute(route: RouteAlternativeV2, demoOrigin: boolean) {
    cameraRef.current?.fitBounds(routeBounds(route), {
      // A preview is read north-up and flat, whatever the last trip left the camera at.
      bearing: 0,
      duration: 750,
      pitch: 0,
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
    void fetchAppConfig({ signal: controller.signal })
      .then((config) => {
        setApiConnection('online');
        setServerConfig(config);
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
        message: `Nearby place categories cover ${coverageName}. Your current location is outside that area.`,
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

    if (community.reports.length > 0) {
      const reportId = renderedFeatureId(await hitTest(COMMUNITY_REPORT_LAYER_IDS));
      if (!isCurrentInteraction()) return;
      const report = community.reports.find((candidate) => candidate.id === reportId);
      if (report !== undefined) {
        Keyboard.dismiss();
        setSelectedCommunityReport(report);
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
    if (!isCoordinateServed(serverConfig?.coverage, parkingOrigin)) {
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

  const handleSelectRoute = (route: RouteAlternativeV2) => {
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
      selectedRoute.traffic === undefined && selectedRoute.congestion === undefined
        ? undefined
        : planner.routeSource?.trafficSource?.id,
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

  const closeRoadReport = () => {
    setIsRoadReportVisible(false);
    setNearPrivateReport(undefined);
  };

  /** The private draft: the only path before sharing existed, and the fallback after it. */
  const storeRoadReportDraft = async (
    type: RoadReportType,
    coordinate: Coordinate,
    notice: CommunityNotice,
  ) => {
    try {
      const currentReports = await loadRoadReportDrafts();
      await saveRoadReportDrafts([createRoadReportDraft(type, coordinate), ...currentReports]);
      closeRoadReport();
      haptics.success();
      showNotice(notice);
    } catch {
      haptics.error();
      showNotice({
        message: 'The report could not be stored on this phone.',
        title: 'Report not saved',
        tone: 'danger',
      });
    }
  };

  /**
   * The one place a road report is committed. With "Share road reports" on (and the server and
   * device able to share), it goes to the native community service; near a private place it
   * waits for an explicit choice; every other outcome keeps it as a private draft.
   */
  const commitRoadReport = async (
    type: RoadReportType,
    coordinate: Coordinate,
    confirmNearPrivatePlace: boolean,
  ) => {
    if (isRoadReportSaving) return;
    setIsRoadReportSaving(true);
    try {
      if (community.availability.reportSharing !== 'live' || !sharesRoadReports) {
        await storeRoadReportDraft(
          type,
          coordinate,
          privateDraftNotice(community.availability.reportSharing),
        );
        return;
      }
      const outcome = await community.submit(type, coordinate, {
        confirmNearPrivatePlace,
        heading:
          routeState.type === 'navigating' ? navigationSnapshot?.matchedCourseDegrees : undefined,
      });
      if (outcome.kind === 'confirm-near-private-place') {
        haptics.warning();
        setNearPrivateReport({ coordinate, type });
        return;
      }
      if (outcome.kind === 'shared') {
        closeRoadReport();
        haptics.success();
        showNotice(outcome.notice);
        return;
      }
      await storeRoadReportDraft(type, coordinate, outcome.notice);
    } finally {
      setIsRoadReportSaving(false);
    }
  };

  const handleSaveRoadReport = (type: RoadReportType) => {
    if (reportCoordinate === undefined) return;
    void commitRoadReport(type, reportCoordinate, false);
  };

  const handleKeepReportPrivate = () => {
    if (nearPrivateReport === undefined || isRoadReportSaving) return;
    setIsRoadReportSaving(true);
    void storeRoadReportDraft(
      nearPrivateReport.type,
      nearPrivateReport.coordinate,
      privateDraftNotice(community.availability.reportSharing),
    ).finally(() => {
      setIsRoadReportSaving(false);
    });
  };

  const handleShareReportAnyway = () => {
    if (nearPrivateReport === undefined) return;
    void commitRoadReport(nearPrivateReport.type, nearPrivateReport.coordinate, true);
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
    cameraAlerts.reset();
    endTrip();
  };

  const handleFinishArrival = () => {
    if (routeState.type !== 'arrived') return;
    cameraAlerts.reset();
    endTrip();
  };

  /** Applies changed guidance settings to the navigation core, which shares them with CarPlay. */
  const handleChangeGuidanceSettings = (next: GuidanceSettings) => {
    if (next.audioMode !== guidanceSettings.audioMode) setNavigationAudioMode(next.audioMode);
    if (next.rerouteMode !== guidanceSettings.rerouteMode) {
      setNavigationRerouteMode(next.rerouteMode);
    }
    if (
      next.speedingToleranceKph !== guidanceSettings.speedingToleranceKph ||
      next.speedingAudibleWarning !== guidanceSettings.speedingAudibleWarning
    ) {
      setNavigationSpeedingWarning(next.speedingToleranceKph, next.speedingAudibleWarning);
    }
    setGuidanceSettings(next);
  };

  const rerouteProposal =
    routeState.type === 'navigating' ? navigationSnapshot?.rerouteProposal : undefined;
  const rerouteProposalId = rerouteProposal?.id;
  useEffect(() => {
    // An offer needs a decision while driving: make sure it is felt as well as seen.
    if (rerouteProposalId !== undefined) haptics.warning();
  }, [rerouteProposalId]);
  const handleAcceptReroute = () => {
    if (rerouteProposalId === undefined) return;
    if (acceptRerouteProposal(rerouteProposalId)) haptics.success();
  };
  const handleKeepRoute = () => {
    if (rerouteProposalId === undefined) return;
    declineRerouteProposal(rerouteProposalId);
    haptics.selection();
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
    setGuidanceSettings((current) => guidanceSettingsFromNative(current, initialPreferences));
    adoptRoutePreferences(initialPreferences.routePreferences);
    const stateSubscription = observeCarPlayState((state) => {
      handleCarPlayStateChanged(state.connected);
    });
    const preferencesSubscription = observeNavigationPreferences((preferences) => {
      setGuidanceSettings((current) => guidanceSettingsFromNative(current, preferences));
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
  // Congestion is drawn from the full route geometry it is aligned to, minus the road driven.
  const selectedRouteCongestion = useMemo(
    () =>
      selectedRoute === undefined || routeState.type === 'arrived'
        ? undefined
        : congestionFeatures(selectedRoute, routeState.type === 'navigating' ? routeProgress : 0),
    [routeProgress, routeState.type, selectedRoute],
  );
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
  // While a route is being planned or previewed the map is at city zoom: draw only the cameras
  // the selected route passes, so the line stays readable.
  const planningRoute = routeState.type === 'preview' ? selectedRoute : undefined;
  const hidesCameras = routeState.type === 'loading' || routeState.type === 'error';
  const allSafetyCameras = overlays.safetyCameras;
  const visibleSafetyCameras = useMemo(
    () =>
      hidesCameras
        ? []
        : planningRoute === undefined
          ? allSafetyCameras
          : itemsNearRoute(allSafetyCameras, planningRoute, CAMERA_ROUTE_CORRIDOR_METERS),
    [allSafetyCameras, hidesCameras, planningRoute],
  );
  const placeSheetVisible = routeIsIdle && selectedResult !== undefined;
  const appShellVisible = routeIsIdle && selectedResult === undefined;

  // --- Community reports and traffic --------------------------------------------------------

  // The tapped report as the bridge knows it now; it closes if the report ends.
  const liveSelectedReport =
    selectedCommunityReport === undefined
      ? undefined
      : community.state?.reports.find((report) => report.id === selectedCommunityReport.id);
  const communityFeatureDetail: MapFeatureDetail | undefined = (() => {
    const report = liveSelectedReport ?? selectedCommunityReport;
    if (report === undefined) return undefined;
    const detail = communityReportDetail(report, {
      answered: community.answeredIds.has(report.id),
      nowMs: Date.now(),
      reportSharing: community.availability.reportSharing,
      sharesRoadReports,
    });
    return {
      actionHint: detail.hint,
      actions: detail.actions,
      body: detail.body,
      eyebrow: detail.eyebrow,
      icon: communityReportSymbol(report.type),
      title: detail.title,
    };
  })();

  const handleCommunityReportAction = async (action: CommunityReportAction) => {
    const report = selectedCommunityReport;
    if (report === undefined || communityActionBusy !== undefined) return;
    setCommunityActionBusy(action);
    try {
      const notice =
        action === 'withdraw'
          ? await community.withdraw(report.id)
          : await community.vote(report.id, action, userCoordinate);
      if (notice.tone === 'info') haptics.success();
      else haptics.warning();
      setSelectedCommunityReport(undefined);
      showNotice(notice);
    } finally {
      setCommunityActionBusy(undefined);
    }
  };

  const distanceToManeuverMeters =
    routeState.type === 'navigating'
      ? (nativeGuidance?.distanceToManeuverMeters ?? remainingStep?.distanceMeters)
      : undefined;
  const communityGuidance = useCommunityGuidance({
    competingPrompt: rerouteProposal !== undefined || cameraAlerts.alert !== undefined,
    distanceToManeuverMeters,
    onDismissStillThere: community.dismissStillThere,
    reportSharing: community.availability.reportSharing,
    sharesRoadReports,
    snapshot: routeState.type === 'navigating' ? navigationSnapshot : undefined,
  });
  const handleStillThereAnswer = async (vote: 'not-present' | 'present') => {
    const prompt = communityGuidance.stillThere;
    if (prompt === undefined || stillThereBusy) return;
    setStillThereBusy(true);
    try {
      const notice = await community.vote(prompt.reportId, vote);
      communityGuidance.resolveStillThere();
      if (notice.tone === 'info') haptics.success();
      else haptics.warning();
      showNotice(notice);
    } finally {
      setStillThereBusy(false);
    }
  };

  const trafficFlowData = useMemo(
    () => trafficFlowFeatures(overlays.trafficFlow),
    [overlays.trafficFlow],
  );
  const trafficStatus = trafficLayerWanted
    ? trafficFlowStatus({
        failed: overlays.trafficFlowFailed,
        response: overlays.trafficFlow,
        tooWide: viewBox !== undefined && flowQuery === undefined,
      })
    : undefined;
  // Traffic is drawn beneath the basemap's labels when no route is on the map.
  const basemapLabelLayerId =
    typeof mapStyle === 'string'
      ? undefined
      : mapStyle.layers.find((layer) => layer.type === 'symbol')?.id;

  const communitySettings: Omit<
    CommunitySettingsProps,
    'onSetShowReports' | 'onSetShowTraffic' | 'showReports' | 'showTraffic'
  > = {
    availability: community.availability,
    hasIdentity: community.state?.hasIdentity === true,
    onResetIdentity: async () => {
      const notice = await community.resetIdentity();
      if (notice.tone === 'info') haptics.success();
      else haptics.warning();
      showNotice(notice);
    },
    onSetShareRoadReports: community.setShareRoadReports,
    onSetShareTrafficSpeeds: community.setShareTrafficSpeeds,
    sharesRoadReports,
    sharesTrafficSpeeds: community.state?.preferences.sharesTrafficSpeeds === true,
    trafficSharing: community.state?.trafficSharing,
  };

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
    onRegionDidChange: handleRegionDidChange,
    openAbout: useStableCallback(() => {
      setIsAboutVisible(true);
    }),
    openGuidanceSettings: useStableCallback(() => {
      // From map appearance, guidance settings opens once that sheet has finished closing.
      if (isMapPreferencesVisible) {
        guidanceSettingsQueuedRef.current = true;
        setIsMapPreferencesVisible(false);
      } else {
        setIsGuidanceSettingsVisible(true);
      }
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
    camera: {
      idleCenter: idleCameraCenter,
      idleShouldFollow: idleCameraShouldFollow,
      isNavigationFollowing: isNavigationCameraFollowing,
      navigationBearing,
      onChange: handleCameraChange,
      recenter: stable.recenter,
      vehicleCoordinate,
    },
    basemapLabelLayerId,
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
    community: {
      reports: community.reports,
      settings: communitySettings,
      stillThere: communityGuidance.stillThere,
      stillThereBusy,
      reportAhead: communityGuidance.reportAhead,
      onAnswerStillThere: (vote: 'not-present' | 'present') => {
        void handleStillThereAnswer(vote);
      },
      onDismissStillThere: () => {
        const prompt = communityGuidance.stillThere;
        if (prompt === undefined) return;
        communityGuidance.resolveStillThere();
        community.dismissStillThere(prompt.reportId);
      },
      trafficFlow: trafficFlowData,
      trafficStatus,
    },
    communityActionBusy,
    coverageName,
    darkMap,
    destinationCatalog,
    exploreSheetRef,
    featureDetail: communityFeatureDetail ?? featureDetail,
    googlePlaceRatingAvailable,
    guidanceSettings: {
      change: handleChangeGuidanceSettings,
      close: () => {
        setIsGuidanceSettingsVisible(false);
      },
      open: stable.openGuidanceSettings,
      settings: guidanceSettings,
      visible: isGuidanceSettingsVisible,
    },
    guidance: {
      bannerHeight: guidanceBannerHeight,
      onBannerHeightChange: setGuidanceBannerHeight,
      currentRoadName: navigationSnapshot?.currentRoadName,
      onAcceptReroute: handleAcceptReroute,
      onKeepRoute: handleKeepRoute,
      positionEstimated: navigationSnapshot?.isDeadReckoning === true,
      remainingRoute,
      remainingStep,
      rerouteCount: session.rerouteCount,
      rerouteProposal,
      routeStatus: session.routeStatus,
      speed:
        navigationSnapshot === undefined || routeState.type !== 'navigating'
          ? undefined
          : speedReadout(navigationSnapshot),
      laneStrip: guidanceLaneStrip,
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
      onClosed: () => {
        if (!guidanceSettingsQueuedRef.current) return;
        guidanceSettingsQueuedRef.current = false;
        setIsGuidanceSettingsVisible(true);
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
      setSelectedCommunityReport(undefined);
    },
    onCommunityReportAction: (action: CommunityReportAction) => {
      void handleCommunityReportAction(action);
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
    onRegionDidChange: stable.onRegionDidChange,
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
        if (!isRoadReportSaving) closeRoadReport();
      },
      keepPrivate: handleKeepReportPrivate,
      nearPrivatePlace: nearPrivateReport?.type,
      open: stable.openRoadReport,
      save: handleSaveRoadReport,
      saving: isRoadReportSaving,
      setShareRoadReports: community.setShareRoadReports,
      shareAnyway: handleShareReportAnyway,
      sharing: {
        availability: community.availability.reportSharing,
        enabled: sharesRoadReports,
      },
      visible: isRoadReportVisible,
    },
    route: {
      alternateRoutes,
      onPreviewDetentChange: setPreviewDetent,
      previewDetent,
      displayedSelectedRoute,
      preferences: planner.routePreferences,
      selectedRoute,
      selectedRouteCongestion,
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
    visibleSafetyCameras,
    zoomStepStore,
  };
}

export type MapController = ReturnType<typeof useMapController>;
