import { NativeModule, requireNativeModule } from 'expo';

export interface NativeNavigationCapabilities {
  arrivalDetection: true;
  backgroundLocation: boolean;
  carPlayTripBridge: true;
  courseMatching: true;
  deadReckoning: true;
  geometryGuidance: true;
  implementation: 'native-ios';
  nativeSafetyCameraAlerts: true;
  offRouteDetection: true;
  replayInput: true;
  rerouteConsent: true;
  routeContinuity: true;
  routeMatching: true;
  safetyCameraAnnouncements: true;
  speedingWarning: true;
  version: 9;
}

/**
 * How native navigation recovers once the driver leaves the selected route. NavOSS never swaps
 * routes merely to save time.
 * - `adaptive`: install the fastest replacement automatically.
 * - `ask-first`: offer `rerouteProposal`; it is withdrawn if the driver returns to the route and
 *   replaced by an automatic recovery if unanswered for `respondWithinSeconds` while off route.
 * - `keep-route`: route back onto the selected route ahead of the vehicle, never behind it.
 */
export type NativeRerouteMode = 'adaptive' | 'ask-first' | 'keep-route';

export type NativeSpeedingState = 'over-limit' | 'unknown' | 'within-limit';

export type NativeNavigationAudioMode = 'alerts-only' | 'all-guidance' | 'muted';

export interface NativeNavigationCoordinate {
  latitude: number;
  longitude: number;
}

export interface NativeNavigationDestination extends NativeNavigationCoordinate {
  category?: 'address' | 'landmark' | 'neighborhood' | 'poi' | 'street';
  id: string;
  label: string;
  name: string;
}

export interface NativeDestinationCatalog {
  favorites: NativeNavigationDestination[];
  home?: NativeNavigationDestination;
  recents: NativeNavigationDestination[];
  work?: NativeNavigationDestination;
}

export interface NativeNavigationLocationSample extends NativeNavigationCoordinate {
  courseDegrees?: number;
  horizontalAccuracyMeters?: number;
  speedMetersPerSecond?: number;
  /** Fix time in milliseconds since the Unix epoch. */
  timestampMs?: number;
}

export interface NativeRerouteProposal {
  createdAtMs: number;
  /** Replacement minus the selected route's remaining distance; positive is longer. */
  distanceDeltaMeters: number;
  distanceMeters: number;
  /** Replacement minus the selected route's remaining duration; positive is slower. */
  durationDeltaSeconds: number;
  durationSeconds: number;
  id: string;
  respondWithinSeconds: number;
  trip: NativeCarPlayTrip;
}

/** Present while the announced camera is still ahead. `sequence` changes per new alert. */
export interface NativeSafetyCameraAlert {
  cameraId: string;
  distanceAheadMeters: number;
  location: string;
  sequence: number;
}

export interface NativeNavigationSnapshot {
  /** Name of the road being driven, from the route's current step, when the route names it. */
  currentRoadName?: string;
  distanceFromRouteMeters?: number;
  horizontalAccuracyMeters?: number;
  /** The matched position is extrapolated along the route through a short gap in fixes. */
  isDeadReckoning?: boolean;
  isOffRoute: boolean;
  matchedCoordinate?: NativeNavigationCoordinate;
  matchedCourseDegrees?: number;
  phase: 'arrived' | 'idle' | 'tracking';
  rawCoordinate?: NativeNavigationCoordinate;
  rerouteCount: number;
  rerouteMode?: NativeRerouteMode;
  rerouteProposal?: NativeRerouteProposal;
  guidance?: NativeCarPlayGuidance;
  routeProgress: number;
  routeStatus: 'reroute-failed' | 'rerouting' | 'tracking';
  routeVersion: number;
  safetyCameraAlert?: NativeSafetyCameraAlert;
  sequence: number;
  /** Posted limit at the matched position from route annotations; absent when unknown. */
  speedLimitKph?: number;
  speedMetersPerSecond?: number;
  speedingState?: NativeSpeedingState;
  stateVersion: number;
  trip?: NativeCarPlayTrip;
}

