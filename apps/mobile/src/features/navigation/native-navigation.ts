import type {
  RouteAlternativeV2,
  RoutePreferences,
  RouteStepV2,
  SearchResult,
} from '@navoss/contracts';

import NavOSSNavigation, {
  type NativeCarPlayState,
  type NativeCommunityBounds,
  type NativeCommunityReport,
  type NativeCommunityReportSubmission,
  type NativeCommunityResult,
  type NativeCarPlayTrip,
  type NativeCommunityState,
  type NativeDestinationCatalog,
  type NativeHostStatus,
  type NativeLocationAvailability,
  type NativeNavigationDestination,
  type NativeNavigationAudioMode,
  type NativeVoteObservation,
  type NativeNavigationPreferences,
  type NativeNavigationSnapshot,
  type NativeRerouteMode,
  type NativeSnapshotPayload,
} from '../../../modules/navoss-navigation';

interface NativeTrafficInput {
  delaySeconds: number;
  /** Community traffic only: the oldest publication boundary of the speeds used (ISO 8601). */
  oldestObservedAt?: string;
  typicalDurationSeconds: number;
}

interface NativeNavigationPreferencesModule {
  getAudioMode(): NativeNavigationAudioMode;
  getNavigationPreferences(): NativeNavigationPreferences;
  getRoutePreferences(): RoutePreferences;
  setAudioMode(mode: NativeNavigationAudioMode): void;
  setRoutePreferences(preferences: RoutePreferences): void;
}

interface NativeNavigationHarnessModule {
  isCarPlayVisualHarness(): boolean;
}

/** Oldest native navigation contract this JavaScript works with. */
export const REQUIRED_NATIVE_NAVIGATION_VERSION = 11;

/**
 * Explains a JavaScript/native mismatch, or `undefined` when they match. New JavaScript on an
 * older dev client would otherwise run silently without native features it relies on, such as
 * camera alerts, which moved into native navigation in contract 9, or the `/v2/routes` lanes and
 * signposts native carries from contract 10, or the restored-trip acquisition state
 * (`isAcquiringPosition`) native withholds guidance behind from contract 11: an older binary
 * would show a restored trip's saved step as current.
 */
/**
 * Stands in for a snapshot that is not one: idle, no trip, nothing guided. Its `stateVersion` is
 * below every real one, so during a trip it is dropped and the last good snapshot stays; nothing
 * is invented from a malformed one.
 */
export const UNAVAILABLE_SNAPSHOT: NativeNavigationSnapshot = {
  isDeadReckoning: false,
  isOffRoute: false,
  phase: 'idle',
  rerouteCount: 0,
  routeProgress: 0,
  routeStatus: 'tracking',
  routeVersion: 0,
  sequence: 0,
  speedingState: 'unknown',
  stateVersion: -1,
};

const PHASES = new Set(['arrived', 'idle', 'tracking']);
const ROUTE_STATUSES = new Set(['reroute-failed', 'rerouting', 'tracking']);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The fields the app reads on every snapshot, checked before any of them is trusted. */
function isSnapshot(value: unknown): value is NativeNavigationSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const snapshot = value as Record<string, unknown>;
  const trip = snapshot.trip;
  return (
    PHASES.has(snapshot.phase as string) &&
    ROUTE_STATUSES.has(snapshot.routeStatus as string) &&
    typeof snapshot.isOffRoute === 'boolean' &&
    isFiniteNumber(snapshot.stateVersion) &&
    isFiniteNumber(snapshot.rerouteCount) &&
    isFiniteNumber(snapshot.routeVersion) &&
    isFiniteNumber(snapshot.routeProgress) &&
    (trip === undefined ||
      (typeof trip === 'object' &&
        trip !== null &&
        typeof (trip as Record<string, unknown>).id === 'string' &&
        Array.isArray((trip as Record<string, unknown>).steps)))
  );
}

/**
 * iOS hands over the snapshot object; Android the core's JSON text, parsed here once and checked:
 * a malformed snapshot is [UNAVAILABLE_SNAPSHOT], never half-read.
 */
export function nativeSnapshot(payload: NativeSnapshotPayload): NativeNavigationSnapshot {
  if (!('snapshotJson' in payload)) return payload;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.snapshotJson);
  } catch {
    parsed = undefined;
  }
  if (isSnapshot(parsed)) return parsed;
  console.warn('NavOSS navigation: ignored a malformed native snapshot');
  return UNAVAILABLE_SNAPSHOT;
}

