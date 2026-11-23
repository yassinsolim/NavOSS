import {
  isCoordinateInBounds,
  serverAreaForCoordinate,
  type Coordinate,
  type ServerCoverage,
} from '@navoss/contracts';
import * as Location from 'expo-location';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { AppState } from 'react-native';

import {
  automaticLocationOptions,
  phoneIdleLocationWatchOptions,
} from '@/features/map/idle-camera-follow';
import { ensureForegroundLocationPermission } from '@/features/map/map-location';
import {
  type MapRegion,
  mapRegionForCoordinate,
  TORONTO_CAMERA_BOUNDS,
} from '@/features/map/map-region';
import {
  currentLocationFix,
  newestValidRouteOriginSample,
  routeOriginFailureMessage,
  routeOriginSampleFromLocation,
  routeRequestOriginFromSample,
  type RouteOriginSample,
  type RouteRequestOrigin,
} from '@/features/navigation/route-origin';
import { RouteOriginUnavailableError } from '@/features/navigation/route-ui-state';
import { createValueStore, type ValueStore } from '@/lib/value-store';
import { IS_ANDROID } from '@/lib/device-copy';

export type LocationState = 'denied' | 'error' | 'idle' | 'locating' | 'visible';

export interface UserLocation {
  /** Records a fix from a location subscription. */
  applySample: (sample: RouteOriginSample) => void;
  /**
   * Compass facing. It ticks many times a second, so it lives in a store that only the heading
   * cone layer subscribes to; nothing else re-renders when the phone turns.
   */
  deviceHeadingStore: ValueStore<number | undefined>;
  /** Resolves a fresh, accurate origin for a route request, prompting for permission if needed. */
  getCurrentRouteOrigin: (signal: AbortSignal) => Promise<RouteRequestOrigin | undefined>;
  /**
   * A fresh, accurate fix (the route-origin rules: at most 15 s old, 100 m accuracy), asking for
   * permission and a new fix when the cached one does not qualify. Throws when location is
   * denied or no qualifying fix arrives; undefined only when aborted.
   */
  getFreshLocationSample: (signal: AbortSignal) => Promise<RouteOriginSample | undefined>;
  inTorontoCameraBounds: boolean;
  /**
   * One-shot high-accuracy fix for the locate button: the fix, `'denied'` without permission,
   * `'no-fix'` when the device found no location in time, or undefined if the app left the screen.
   */
  locate: () => Promise<Coordinate | 'denied' | 'no-fix' | undefined>;
  locationState: LocationState;
  mapRegion: MapRegion;
  /** Origin for nearby search, or undefined outside (or before) the server's declared coverage. */
  searchOrigin: Coordinate | undefined;
  setLocationState: (state: LocationState) => void;
  /** Position reported by the navigation core while a trip is active. */
  setNavigationFix: (coordinate: Coordinate | undefined, courseDegrees: number | undefined) => void;
  userCoordinate: Coordinate | undefined;
  /** Course over ground: direction of travel, available only while moving. */
  userHeading: number;
}

/**
 * Foreground location for the phone map: the last fix, permission state, and the one-shot
 * lookups. The navigation core owns location during a trip; this hook only mirrors its fixes.
 * The subscriptions that feed it live in `useLocationWatches`, which runs once the screen knows
 * whether the phone map is visible.
 *
 * Wave 2 seam: opt-in speed probes are sampled by the native navigation core, not
 * here. This hook is the place to read the consent flag if the idle watch ever needs it.
 */
