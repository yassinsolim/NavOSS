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
