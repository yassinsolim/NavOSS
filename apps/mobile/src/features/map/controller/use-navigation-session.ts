import type { Coordinate } from '@navoss/contracts';
import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react';

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
  onFix: (coordinate: Coordinate | undefined, courseDegrees: number | undefined) => void;
  onTripEnded: () => void;
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

  const applySnapshot = useEffectEvent((next: NativeNavigationSnapshot) => {
    if (next.stateVersion < stateVersionRef.current) return;
    stateVersionRef.current = next.stateVersion;
    setSnapshot(next);
    setRouteStatus(next.routeStatus);
    setRerouteCount(next.rerouteCount);
    onFix(next.rawCoordinate, next.matchedCourseDegrees);
    setStepIndex(next.guidance?.stepIndex ?? 0);
    if (next.trip === undefined) {
      adoptedTripRef.current = undefined;
      onTripEnded();
      setRouteState((current) =>
        current.type === 'navigating' || current.type === 'arrived' ? { type: 'idle' } : current,
      );
      return;
    }
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
    if (routeChanged) setRouteSource(routeSourceForNativeTrip(trip.source));
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
