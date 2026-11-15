import type { GooglePlaceQueryGrantResponse } from '@navoss/contracts';
import { describe, expect, it } from 'vitest';

import {
  GoogleLoadSequencer,
  googlePlaceIdentity,
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

    const loads = [];
    for (const phase of ['nearest', 'search', 'search'] as const) {
      const outcome = await sequencer.begin(phase);
      expect(outcome).toMatchObject({ kind: 'load', load: { phase } });
      if (outcome.kind === 'load') loads.push(outcome.load.request);
      sequencer.settle(); // The second search came back empty.
    }
    // Same phase, new request: the native view's key changes, so one new component loads.
    expect(new Set(loads).size).toBe(3);
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

describe('Google loads across place identities', () => {
  it('gives every load a request number no other load has, across sequencers', async () => {
    const first = harness().sequencer;
    const second = harness().sequencer;
    const a = await first.begin('nearest');
    first.settle();
    const b = await second.begin('nearest');
    expect(a.kind === 'load' && b.kind === 'load' && a.load.request !== b.load.request).toBe(true);
  });

  it('drops an old identity’s grant that arrives after the place changed', async () => {
    let release: (response: GooglePlaceQueryGrantResponse) => void = () => undefined;
    const old = new GoogleLoadSequencer(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = old.begin('nearest');
    old.retire(); // The selection changed mid-load.
    release(grant);
    expect(await pending).toEqual({ kind: 'stale' });
    expect(await old.begin('search')).toEqual({ kind: 'stale' });

    const { grants, sequencer } = harness();
    const fresh = await sequencer.begin('nearest');
    expect(fresh).toMatchObject({ kind: 'load', load: { phase: 'nearest' } });
    expect(grants()).toBe(1);
    expect(sequencer.inProgress).toBe(true);
    sequencer.settle();
    expect(sequencer.inProgress).toBe(false);
  });

  it('keys the section by id, name and coordinate', () => {
    const base = {
      category: 'poi' as const,
      center: { latitude: 51.0443, longitude: -114.0631 },
      confidence: 1,
      id: 'map-poi:1',
      label: 'Calgary',
      name: 'Calgary Tower',
    };
    const key = googlePlaceIdentity(base);
    expect(googlePlaceIdentity({ ...base })).toBe(key);
    expect(googlePlaceIdentity({ ...base, name: 'Sky 360' })).not.toBe(key);
    expect(
      googlePlaceIdentity({ ...base, center: { latitude: 51.0444, longitude: -114.0631 } }),
    ).not.toBe(key);
    expect(googlePlaceIdentity({ ...base, id: 'map-poi:2' })).not.toBe(key);
  });
});
