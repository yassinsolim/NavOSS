import { describe, expect, it } from 'vitest';

import {
  isResumingTrip,
  tripNotice,
  tripStatusLabel,
  vehicleMatchStatus,
} from '../src/features/navigation/trip-status.js';

const coordinate = { latitude: 51.04, longitude: -114.07 };

describe('trip status', () => {
  it('reads a raw position without a match as still acquiring, never as on route', () => {
    expect(vehicleMatchStatus(undefined)).toBe('acquiring');
    expect(vehicleMatchStatus({ isOffRoute: false })).toBe('acquiring');
    expect(vehicleMatchStatus({ isOffRoute: false, matchedCoordinate: coordinate })).toBe(
      'matched',
    );
    expect(vehicleMatchStatus({ isOffRoute: true })).toBe('off-route');
  });

  it('shows a restored trip finding its place as resuming, whatever else the snapshot holds', () => {
    const resuming = {
      isAcquiringPosition: true,
      isOffRoute: false,
      matchedCoordinate: coordinate,
    };
    expect(isResumingTrip(resuming)).toBe(true);
    expect(vehicleMatchStatus(resuming)).toBe('acquiring');
    expect(isResumingTrip({ isOffRoute: false, matchedCoordinate: coordinate })).toBe(false);
    expect(
      tripNotice({
        matchStatus: 'acquiring',
        positionEstimated: false,
        rerouteCount: 2,
        resuming: true,
      }),
    ).toEqual({
      message: 'Guidance resumes once GPS confirms where you are on the route.',
      title: 'Resuming your trip',
    });
    expect(
      tripStatusLabel({ matchStatus: 'acquiring', positionEstimated: false, resuming: true }),
    ).toBe('resuming trip, finding your place on the route');
  });

  it('keeps the existing notices for a trip that is guiding', () => {
    const base = { positionEstimated: false, rerouteCount: 0, resuming: false };
    expect(tripNotice({ ...base, matchStatus: 'acquiring' })?.title).toBe('Waiting for GPS');
    expect(tripNotice({ ...base, matchStatus: 'off-route' })?.title).toBe('Off route');
    expect(tripNotice({ ...base, matchStatus: 'matched' })).toBeUndefined();
    expect(tripNotice({ ...base, matchStatus: 'matched', rerouteCount: 1 })?.title).toBe(
      'Route updated',
    );
    expect(tripNotice({ ...base, matchStatus: 'matched', positionEstimated: true })?.title).toBe(
      'Weak GPS signal',
    );
    expect(
      tripStatusLabel({ matchStatus: 'matched', positionEstimated: false, resuming: false }),
    ).toBe('on route');
  });
});