export function nativeNavigationContractError(version: number | undefined): string | undefined {
  if (version !== undefined && version >= REQUIRED_NATIVE_NAVIGATION_VERSION) {
    return undefined;
  }
  return (
    `NavOSS native navigation is contract ${version === undefined ? 'unknown' : `v${String(version)}`}, ` +
    `but this JavaScript needs v${String(REQUIRED_NATIVE_NAVIGATION_VERSION)}. ` +
    'Rebuild the iOS dev client (expo prebuild, then expo run:ios) so native and JavaScript match.'
  );
}

let nativeNavigationContractVerified = false;

function assertNativeNavigationContract(): void {
  if (nativeNavigationContractVerified) return;
  const version: number = NavOSSNavigation.getCapabilities().version;
  const error = nativeNavigationContractError(version);
  if (error !== undefined) throw new Error(error);
  nativeNavigationContractVerified = true;
}

const nativeNavigationPreferences = NavOSSNavigation as NativeNavigationPreferencesModule;
const nativeNavigationHarness = NavOSSNavigation as NativeNavigationHarnessModule;

export function getNavigationAudioMode(): NativeNavigationAudioMode {
  return nativeNavigationPreferences.getAudioMode();
}

export function getNavigationRoutePreferences(): RoutePreferences {
  return nativeNavigationPreferences.getRoutePreferences();
}

export function setNavigationRoutePreferences(preferences: RoutePreferences): void {
  nativeNavigationPreferences.setRoutePreferences(preferences);
}

export function setNavigationAudioMode(mode: NativeNavigationAudioMode): void {
  nativeNavigationPreferences.setAudioMode(mode);
}

export type NavigationAudioMode = NativeNavigationAudioMode;

export type {
  NativeCarPlayState,
  NativeCommunityBounds,
  NativeCommunityError,
  NativeCommunityReport,
  NativeCommunityReportAlert,
  NativeCommunityReportSubmission,
  NativeCommunityReportType,
  NativeCommunityResult,
  NativeCommunityState,
  NativeStillTherePrompt,
  NativeVoteObservation,
  NativeTrafficSharingState,
  NativeDestinationCatalog,
  NativeNavigationSnapshot,
  NativeRerouteMode,
  NativeRerouteProposal,
  NativeSafetyCameraAlert,
  NativeSpeedingState,
} from '../../../modules/navoss-navigation';

export function setNavigationRerouteMode(mode: NativeRerouteMode): void {
  NavOSSNavigation.setRerouteMode(mode);
}

export function setNavigationSpeedingWarning(toleranceKph: number, audible: boolean): void {
  NavOSSNavigation.setSpeedingWarning(toleranceKph, audible);
}

export function acceptRerouteProposal(id: string): boolean {
  return NavOSSNavigation.acceptRerouteProposal(id);
}

export function declineRerouteProposal(id: string): boolean {
  return NavOSSNavigation.declineRerouteProposal(id);
}

export function observeNavigationSnapshots(listener: (snapshot: NativeNavigationSnapshot) => void) {
  assertNativeNavigationContract();
  return NavOSSNavigation.addListener('onNavigationSnapshot', (payload) => {
    listener(nativeSnapshot(payload));
  });
}

export function observeNavigationPreferences(
  listener: (preferences: NativeNavigationPreferences) => void,
) {
  return NavOSSNavigation.addListener('onNavigationPreferencesChanged', listener);
}

export function observeCarPlayState(listener: (state: NativeCarPlayState) => void) {
  return NavOSSNavigation.addListener('onCarPlayStateChanged', listener);
}

export function observeCarPlayNavigationEnded(listener: () => void) {
  return NavOSSNavigation.addListener('onCarPlayNavigationEnded', listener);
}

export function getCarPlayState(): NativeCarPlayState {
  return NavOSSNavigation.getCarPlayState();
}

export function getNavigationPreferences(): NativeNavigationPreferences {
  return nativeNavigationPreferences.getNavigationPreferences();
}

export function getNavigationSnapshot(): NativeNavigationSnapshot {
  return nativeSnapshot(NavOSSNavigation.getSnapshot());
}

export function getRecentDestinationIds(): string[] {
  return NavOSSNavigation.getRecentDestinationIds();
}