export function useUserLocation(coverage: ServerCoverage | undefined): UserLocation {
  const routeOriginSampleRef = useRef<RouteOriginSample | undefined>(undefined);
  const [deviceHeadingStore] = useState(() => createValueStore<number | undefined>(undefined));
  const [locationState, setLocationState] = useState<LocationState>('idle');
  const [userCoordinate, setUserCoordinate] = useState<Coordinate>();
  const [userHeading, setUserHeading] = useState(0);

  const applySample = (sample: RouteOriginSample) => {
    routeOriginSampleRef.current = sample;
    setUserCoordinate(sample.coordinate);
    if (sample.headingDegrees !== undefined) setUserHeading(sample.headingDegrees);
  };

  const getFreshLocationSample = async (
    signal: AbortSignal,
  ): Promise<RouteOriginSample | undefined> => {
    // Read through a function: the signal flips while these lookups are awaiting.
    const aborted = () => signal.aborted;
    if (aborted()) return undefined;
    const cached = routeOriginSampleRef.current;
    if (routeRequestOriginFromSample(cached) !== undefined) return cached;

    setLocationState('locating');
    const granted = await ensureForegroundLocationPermission(
      Location.getForegroundPermissionsAsync,
      Location.requestForegroundPermissionsAsync,
    );
    if (aborted()) return undefined;
    if (!granted) {
      setLocationState('denied');
      throw new RouteOriginUnavailableError(
        `Allow NavOSS to use your location in ${IS_ANDROID ? 'Settings' : 'iPhone Settings'} to calculate a route.`,
      );
    }

    const lastKnown = await Location.getLastKnownPositionAsync({
      maxAge: 15_000,
      requiredAccuracy: 100,
    });
    const location =
      lastKnown ??
      (await currentLocationFix(
        {
          currentPosition: () =>
            Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
          servicesEnabled: Location.hasServicesEnabledAsync,
        },
        IS_ANDROID,
      ));
    if (aborted()) return undefined;
    if (location === 'no-fix' || location === 'services-off') {
      setLocationState('error');
      throw new RouteOriginUnavailableError(routeOriginFailureMessage(location));
    }
    const sample = routeOriginSampleFromLocation(location);
    const selectedSample = newestValidRouteOriginSample(sample, routeOriginSampleRef.current);
    const routeOrigin = routeRequestOriginFromSample(selectedSample);
    if (selectedSample === undefined || routeOrigin === undefined) {
      throw new RouteOriginUnavailableError(routeOriginFailureMessage('stale-fix'));
    }
    if (aborted()) return undefined;
    applySample(selectedSample);
    setLocationState('visible');
    return selectedSample;
  };

  const getCurrentRouteOrigin = async (
    signal: AbortSignal,
  ): Promise<RouteRequestOrigin | undefined> =>
    routeRequestOriginFromSample(await getFreshLocationSample(signal));

  const locate = async (): Promise<Coordinate | 'denied' | 'no-fix' | undefined> => {
    setLocationState('locating');
    const appIsActive = () => AppState.currentState === 'active';
    try {
      const granted = await ensureForegroundLocationPermission(
        Location.getForegroundPermissionsAsync,
        Location.requestForegroundPermissionsAsync,
      );
      if (!appIsActive()) return undefined;
      if (!granted) {
        setLocationState('denied');
        return 'denied';
      }
      const location = await currentLocationFix(
        {
          currentPosition: () =>
            Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
          servicesEnabled: Location.hasServicesEnabledAsync,
        },
        IS_ANDROID,
      );
      if (!appIsActive()) return undefined;
      if (location === 'no-fix' || location === 'services-off') {
        setLocationState('error');
        return 'no-fix';
      }
      const sample = routeOriginSampleFromLocation(location);
      applySample(sample);
      setLocationState('visible');
      return sample.coordinate;
    } catch {
      setLocationState('error');
      // iOS keeps its silent failure (the button can simply be tapped again); only the Android
      // build, where a missing fix is the normal case on GPS-less handhelds, says why.
      return IS_ANDROID ? 'no-fix' : undefined;
    }
  };

  const setNavigationFix = (
    coordinate: Coordinate | undefined,
    courseDegrees: number | undefined,
  ) => {
    if (coordinate !== undefined) setUserCoordinate(coordinate);
    if (courseDegrees !== undefined) setUserHeading(courseDegrees);
  };

  const mapRegion = mapRegionForCoordinate(userCoordinate);
  const searchArea =
    coverage === undefined ? undefined : serverAreaForCoordinate(coverage, userCoordinate);

  return {
    applySample,
    deviceHeadingStore,
    getCurrentRouteOrigin,
    getFreshLocationSample,
    inTorontoCameraBounds:
      userCoordinate !== undefined && isCoordinateInBounds(userCoordinate, TORONTO_CAMERA_BOUNDS),
    locate,
    locationState,
    mapRegion,
    searchOrigin: searchArea === undefined ? undefined : userCoordinate,
    setLocationState,
    setNavigationFix,
    userCoordinate,
    userHeading,
  };
}

