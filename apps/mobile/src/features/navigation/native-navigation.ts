import type { Coordinate, RouteAlternative, SearchResult } from '@navoss/contracts';

import NavOSSNavigation, {
  type NativeCarPlayGuidance,
  type NativeCarPlayState,
  type NativeNavigationSnapshot,
} from '../../../modules/navoss-navigation';

export type {
  NativeCarPlayGuidance,
  NativeCarPlayState,
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

export function setNavigationRoute(
  route: RouteAlternative,
  destination: SearchResult,
): NativeNavigationSnapshot {
  const coordinate = ([longitude, latitude]: [number, number]) => ({ latitude, longitude });
  NavOSSNavigation.publishCarPlayTrip({
    destination: {
      id: destination.id,
      label: destination.label,
      latitude: destination.center.latitude,
      longitude: destination.center.longitude,
      name: destination.name,
    },
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
    geometry: route.geometry.map(coordinate),
    id: route.id,
    steps: route.steps.map((step) => ({
      distanceMeters: step.distanceMeters,
      durationSeconds: step.durationSeconds,
      geometry: step.geometry.map(coordinate),
      instruction: step.instruction,
      maneuverType: step.maneuverType,
      roadName: step.roadName,
    })),
  });
  return NavOSSNavigation.setRoute(route.geometry.map(coordinate));
}

export function publishCarPlayGuidance(guidance: NativeCarPlayGuidance): void {
  NavOSSNavigation.publishCarPlayGuidance(guidance);
}

export function clearCarPlayTrip(): void {
  NavOSSNavigation.clearCarPlayTrip();
}

export function recordRecentDestination(destination: SearchResult): void {
  NavOSSNavigation.recordRecentDestination({
    id: destination.id,
    label: destination.label,
    latitude: destination.center.latitude,
    longitude: destination.center.longitude,
    name: destination.name,
  });
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