export function getDestinationCatalog(): NativeDestinationCatalog {
  return NavOSSNavigation.getDestinationCatalog();
}

export function isGooglePlaceRatingAvailable(): boolean {
  return NavOSSNavigation.isGooglePlaceRatingAvailable();
}

export function isCarPlayVisualHarness(): boolean {
  return nativeNavigationHarness.isCarPlayVisualHarness();
}

export function getGooglePlacesOpenSourceLicenseInfo(): string | undefined {
  return NavOSSNavigation.getGooglePlacesOpenSourceLicenseInfo() ?? undefined;
}

export function nativeDestinationToSearchResult(
  destination: NativeNavigationDestination,
): SearchResult {
  const category: SearchResult['category'] =
    destination.category === 'address' ||
    destination.category === 'landmark' ||
    destination.category === 'neighborhood' ||
    destination.category === 'poi' ||
    destination.category === 'street'
      ? destination.category
      : 'landmark';
  return {
    category,
    center: {
      latitude: destination.latitude,
      longitude: destination.longitude,
    },
    confidence: 1,
    id: destination.id,
    label: destination.label,
    name: destination.name,
  };
}

function nativeDestination(destination: SearchResult): NativeNavigationDestination {
  return {
    category: destination.category,
    id: destination.id,
    label: destination.label,
    latitude: destination.center.latitude,
    longitude: destination.center.longitude,
    name: destination.name,
  };
}

export function setHomeDestination(destination: SearchResult | undefined): void {
  NavOSSNavigation.setHomeDestination(
    destination === undefined ? null : nativeDestination(destination),
  );
}

export function setWorkDestination(destination: SearchResult | undefined): void {
  NavOSSNavigation.setWorkDestination(
    destination === undefined ? null : nativeDestination(destination),
  );
}

/** The optional `/v2/routes` step fields native carries (contract 10), minus absent ones. */
export type RouteStepMetadata = Pick<
  RouteStepV2,
  | 'bearingAfterDegrees'
  | 'bearingBeforeDegrees'
  | 'currentRoadName'
  | 'exitNumber'
  | 'junctionName'
  | 'lanes'
  | 'maneuverModifier'
  | 'roundaboutExit'
  | 'signpost'
  | 'signpostBranch'
  | 'signpostToward'
  | 'spokenInstruction'
>;

const STEP_METADATA_KEYS = [
  'bearingAfterDegrees',
  'bearingBeforeDegrees',
  'currentRoadName',
  'exitNumber',
  'junctionName',
  'lanes',
  'maneuverModifier',
  'roundaboutExit',
  'signpost',
  'signpostBranch',
  'signpostToward',
  'spokenInstruction',
] as const satisfies readonly (keyof RouteStepMetadata)[];

export function definedStepMetadata(step: RouteStepMetadata): RouteStepMetadata {
  const metadata: RouteStepMetadata = {};
  for (const key of STEP_METADATA_KEYS) {
    if (step[key] !== undefined) Object.assign(metadata, { [key]: step[key] });
  }
  return metadata;
}

export function setNavigationRoute(
  route: RouteAlternativeV2,
  destination: SearchResult,
  preferences: RoutePreferences,
  source?: string,
  traffic?: NativeTrafficInput,
  waypoints: SearchResult[] = [],
  trafficSource?: string,
): NativeNavigationSnapshot {
  assertNativeNavigationContract();
  return nativeSnapshot(
    NavOSSNavigation.setRoute(
      nativeTrip(route, destination, preferences, source, traffic, waypoints, trafficSource),
    ),
  );
}