/**
 * The subscriptions behind `useUserLocation`: the first fix when the phone map becomes visible,
 * the compass, and the idle position watch. Each stops as soon as its condition is false, so
 * nothing samples location while the map is hidden or CarPlay owns the handset.
 */
export function useLocationWatches(
  location: UserLocation,
  { phoneMapVisible, watchIdlePosition }: { phoneMapVisible: boolean; watchIdlePosition: boolean },
): void {
  const { applySample, deviceHeadingStore, locationState, setLocationState } = location;
  const onSample = useEffectEvent(applySample);
  const onLocationState = useEffectEvent(setLocationState);

  useEffect(() => {
    if (!phoneMapVisible) return;
    let cancelled = false;
    const active = () => !cancelled;
    let recovery: Location.LocationSubscription | undefined;
    onLocationState('locating');
    void ensureForegroundLocationPermission(
      Location.getForegroundPermissionsAsync,
      Location.requestForegroundPermissionsAsync,
    )
      .then(async (granted) => {
        if (!active()) return;
        if (!granted) {
          onLocationState('denied');
          return;
        }
        const lastKnown = await Location.getLastKnownPositionAsync({
          maxAge: 60_000,
          requiredAccuracy: 500,
        });
        if (!active()) return;
        const position =
          lastKnown ??
          (await Location.getCurrentPositionAsync(
            automaticLocationOptions(Location.Accuracy.Balanced),
          ));
        if (!active()) return;
        onSample(routeOriginSampleFromLocation(position));
        onLocationState('visible');
      })
      .catch(() => {
        if (!active()) return;
        onLocationState('error');
        // Android's one-shot lookup fails at once when the provider has no fix yet (a cold start
        // with permission already granted), and the idle watch only runs once a fix is visible.
        // Wait for the first fix instead of leaving "Current location unavailable" until the
        // driver taps Center. iOS's lookup waits for a fix itself.
        if (!IS_ANDROID) return;
        let recovered = false;
        void Location.watchPositionAsync(
          automaticLocationOptions(Location.Accuracy.Balanced),
          (position) => {
            if (!active() || recovered) return;
            recovered = true;
            recovery?.remove();
            recovery = undefined;
            onSample(routeOriginSampleFromLocation(position));
            onLocationState('visible');
          },
        )
          .then((subscription) => {
            if (active() && !recovered) recovery = subscription;
            else subscription.remove();
          })
          .catch(() => undefined);
      });
    return () => {
      cancelled = true;
      recovery?.remove();
    };
  }, [phoneMapVisible]);

  useEffect(() => {
    if (locationState !== 'visible' || !phoneMapVisible) return;
    let active = true;
    let subscription: Location.LocationSubscription | undefined;
    void Location.watchHeadingAsync((heading) => {
      if (!active) return;
      // trueHeading is -1 until the magnetometer has a bearing to true north; magHeading still
      // points the right way, so prefer true and fall back rather than showing nothing.
      const facing = heading.trueHeading >= 0 ? heading.trueHeading : heading.magHeading;
      // Whole degrees: the cone cannot show less, and it stops sub-degree jitter redrawing it.
      deviceHeadingStore.set(
        Number.isFinite(facing) && facing >= 0 ? Math.round(facing) : undefined,
      );
    })
      .then((nextSubscription) => {
        if (active) subscription = nextSubscription;
        else nextSubscription.remove();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      subscription?.remove();
    };
  }, [deviceHeadingStore, locationState, phoneMapVisible]);

  useEffect(() => {
    if (!watchIdlePosition) return;
    let active = true;
    let subscription: Location.LocationSubscription | undefined;
    void Location.watchPositionAsync(
      phoneIdleLocationWatchOptions(Location.Accuracy.High),
      (position) => {
        if (active) onSample(routeOriginSampleFromLocation(position));
      },
    )
      .then((nextSubscription) => {
        if (active) subscription = nextSubscription;
        else nextSubscription.remove();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      subscription?.remove();
    };
  }, [watchIdlePosition]);
}
