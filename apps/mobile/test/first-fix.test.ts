import { describe, expect, it } from 'vitest';

import { findFirstFix, type FirstFixSource } from '../src/features/map/first-fix.js';

/** Lets every promise step the search has queued run; it awaits nothing but resolved promises. */
async function settled() {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

function rig({ lastKnown = null }: { lastKnown?: string | null | Error } = {}) {
  const lookup = Promise.withResolvers<string>();
  const events: string[] = [];
  let lookups = 0;
  const source: FirstFixSource<string> = {
    lastKnown: () =>
      lastKnown instanceof Error ? Promise.reject(lastKnown) : Promise.resolve(lastKnown),
    lookup: () => {
      lookups += 1;
      return lookup.promise;
    },
  };
  const listener = {
    onFix: (position: string) => events.push(`fix:${position}`),
    onGaveUp: () => events.push('gave-up'),
  };
  return { events, listener, lookup, lookups: () => lookups, source };
}

// On Android the phone watch runs beside this search (see `shouldWatchPhoneIdleLocation`); the
// search itself is the last known position and one lookup on both platforms.
describe('the map’s first position', () => {
  it('uses a last known position without asking for another', async () => {
    const r = rig({ lastKnown: 'cached' });
    findFirstFix(r.source, r.listener);
    await settled();

    expect(r.events).toEqual(['fix:cached']);
    expect(r.lookups()).toBe(0);
  });

  it('asks once when there is no last known position, and reports its position', async () => {
    const r = rig();
    findFirstFix(r.source, r.listener);
    await settled();
    r.lookup.resolve('network');
    await settled();

    expect(r.events).toEqual(['fix:network']);
    expect(r.lookups()).toBe(1);
  });

  it('reports the lookup’s failure', async () => {
    const r = rig();
    findFirstFix(r.source, r.listener);
    await settled();
    r.lookup.reject(new Error('Current location is unavailable'));
    await settled();

    expect(r.events).toEqual(['gave-up']);
  });

  it('gives up without a lookup when the last known position cannot be read', async () => {
    const r = rig({ lastKnown: new Error('provider') });
    findFirstFix(r.source, r.listener);
    await settled();

    expect(r.events).toEqual(['gave-up']);
    expect(r.lookups()).toBe(0);
  });

  it('reports nothing after it is stopped', async () => {
    const r = rig();
    const stop = findFirstFix(r.source, r.listener);
    await settled();

    stop();
    r.lookup.resolve('network');
    await settled();

    expect(r.events).toEqual([]);
  });

  it('reports no failure after it is stopped', async () => {
    const r = rig();
    const stop = findFirstFix(r.source, r.listener);
    await settled();

    stop();
    r.lookup.reject(new Error('Current location is unavailable'));
    await settled();

    expect(r.events).toEqual([]);
  });
});
