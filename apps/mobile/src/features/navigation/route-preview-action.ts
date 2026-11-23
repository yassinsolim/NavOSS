/** The route preview's primary action (the button beside the arrival time). */
export type RoutePreviewPrimaryAction = 'simulate-drive' | 'start' | 'use-my-location';

export interface RoutePreviewActionInput {
  /** The route was planned from a chosen start or a demo origin, not the device's location. */
  chosenStart: boolean;
  /** Android only: the device has no location provider that could follow a drive. */
  deviceHasNoGps: boolean;
  isAndroid: boolean;
  simulateDriveAvailable: boolean;
}

/**
 * A route from a chosen start is normally re-planned from the driver's location ("Use my
 * location"). On an Android device with no GPS that can never work, so Simulate drive becomes the
 * primary action and the sheet says why. iOS is unchanged.
 */
export function routePreviewPrimaryAction(
  input: RoutePreviewActionInput,
): RoutePreviewPrimaryAction {
  if (!input.chosenStart) return 'start';
  if (input.isAndroid && input.deviceHasNoGps && input.simulateDriveAvailable)
    return 'simulate-drive';
  return 'use-my-location';
}

export const NO_GPS_PREVIEW_NOTICE =
  'This device has no GPS, so NavOSS cannot guide this trip live.';
