import { NativeModule, requireNativeModule } from 'expo';

export interface NativeNavigationCapabilities {
  arrivalDetection: true;
  backgroundLocation: boolean;
  carPlayTripBridge: true;
  /** Community road reports bridge (`submitCommunityReport` …). Absent on older native builds. */
  communityReports?: true;
  /** "Share traffic speeds" uploader. Absent on older native builds. */
  communityTraffic?: true;
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
  version: 10;
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

/** The eight structured report types; no police, checkpoint, free text or photos. */
export type NativeCommunityReportType =
  | 'collision'
  | 'construction'
  | 'object-on-road'
  | 'pothole'
  | 'road-closure'
  | 'road-hazard'
  | 'slow-traffic'
  | 'stalled-vehicle';

/**
 * A published community report: grid-snapped position (~55 m × 35 m), five-minute times, no
 * reporter identity. Never official data; never changes a route.
 */
export interface NativeCommunityReport {
  confirmations: number;
  expiresAtMs: number;
  id: string;
  /** Submitted by this installation during this app session (kept in memory only). */
  isOwn: boolean;
  latitude: number;
  longitude: number;
  reportedAtMs: number;
  state: 'confirmed' | 'unconfirmed';
  type: NativeCommunityReportType;
}

/**
 * "Share traffic speeds". `starts-later`: a new installation contributes from the next day
 * (show "Traffic sharing starts tomorrow", not an error). `paused`: the server asked for a
 * five-minute pause. `unavailable` lasts for the current trip.
 */
export type NativeTrafficSharingState =
  | { state: 'off' | 'ready' | 'sharing' | 'starting' }
  | { state: 'paused' | 'starts-later'; untilMs: number }
  | {
      reason: 'not-accepting' | 'offline' | 'rate-limited' | 'rejected' | 'unsupported';
      state: 'unavailable';
    };

export interface NativeCommunityPreferences {
  /** Speak a short alert for a report ahead (still subject to the guidance sound mode). */
  announcesRoadReports: boolean;
  /**
   * "Share road reports": off by default. Until the driver knowingly turns it on, reports stay
   * private drafts and `submitCommunityReport` answers `not-shared` without sending anything.
   */
  sharesRoadReports: boolean;
  /** Off by default; shared with CarPlay settings. */
  sharesTrafficSpeeds: boolean;
}

export interface NativeCommunityState {
  /** This device/build can sign writes (App Attest; DEBUG Simulator builds: development key). */
  canWrite: boolean;
  /** A community installation key id is stored in the Keychain. */
  hasIdentity: boolean;
  preferences: NativeCommunityPreferences;
  /** Active reports known natively (route corridor during guidance plus fetched areas). */
  reports: NativeCommunityReport[];
  /** `features.communityReports` from `/v2/config`; absent until the server answered. */
  reportsLive?: boolean;
  trafficSharing: NativeTrafficSharingState;
}

export type NativeCommunityError =
  | 'already-voted'
  | 'identity-lost'
  | 'invalid-request'
  | 'location-unavailable'
  | 'near-private-place'
  | 'not-found'
  | 'not-shared'
  | 'offline'
  | 'out-of-coverage'
  | 'own-report'
  | 'rate-limited'
  | 'rejected'
  | 'too-far'
  | 'too-new'
  | 'unavailable'
  | 'unsupported';

export type NativeCommunityResult<T extends object = object> =
  ({ ok: true } & T) | { error: NativeCommunityError; ok: false; retryAfterSeconds?: number };

export interface NativeCommunityBounds {
  east: number;
  north: number;
  south: number;
  west: number;
}

export interface NativeCommunityReportSubmission extends NativeNavigationCoordinate {
  /**
   * Within 400 m of saved Home/Work or the trip's start, destination or stops a report is
   * refused (`near-private-place`) unless the driver explicitly confirmed sharing it.
   */
  confirmNearPrivatePlace?: boolean;
  /** Degrees 0-359, when known. */
  heading?: number;
  type: NativeCommunityReportType;
}

/** A report ahead on the route the driver was alerted to, while still ahead. */
export interface NativeCommunityReportAlert {
  distanceAheadMeters: number;
  reportId: string;
  sequence: number;
  type: NativeCommunityReportType;
}

/**
 * Ask "Still there?" (Present / Not present / Dismiss). Native raises it only after the report
 * is passed and never near a maneuver; Dismiss must call `dismissStillThere` and sends nothing.
 */
export interface NativeStillTherePrompt {
  reportId: string;
  sequence: number;
  type: NativeCommunityReportType;
}

export interface NativeNavigationSnapshot {
  communityReportAlert?: NativeCommunityReportAlert;
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
  stillTherePrompt?: NativeStillTherePrompt;
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

/** One approach lane, left to right; mirrors the `/v2/routes` step `lanes` contract. */
export interface NativeRouteLane {
  active?: boolean;
  indications: string[];
  valid: boolean;
  validIndication?: string;
}

/**
 * A route step. Contract 10 carries the optional `/v2/routes` step metadata through native, so a
 * trip native rerouted or CarPlay started still has its lanes and signposts on the phone.
 * `spokenInstruction` describes this step's own maneuver (the v2 meaning).
 */
export interface NativeCarPlayRouteStep {
  bearingAfterDegrees?: number;
  bearingBeforeDegrees?: number;
  currentRoadName?: string;
  distanceMeters: number;
  durationSeconds: number;
  exitNumber?: string;
  geometry: NativeNavigationCoordinate[];
  instruction: string;
  junctionName?: string;
  lanes?: NativeRouteLane[];
  maneuverModifier?: string;
  maneuverType: string;
  roadName: string;
  roundaboutExit?: number;
  signpost?: string;
  signpostBranch?: string[];
  signpostToward?: string[];
  spokenInstruction?: string;
}

export interface NativeRoutePreferences {
  avoidFerries: boolean;
  avoidHighways: boolean;
  avoidTolls: boolean;
  avoidUnpaved: boolean;
}

export interface NativeCarPlayTrip {
  /** Per geometry segment, only on a route a live traffic source observed. */
  congestion?: ('free' | 'heavy' | 'slow' | 'stopped' | 'unknown')[];
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
  /** `navoss-community` when `traffic`/`congestion` come from opted-in NavOSS drivers. */
  trafficSource?: string;
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

type NavOSSNavigationEvents = {
  onCarPlayNavigationEnded(event: { reason: 'carplay' }): void;
  onCarPlayStateChanged(state: NativeCarPlayState): void;
  onCommunityStateChanged(state: NativeCommunityState): void;
  onNavigationPreferencesChanged(preferences: NativeNavigationPreferences): void;
  onNavigationSnapshot(snapshot: NativeNavigationSnapshot): void;
};

declare class NavOSSNavigationModule extends NativeModule<NavOSSNavigationEvents> {
  acceptRerouteProposal(id: string): boolean;
  clearCarPlayTrip(): void;
  clearDestinationHistory(): void;
  clearRecentDestinations(): void;
  clearRoute(): NativeNavigationSnapshot;
  declineRerouteProposal(id: string): boolean;
  dismissStillThere(reportId: string): void;
  fetchCommunityReports(
    bounds: NativeCommunityBounds,
  ): Promise<NativeCommunityResult<{ reports: NativeCommunityReport[] }>>;
  getCarPlayState(): NativeCarPlayState;
  getAudioMode(): NativeNavigationAudioMode;
  getCapabilities(): NativeNavigationCapabilities;
  getCommunityState(): Promise<NativeCommunityState>;
  getDestinationCatalog(): NativeDestinationCatalog;
  getGooglePlacesOpenSourceLicenseInfo(): string | null;
  getNavigationPreferences(): NativeNavigationPreferences;
  getRecentDestinationIds(): string[];
  getRoutePreferences(): NativeRoutePreferences;
  getSnapshot(): NativeNavigationSnapshot;
  isFavoriteDestination(id: string): boolean;
  isCarPlayVisualHarness(): boolean;
  isGooglePlaceRatingAvailable(): boolean;
  recordRecentDestination(destination: NativeNavigationDestination): void;
  replaceFavoriteDestinations(destinations: NativeNavigationDestination[]): void;
  resetCommunityIdentity(): Promise<NativeCommunityResult>;
  setHomeDestination(destination: NativeNavigationDestination | null): void;
  setAnnounceRoadReports(enabled: boolean): void;
  setAudioMode(mode: NativeNavigationAudioMode): void;
  setRerouteMode(mode: NativeRerouteMode): void;
  setRoute(trip: NativeCarPlayTrip): NativeNavigationSnapshot;
  setRoutePreferences(preferences: NativeRoutePreferences): void;
  setShareRoadReports(enabled: boolean): void;
  setShareTrafficSpeeds(enabled: boolean): void;
  setSpeedingWarning(toleranceKph: number, audible: boolean): void;
  setWorkDestination(destination: NativeNavigationDestination | null): void;
  stopAnnouncements(): void;
  submitCommunityReport(
    report: NativeCommunityReportSubmission,
  ): Promise<NativeCommunityResult<{ expiresAtMs: number; merged: boolean; reportId: string }>>;
  toggleFavoriteDestination(destination: NativeNavigationDestination): boolean;
  updateLocation(location: NativeNavigationLocationSample): NativeNavigationSnapshot;
  voteCommunityReport(
    reportId: string,
    vote: 'not-present' | 'present',
  ): Promise<NativeCommunityResult<{ active: boolean }>>;
  withdrawCommunityReport(reportId: string): Promise<NativeCommunityResult>;
}

export default requireNativeModule<NavOSSNavigationModule>('NavOSSNavigation');
