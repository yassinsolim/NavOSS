import { GooglePlaceQueryGrantResponseSchema, type SearchResult } from '@navoss/contracts';
import { describe, expect, it } from 'vitest';

import {
  googleGrantFailureState,
  googlePlaceDetailsEligible,
  googlePlaceDetailsHeight,
  googlePlaceDetailsMessage,
  nativeGooglePlaceState,
} from '../src/features/map/google-place-details.js';
import { NavOssApiError } from '../src/lib/api.js';
import { droppedPinResult } from '../src/features/map/map-features.js';

function place(overrides: Partial<SearchResult>): SearchResult {
  return {
    category: 'poi',
    center: { latitude: 51.0443, longitude: -114.0631 },
    confidence: 1,
    id: 'nominatim:node:1',
    label: 'Calgary, AB',
    name: 'Calgary Tower',
    ...overrides,
  };
}

describe('Google place details eligibility', () => {
  it('offers Google details for named places from search, the business index and map taps', () => {
    expect(googlePlaceDetailsEligible(place({}))).toBe(true);
    expect(googlePlaceDetailsEligible(place({ category: 'landmark', name: 'Stampede Park' }))).toBe(
      true,
    );
    expect(
      googlePlaceDetailsEligible(
        place({ id: 'calgary-business:123', name: 'Shoppers Drug Mart #2345' }),
      ),
    ).toBe(true);
    expect(googlePlaceDetailsEligible(place({ id: 'map-poi:42', name: 'Peters Drive In' }))).toBe(
      true,
    );
    expect(googlePlaceDetailsEligible(place({ name: '7-Eleven' }))).toBe(true);
    expect(googlePlaceDetailsEligible(place({ name: '17th Avenue Retail' }))).toBe(true);
    // Business names that start with a number are not addresses.
    for (const name of ['10 Foot Henry', '88 Brewing Company', '33 Acres Brewing Company']) {
      expect(googlePlaceDetailsEligible(place({ name }))).toBe(true);
      expect(googlePlaceDetailsEligible(place({ category: 'landmark', name }))).toBe(true);
    }
  });

  it('spends no Google query on addresses, streets, areas, pins or coordinates', () => {
    expect(googlePlaceDetailsEligible(place({ category: 'address', name: '123 Main St' }))).toBe(
      false,
    );
    expect(googlePlaceDetailsEligible(place({ category: 'street', name: '17 Avenue SW' }))).toBe(
      false,
    );
    expect(googlePlaceDetailsEligible(place({ category: 'neighborhood', name: 'Beltline' }))).toBe(
      false,
    );
    expect(
      googlePlaceDetailsEligible(droppedPinResult({ latitude: 51.04, longitude: -114.06 })),
    ).toBe(false);
    expect(
      googlePlaceDetailsEligible(place({ category: 'landmark', name: '51.04430, -114.06310' })),
    ).toBe(false);
    expect(googlePlaceDetailsEligible(place({ category: 'landmark', name: '123 Main St' }))).toBe(
      false,
    );
    expect(
      googlePlaceDetailsEligible(place({ category: 'landmark', name: '1200 - 5 Avenue SW' })),
    ).toBe(false);
    expect(googlePlaceDetailsEligible(place({ category: 'poi', name: '800 3 Street SE' }))).toBe(
      false,
    );
    expect(
      googlePlaceDetailsEligible(place({ category: 'landmark', name: '45 Crowfoot Cres NW' })),
    ).toBe(false);
  });
});

describe('Google place details states', () => {
  it('treats no answer from the grant server as offline and any answer that fails as unavailable', () => {
    expect(googleGrantFailureState(new TypeError('Network request failed'))).toBe('offline');
    // Expo's fetch: the message recorded on the simulator when the connection was dropped.
    class FetchError extends Error {}
    expect(
      googleGrantFailureState(new FetchError('fetch failed: The network connection was lost.')),
    ).toBe('offline');
    expect(googleGrantFailureState(new NavOssApiError('Place details unavailable', 503))).toBe(
      'unavailable',
    );
    expect(googleGrantFailureState(new SyntaxError('Unexpected token <'))).toBe('unavailable');
    expect(googleGrantFailureState(GooglePlaceQueryGrantResponseSchema.safeParse({}).error)).toBe(
      'unavailable',
    );
  });

  it('accepts only known native states and hides Google on anything else', () => {
    expect(nativeGooglePlaceState('matched')).toBe('matched');
    expect(nativeGooglePlaceState('offline')).toBe('offline');
    expect(nativeGooglePlaceState('searchReady')).toBe('searchReady');
    expect(nativeGooglePlaceState('searchEmpty')).toBe('searchEmpty');
    expect(nativeGooglePlaceState('picked')).toBe('picked');
    // The grant step belongs to React; native never reports it.
    expect(nativeGooglePlaceState('checking')).toBe('noMatch');
    expect(nativeGooglePlaceState(undefined)).toBe('noMatch');
  });

  it('labels each state without claiming the listing is the same business', () => {
    expect(googlePlaceDetailsMessage('matched')).toBeUndefined();
    expect(googlePlaceDetailsMessage('searchReady')).toBeUndefined();
    expect(googlePlaceDetailsMessage('noMatch')).toEqual({
      title: 'Google has no listing at this exact spot',
    });
    expect(googlePlaceDetailsMessage('searchEmpty')).toEqual({
      title: 'Google found no listing with this name nearby',
    });
    for (const state of ['checking', 'loading', 'picked'] as const) {
      expect(googlePlaceDetailsMessage(state)).toEqual({ title: 'Loading Google details' });
    }
    expect(googlePlaceDetailsMessage('unavailable')).toEqual({
      title: 'Google details are temporarily unavailable',
    });
    expect(googlePlaceDetailsMessage('offline')?.title).toBe('Google details need a connection');
  });

  it('gives Google’s view a bounded fixed height', () => {
    expect(googlePlaceDetailsHeight(568)).toBe(420);
    expect(googlePlaceDetailsHeight(874)).toBe(612);
    expect(googlePlaceDetailsHeight(1366)).toBe(720);
  });
});
