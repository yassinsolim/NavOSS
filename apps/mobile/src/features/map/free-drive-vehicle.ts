import type { Coordinate } from '@navoss/contracts';

// With no trip the phone map draws the same NavOSS vehicle as guidance, under the rules CarPlay's
// free drive uses (`CarPlayFreeDrive.swift`): the vehicle means a live, accurate fix, and it
// points only where the evidence says the car is going.

/** Below 9 km/h GPS course is noise (CarPlay `navOSSCarPlayFreeDriveCourseMinimumSpeedMetersPerSecond`). */
export const FREE_DRIVE_COURSE_MINIMUM_SPEED_METERS_PER_SECOND = 2.5;
/**
 * A fix is live for at most 15 s with 100 m accuracy: the route-origin rule CarPlay free drive
 * applies (`navOSSNavigationRouteOrigin`) and the phone's own `routeRequestOriginFromSample`.
 */
export const FREE_DRIVE_MAXIMUM_FIX_AGE_MS = 15_000;
export const FREE_DRIVE_MAXIMUM_ACCURACY_METERS = 100;
/** A fix timestamped further ahead than this is a clock fault, not a live fix (route-origin rule). */
const MAXIMUM_FUTURE_SKEW_MS = 5_000;

/** One location sample, unknown values absent (iOS reports an unknown course or speed as -1). */
export interface FreeDriveFix {
  accuracyMeters?: number;
  /** When the device measured it (the location's own timestamp), not when it arrived. */
  capturedAtMs: number;
  coordinate: Coordinate;
  courseDegrees?: number;
  /** Android reports a fix from a mock location provider; it is never drawn as the vehicle. */
  mocked?: true;
  speedMetersPerSecond?: number;
}

/** What the phone remembers between fixes. */
export interface FreeDriveTrack {
  /** The newest fix from the phone map's own location watch (it does not run during a trip). */
  fix?: FreeDriveFix;
  /** The last course a drawable fix proved while moving; held while stopped. */
  lastCourseDegrees?: number;
  /** The course the active trip has drawn; undefined without a trip or before its first course. */
  tripCourseDegrees?: number;
}

export const EMPTY_FREE_DRIVE_TRACK: FreeDriveTrack = {};

interface LocationLike {
  coords: {
    accuracy: number | null;
    heading: number | null;
    latitude: number;
    longitude: number;
    speed: number | null;
  };
  mocked?: boolean;
  timestamp: number;
}

function validBearing(degrees: number | null | undefined): number | undefined {
  return degrees !== null && degrees !== undefined && Number.isFinite(degrees) && degrees >= 0
    ? degrees < 360
      ? degrees
      : undefined
    : undefined;
}

