import type { GooglePlaceQueryGrantResponse } from '@navoss/contracts';
import { describe, expect, it } from 'vitest';

import {
  GoogleLoadSequencer,
  settlesGoogleLoad,
} from '../src/features/map/google-place-details.js';

const grant: GooglePlaceQueryGrantResponse = {
  granted: true,
  limit: 8_000,
  period: '2026-11',
  remaining: 7_000,
  resetsAt: '2026-12-01T00:00:00.000Z',
};

function harness(response: GooglePlaceQueryGrantResponse = grant) {
  let grants = 0;
  const sequencer = new GoogleLoadSequencer(() => {
    grants += 1;
    return Promise.resolve(response);
  });
  return { grants: () => grants, sequencer };
}

describe('Google load sequencer', () => {
  it('starts exactly one new load when the driver retries a search that found nothing', async () => {
    const { grants, sequencer } = harness();

    const nearest = await sequencer.begin('nearest');
    expect(nearest).toEqual({ kind: 'load', load: { phase: 'nearest', request: 1 } });
    sequencer.settle();

    const search = await sequencer.begin('search');
    expect(search).toEqual({ kind: 'load', load: { phase: 'search', request: 2 } });
    sequencer.settle(); // Google's search list came back empty.

    const retry = await sequencer.begin('search');
    // Same phase, new request: the native view's key changes, so one new component loads.
    expect(retry).toEqual({ kind: 'load', load: { phase: 'search', request: 3 } });
    expect(grants()).toBe(3);
  });

  it('spends no grant on a second tap while a grant or a load is in progress', async () => {
    const { grants, sequencer } = harness();

    const first = sequencer.begin('search');
    expect(sequencer.inProgress).toBe(true);
    expect(await sequencer.begin('search')).toEqual({ kind: 'busy' });
    await first;
    // Granted and loading, not yet settled by the native view.
    expect(await sequencer.begin('search')).toEqual({ kind: 'busy' });
    expect(grants()).toBe(1);

    sequencer.settle();
    expect(sequencer.inProgress).toBe(false);
    expect(await sequencer.begin('search')).toMatchObject({ kind: 'load' });
    expect(grants()).toBe(2);
  });

  it('frees the control after a refused or failed grant without starting a load', async () => {
    const refused = harness({ ...grant, granted: false, remaining: 0 });
    expect(await refused.sequencer.begin('nearest')).toEqual({ kind: 'refused' });
    expect(await refused.sequencer.begin('search')).toEqual({ kind: 'refused' });
    expect(refused.grants()).toBe(2);
    expect(refused.sequencer.inProgress).toBe(false);

    const failing = new GoogleLoadSequencer(() => Promise.reject(new TypeError('offline')));
    expect(await failing.begin('nearest')).toEqual({ kind: 'failed', state: 'offline' });
    expect(await failing.begin('nearest')).toEqual({ kind: 'failed', state: 'offline' });
  });

  it('frees the control when Google answers, not while it is loading', () => {
    expect(settlesGoogleLoad('loading')).toBe(false);
    expect(settlesGoogleLoad('checking')).toBe(false);
    for (const state of [
      'matched',
      'noMatch',
      'searchReady',
      'searchEmpty',
      'picked',
      'offline',
      'unavailable',
    ] as const) {
      expect(settlesGoogleLoad(state)).toBe(true);
    }
  });
});
