import { normalizeHeadingDegrees } from './vehicle-heading';

export type NavigationMapOrientation = 'heading-up' | 'north-up';

export const NAVIGATION_CAMERA_TRANSITION = {
  duration: 1_000,
  easing: 'linear' as const,
};

export function navigationCameraBearing(
  orientation: NavigationMapOrientation,
  matchedRoadCourse: number | undefined,
  fallbackCourse: number | undefined,
): number {
  if (orientation === 'north-up') {
    return 0;
  }

  return normalizeHeadingDegrees(matchedRoadCourse ?? fallbackCourse ?? 0);
}

export function toggleNavigationMapOrientation(
  orientation: NavigationMapOrientation,
): NavigationMapOrientation {
  return orientation === 'heading-up' ? 'north-up' : 'heading-up';
}

/**
 * Where the guidance camera centres. Until the first fix after a relaunch there is no vehicle
 * position; following "nothing" at street zoom left the camera over the middle of Canada, an
 * empty beige map. The route's start is a place the driver recognises until a fix arrives.
 */
export function navigationCameraCenter(
  vehicle: { latitude: number; longitude: number } | undefined,
  routeGeometry: readonly (readonly number[])[] | undefined,
): { latitude: number; longitude: number } | undefined {
  if (vehicle !== undefined) return vehicle;
  const start = routeGeometry?.[0];
  if (start === undefined || start.length < 2) return undefined;
  const [longitude, latitude] = start as [number, number];
  return { latitude, longitude };
}
