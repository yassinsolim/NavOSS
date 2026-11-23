import { afterEach, describe, expect, it, vi } from 'vitest';

const availability = vi.hoisted(() => ({ value: 'available' }));

vi.mock('../modules/navoss-navigation/index.js', () => ({
  default: {
    getCapabilities: () => ({ geometryGuidance: true, routeMatching: true }),
    getLocationAvailability: () => availability.value,
    startSimulatedDrive: vi.fn(),
  },
}));

import { canSimulateDrive } from '../src/features/navigation/native-navigation.js';

describe('Simulate drive on Android', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is offered in a release build only when no location provider can follow a drive', () => {
    vi.stubGlobal('__DEV__', false);
    availability.value = 'no-gps';
    expect(canSimulateDrive()).toBe(true);
    availability.value = 'location-off';
    expect(canSimulateDrive()).toBe(true);
    // A denial is the driver's choice, not a missing provider: Start explains how to allow it.
    availability.value = 'permission-denied';
    expect(canSimulateDrive()).toBe(false);
    availability.value = 'available';
    expect(canSimulateDrive()).toBe(false);
  });

  it('is always offered in development builds', () => {
    vi.stubGlobal('__DEV__', true);
    availability.value = 'permission-denied';
    expect(canSimulateDrive()).toBe(true);
  });
});
