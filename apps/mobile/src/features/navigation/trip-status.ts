import type { NativeNavigationSnapshot } from '@/features/navigation/native-navigation';
import type { VehicleMatchStatus } from '@/features/navigation/vehicle-puck';

type MatchSnapshot = Pick<
  NativeNavigationSnapshot,
  'isAcquiringPosition' | 'isOffRoute' | 'matchedCoordinate'
>;

/**
 * Whether the active trip is one restored after a relaunch that has not found its place on the
 * route yet. The core then sends no guidance, step or progress; the phone shows the trip as
 * resuming, with End, and no maneuver or estimate.
 */
export function isResumingTrip(snapshot: MatchSnapshot | undefined): boolean {
  return snapshot?.isAcquiringPosition === true;
}

/**
 * Where the vehicle stands relative to the route. Only a matched position is "on route": a raw
 * fix alone (before the first match, or while a restored trip finds its place) is still
 * acquiring.
 */
export function vehicleMatchStatus(snapshot: MatchSnapshot | undefined): VehicleMatchStatus {
  if (snapshot === undefined || isResumingTrip(snapshot)) return 'acquiring';
  if (snapshot.isOffRoute) return 'off-route';
  return snapshot.matchedCoordinate === undefined ? 'acquiring' : 'matched';
}

export interface TripNotice {
  message: string;
  title: string;
}

/** The trip panel's notice: shown only when the driver should know something. */
export function tripNotice({
  matchStatus,
  positionEstimated,
  rerouteCount,
  resuming,
}: {
  matchStatus: VehicleMatchStatus;
  positionEstimated: boolean;
  rerouteCount: number;
  resuming: boolean;
}): TripNotice | undefined {
  if (resuming) {
    return {
      message: 'Guidance resumes once GPS confirms where you are on the route.',
      title: 'Resuming your trip',
    };
  }
  if (positionEstimated) {
    return {
      message: 'Your position is being estimated along the route until GPS returns.',
      title: 'Weak GPS signal',
    };
  }
  if (matchStatus === 'acquiring') {
    return {
      message: 'Guidance starts as soon as your position is known.',
      title: 'Waiting for GPS',
    };
  }
  if (matchStatus === 'off-route') {
    return { message: 'NavOSS is working out how to get you back on track.', title: 'Off route' };
  }
  if (rerouteCount > 0) {
    return {
      message:
        rerouteCount === 1
          ? 'Your route was updated once on this trip.'
          : `Your route was updated ${String(rerouteCount)} times on this trip.`,
      title: 'Route updated',
    };
  }
  return undefined;
}

/** The trip's position status, as read in the trip panel's accessible summary. */
export function tripStatusLabel({
  matchStatus,
  positionEstimated,
  resuming,
}: {
  matchStatus: VehicleMatchStatus;
  positionEstimated: boolean;
  resuming: boolean;
}): string {
  if (resuming) return 'resuming trip, finding your place on the route';
  if (positionEstimated) return 'position estimated, waiting for GPS';
  if (matchStatus === 'matched') return 'on route';
  if (matchStatus === 'off-route') return 'off route';
  return 'acquiring route position';
}