export type NativeCarPlayGuidancePhase = 'arrived' | 'navigating' | 'preview';

export interface NativeCarPlayGuidance {
  distanceToManeuverMeters: number;
  durationToManeuverSeconds: number;
  instruction: string;
  maneuverType: string;
  phase: NativeCarPlayGuidancePhase;
  remainingDistanceMeters: number;
  remainingDurationSeconds: number;
  roadName: string;
  stepIndex: number;
}

export interface NativeCarPlayRouteStep {
  distanceMeters: number;
  durationSeconds: number;
  geometry: NativeNavigationCoordinate[];
  instruction: string;
  maneuverType: string;
  roadName: string;
  spokenInstruction?: string;
}

export interface NativeRoutePreferences {
  avoidFerries: boolean;
  avoidHighways: boolean;
  avoidTolls: boolean;
  avoidUnpaved: boolean;
}

export interface NativeCarPlayTrip {
  destination: NativeNavigationDestination;
  distanceMeters: number;
  durationSeconds: number;
  geometry: NativeNavigationCoordinate[];
  id: string;
  preferences: NativeRoutePreferences;
  source?: string;
  speedLimitsKph?: number[];
  steps: NativeCarPlayRouteStep[];
  traffic?: {
    delaySeconds: number;
    typicalDurationSeconds: number;
  };
  waypoints?: NativeNavigationDestination[];
}

export interface NativeCarPlayState {
  connected: boolean;
  guidance?: NativeCarPlayGuidance;
  hasActiveTrip: boolean;
}

export interface NativeNavigationPreferences {
  audioMode: NativeNavigationAudioMode;
  rerouteMode?: NativeRerouteMode;
  routePreferences: NativeRoutePreferences;
  speedingAudibleWarning?: boolean;
  /** km/h over the posted limit before `speedingState` turns `over-limit` (0-20, default 5). */
  speedingToleranceKph?: number;
}

export type NativeOfflineCatalog =
  'available' | 'loading' | 'not-published' | 'unreachable' | 'unsupported';

export type NativeOfflineRegionState =
  | 'downloading'
  | 'failed'
  | 'installed'
  | 'installing'
  | 'not-downloaded'
  | 'paused'
  | 'queued'
  | 'verifying';

export interface NativeOfflineFailure {
  availableBytes?: number;
  reason: 'installation' | 'integrity' | 'network' | 'server' | 'storage' | 'unsupported';
  requiredBytes?: number;
  statusCode?: number;
}

export interface NativeOfflineRegion {
  attribution: { license: string; text: string; url: string }[];
  /** `[west, south, east, north]`. */
  bounds: [number, number, number, number];
  /** Bytes still to download for this region, including shared resources not yet installed. */
  downloadBytes: number;
  failure?: NativeOfflineFailure;
  id: string;
  installedBytes?: number;
  installedDataDate?: string;
  installedVersion?: string;
  name: string;
  receivedBytes?: number;
  state: NativeOfflineRegionState;
  totalBytes?: number;
  updateAvailable: boolean;
}

export interface NativeOfflineState {
  availableBytes?: number;
  bundleVersion?: string;
  catalog: NativeOfflineCatalog;
  dataDate?: string;
  networkAvailable: boolean;
  preferOffline: boolean;
  regions: NativeOfflineRegion[];
  /** The manifest came from the device cache after a failed refresh. */
  stale: boolean;
  storageBytes: number;
}

export interface NativeOfflineRouteRequest {
  alternatives: number;
  destination: NativeNavigationDestination;
  origin: NativeNavigationCoordinate;
  originHeadingDegrees?: number;
  originHorizontalAccuracyMeters?: number;
  preferences: NativeRoutePreferences;
  waypoints: NativeNavigationDestination[];
}

export type NativeOfflineErrorCode =
  'engine-unavailable' | 'no-route' | 'not-installed' | 'outside-coverage';

