import { describe, expect, it } from 'vitest';

import type { LocationState } from '../src/features/map/idle-camera-follow.js';
import {
  EMPTY_LOOKUP_LEDGER,
  type LookupLedger,
  lookupOutcome,
  phoneWatchFix,
} from '../src/features/map/location-lookup.js';

const states: LocationState[] = ['idle', 'locating', 'visible', 'error', 'denied'];

/** The ledger after a lookup starts, as the hook records it; that value is also the lookup's start. */
const started = (ledger: LookupLedger): LookupLedger => ({
  ...ledger,
  latestLookup: ledger.latestLookup + 1,
});
const withFix = (ledger: LookupLedger): LookupLedger => ({
  ...ledger,
  fixesApplied: ledger.fixesApplied + 1,
});

describe('a fix from the phone watch', () => {
  it('on Android, shows the position again after a failed lookup, clearing its label', () => {
    // "Location is off" and "Current location unavailable" are drawn from `'error'`.
    expect(phoneWatchFix(true, 'error')).toEqual({ state: 'visible', stopsFirstFixSearch: true });
  });

  it('on Android, ends the first-fix search and a Center lookup still looking', () => {
    for (const state of ['idle', 'locating', 'visible'] as const) {
      expect(phoneWatchFix(true, state), state).toEqual({
        state: 'visible',
        stopsFirstFixSearch: true,
      });
    }
  });

  it('on Android, does not undo a denial', () => {
    expect(phoneWatchFix(true, 'denied').state).toBe('denied');
  });

  it('on iOS, changes nothing (its watch runs only while a position is shown)', () => {
    for (const state of states) {
      expect(phoneWatchFix(false, state), state).toEqual({ state, stopsFirstFixSearch: false });
    }
  });
});

describe('a one-shot lookup’s outcome', () => {
  const ledgerAtStart = started(withFix(EMPTY_LOOKUP_LEDGER));

  it('on Android, applies a fix it found while it is the newest lookup', () => {
    expect(
      lookupOutcome({ android: true, found: true, now: ledgerAtStart, started: ledgerAtStart }),
    ).toEqual({ applyFix: true, state: 'visible' });
  });

  it('on Android, is an error when nothing arrived during it', () => {
    // A fix from before the lookup proves nothing about now (Location may have been switched off).
    expect(
      lookupOutcome({ android: true, found: false, now: ledgerAtStart, started: ledgerAtStart }),
    ).toEqual({ applyFix: false, state: 'error' });
  });

  it('on Android, stays visible when the watch put a fix on the map during it', () => {
    // Center timed out after 15 s, but the watch delivered a fix meanwhile: the map shows a current
    // position, so it is neither `'error'` nor "Current location unavailable".
    expect(
      lookupOutcome({
        android: true,
        found: false,
        now: withFix(ledgerAtStart),
        started: ledgerAtStart,
      }),
    ).toEqual({ applyFix: false, state: 'visible' });
  });

  it('on Android, changes nothing once a newer lookup has started', () => {
    for (const found of [true, false]) {
      expect(
        lookupOutcome({
          android: true,
          found,
          now: started(ledgerAtStart),
          started: ledgerAtStart,
        }),
      ).toEqual({ applyFix: false });
    }
  });

  it('on iOS, is always the lookup’s own result', () => {
    for (const now of [ledgerAtStart, withFix(ledgerAtStart), started(ledgerAtStart)]) {
      expect(lookupOutcome({ android: false, found: true, now, started: ledgerAtStart })).toEqual({
        applyFix: true,
        state: 'visible',
      });
      expect(lookupOutcome({ android: false, found: false, now, started: ledgerAtStart })).toEqual({
        applyFix: false,
        state: 'error',
      });
    }
  });
});

describe('Android: Location switched off with the startup lookup still pending', () => {
  // The startup lookup is pending; the watch delivers a fix; the driver switches Location off and
  // taps Center, which finds nothing. The "Location is off" chip must stay.
  const startup = started(EMPTY_LOOKUP_LEDGER);
  const afterWatchFix = withFix(startup);
  const center = started(afterWatchFix);

  it('Center fails, then the older startup lookup fails: the error stays', () => {
    expect(lookupOutcome({ android: true, found: false, now: center, started: center })).toEqual({
      applyFix: false,
      state: 'error',
    });
    // The watch fix came during the startup lookup, but Center has started since: stale.
    expect(lookupOutcome({ android: true, found: false, now: center, started: startup })).toEqual({
      applyFix: false,
    });
  });

  it('the startup lookup fails first, then Center: the same end', () => {
    expect(lookupOutcome({ android: true, found: false, now: center, started: startup })).toEqual({
      applyFix: false,
    });
    expect(lookupOutcome({ android: true, found: false, now: center, started: center })).toEqual({
      applyFix: false,
      state: 'error',
    });
  });

  it('a late answer from the startup lookup does not move the marker back', () => {
    expect(lookupOutcome({ android: true, found: true, now: center, started: startup })).toEqual({
      applyFix: false,
    });
  });
});
