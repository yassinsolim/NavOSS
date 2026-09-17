import { describe, expect, it } from 'vitest';

import {
  type PhoneRouteStatus,
  type PhoneSurfaceInput,
  phoneSurface,
  releasesPhoneRouteOnCarPlayConnect,
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

const CONNECTED_SURFACE_CASES = [
  { expected: 'arrival', guidanceResolved: false, routeStatus: 'arrived' },
  { expected: 'arrival', guidanceResolved: true, routeStatus: 'arrived' },
  { expected: 'map', guidanceResolved: false, routeStatus: 'error' },
  { expected: 'map', guidanceResolved: true, routeStatus: 'error' },
  { expected: 'map', guidanceResolved: false, routeStatus: 'idle' },
  { expected: 'map', guidanceResolved: true, routeStatus: 'idle' },
  { expected: 'map', guidanceResolved: false, routeStatus: 'loading' },
  { expected: 'map', guidanceResolved: true, routeStatus: 'loading' },
  { expected: 'carplay-idle', guidanceResolved: false, routeStatus: 'navigating' },
  { expected: 'guidance', guidanceResolved: true, routeStatus: 'navigating' },
  { expected: 'map', guidanceResolved: false, routeStatus: 'preview' },
  { expected: 'map', guidanceResolved: true, routeStatus: 'preview' },
] as const;

describe('phone surface while CarPlay is connected', () => {
  it.each(CONNECTED_SURFACE_CASES)(
    'renders $expected for $routeStatus when guidance is $guidanceResolved',
    ({ expected, guidanceResolved, routeStatus }) => {
      expect(surface({ guidanceResolved, routeStatus })).toBe(expected);
    },
  );
});

describe('phone surface while CarPlay is disconnected', () => {
  it('always renders the map, including mid-trip and incomplete guidance', () => {
    for (const routeStatus of ALL_STATUSES) {
      for (const guidanceResolved of [false, true]) {
        expect(surface({ carPlayConnected: false, guidanceResolved, routeStatus })).toBe('map');
      }
    }
  });
});

describe('releasing a phone-side route when the car connects', () => {
  it('preserves every route state so connecting cannot discard phone planning work', () => {
    for (const routeStatus of ALL_STATUSES) {
      expect(releasesPhoneRouteOnCarPlayConnect(routeStatus)).toBe(false);
    }
  });
});
