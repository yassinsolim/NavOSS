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
  capturedAtMs: number;
  coordinate: Coordinate;
  courseDegrees?: number;
  speedMetersPerSecond?: number;
}

/** What the phone remembers between fixes. */
export interface FreeDriveTrack {
  /** The newest fix, from the map's own watch or, during a trip, the navigation core. */
  fix?: FreeDriveFix;
  /** The last course a fix proved while moving; held while stopped. */
  lastCourseDegrees?: number;
  /** The last navigation snapshot taken as a fix, so a repeated snapshot is not a new fix. */
  navigationSequence?: number;
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

/** Records a fix. A late fix older than the one held never replaces it. */
export function trackWithFix(track: FreeDriveTrack, fix: FreeDriveFix): FreeDriveTrack {
  if (track.fix !== undefined && track.fix.capturedAtMs > fix.capturedAtMs) return track;
  return {
    ...track,
    fix,
    lastCourseDegrees: freeDriveCourseDegrees(fix) ?? track.lastCourseDegrees,
  };
}

/** The navigation snapshot fields the phone uses as a position while a trip runs. */
export interface NavigationFix {
  horizontalAccuracyMeters?: number;
  isDeadReckoning?: boolean;
  matchedCourseDegrees?: number;
  rawCoordinate?: Coordinate;
  sequence: number;
  speedMetersPerSecond?: number;
  /** Present while the core has a trip. */
  trip?: unknown;
}

/**
 * During a trip the map's own watch is off and the navigation core reports position. Each new
 * snapshot of an active trip with a measured (not dead-reckoned) position is taken as a fix
 * received now, with the trip's course as its course, so at End the vehicle carries on from a live
 * fix and the direction guidance last proved instead of starting over. A snapshot without a trip
 * is not a fix (the core has stopped measuring) and clears the trip course.
 */
export function trackWithNavigationFix(
  track: FreeDriveTrack,
  snapshot: NavigationFix,
  nowMs: number,
): FreeDriveTrack {
  const tripCourse =
    snapshot.trip === undefined
      ? undefined
      : (validBearing(snapshot.matchedCourseDegrees) ?? track.tripCourseDegrees);
  const next: FreeDriveTrack = { ...track, tripCourseDegrees: tripCourse };
  if (
    snapshot.trip === undefined ||
    snapshot.rawCoordinate === undefined ||
    snapshot.isDeadReckoning === true ||
    snapshot.sequence === track.navigationSequence
  ) {
    return next.tripCourseDegrees === track.tripCourseDegrees ? track : next;
  }
  const accuracyMeters = nonNegative(snapshot.horizontalAccuracyMeters);
  const courseDegrees = validBearing(snapshot.matchedCourseDegrees);
  const speedMetersPerSecond = nonNegative(snapshot.speedMetersPerSecond);
  return {
    ...trackWithFix(next, {
      ...(accuracyMeters === undefined ? {} : { accuracyMeters }),
      capturedAtMs: nowMs,
      coordinate: {
        latitude: snapshot.rawCoordinate.latitude,
        longitude: snapshot.rawCoordinate.longitude,
      },
      ...(courseDegrees === undefined ? {} : { courseDegrees }),
      ...(speedMetersPerSecond === undefined ? {} : { speedMetersPerSecond }),
    }),
    navigationSequence: snapshot.sequence,
  };
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

/** Whether a fix may be drawn as the vehicle (the route-origin rule). */
export function isLiveFreeDriveFix(fix: FreeDriveFix | undefined, nowMs: number): boolean {
  return (
    fix?.accuracyMeters !== undefined &&
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
  const compass = validBearing(compassDegrees);
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
