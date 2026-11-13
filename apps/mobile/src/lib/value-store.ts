import { useSyncExternalStore } from 'react';

export interface ValueStore<T> {
  get: () => T;
  /** Returns whether the value changed. Setting an equal value notifies nobody. */
  set: (next: T) => boolean;
  subscribe: (listener: () => void) => () => void;
}

/**
 * A single observable value that lives outside React. High-frequency inputs (map camera frames,
 * compass ticks) are written here so that only the leaf components that subscribe re-render,
 * and only when the value actually differs.
 */
export function createValueStore<T>(
  initial: T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): ValueStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (isEqual(value, next)) return false;
      value = next;
      for (const listener of listeners) listener();
      return true;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useStoreValue<T>(store: ValueStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
