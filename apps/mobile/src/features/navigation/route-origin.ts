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