function nativeTrip(
  route: RouteAlternativeV2,
  destination: SearchResult,
  preferences: RoutePreferences,
  source?: string,
  traffic?: NativeTrafficInput,
  waypoints: SearchResult[] = [],
  trafficSource?: string,
): NativeCarPlayTrip {
  const coordinate = ([longitude, latitude]: [number, number]) => ({ latitude, longitude });
  return {
    destination: nativeDestination(destination),
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
    geometry: route.geometry.map(coordinate),
    id: route.id,
    preferences,
    ...(source === undefined ? {} : { source }),
    steps: route.steps.map((step) => ({
      ...definedStepMetadata(step),
      distanceMeters: step.distanceMeters,
      durationSeconds: step.durationSeconds,
      geometry: step.geometry.map(coordinate),
      instruction: step.instruction,
      maneuverType: step.maneuverType,
      roadName: step.roadName,
    })),
    ...(route.congestion === undefined ? {} : { congestion: route.congestion }),
    ...(trafficSource === undefined ? {} : { trafficSource }),
    ...(traffic === undefined
      ? {}
      : {
          traffic: {
            delaySeconds: traffic.delaySeconds,
            ...(traffic.oldestObservedAt === undefined
              ? {}
              : { oldestObservedAt: traffic.oldestObservedAt }),
            typicalDurationSeconds: traffic.typicalDurationSeconds,
          },
        }),
    ...(waypoints.length === 0
      ? {}
      : { waypoints: waypoints.map((waypoint) => nativeDestination(waypoint)) }),
  };
}

/** Android only; iOS owns location without this check and always answers `available`. */
export function getLocationAvailability(): NativeLocationAvailability {
  return NavOSSNavigation.getLocationAvailability?.() ?? 'available';
}

/**
 * Why Start cannot begin live guidance on this device, or `undefined` when it can. Android
 * only: iOS always starts.
 */
export function liveGuidanceRefusal(): { message: string; title: string } | undefined {
  if (NavOSSNavigation.getLocationAvailability === undefined) return undefined;
  if (!hasNativeTurnByTurnGuidance()) {
    return {
      message: 'This build of NavOSS cannot give turn-by-turn guidance on this device.',
      title: 'Guidance unavailable',
    };
  }
  switch (getLocationAvailability()) {
    case 'available':
      return undefined;
    case 'no-gps':
      return {
        message:
          'This device has no GPS, so NavOSS cannot follow your drive. Use Simulate drive to see how guidance works.',
        title: 'No GPS on this device',
      };
    case 'location-off':
      return {
        message: 'Turn on Location in system settings, then start again.',
        title: 'Location is off',
      };
    case 'permission-denied':
      return {
        message: 'Allow NavOSS to use your precise location in system settings, then start again.',
        title: 'Location not allowed',
      };
  }
}

/**
 * Android only: Simulate drive is offered where no location provider can follow a drive (no GPS,
 * or Location turned off), and in development builds. Not for a denied permission: Start says how
 * to allow it, and a simulation would only hide that.
 */
export function canSimulateDrive(): boolean {
  if (NavOSSNavigation.startSimulatedDrive === undefined || !hasNativeTurnByTurnGuidance()) {
    return false;
  }
  if (__DEV__) return true;
  const availability = getLocationAvailability();
  return availability === 'no-gps' || availability === 'location-off';
}

/** Starts a clearly labelled simulated drive of `route`; real fixes are ignored meanwhile. */
export function startSimulatedDrive(
  route: RouteAlternativeV2,
  destination: SearchResult,
  preferences: RoutePreferences,
  source?: string,
  waypoints: SearchResult[] = [],
): NativeNavigationSnapshot {
  assertNativeNavigationContract();
  const snapshot = NavOSSNavigation.startSimulatedDrive?.(
    nativeTrip(route, destination, preferences, source, undefined, waypoints),
  );
  if (snapshot === undefined)
    throw new Error('Simulated drives are not available on this platform.');
  return nativeSnapshot(snapshot);
}

export function isSimulatingDrive(): boolean {
  return NavOSSNavigation.isSimulatingDrive?.() ?? false;
}

/** Android: the trip or its arrival came from a simulated drive (kept natively until End / Done). */
export function isSimulatedTrip(): boolean {
  return NavOSSNavigation.isSimulatedTrip?.() ?? false;
}

/** Android: speech and trip storage as the native host sees them; both fine on iOS. */
export function getHostStatus(): NativeHostStatus {
  return NavOSSNavigation.getHostStatus?.() ?? { speechAvailable: true, tripSaved: true };
}

export function observeHostStatus(listener: (status: NativeHostStatus) => void) {
  return NavOSSNavigation.addListener('onHostStatusChanged', listener);
}

export function observeSimulatedDrive(listener: (active: boolean) => void) {
  return NavOSSNavigation.addListener('onSimulatedDriveChanged', (event) => {
    listener(event.active);
  });
}

export function clearCarPlayTrip(): void {
  NavOSSNavigation.clearCarPlayTrip();
}

export function clearRecentDestinations(): void {
  NavOSSNavigation.clearRecentDestinations();
}

