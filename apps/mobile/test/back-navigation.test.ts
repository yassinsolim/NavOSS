import { describe, expect, it } from 'vitest';

import { mapBackAction } from '../src/features/map/back-navigation.js';

const idle = {
  activeTab: 'explore',
  hasSearch: false,
  placeOpen: false,
  routeState: 'idle',
} as const;

describe('Android back on the map screen', () => {
  it('never ends an active trip or an arrival', () => {
    for (const routeState of ['navigating', 'arrived'] as const) {
      expect(mapBackAction({ ...idle, hasSearch: true, placeOpen: true, routeState })).toBe(
        'system',
      );
    }
  });

  it('closes the route preview, planning and its error before the place behind them', () => {
    for (const routeState of ['preview', 'loading', 'error'] as const) {
      expect(mapBackAction({ ...idle, placeOpen: true, routeState })).toBe('cancel-route');
    }
  });

  it('closes the place, then leaves a full-screen tab, then clears the search', () => {
    expect(mapBackAction({ ...idle, hasSearch: true, placeOpen: true })).toBe('close-place');
    expect(mapBackAction({ ...idle, activeTab: 'saved', hasSearch: true })).toBe('explore-tab');
    expect(mapBackAction({ ...idle, hasSearch: true })).toBe('clear-search');
  });

  it('leaves the app from a resting map', () => {
    expect(mapBackAction(idle)).toBe('system');
  });
});
