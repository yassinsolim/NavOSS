import {
  isCoordinateInBounds,
  serverAreaForCoordinate,
  type Coordinate,
  type ServerCoverage,
} from '@navoss/contracts';
import * as Location from 'expo-location';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { findFirstFix } from '@/features/map/first-fix';
import {
  EMPTY_FREE_DRIVE_TRACK,
  type FreeDriveTrack,
  freeDriveFixFromLocation,
  trackWithFix,
  trackWithTripSnapshot,
} from '@/features/map/free-drive-vehicle';
import {
  automaticLocationOptions,
  type LocationPermission,
  type LocationState,
  phoneIdleLocationWatchOptions,
} from '@/features/map/idle-camera-follow';
import {
  EMPTY_LOOKUP_LEDGER,
  type LookupLedger,
  lookupOutcome,
  phoneWatchFix,
} from '@/features/map/location-lookup';
import {
  ensureForegroundLocationPermission,
  mapLocationPermissionRequest,
} from '@/features/map/map-location';
import {
  type MapRegion,
  mapRegionForCoordinate,
  TORONTO_CAMERA_BOUNDS,
} from '@/features/map/map-region';
import {
  currentLocationFix,
  deviceLacksGps,
  newestValidRouteOriginSample,
  routeOriginFailureMessage,
  routeOriginSampleFromLocation,
  routeRequestOriginFromSample,
  type RouteOriginSample,
  type RouteRequestOrigin,
} from '@/features/navigation/route-origin';
import {
  getLocationAvailability,
  type NativeNavigationSnapshot,
} from '@/features/navigation/native-navigation';
import { RouteOriginUnavailableError } from '@/features/navigation/route-ui-state';
import { tripVehicleCourseDegrees } from '@/features/navigation/vehicle-heading';
import { createValueStore, type ValueStore } from '@/lib/value-store';
import { IS_ANDROID } from '@/lib/device-copy';

/** The first-fix effect's permission request: once per session on Android (see the helper). */
const automaticLocationPermission = mapLocationPermissionRequest(
  IS_ANDROID,
  Location.getForegroundPermissionsAsync,
  Location.requestForegroundPermissionsAsync,
);

export interface UserLocation {
  /** Records a fix from a location subscription. */
  applyLocation: (location: Location.LocationObject) => void;
  /** Records that a one-shot lookup starts; pass the result to `settleLookup` when it ends. */
  beginLookup: () => LookupLedger;
  /**
   * Compass facing. It ticks many times a second, so it lives in a store that only the heading
   * cone layer subscribes to; nothing else re-renders when the phone turns.
   */
  deviceHeadingStore: ValueStore<number | undefined>;
  /** Android only: location is on but the device has no GPS receiver, so no drive can be followed. */
  deviceHasNoGps: boolean;
  /**
   * The newest fix with its speed and course, and the course it last proved, for the vehicle the
   * map draws without a trip. A store, so only the vehicle re-renders when it changes.
   */
  freeDriveTrackStore: ValueStore<FreeDriveTrack>;
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
  /** Foreground permission as last learned by the first-fix search, Center or a route request. */
  locationPermission: LocationPermission;
  locationState: LocationState;
  mapRegion: MapRegion;
  /** Origin for nearby search, or undefined outside (or before) the server's declared coverage. */
  searchOrigin: Coordinate | undefined;
  setLocationPermission: (permission: LocationPermission) => void;
  setLocationState: (state: LocationState) => void;
  /**
   * Ends a lookup begun with `beginLookup`, with its fix or undefined when it found none: applies
   * what `lookupOutcome` allows, and returns that decision.
   */
  settleLookup: (
    started: LookupLedger,
    location: Location.LocationObject | undefined,
  ) => ReturnType<typeof lookupOutcome>;
  /** Mirrors the navigation core's snapshot while a trip is active. */
  setNavigationFix: (snapshot: NativeNavigationSnapshot) => void;
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
  const [freeDriveTrackStore] = useState(() =>
    createValueStore<FreeDriveTrack>(EMPTY_FREE_DRIVE_TRACK),
  );
  const [locationState, setLocationState] = useState<LocationState>('idle');
  const [locationPermission, setLocationPermission] = useState<LocationPermission>('unknown');
  const lookupLedgerRef = useRef<LookupLedger>(EMPTY_LOOKUP_LEDGER);
  const [userCoordinate, setUserCoordinate] = useState<Coordinate>();
  const [userHeading, setUserHeading] = useState(0);
  const [deviceHasNoGps, setDeviceHasNoGps] = useState(false);

