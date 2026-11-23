import { describe, expect, it } from 'vitest';

import {
  isResumingTrip,
  tripNotice,
  tripStatusLabel,
  tripActions,
  tripSummaryFlags,
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

describe('trip notice without native guidance', () => {
  it('says guidance is unavailable instead of waiting for a GPS fix that would not start it', () => {
    const notice = tripNotice({
      guidanceAvailable: false,
      matchStatus: 'acquiring',
      positionEstimated: false,
      rerouteCount: 0,
      resuming: false,
    });
    expect(notice?.title).toBe('Turn-by-turn guidance is not available yet');
    expect(notice?.message).not.toMatch(/GPS/);
  });
});

describe('trip summary flags', () => {
  it('says "Not saved" in the always-visible summary on Android when the trip is not on disk', () => {
    expect(tripSummaryFlags({ isAndroid: true, simulated: false, tripNotSaved: true })).toEqual({
      label: 'Trip not saved, it will not be restored if NavOSS closes. ',
      text: 'Not saved · ',
    });
  });

  it('keeps the simulation label first and leaves iOS unchanged', () => {
    expect(tripSummaryFlags({ isAndroid: true, simulated: true, tripNotSaved: true })).toEqual({
      label: 'Simulated drive. Trip not saved, it will not be restored if NavOSS closes. ',
      text: 'Simulation · Not saved · ',
    });
    expect(tripSummaryFlags({ isAndroid: false, simulated: false, tripNotSaved: true })).toEqual({
      label: '',
      text: '',
    });
    expect(tripSummaryFlags({ isAndroid: false, simulated: true, tripNotSaved: false })).toEqual({
      label: 'Simulated drive. ',
      text: 'Simulation · ',
    });
  });
});

describe('trip actions', () => {
  it('offers Report and Share ETA on a real trip', () => {
    expect(tripActions({ hasRemaining: true, simulated: false })).toEqual({
      report: true,
      shareEta: true,
    });
  });

  it('never reports a road condition at, or shares an ETA from, a simulated position', () => {
    expect(tripActions({ hasRemaining: true, simulated: true })).toEqual({
      report: false,
      shareEta: false,
    });
  });

  it('shares no ETA before the remaining route is known', () => {
    expect(tripActions({ hasRemaining: false, simulated: false }).shareEta).toBe(false);
  });
});