export function clearDestinationHistory(): void {
  NavOSSNavigation.clearDestinationHistory();
}

export function recordRecentDestination(destination: SearchResult): void {
  NavOSSNavigation.recordRecentDestination(nativeDestination(destination));
}

export function isFavoriteDestination(id: string): boolean {
  return NavOSSNavigation.isFavoriteDestination(id);
}

export function toggleFavoriteDestination(destination: SearchResult): boolean {
  return NavOSSNavigation.toggleFavoriteDestination(nativeDestination(destination));
}

export function clearNavigationRoute(): NativeNavigationSnapshot {
  return nativeSnapshot(NavOSSNavigation.clearRoute());
}

export function stopNavigationAnnouncements(): void {
  NavOSSNavigation.stopAnnouncements();
}

/**
 * Whether the native engine matches the vehicle to the route and derives turn-by-turn guidance
 * from it. The Android placeholder engine does neither; the phone then shows the trip without a
 * maneuver, an estimate or speed readouts, and says guidance is not available yet.
 */
export function hasNativeTurnByTurnGuidance(): boolean {
  const capabilities = NavOSSNavigation.getCapabilities();
  return capabilities.routeMatching && capabilities.geometryGuidance;
}

// Community reports and traffic sharing. Networking and App Attest live natively and are
// shared with CarPlay; these wrappers never touch identity material.

/** Whether this native build has the community bridge (older dev clients do not). */
export function hasNativeCommunity(): boolean {
  return NavOSSNavigation.getCapabilities().communityReports === true;
}

/** Whether this native build has the "Share traffic speeds" uploader. */
export function hasNativeCommunityTraffic(): boolean {
  return NavOSSNavigation.getCapabilities().communityTraffic === true;
}

export function getCommunityState(): Promise<NativeCommunityState> {
  return NavOSSNavigation.getCommunityState();
}

export function observeCommunityState(listener: (state: NativeCommunityState) => void) {
  return NavOSSNavigation.addListener('onCommunityStateChanged', listener);
}

/** Reports in a box of at most 0.5° per side; served from cache while a fresh answer covers it. */
export function fetchCommunityReports(
  bounds: NativeCommunityBounds,
): Promise<NativeCommunityResult<{ reports: NativeCommunityReport[] }>> {
  return NavOSSNavigation.fetchCommunityReports(bounds);
}

export function submitCommunityReport(
  report: NativeCommunityReportSubmission,
): Promise<NativeCommunityResult<{ expiresAtMs: number; merged: boolean; reportId: string }>> {
  return NavOSSNavigation.submitCommunityReport(report);
}

/**
 * Votes from the device's current position (used by the server only to check proximity). The
 * navigation core's fix is used when it has one; `observedAt` is the phone's own fresh fix for a
 * vote outside guidance, which native accepts only within its own age and accuracy bounds.
 */
export function voteCommunityReport(
  reportId: string,
  vote: 'not-present' | 'present',
  observedAt?: NativeVoteObservation,
): Promise<NativeCommunityResult<{ active: boolean }>> {
  return observedAt === undefined
    ? NavOSSNavigation.voteCommunityReport(reportId, vote)
    : NavOSSNavigation.voteCommunityReport(reportId, vote, observedAt);
}

/** "Still there?" dismissed: sends nothing, and the prompt is not shown again this trip. */
export function dismissStillThere(reportId: string): void {
  NavOSSNavigation.dismissStillThere(reportId);
}

export function withdrawCommunityReport(reportId: string): Promise<NativeCommunityResult> {
  return NavOSSNavigation.withdrawCommunityReport(reportId);
}

/** Deletes this installation with its reports and votes on the server, then forgets the key. */
export function resetCommunityIdentity(): Promise<NativeCommunityResult> {
  return NavOSSNavigation.resetCommunityIdentity();
}

/** Only after the driver has read and accepted that reports are shared with other drivers. */
export function setShareRoadReports(enabled: boolean): void {
  NavOSSNavigation.setShareRoadReports(enabled);
}

export function setShareTrafficSpeeds(enabled: boolean): void {
  NavOSSNavigation.setShareTrafficSpeeds(enabled);
}

export function setAnnounceRoadReports(enabled: boolean): void {
  NavOSSNavigation.setAnnounceRoadReports(enabled);
}
