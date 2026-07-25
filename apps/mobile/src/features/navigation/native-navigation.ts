import type {
  Coordinate,
  RouteAlternative,
  RoutePreferences,
  SearchResult,
} from '@navoss/contracts';

import NavOSSNavigation, {
  type NativeCarPlayState,
  type NativeDestinationCatalog,
  type NativeNavigationDestination,
  type NativeNavigationSnapshot,
} from '../../../modules/navoss-navigation';

interface NativeTrafficInput {
  delaySeconds: number;
  typicalDurationSeconds: number;
}

export type {
  NativeCarPlayState,
  NativeDestinationCatalog,
  NativeNavigationSnapshot,
} from '../../../modules/navoss-navigation';

export function announceSafetyCamera(): void {
  NavOSSNavigation.announceSafetyCamera();
}

export function observeNavigationSnapshots(listener: (snapshot: NativeNavigationSnapshot) => void) {
  return NavOSSNavigation.addListener('onNavigationSnapshot', listener);
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
): NativeNavigationSnapshot {
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
