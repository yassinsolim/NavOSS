import { describe, expect, it } from 'vitest';

import { findFirstFix, type FirstFixSource } from '../src/features/map/first-fix.js';

/** Lets every promise step the search has queued run; it awaits nothing but resolved promises. */
async function settled() {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

function rig({ lastKnown = null }: { lastKnown?: string | null | Error } = {}) {
  const lookup = Promise.withResolvers<string>();
  const events: string[] = [];
  let emit: ((position: string) => void) | undefined;
  let lookups = 0;
  let watches = 0;
  let removals = 0;
  const started = Promise.withResolvers<{ remove: () => void }>();
  const source: Required<FirstFixSource<string>> = {
    lastKnown: () =>
      lastKnown instanceof Error ? Promise.reject(lastKnown) : Promise.resolve(lastKnown),
    lookup: () => {
      lookups += 1;
      return lookup.promise;
    },
    watch: (onPosition) => {
      watches += 1;
      emit = onPosition;
      return started.promise;
    },
  };
  const listener = {
    onFix: (position: string) => events.push(`fix:${position}`),
    onGaveUp: () => events.push('gave-up'),
  };
  return {
    counts: () => ({ lookups, removals, watches }),
    emit: (position: string) => emit?.(position),
    events,
    listener,
    lookup,
    source,
    startWatch: () => started.resolve({ remove: () => (removals += 1) }),
  };
}

describe('the map’s first position', () => {
  it('uses a last known position without asking for another', async () => {
    const r = rig({ lastKnown: 'cached' });
    findFirstFix(r.source, r.listener);
    await settled();

    expect(r.events).toEqual(['fix:cached']);
    expect(r.counts()).toEqual({ lookups: 0, removals: 0, watches: 0 });
  });

  it('takes the watch’s position while the lookup is still waiting, and stops the watch', async () => {
    const r = rig();
    findFirstFix(r.source, r.listener);
    await settled();
    r.startWatch();
    await settled();

    r.emit('gps');
    r.emit('gps-2');
    r.lookup.resolve('network');
    await settled();

    expect(r.events).toEqual(['fix:gps']);
    expect(r.counts()).toEqual({ lookups: 1, removals: 1, watches: 1 });
  });

  it('takes the lookup’s position when it answers first, and stops the watch', async () => {
    const r = rig();
    findFirstFix(r.source, r.listener);
    await settled();
    r.startWatch();
    r.lookup.resolve('network');
    await settled();
    r.emit('gps');

    expect(r.events).toEqual(['fix:network']);
    expect(r.counts().removals).toBe(1);
  });

  it('keeps waiting on the watch after the lookup gives up', async () => {
    const r = rig();
    findFirstFix(r.source, r.listener);
    await settled();
    r.startWatch();
    r.lookup.reject(new Error('Current location is unavailable'));
    await settled();
    expect(r.events).toEqual(['gave-up']);
    expect(r.counts().removals).toBe(0);

    r.emit('gps');

    expect(r.events).toEqual(['gave-up', 'fix:gps']);
    expect(r.counts().removals).toBe(1);
  });

  it('does not report a lookup failure after the watch has answered', async () => {
    const r = rig();
    findFirstFix(r.source, r.listener);
    await settled();
    r.startWatch();
    await settled();
    r.emit('gps');
    r.lookup.reject(new Error('Current location is unavailable'));
    await settled();

    expect(r.events).toEqual(['fix:gps']);
  });

  it('removes a watch that only finishes starting after the position arrived', async () => {
    const r = rig();
    findFirstFix(r.source, r.listener);
    await settled();
    r.lookup.resolve('network');
    await settled();
    r.startWatch();
    await settled();

    expect(r.events).toEqual(['fix:network']);
    expect(r.counts().removals).toBe(1);
  });

  it('reports nothing after it is stopped, and removes the watch', async () => {
    const r = rig();
    const stop = findFirstFix(r.source, r.listener);
    await settled();
    r.startWatch();
    await settled();

    stop();
    r.emit('gps');
    r.lookup.resolve('network');
    await settled();

    expect(r.events).toEqual([]);
    expect(r.counts().removals).toBe(1);
  });

  it('without a watch, reports the lookup’s failure and nothing else', async () => {
    const r = rig();
    const { watch: _watch, ...lookupOnly } = r.source;
    findFirstFix(lookupOnly, r.listener);
    await settled();
    r.lookup.reject(new Error('denied'));
    await settled();

    expect(r.events).toEqual(['gave-up']);
    expect(r.counts().watches).toBe(0);
  });

  it('gives up when the last known position cannot be read, still watching', async () => {
    const r = rig({ lastKnown: new Error('provider') });
    findFirstFix(r.source, r.listener);
    await settled();
    r.startWatch();
    await settled();
    expect(r.events).toEqual(['gave-up']);
    expect(r.counts()).toEqual({ lookups: 0, removals: 0, watches: 1 });

    r.emit('gps');

    expect(r.events).toEqual(['gave-up', 'fix:gps']);
  });
});
