import { describe, expect, it, vi } from 'vitest';

import { createValueStore } from '../src/lib/value-store.js';

describe('value store', () => {
  it('notifies subscribers only when the value actually changes', () => {
    const store = createValueStore<number | undefined>(undefined);
    const listener = vi.fn();
    store.subscribe(listener);

    expect(store.set(14.25)).toBe(true);
    // A map camera reports the same quantised zoom on most frames; those must be free.
    expect(store.set(14.25)).toBe(false);
    expect(store.set(14.25)).toBe(false);
    expect(store.set(14.5)).toBe(true);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.get()).toBe(14.5);
  });

  it('stops notifying after unsubscribe and supports a custom equality', () => {
    const store = createValueStore(
      { degrees: 10 },
      (left, right) => left.degrees === right.degrees,
    );
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    expect(store.set({ degrees: 10 })).toBe(false);
    expect(store.set({ degrees: 11 })).toBe(true);
    unsubscribe();
    expect(store.set({ degrees: 12 })).toBe(true);

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
