import { describe, expect, it } from 'vitest';

import {
  type PhoneRouteStatus,
  type PhoneSurfaceInput,
  phoneSurface,
} from '../src/features/navigation/phone-surface';

const ALL_STATUSES: PhoneRouteStatus[] = [
  'arrived',
  'error',
  'idle',
  'loading',
  'navigating',
  'preview',
];

function surface(overrides: Partial<PhoneSurfaceInput> = {}) {
  return phoneSurface({
    carPlayConnected: true,
    guidanceResolved: true,
    routeStatus: 'idle',
    ...overrides,
  });
}

describe('phone surface while CarPlay is connected', () => {
  it('never renders a map for any route status', () => {
    // A tester on build 52 reported a blank phone screen with CarPlay working. The handset was
    // falling through to a full map beside the car's, so no connected state may resolve to 'map'.
    for (const routeStatus of ALL_STATUSES) {
      expect(surface({ routeStatus })).not.toBe('map');
      expect(surface({ guidanceResolved: false, routeStatus })).not.toBe('map');
    }
  });

  it('shows guidance only when the maneuver snapshot is complete', () => {
    expect(surface({ routeStatus: 'navigating' })).toBe('guidance');
    expect(surface({ guidanceResolved: false, routeStatus: 'navigating' })).toBe('carplay-idle');
  });

  it('shows arrival regardless of guidance resolution', () => {
    expect(surface({ routeStatus: 'arrived' })).toBe('arrival');
    expect(surface({ guidanceResolved: false, routeStatus: 'arrived' })).toBe('arrival');
  });

  it('shows the idle companion for states with no active guidance', () => {
    for (const routeStatus of ['error', 'idle', 'loading', 'preview'] as PhoneRouteStatus[]) {
      expect(surface({ routeStatus })).toBe('carplay-idle');
    }
  });
});

describe('phone surface while CarPlay is disconnected', () => {
  it('always renders the map, including mid-trip', () => {
    for (const routeStatus of ALL_STATUSES) {
      expect(surface({ carPlayConnected: false, routeStatus })).toBe('map');
    }
  });
});
