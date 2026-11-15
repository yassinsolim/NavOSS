import type { SearchResult } from '@navoss/contracts';

import { NavOssApiError } from '../../lib/api';

/**
 * What the Google section of a place sheet shows. `checking` is the anonymous grant request,
 * `loading` is Google's component fetching; the rest come from the native view (see
 * `NavOSSGooglePlaceRatingView.swift`) or from a refused or failed grant.
 */
export type GooglePlaceDetailsState =
  'checking' | 'loading' | 'matched' | 'noMatch' | 'offline' | 'unavailable';

export const NATIVE_GOOGLE_PLACE_STATES: readonly GooglePlaceDetailsState[] = [
  'loading',
  'matched',
  'noMatch',
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

/** Copy for the states that show NavOSS text; `matched` and `noMatch` show none. */
export function googlePlaceDetailsMessage(
  state: GooglePlaceDetailsState,
): { message?: string; title: string } | undefined {
  switch (state) {
    case 'checking':
    case 'loading':
      return { title: 'Loading Google details' };
    case 'offline':
      return {
        message: 'Open this place again when you are back online.',
        title: 'Google details need a connection',
      };
    case 'unavailable':
      return { title: 'Google details are temporarily unavailable' };
    case 'matched':
    case 'noMatch':
      return undefined;
  }
}

/**
 * Height for Google's full Place Details view. Google recommends a fixed height for it: the view
 * scrolls inside that space, with reviews and features in their own tabs.
 */
export function googlePlaceDetailsHeight(windowHeight: number): number {
  return Math.round(Math.min(Math.max(windowHeight * 0.7, 420), 720));
}