  // Read again whenever the app returns, since location may have been switched on meanwhile.
  useEffect(() => {
    if (!IS_ANDROID) return;
    let cancelled = false;
    const read = () => {
      Location.getProviderStatusAsync().then(
        (status) => {
          if (!cancelled) setDeviceHasNoGps(deviceLacksGps(status));
        },
        () => undefined,
      );
    };
    read();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') read();
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  const applySample = (sample: RouteOriginSample) => {
    lookupLedgerRef.current = {
      ...lookupLedgerRef.current,
      fixesApplied: lookupLedgerRef.current.fixesApplied + 1,
    };
    routeOriginSampleRef.current = sample;
    setUserCoordinate(sample.coordinate);
    if (sample.headingDegrees !== undefined) setUserHeading(sample.headingDegrees);
  };

  const recordFreeDriveFix = (location: Location.LocationObject) => {
    freeDriveTrackStore.set(
      trackWithFix(freeDriveTrackStore.get(), freeDriveFixFromLocation(location), Date.now()),
    );
  };

  const applyLocation = (location: Location.LocationObject) => {
    recordFreeDriveFix(location);
    applySample(routeOriginSampleFromLocation(location));
  };

  const beginLookup = (): LookupLedger => {
    lookupLedgerRef.current = {
      ...lookupLedgerRef.current,
      latestLookup: lookupLedgerRef.current.latestLookup + 1,
    };
    return lookupLedgerRef.current;
  };

  const outcomeOf = (started: LookupLedger, found: boolean) =>
    lookupOutcome({ android: IS_ANDROID, found, now: lookupLedgerRef.current, started });

  const settleLookup = (started: LookupLedger, location: Location.LocationObject | undefined) => {
    const outcome = outcomeOf(started, location !== undefined);
    if (outcome.applyFix && location !== undefined) applyLocation(location);
    if (outcome.state !== undefined) setLocationState(outcome.state);
    return outcome;
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
    const started = beginLookup();
    const granted = await ensureForegroundLocationPermission(
      Location.getForegroundPermissionsAsync,
      Location.requestForegroundPermissionsAsync,
    );
    setLocationPermission(granted ? 'granted' : 'denied');
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
      const failed = outcomeOf(started, false);
      if (failed.state !== undefined) setLocationState(failed.state);
      // Android: a device without GPS (a handheld) can only have a Wi-Fi position; say so.
      const failure =
        location === 'no-fix' && IS_ANDROID && getLocationAvailability() === 'no-gps'
          ? 'no-gps'
          : location;
      throw new RouteOriginUnavailableError(routeOriginFailureMessage(failure));
    }
    const sample = routeOriginSampleFromLocation(location);
    // A stale lookup (Android: a newer one has started) still answers its route request, but
    // leaves the map to the newer one.
    const found = outcomeOf(started, true);
    if (found.applyFix) recordFreeDriveFix(location);
    const selectedSample = newestValidRouteOriginSample(sample, routeOriginSampleRef.current);
    const routeOrigin = routeRequestOriginFromSample(selectedSample);
    if (selectedSample === undefined || routeOrigin === undefined) {
      throw new RouteOriginUnavailableError(routeOriginFailureMessage('stale-fix'));
    }
    if (aborted()) return undefined;
    if (found.applyFix) applySample(selectedSample);
    if (found.state !== undefined) setLocationState(found.state);
    return selectedSample;
  };

  const getCurrentRouteOrigin = async (
    signal: AbortSignal,
  ): Promise<RouteRequestOrigin | undefined> =>
    routeRequestOriginFromSample(await getFreshLocationSample(signal));

  const locate = async (): Promise<Coordinate | 'denied' | 'no-fix' | undefined> => {
    setLocationState('locating');
    const started = beginLookup();
    const appIsActive = () => AppState.currentState === 'active';
    // `lookupOutcome` decides what the lookup's end changes. Android: nothing once a newer lookup
    // has started (that one answers), and a failure after the watch put a fix on the map during
    // the lookup returns that fix rather than a failure. iOS: always the lookup's own result.
    const settledFailure = (failure: 'no-fix' | undefined): Coordinate | 'no-fix' | undefined => {
      const { state } = settleLookup(started, undefined);
      if (state === 'visible') return routeOriginSampleRef.current?.coordinate;
      return state === 'error' ? failure : undefined;
    };
    try {
      const granted = await ensureForegroundLocationPermission(
        Location.getForegroundPermissionsAsync,
        Location.requestForegroundPermissionsAsync,
      );
      setLocationPermission(granted ? 'granted' : 'denied');
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
      if (location === 'no-fix' || location === 'services-off') return settledFailure('no-fix');
      if (settleLookup(started, location).state === undefined) return undefined;
      return { latitude: location.coords.latitude, longitude: location.coords.longitude };
    } catch {
      // iOS keeps its silent failure (the button can simply be tapped again); only the Android
      // build, where a missing fix is the normal case on GPS-less handhelds, says why.
      return settledFailure(IS_ANDROID ? 'no-fix' : undefined);
    }
  };

  const setNavigationFix = (snapshot: NativeNavigationSnapshot) => {
    freeDriveTrackStore.set(trackWithTripSnapshot(freeDriveTrackStore.get(), snapshot));
    if (snapshot.rawCoordinate !== undefined) setUserCoordinate(snapshot.rawCoordinate);
    const course = tripVehicleCourseDegrees(snapshot);
    if (course !== undefined) setUserHeading(course);
  };

  const mapRegion = mapRegionForCoordinate(userCoordinate);
  const searchArea =
    coverage === undefined ? undefined : serverAreaForCoordinate(coverage, userCoordinate);

  return {
    applyLocation,
    beginLookup,
    deviceHasNoGps,
    deviceHeadingStore,
    freeDriveTrackStore,
    getCurrentRouteOrigin,
    getFreshLocationSample,
    inTorontoCameraBounds:
      userCoordinate !== undefined && isCoordinateInBounds(userCoordinate, TORONTO_CAMERA_BOUNDS),
    locate,
    locationPermission,
    locationState,
    mapRegion,
    searchOrigin: searchArea === undefined ? undefined : userCoordinate,
    setLocationPermission,
    setLocationState,
    setNavigationFix,
    settleLookup,
    userCoordinate,
    userHeading,
  };
}

/**
 * The subscriptions behind `useUserLocation`: the first fix when the phone map becomes visible,
 * the compass, and the idle position watch. Each stops as soon as its condition is false, so
 * nothing samples location while the map is hidden or CarPlay owns the handset. On Android the
 * idle watch runs whenever permission is granted (`shouldWatchPhoneIdleLocation`), beside the
 * first-fix search and Center's lookup; its first fix ends the search and its fixes bring a failed
 * lookup's map back to `'visible'` (`phoneWatchFix`). iOS watches only while a position is shown.
 */
export function useLocationWatches(
  location: UserLocation,
  { phoneMapVisible, watchIdlePosition }: { phoneMapVisible: boolean; watchIdlePosition: boolean },
): void {
  const {
    applyLocation,
    beginLookup,
    deviceHeadingStore,
    locationState,
    setLocationPermission,
    setLocationState,
    settleLookup,
  } = location;
  const onLocationState = useEffectEvent(setLocationState);
  const onLocationPermission = useEffectEvent(setLocationPermission);
  const onLookupStarted = useEffectEvent(beginLookup);
  const onLookupSettled = useEffectEvent(settleLookup);
  /** Stops the first-fix search in flight, if any. */
  const stopFirstFixSearchRef = useRef<(() => void) | undefined>(undefined);
  const onWatchFix = useEffectEvent((position: Location.LocationObject) => {
    applyLocation(position);
    const next = phoneWatchFix(IS_ANDROID, locationState);
    if (next.stopsFirstFixSearch) {
      stopFirstFixSearchRef.current?.();
      stopFirstFixSearchRef.current = undefined;
    }
    if (next.state !== locationState) setLocationState(next.state);
  });

  useEffect(() => {
    if (!phoneMapVisible) return;
    let cancelled = false;
    onLocationState('locating');
    void automaticLocationPermission()
      .then((granted) => {
        if (cancelled) return;
        onLocationPermission(granted ? 'granted' : 'denied');
        if (!granted) {
          onLocationState('denied');
          return;
        }
        // Android: granting starts the phone watch beside this search; its first fix stops it.
        const started = onLookupStarted();
        stopFirstFixSearchRef.current = findFirstFix<Location.LocationObject>(
          {
            lastKnown: () =>
              Location.getLastKnownPositionAsync({ maxAge: 60_000, requiredAccuracy: 500 }),
            lookup: () =>
              Location.getCurrentPositionAsync(
                automaticLocationOptions(Location.Accuracy.Balanced),
              ),
          },
          {
            onFix: (position) => {
              onLookupSettled(started, position);
            },
            onGaveUp: () => {
              onLookupSettled(started, undefined);
            },
          },
        );
      })
      .catch(() => {
        if (!cancelled) onLocationState('error');
      });
    return () => {
      cancelled = true;
      stopFirstFixSearchRef.current?.();
      stopFirstFixSearchRef.current = undefined;
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
        if (active) onWatchFix(position);
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