export type NativeOfflineRouteResult =
  { ok: true; trips: NativeCarPlayTrip[] } | { code: NativeOfflineErrorCode; ok: false };

export interface NativeOfflinePlace {
  address?: string;
  category: 'address' | 'landmark' | 'neighborhood' | 'poi';
  detailCategory?: string;
  /** Straight-line ranking distance, not a driving distance. */
  distanceMeters: number;
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  name: string;
  nameSource: 'address' | 'category' | 'osm';
}

export type NativeOfflineSearchResult =
  | { bundleVersion: string; ok: true; osmTimestamp: string; results: NativeOfflinePlace[] }
  | { code: NativeOfflineErrorCode; ok: false };

type NavOSSNavigationEvents = {
  onCarPlayNavigationEnded(event: { reason: 'carplay' }): void;
  onCarPlayStateChanged(state: NativeCarPlayState): void;
  onNavigationPreferencesChanged(preferences: NativeNavigationPreferences): void;
  onNavigationSnapshot(snapshot: NativeNavigationSnapshot): void;
  onOfflineStateChanged(state: NativeOfflineState): void;
};

declare class NavOSSNavigationModule extends NativeModule<NavOSSNavigationEvents> {
  acceptRerouteProposal(id: string): boolean;
  clearCarPlayTrip(): void;
  clearDestinationHistory(): void;
  clearRecentDestinations(): void;
  clearRoute(): NativeNavigationSnapshot;
  deleteOfflineRegion(regionId: string): 'blocked-by-active-route' | 'deleted';
  downloadOfflineRegion(regionId: string): void;
  declineRerouteProposal(id: string): boolean;
  getCarPlayState(): NativeCarPlayState;
  getAudioMode(): NativeNavigationAudioMode;
  getCapabilities(): NativeNavigationCapabilities;
  getDestinationCatalog(): NativeDestinationCatalog;
  getGooglePlacesOpenSourceLicenseInfo(): string | null;
  getNavigationPreferences(): NativeNavigationPreferences;
  getOfflineMapStyle(
    slug: string,
    latitude: number | null,
    longitude: number | null,
  ): { style: string; use: boolean } | null;
  getOfflineState(): NativeOfflineState;
  getRecentDestinationIds(): string[];
  getRoutePreferences(): NativeRoutePreferences;
  getSnapshot(): NativeNavigationSnapshot;
  isFavoriteDestination(id: string): boolean;
  isCarPlayVisualHarness(): boolean;
  isGooglePlaceRatingAvailable(): boolean;
  pauseOfflineRegion(regionId: string): void;
  planOfflineRoutes(request: NativeOfflineRouteRequest): Promise<NativeOfflineRouteResult>;
  recordRecentDestination(destination: NativeNavigationDestination): void;
  refreshOfflineManifest(): Promise<NativeOfflineState>;
  replaceFavoriteDestinations(destinations: NativeNavigationDestination[]): void;
  searchOffline(
    query: string,
    latitude: number | null,
    longitude: number | null,
    limit: number,
    category: string | null,
  ): Promise<NativeOfflineSearchResult>;
  setHomeDestination(destination: NativeNavigationDestination | null): void;
  setAudioMode(mode: NativeNavigationAudioMode): void;
  setPreferOfflineMaps(prefer: boolean): void;
  setRerouteMode(mode: NativeRerouteMode): void;
  setRoute(trip: NativeCarPlayTrip): NativeNavigationSnapshot;
  setRoutePreferences(preferences: NativeRoutePreferences): void;
  setSpeedingWarning(toleranceKph: number, audible: boolean): void;
  setWorkDestination(destination: NativeNavigationDestination | null): void;
  stopAnnouncements(): void;
  toggleFavoriteDestination(destination: NativeNavigationDestination): boolean;
  updateLocation(location: NativeNavigationLocationSample): NativeNavigationSnapshot;
}

export default requireNativeModule<NavOSSNavigationModule>('NavOSSNavigation');
