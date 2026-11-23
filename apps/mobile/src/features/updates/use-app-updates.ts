import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { NavOSSUpdater } from '../../../modules/navoss-updater';
import { type AppUpdates, type AppUpdatesState, createAppUpdates } from './app-updates';
import { releasesUrl } from './update-feed';

const STORAGE_KEY = 'navoss.app-updates.v1';

/**
 * The app's updater, or undefined where there is none (iOS, where the native module is absent,
 * and web). The check is one anonymous GET, made by the native module so its size is capped.
 */
export const appUpdates: AppUpdates | undefined =
  NavOSSUpdater === null
    ? undefined
    : createAppUpdates({
        feedUrl: releasesUrl(),
        // The result code is the only thing recorded about a check.
        log: (code) => {
          console.info(`NavOSS update check: ${code}`);
        },
        native: NavOSSUpdater,
        now: Date.now,
        storage: {
          load: () => AsyncStorage.getItem(STORAGE_KEY),
          save: (value) => AsyncStorage.setItem(STORAGE_KEY, value),
        },
      });

const noUpdates = {
  get: () => undefined,
  subscribe: () => () => undefined,
};

export function useAppUpdatesState(): AppUpdatesState | undefined {
  const store = appUpdates?.store ?? noUpdates;
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/**
 * Starts the updater, tells it whether a trip is active (nothing installs during one), and runs the
 * once-a-day check on launch and whenever the app returns to the foreground, except during a trip.
 */
export function useAutomaticUpdateChecks(tripActive: boolean): void {
  useEffect(() => {
    if (appUpdates === undefined) return;
    const updater = appUpdates;
    updater.setTripActive(tripActive);
    void updater.start().then(() => updater.checkAutomatically(tripActive));
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      updater.resume();
      void updater.checkAutomatically(tripActive);
    });
    return () => {
      subscription.remove();
    };
  }, [tripActive]);
}
