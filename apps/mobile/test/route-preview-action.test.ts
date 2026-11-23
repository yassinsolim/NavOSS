import { describe, expect, it } from 'vitest';

import { routePreviewPrimaryAction } from '../src/features/navigation/route-preview-action.js';

const base = {
  chosenStart: true,
  deviceHasNoGps: true,
  isAndroid: true,
  simulateDriveAvailable: true,
};

describe('route preview primary action', () => {
  it('offers Simulate drive from a chosen start on an Android device with no GPS', () => {
    expect(routePreviewPrimaryAction(base)).toBe('simulate-drive');
  });

  it('offers no dead-end button on an Android device with no GPS when nothing can drive the route', () => {
    expect(routePreviewPrimaryAction({ ...base, simulateDriveAvailable: false })).toBe('none');
  });

  it('keeps Use my location on iOS whatever the flags say', () => {
    expect(routePreviewPrimaryAction({ ...base, isAndroid: false })).toBe('use-my-location');
    expect(
      routePreviewPrimaryAction({ ...base, isAndroid: false, simulateDriveAvailable: false }),
    ).toBe('use-my-location');
  });

  it('keeps Use my location on Android when a provider exists', () => {
    expect(routePreviewPrimaryAction({ ...base, deviceHasNoGps: false })).toBe('use-my-location');
    expect(
      routePreviewPrimaryAction({ ...base, deviceHasNoGps: false, simulateDriveAvailable: false }),
    ).toBe('use-my-location');
  });

  it('starts a route planned from the device location', () => {
    expect(routePreviewPrimaryAction({ ...base, chosenStart: false })).toBe('start');
    expect(routePreviewPrimaryAction({ ...base, chosenStart: false, isAndroid: false })).toBe(
      'start',
    );
  });
});
