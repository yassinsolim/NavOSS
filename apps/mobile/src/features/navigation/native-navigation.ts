import type { Coordinate, RouteAlternative, SearchResult } from '@navoss/contracts';

import NavOSSNavigation, {
  type NativeNavigationSnapshot,
} from '../../../modules/navoss-navigation';

export type { NativeNavigationSnapshot } from '../../../modules/navoss-navigation';

export function announceSafetyCamera(): void {
  NavOSSNavigation.announceSafetyCamera();
}

export function observeNavigationSnapshots(listener: (snapshot: NativeNavigationSnapshot) => void) {
  return NavOSSNavigation.addListener('onNavigationSnapshot', listener);
}

export function setNavigationRoute(route: RouteAlternative): NativeNavigationSnapshot {
  return NavOSSNavigation.setRoute(
    route.geometry.map(([longitude, latitude]) => ({ latitude, longitude })),
  );
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
