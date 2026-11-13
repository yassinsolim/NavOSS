import type {
  Coordinate,
  RouteAlternativeV2,
  RoutePreferences,
  RouteStepV2,
  SearchResult,
} from '@navoss/contracts';

import NavOSSNavigation, {
  type NativeCarPlayState,
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
export const REQUIRED_NATIVE_NAVIGATION_VERSION = 10;

/**
 * Explains a JavaScript/native mismatch, or `undefined` when they match. New JavaScript on an
 * older dev client would otherwise run silently without native features it relies on, such as
 * camera alerts, which moved into native navigation in contract 9, or the `/v2/routes` lanes and
 * signposts native carries from contract 10.
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
