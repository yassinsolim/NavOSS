import type {
  Coordinate,
  RouteAlternative,
  RoutePreferences,
  SearchResult,
} from '@navoss/contracts';

import NavOSSNavigation, {
  type NativeCarPlayState,
  type NativeCommunityBounds,
  type NativeCommunityReport,
  type NativeCommunityReportSubmission,
  type NativeCommunityResult,
  type NativeCommunityState,
  type NativeDestinationCatalog,
  type NativeNavigationDestination,
  type NativeNavigationAudioMode,
  type NativeNavigationPreferences,
  type NativeNavigationSnapshot,
  type NativeRerouteMode,
} from '../../../modules/navoss-navigation';

interface NativeTrafficInput {
  delaySeconds: number;
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
export const REQUIRED_NATIVE_NAVIGATION_VERSION = 9;

/**
 * Explains a JavaScript/native mismatch, or `undefined` when they match. New JavaScript on an
 * older dev client would otherwise run silently without native features it relies on, such as
 * camera alerts, which moved into native navigation in contract 9.
 */
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
  return NavOSSNavigation.addListener('onNavigationSnapshot', listener);
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
  return NavOSSNavigation.getSnapshot();
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

export function setNavigationRoute(
  route: RouteAlternative,
  destination: SearchResult,
  preferences: RoutePreferences,
  source?: string,
  traffic?: NativeTrafficInput,
  waypoints: SearchResult[] = [],
): NativeNavigationSnapshot {
  assertNativeNavigationContract();
  const coordinate = ([longitude, latitude]: [number, number]) => ({ latitude, longitude });
  return NavOSSNavigation.setRoute({
    destination: nativeDestination(destination),
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
    geometry: route.geometry.map(coordinate),
    id: route.id,
    preferences,
    ...(source === undefined ? {} : { source }),
    steps: route.steps.map((step) => ({
      distanceMeters: step.distanceMeters,
      durationSeconds: step.durationSeconds,
      geometry: step.geometry.map(coordinate),
      instruction: step.instruction,
      maneuverType: step.maneuverType,
      roadName: step.roadName,
      ...(step.spokenInstruction === undefined
        ? {}
        : { spokenInstruction: step.spokenInstruction }),
    })),
    ...(traffic === undefined
      ? {}
      : {
          traffic: {
            delaySeconds: traffic.delaySeconds,
            typicalDurationSeconds: traffic.typicalDurationSeconds,
          },
        }),
    ...(waypoints.length === 0
      ? {}
      : { waypoints: waypoints.map((waypoint) => nativeDestination(waypoint)) }),
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

export function updateNavigationLocation(
  coordinate: Coordinate,
  horizontalAccuracyMeters?: number,
  courseDegrees?: number,
): NativeNavigationSnapshot {
  return NavOSSNavigation.updateLocation({
    ...coordinate,
    ...(courseDegrees === undefined ? {} : { courseDegrees }),
    ...(horizontalAccuracyMeters === undefined ? {} : { horizontalAccuracyMeters }),
  });
}

export function clearNavigationRoute(): NativeNavigationSnapshot {
  return NavOSSNavigation.clearRoute();
}

export function stopNavigationAnnouncements(): void {
  NavOSSNavigation.stopAnnouncements();
}

// Community reports and traffic sharing. Networking and App Attest live natively and are
// shared with CarPlay; these wrappers never touch identity material.

/** Whether this native build has the community bridge (older dev clients do not). */
export function hasNativeCommunity(): boolean {
  return NavOSSNavigation.getCapabilities().communityReports === true;
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

/** Votes from the device's current position (used by the server only to check proximity). */
export function voteCommunityReport(
  reportId: string,
  vote: 'not-present' | 'present',
): Promise<NativeCommunityResult<{ active: boolean }>> {
  return NavOSSNavigation.voteCommunityReport(reportId, vote);
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

export function setShareTrafficSpeeds(enabled: boolean): void {
  NavOSSNavigation.setShareTrafficSpeeds(enabled);
}

export function setAnnounceRoadReports(enabled: boolean): void {
  NavOSSNavigation.setAnnounceRoadReports(enabled);
}
