import type { Coordinate } from '@navoss/contracts';

const MAX_ROUTE_ORIGIN_AGE_MS = 15_000;
const MAX_ROUTE_ORIGIN_ACCURACY_METERS = 100;
const MINIMUM_HEADING_SPEED_METERS_PER_SECOND = 2;
const MAX_FUTURE_SKEW_MS = 5_000;

interface LocationLike {
  coords: {
    accuracy: number | null;
    heading: number | null;
    latitude: number;
    longitude: number;
    speed: number | null;
  };
  timestamp: number;
}

export interface RouteOriginSample {
  accuracyMeters?: number;
  capturedAtMs: number;
  coordinate: Coordinate;
  headingDegrees?: number;
}

export interface RouteRequestOrigin {
  origin: Coordinate;
  originHeadingDegrees?: number;
  originHorizontalAccuracyMeters?: number;
}

export function routeOriginSampleFromLocation(location: LocationLike): RouteOriginSample {
  const accuracyMeters =
    location.coords.accuracy !== null &&
    Number.isFinite(location.coords.accuracy) &&
    location.coords.accuracy >= 0
      ? location.coords.accuracy
      : undefined;
  const headingDegrees =
    location.coords.speed !== null &&
    Number.isFinite(location.coords.speed) &&
    location.coords.speed >= MINIMUM_HEADING_SPEED_METERS_PER_SECOND &&
    location.coords.heading !== null &&
    Number.isFinite(location.coords.heading) &&
    location.coords.heading >= 0 &&
    location.coords.heading < 360
      ? location.coords.heading
      : undefined;

  return {
    ...(accuracyMeters === undefined ? {} : { accuracyMeters }),
    capturedAtMs: location.timestamp,
    coordinate: {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
    },
    ...(headingDegrees === undefined ? {} : { headingDegrees }),
  };
}

export function routeRequestOriginFromSample(
  sample: RouteOriginSample | undefined,
  nowMs = Date.now(),
): RouteRequestOrigin | undefined {
  if (
    sample?.accuracyMeters === undefined ||
    sample.accuracyMeters > MAX_ROUTE_ORIGIN_ACCURACY_METERS ||
    sample.capturedAtMs < nowMs - MAX_ROUTE_ORIGIN_AGE_MS ||
    sample.capturedAtMs > nowMs + MAX_FUTURE_SKEW_MS
  ) {
    return undefined;
  }

  return {
    origin: sample.coordinate,
    ...(sample.headingDegrees === undefined ? {} : { originHeadingDegrees: sample.headingDegrees }),
    originHorizontalAccuracyMeters: sample.accuracyMeters,
  };
}

export function newestValidRouteOriginSample(
  first: RouteOriginSample | undefined,
  second: RouteOriginSample | undefined,
  nowMs = Date.now(),
): RouteOriginSample | undefined {
  const validSamples = [first, second].filter(
    (sample): sample is RouteOriginSample =>
      routeRequestOriginFromSample(sample, nowMs) !== undefined,
  );
  return validSamples.sort((left, right) => right.capturedAtMs - left.capturedAtMs)[0];
}

/** How long a one-shot location lookup may take before the device is treated as having no fix. */
export const LOCATION_FIX_TIMEOUT_MS = 15_000;

/** Why no route origin could be found from the device's location. */
export type RouteOriginFailure = 'no-fix' | 'no-gps' | 'services-off' | 'stale-fix';

/**
 * What the route sheet says when the device's location cannot start a route. Devices without a
 * GPS radio (a Wi-Fi-only handheld) or with location turned off land here (the Android build
 * only); the sheet offers "Choose a start" beside the message.
 */
export function routeOriginFailureMessage(failure: RouteOriginFailure): string {
  switch (failure) {
    case 'services-off':
      return 'Location is turned off on this device, so NavOSS cannot route from where you are. Turn it on in Settings, or choose where the route starts.';
    case 'no-gps':
      return 'This device has no GPS and has not found its location from Wi-Fi, so NavOSS cannot route from where you are. Choose where the route starts.';
    case 'no-fix':
      return 'This device has not found your location, so NavOSS cannot route from where you are. Try again, or choose where the route starts.';
    case 'stale-fix':
      return 'A fresh, accurate location fix is needed. Wait for GPS to update, then try again.';
  }
}

/**
 * Resolves `lookup`, or `undefined` once `timeoutMs` passes or the lookup fails. A device with no
 * location provider can otherwise leave a one-shot lookup waiting with a spinner on screen.
 */
export async function withinLocationTimeout<T>(
  lookup: Promise<T>,
  timeoutMs: number = LOCATION_FIX_TIMEOUT_MS,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, timeoutMs);
  });
  try {
    return await Promise.race([lookup.catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The device location calls a one-shot fix lookup needs. */
export interface CurrentFixLookup<T> {
  currentPosition: () => Promise<T>;
  servicesEnabled: () => Promise<boolean>;
}

/**
 * One-shot current position. With `givesUp` (the Android build: handhelds without a GPS radio and
 * devices with location off) it first checks that location services are on and stops waiting
 * after `timeoutMs`, so a spinner never stays up forever. Without it (iOS) it waits for the fix
 * for as long as acquisition takes (slow indoor or parkade fixes) and lets a failed lookup throw,
 * exactly as before Android existed.
 */
export async function currentLocationFix<T>(
  lookup: CurrentFixLookup<T>,
  givesUp: boolean,
  timeoutMs: number = LOCATION_FIX_TIMEOUT_MS,
): Promise<T | 'no-fix' | 'services-off'> {
  if (!givesUp) return lookup.currentPosition();
  if (!(await lookup.servicesEnabled())) return 'services-off';
  return (await withinLocationTimeout(lookup.currentPosition(), timeoutMs)) ?? 'no-fix';
}

/** The part of expo-location's provider status that tells whether a GPS receiver exists. */
export interface LocationProviderStatusLike {
  /** Android only: whether the GPS provider is enabled; undefined elsewhere. */
  gpsAvailable?: boolean;
  locationServicesEnabled: boolean;
}

/**
 * Whether the device has no GPS receiver (Android handhelds such as the Retroid Pocket): location
 * is switched on yet the GPS provider is missing. With location off every provider reads as
 * disabled, so nothing is claimed then.
 */
export function deviceLacksGps(status: LocationProviderStatusLike): boolean {
  return status.locationServicesEnabled && status.gpsAvailable === false;
}