function nonNegative(value: number | null | undefined): number | undefined {
  return value !== null && value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function freeDriveFixFromLocation(location: LocationLike): FreeDriveFix {
  const accuracyMeters = nonNegative(location.coords.accuracy);
  const courseDegrees = validBearing(location.coords.heading);
  const speedMetersPerSecond = nonNegative(location.coords.speed);
  return {
    ...(accuracyMeters === undefined ? {} : { accuracyMeters }),
    capturedAtMs: location.timestamp,
    coordinate: { latitude: location.coords.latitude, longitude: location.coords.longitude },
    ...(courseDegrees === undefined ? {} : { courseDegrees }),
    ...(location.mocked === true ? { mocked: true as const } : {}),
    ...(speedMetersPerSecond === undefined ? {} : { speedMetersPerSecond }),
  };
}

/** The direction of travel a fix proves on its own: a valid course while moving fast enough. */
export function freeDriveCourseDegrees(fix: FreeDriveFix): number | undefined {
  const course = validBearing(fix.courseDegrees);
  if (course === undefined || fix.speedMetersPerSecond === undefined) return undefined;
  return fix.speedMetersPerSecond >= FREE_DRIVE_COURSE_MINIMUM_SPEED_METERS_PER_SECOND
    ? course
    : undefined;
}

/**
 * Records a fix. A late fix older than the one held never replaces it, and a course is remembered
 * only from a fix that could itself be drawn (live, accurate, not mocked), as CarPlay validates a
 * fix before taking its course.
 */
export function trackWithFix(
  track: FreeDriveTrack,
  fix: FreeDriveFix,
  nowMs: number,
): FreeDriveTrack {
  if (track.fix !== undefined && track.fix.capturedAtMs > fix.capturedAtMs) return track;
  const course = isLiveFreeDriveFix(fix, nowMs) ? freeDriveCourseDegrees(fix) : undefined;
  return { ...track, fix, lastCourseDegrees: course ?? track.lastCourseDegrees };
}

/**
 * The navigation snapshot gives the trip vehicle its course (used at Start before the trip has
 * drawn one). It is never a free-drive fix: it carries no time of measurement, and during an
 * Android simulated drive it is not where the phone is. While a trip runs the free-drive fix and
 * course are dropped (the phone map's own watch is off then), so after End the vehicle starts over
 * as at launch: the dot until the restarted watch delivers a drawable fix, and a course only from
 * that fix or later ones. A snapshot without a trip clears the trip course. An unchanged track is
 * returned as is, so repeated snapshots re-render nothing.
 */
export function trackWithTripSnapshot(
  track: FreeDriveTrack,
  snapshot: { matchedCourseDegrees?: number; trip?: unknown },
): FreeDriveTrack {
  if (snapshot.trip === undefined) {
    return track.tripCourseDegrees === undefined
      ? track
      : { ...track, tripCourseDegrees: undefined };
  }
  const tripCourseDegrees = validBearing(snapshot.matchedCourseDegrees) ?? track.tripCourseDegrees;
  return track.fix === undefined &&
    track.lastCourseDegrees === undefined &&
    track.tripCourseDegrees === tripCourseDegrees
    ? track
    : { tripCourseDegrees };
}

export type FreeDriveHeadingSource = 'compass' | 'course' | 'last-course';

/**
 * What the map shows for the driver's position without a trip:
 * - `hidden`: location is not available (denied, off, not found yet); the existing notices speak.
 * - `location-dot`: MapLibre's own dot with its accuracy ring. A position NavOSS cannot vouch for
 *   as the vehicle: the newest fix is older than 15 s, worse than 100 m (or of unknown accuracy),
 *   or nothing says which way the car points.
 * - `vehicle`: the driver's NavOSS vehicle, pointing the way the evidence says.
 */
export type FreeDriveMarker =
  | { kind: 'hidden' }
  | { kind: 'location-dot' }
  | {
      coordinate: Coordinate;
      headingDegrees: number;
      headingSource: FreeDriveHeadingSource;
      kind: 'vehicle';
    };

/** Whether a fix may be drawn as the vehicle: the route-origin rule, and not a mock location. */
export function isLiveFreeDriveFix(fix: FreeDriveFix | undefined, nowMs: number): boolean {
  return (
    fix?.accuracyMeters !== undefined &&
    fix.mocked !== true &&
    fix.accuracyMeters <= FREE_DRIVE_MAXIMUM_ACCURACY_METERS &&
    fix.capturedAtMs >= nowMs - FREE_DRIVE_MAXIMUM_FIX_AGE_MS &&
    fix.capturedAtMs <= nowMs + MAXIMUM_FUTURE_SKEW_MS
  );
}

/** Milliseconds until the held fix stops being live, or undefined when it is not live now. */
export function freeDriveMillisecondsUntilStale(
  fix: FreeDriveFix | undefined,
  nowMs: number,
): number | undefined {
  if (fix === undefined || !isLiveFreeDriveFix(fix, nowMs)) return undefined;
  return fix.capturedAtMs + FREE_DRIVE_MAXIMUM_FIX_AGE_MS - nowMs + 1;
}

/**
 * The marker for the phone map without a trip. Direction, in order: this fix's course while
 * moving at 9 km/h or more; the last such course while stopped or crawling; the compass only
 * before any course has been seen; otherwise no direction, which shows the dot. Never north by
 * default.
 */
export function freeDriveMarker({
  compassDegrees,
  locationAvailable,
  nowMs,
  track,
}: {
  compassDegrees: number | undefined;
  /** The map's location state is `visible`: permission granted and a position found. */
  locationAvailable: boolean;
  nowMs: number;
  track: FreeDriveTrack;
}): FreeDriveMarker {
  if (!locationAvailable) return { kind: 'hidden' };
  const fix = track.fix;
  if (fix === undefined || !isLiveFreeDriveFix(fix, nowMs)) return { kind: 'location-dot' };
  const course = freeDriveCourseDegrees(fix);
  const lastCourse = validBearing(track.lastCourseDegrees);
  // The compass watch rounds to whole degrees, so 359.6 arrives as 360: wrap it, never drop it.
  const compass =
    compassDegrees !== undefined && Number.isFinite(compassDegrees)
      ? ((compassDegrees % 360) + 360) % 360
      : undefined;
  const heading: { degrees: number; source: FreeDriveHeadingSource } | undefined =
    course !== undefined
      ? { degrees: course, source: 'course' }
      : lastCourse !== undefined
        ? { degrees: lastCourse, source: 'last-course' }
        : compass !== undefined
          ? { degrees: compass, source: 'compass' }
          : undefined;
  if (heading === undefined) return { kind: 'location-dot' };
  return {
    coordinate: fix.coordinate,
    headingDegrees: heading.degrees,
    headingSource: heading.source,
    kind: 'vehicle',
  };
}

/** What the map draws for the driver: one vehicle, the location dot, or nothing. */
export type MapVehicle =
  | { kind: 'hidden' }
  | { kind: 'location-dot' }
  | { coordinate: Coordinate; headingDegrees: number; kind: 'vehicle' };

/**
 * One vehicle for trip and free drive. While guidance draws the vehicle it owns it; the heading is
 * the trip's course, and before the trip has one, the heading the vehicle was already drawn with,
 * so Start does not swing the arrow. Without a trip the free-drive marker applies, so at End the
 * same vehicle carries on from the latest fix.
 */
export function mapVehicle({
  freeDrive,
  previousHeadingDegrees,
  trip,
}: {
  freeDrive: FreeDriveMarker;
  /** The heading the vehicle was last drawn with, if it was drawn. */
  previousHeadingDegrees: number | undefined;
  trip:
    | {
        coordinate: Coordinate;
        /** The trip's own course; undefined before its first one. */
        courseDegrees: number | undefined;
        /** The heading guidance used before this existed (the last known course, else north). */
        fallbackHeadingDegrees: number;
      }
    | undefined;
}): MapVehicle {
  if (trip !== undefined) {
    return {
      coordinate: trip.coordinate,
      headingDegrees:
        validBearing(trip.courseDegrees) ??
        validBearing(previousHeadingDegrees) ??
        trip.fallbackHeadingDegrees,
      kind: 'vehicle',
    };
  }
  if (freeDrive.kind !== 'vehicle') return freeDrive;
  return {
    coordinate: freeDrive.coordinate,
    headingDegrees: freeDrive.headingDegrees,
    kind: 'vehicle',
  };
}
