import type { GooglePlaceQueryGrantResponse, SearchResult } from '@navoss/contracts';

import { NavOssApiError } from '../../lib/api';

/**
 * What the Google section of a place sheet shows. Every Google component load first takes an
 * anonymous NavOSS grant (`checking`). The automatic panel is Google's listing nearest the
 * selected coordinate (`loading`, then `matched` or `noMatch` when it is too far away). When the
 * driver asks to find the place, Google's search list appears (`searchReady` or `searchEmpty`) and
 * the listing they pick (`picked`) loads after another grant. A refused or failed grant or a
 * Google error is `unavailable` or `offline`.
 */
export type GooglePlaceDetailsState =
  | 'checking'
  | 'loading'
  | 'matched'
  | 'noMatch'
  | 'searchReady'
  | 'searchEmpty'
  | 'picked'
  | 'offline'
  | 'unavailable';

export const NATIVE_GOOGLE_PLACE_STATES: readonly GooglePlaceDetailsState[] = [
  'loading',
  'matched',
  'noMatch',
  'searchReady',
  'searchEmpty',
  'picked',
  'offline',
  'unavailable',
];

/** A street address: house number (optionally a unit range), then a street ending in a street type. */
const STREET_ADDRESS =
  /^\d+[a-z]?(?:\s*[-–]\s*\d+[a-z]?)?\s+(?:\S+\s+){0,4}(?:avenue|ave|av|boulevard|blvd|circle|close|court|ct|crescent|cres|drive|dr|gate|highway|hwy|lane|ln|mews|parkway|pkwy|place|pl|road|rd|street|st|terrace|trail|tr|way)\.?(?:\s+(?:n|s|e|w|ne|nw|se|sw))?$/iu;

/**
 * Whether Google could plausibly list this place. Named points of interest and landmarks (from
 * search, the Calgary business index, map taps, saved places) qualify; street addresses,
 * streets, neighbourhoods, dropped pins and coordinate-only names do not, so no Google query is
 * spent on them.
 */
export function googlePlaceDetailsEligible(place: SearchResult): boolean {
  if (place.category !== 'poi' && place.category !== 'landmark') return false;
  if (place.id.startsWith('dropped-pin:')) return false;
  const name = place.name.trim();
  if (!/\p{L}/u.test(name)) return false;
  // "123 Main St" or "1200 - 5 Avenue SW" that search labelled as a place; "10 Foot Henry" is not.
  return !STREET_ADDRESS.test(name);
}

/**
 * A failed grant request. When the server answered (an HTTP error or an unreadable body) Google
 * details are unavailable; anything else is a request that never got an answer, which is offline.
 * Expo's `fetch` rejects with `FetchError` ("fetch failed: …"), React Native's with `TypeError`.
 */
export function googleGrantFailureState(error: unknown): 'offline' | 'unavailable' {
  if (error instanceof NavOssApiError || error instanceof SyntaxError) return 'unavailable';
  if (error instanceof Error && error.name === 'ZodError') return 'unavailable';
  return 'offline';
}

export function nativeGooglePlaceState(value: unknown): GooglePlaceDetailsState {
  return NATIVE_GOOGLE_PLACE_STATES.find((state) => state === value) ?? 'noMatch';
}

/** Copy for the states that show a NavOSS message instead of, or before, Google's content. */
export function googlePlaceDetailsMessage(
  state: GooglePlaceDetailsState,
): { message?: string; title: string } | undefined {
  switch (state) {
    case 'checking':
    case 'loading':
    case 'picked':
      return { title: 'Loading Google details' };
    case 'noMatch':
      return { title: 'Google has no listing at this exact spot' };
    case 'searchEmpty':
      return { title: 'Google found no listing with this name nearby' };
    case 'offline':
      return {
        message: 'Open this place again when you are back online.',
        title: 'Google details need a connection',
      };
    case 'unavailable':
      return { title: 'Google details are temporarily unavailable' };
    case 'matched':
    case 'searchReady':
      return undefined;
  }
}

/** Which Google component the native view hosts. */
export type GooglePhase = 'idle' | 'nearest' | 'search' | 'picked';

/** One granted Google component load. `request` is new for every load, so a retry of the same
 * phase changes the native view's key and loads exactly one new component. */
export interface GoogleLoad {
  phase: GooglePhase;
  request: number;
}

export type GoogleLoadOutcome =
  | { kind: 'load'; load: GoogleLoad }
  | { kind: 'busy' }
  | { kind: 'refused' }
  | { kind: 'failed'; state: 'offline' | 'unavailable' };

/**
 * Takes one NavOSS grant per Google component load. While a grant request or a granted load is in
 * progress, another request is `busy` and spends nothing; the native view's terminal state
 * (`settle`) frees it.
 */
export class GoogleLoadSequencer {
  private busy = false;
  private lastRequest = 0;

  public constructor(private readonly reserve: () => Promise<GooglePlaceQueryGrantResponse>) {}

  public async begin(phase: GooglePhase): Promise<GoogleLoadOutcome> {
    if (this.busy) return { kind: 'busy' };
    this.busy = true;
    try {
      const response = await this.reserve();
      if (!response.granted) {
        this.busy = false;
        return { kind: 'refused' };
      }
      this.lastRequest += 1;
      return { kind: 'load', load: { phase, request: this.lastRequest } };
    } catch (error: unknown) {
      this.busy = false;
      return { kind: 'failed', state: googleGrantFailureState(error) };
    }
  }

  /** True while a grant request or a granted load is in progress. */
  public get inProgress(): boolean {
    return this.busy;
  }

  /** The native view reached a terminal state for the current load. */
  public settle(): void {
    this.busy = false;
  }
}

/** Native states that end a component load (the driver can act again). */
export function settlesGoogleLoad(state: GooglePlaceDetailsState): boolean {
  return state !== 'checking' && state !== 'loading';
}

/**
 * Height for Google's full Place Details view. Google recommends a fixed height for it: the view
 * scrolls inside that space, with reviews and features in their own tabs.
 */
export function googlePlaceDetailsHeight(windowHeight: number): number {
  return Math.round(Math.min(Math.max(windowHeight * 0.7, 420), 720));
}
