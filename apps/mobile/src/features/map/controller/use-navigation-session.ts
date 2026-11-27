import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react';

import { TRIP_END_NOTICE, tripEndToReport } from '@/features/map/controller/trip-end-notice-memory';
import {
  getNavigationSnapshot,
  type NativeNavigationSnapshot,
  observeNavigationSnapshots,
} from '@/features/navigation/native-navigation';
import {
  routeFromNativeTrip,
  routeSourceForNativeTrip,
  type RouteSource,
  type RouteUiState,
} from '@/features/navigation/route-ui-state';

export type NavigationRouteStatus = NativeNavigationSnapshot['routeStatus'];

export interface NavigationSession {
  /** Adopts the snapshot returned synchronously when the phone starts a trip. */
  adoptSnapshot: (snapshot: NativeNavigationSnapshot) => void;
  rerouteCount: number;
  /** Returns step, status and reroute counters to their start-of-trip values. */
  resetProgress: () => void;
  routeStatus: NavigationRouteStatus;
  snapshot: NativeNavigationSnapshot | undefined;
  stepIndex: number;
}

/**
 * Mirrors the native navigation core. The core owns location, matching, progress, rerouting and
 * arrival; the phone renders its snapshots and never computes guidance of its own. Snapshots
 * carry a state version so a late event can never roll the UI back.
 *
 * Wave 2 seam: new snapshot fields (lane guidance, current road, posted speed, traffic on the
 * active route) arrive here. Read them from `snapshot` in the guidance components; nothing in
 * this hook needs to change for an additive field.
 */
export function useNavigationSession({
  onFix,
  onTripEnded,
  routeState,
  setRouteSource,
  setRouteState,
}: {
  /** Every snapshot: the phone mirrors its position, and keeps it for the vehicle after End. */
  onFix: (snapshot: NativeNavigationSnapshot) => void;
  /** Called on every snapshot without a trip; `reason` once when the core ended a trip itself. */
  onTripEnded: (reason?: NativeNavigationSnapshot['tripEndReason']) => void;
  routeState: RouteUiState;
  setRouteSource: (source: RouteSource | undefined) => void;
  setRouteState: Dispatch<SetStateAction<RouteUiState>>;
}): NavigationSession {
  const stateVersionRef = useRef(-1);
  const adoptedTripRef = useRef<{ arrived: boolean; id: string; routeVersion: number } | undefined>(
    undefined,
  );
  const [snapshot, setSnapshot] = useState<NativeNavigationSnapshot>();
  const [routeStatus, setRouteStatus] = useState<NavigationRouteStatus>('tracking');
  const [rerouteCount, setRerouteCount] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  // Per mount: a remounted map reports an end again unless its notice was settled (dismissed).
  const reportedEndReasonRef = useRef<NativeNavigationSnapshot['tripEndReason']>(undefined);

  const applySnapshot = useEffectEvent((next: NativeNavigationSnapshot) => {
    if (next.stateVersion < stateVersionRef.current) return;
    stateVersionRef.current = next.stateVersion;
    setSnapshot(next);
    setRouteStatus(next.routeStatus);
    setRerouteCount(next.rerouteCount);
    onFix(next);
    setStepIndex(next.guidance?.stepIndex ?? 0);
    if (next.trip === undefined) {
      adoptedTripRef.current = undefined;
      const reason = tripEndToReport(
        next.tripEndReason,
        { reportedThisMount: reportedEndReasonRef.current !== undefined },
        TRIP_END_NOTICE,
      );
      reportedEndReasonRef.current = next.tripEndReason;
      onTripEnded(reason);
      setRouteState((current) =>
        current.type === 'navigating' || current.type === 'arrived' ? { type: 'idle' } : current,
      );
      return;
    }
    reportedEndReasonRef.current = undefined;
    TRIP_END_NOTICE.tripActive();
    // Snapshots arrive about once a second. Rebuilding the route copies every polyline, so it
    // happens only when the core reports a different route or a different phase of it.
    const trip = next.trip;
    const arrived = next.phase === 'arrived';
    const adopted = adoptedTripRef.current;
    const routeChanged =
      adopted?.id !== trip.id ||
      adopted.routeVersion !== next.routeVersion ||
      adopted.arrived !== arrived;
    adoptedTripRef.current = { arrived, id: trip.id, routeVersion: next.routeVersion };
    setRouteState((current) => {
      const showsTrip =
        (current.type === 'navigating' || current.type === 'arrived') &&
        current.route.id === trip.id &&
        (current.type === 'arrived') === arrived;
      if (showsTrip && !routeChanged) return current;
      const { destination, route, waypoints } = routeFromNativeTrip(trip);
      return {
        destination,
        route,
        routes: [route],
        type: arrived ? 'arrived' : 'navigating',
        waypoints,
      };
    });
    if (routeChanged) setRouteSource(routeSourceForNativeTrip(trip.source, trip.trafficSource));
  });

  useEffect(() => {
    const subscription = observeNavigationSnapshots(applySnapshot);
    applySnapshot(getNavigationSnapshot());
    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (routeState.type !== 'navigating' || snapshot?.phase !== 'arrived') return;
    setStepIndex(Math.max(0, routeState.route.steps.length - 1));
    setRouteState({
      destination: routeState.destination,
      route: routeState.route,
      routes: routeState.routes,
      type: 'arrived',
      waypoints: routeState.waypoints,
    });
  }, [routeState, setRouteState, snapshot]);

  return {
    adoptSnapshot: (next) => {
      stateVersionRef.current = Math.max(stateVersionRef.current, next.stateVersion);
      // The phone already holds this route; its first snapshot must not rebuild it.
      adoptedTripRef.current =
        next.trip === undefined
          ? undefined
          : {
              arrived: next.phase === 'arrived',
              id: next.trip.id,
              routeVersion: next.routeVersion,
            };
      setSnapshot(next);
    },
    rerouteCount,
    resetProgress: () => {
      setStepIndex(0);
      setRouteStatus('tracking');
      setRerouteCount(0);
    },
    routeStatus,
    snapshot,
    stepIndex,
  };
}
