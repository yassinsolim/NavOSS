import type { NativeNavigationSnapshot } from '@/features/navigation/native-navigation';

type TripEndReason = NativeNavigationSnapshot['tripEndReason'];

/**
 * Whether the driver has finished with the latest trip-end notice, kept for the process so it
 * survives a remount of the map screen. Only a dismissal (or, on iOS, the notice timing out)
 * settles it: a notice that was shown but never dismissed is shown again after a remount.
 */
export interface TripEndNoticeMemory {
  isSettled: () => boolean;
  /** The driver dismissed the trip-end notice, or its time on screen ran out. */
  settle: () => void;
  /** A trip is active: its own end, later, is a new one. */
  tripActive: () => void;
}

export function createTripEndNoticeMemory(): TripEndNoticeMemory {
  let settled = false;
  return {
    isSettled: () => settled,
    settle: () => {
      settled = true;
    },
    tripActive: () => {
      settled = false;
    },
  };
}

/** The end to report for a snapshot without a trip: once per mount, never once settled. */
export function tripEndToReport(
  reason: TripEndReason,
  { reportedThisMount }: { reportedThisMount: boolean },
  memory: TripEndNoticeMemory,
): TripEndReason {
  if (reason === undefined || reportedThisMount || memory.isSettled()) return undefined;
  return reason;
}

/** The process-wide memory the map screen uses. */
export const TRIP_END_NOTICE = createTripEndNoticeMemory();
