import type { LocationState } from './idle-camera-follow';

/**
 * What the map has done with location so far, to judge a one-shot lookup (the first-fix search,
 * Center, a route origin) when it settles. The hook keeps the current ledger; a lookup keeps the
 * ledger as it was right after it started.
 */
export interface LookupLedger {
  /** Fixes put on the map, from any source. */
  fixesApplied: number;
  /** Lookups started; the newest one is the only one whose outcome counts on Android. */
  latestLookup: number;
}

export const EMPTY_LOOKUP_LEDGER: LookupLedger = { fixesApplied: 0, latestLookup: 0 };

/**
 * What a fix from the phone watch does besides putting the position on the map.
 *
 * Android: the map shows a current position, so a lookup still in flight (`'locating'`) or one
 * that failed (`'error'`, which drives the "Location is off" and "Current location unavailable"
 * labels) gives way to `'visible'`; `'denied'` stays. The first-fix search stops, as it did on the
 * first fix of the watch it used to run itself: its answer would be older than the watch's.
 *
 * iOS: nothing. Its watch runs only while the position is shown and never beside the search.
 */
export function phoneWatchFix(
  android: boolean,
  state: LocationState,
): { state: LocationState; stopsFirstFixSearch: boolean } {
  if (!android) return { state, stopsFirstFixSearch: false };
  return { state: state === 'denied' ? 'denied' : 'visible', stopsFirstFixSearch: true };
}

/**
 * What a settled lookup may change: whether to put its fix on the map, and the location state
 * (none: leave everything as it is).
 *
 * iOS: the lookup's own result, always (`'visible'` with its fix, else `'error'`).
 *
 * Android, where the watch runs beside every lookup:
 * - Once a newer lookup has started, this one is stale and changes nothing. Its failure would
 *   otherwise undo the newer one's (a startup lookup failing late after Center found Location
 *   off), and its fix could be older than what the map shows.
 * - A failure is `'visible'` when a fix reached the map during the lookup: that fix is younger
 *   than the lookup, so it is current, and Center reports no failure for it. A fix from before the
 *   lookup does not count (Location may have been switched off since).
 */
export function lookupOutcome({
  android,
  found,
  now,
  started,
}: {
  android: boolean;
  /** The lookup returned a fix. */
  found: boolean;
  now: LookupLedger;
  started: LookupLedger;
}): { applyFix: boolean; state?: Extract<LocationState, 'error' | 'visible'> } {
  if (!android)
    return found ? { applyFix: true, state: 'visible' } : { applyFix: false, state: 'error' };
  if (now.latestLookup !== started.latestLookup) return { applyFix: false };
  if (found) return { applyFix: true, state: 'visible' };
  return {
    applyFix: false,
    state: now.fixesApplied > started.fixesApplied ? 'visible' : 'error',
  };
}
