import { describe, expect, it } from 'vitest';

import {
  arrivalTitle,
  hasNoRouteGuidance,
  isResumingTrip,
  isTripState,
  nextTripSimulated,
  simulatedAtTripEntry,
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

describe('a restored trip off its route', () => {
  const tracking = { phase: 'tracking' as const };

  it('derives nothing from the route while the core says the trip has no maneuver', () => {
    for (const restored of [
      { ...tracking, isOffRoute: true, tripPause: 'rerouting' as const },
      { ...tracking, isOffRoute: true, tripPause: 'proceed-to-route' as const },
    ]) {
      expect(hasNoRouteGuidance(restored)).toBe(true);
      expect(vehicleMatchStatus(restored)).toBe('off-route');
    }
    // Its panel has no estimate (resuming) yet reads as off route, not "Resuming your trip".
    const notice = { matchStatus: 'off-route' as const, positionEstimated: false, resuming: true };
    expect(tripNotice({ ...notice, rerouteCount: 0 })?.title).toBe('Off route');
    expect(tripStatusLabel(notice)).toBe('off route');
  });

  it('leaves every other trip as on main', () => {
    // Restored and matched again: guided.
    expect(
      hasNoRouteGuidance({
        ...tracking,
        isOffRoute: false,
        matchedCoordinate: coordinate,
      }),
    ).toBe(false);
    // Paused on the route (a fix the matcher did not accept): no step, still the trip.
    expect(hasNoRouteGuidance({ ...tracking, isOffRoute: false, tripPause: 'locating' })).toBe(
      true,
    );
    // A mid-trip departure (guided, or between guidance and a reroute) is not a pause.
    expect(hasNoRouteGuidance({ ...tracking, isOffRoute: true })).toBe(false);
    expect(
      tripNotice({
        matchStatus: 'off-route',
        positionEstimated: false,
        rerouteCount: 0,
        resuming: false,
      })?.title,
    ).toBe('Off route');
    // A fresh trip before its first match: guidance from the route's start.
    expect(hasNoRouteGuidance({ ...tracking, isOffRoute: false })).toBe(false);
    // A restored trip still finding its place stays resuming.
    expect(hasNoRouteGuidance({ ...tracking, isAcquiringPosition: true, isOffRoute: false })).toBe(
      true,
    );
    expect(
      tripNotice({
        matchStatus: 'acquiring',
        positionEstimated: false,
        rerouteCount: 0,
        resuming: true,
      })?.title,
    ).toBe('Resuming your trip');
    expect(hasNoRouteGuidance(undefined)).toBe(false);
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

describe('a simulated trip at arrival', () => {
  it('stays simulated after the simulation stops at the destination', () => {
    let simulated = nextTripSimulated(false, 'navigating', true);
    expect(simulated).toBe(true);
    // The native simulation ends with the trip; the arrival still came from it.
    simulated = nextTripSimulated(simulated, 'navigating', false);
    simulated = nextTripSimulated(simulated, 'arrived', false);
    expect(simulated).toBe(true);
  });

  it('is cleared once the trip is over', () => {
    expect(nextTripSimulated(true, 'idle', false)).toBe(false);
    expect(nextTripSimulated(true, 'preview', false)).toBe(false);
  });

  it('is taken from the native trip by a screen mounted after the arrival', () => {
    // The screen starts without a trip, so nothing is read and the flag is clear ...
    let wasInTrip = false;
    let simulated = nextTripSimulated(
      false,
      'idle',
      simulatedAtTripEntry('idle', wasInTrip, () => true),
    );
    expect(simulated).toBe(false);
    // ... then adopts the arrived trip: the native flag is read once, at that moment.
    simulated = nextTripSimulated(
      simulated,
      'arrived',
      simulatedAtTripEntry('arrived', wasInTrip, () => true),
    );
    expect(simulated).toBe(true);
    wasInTrip = isTripState('arrived');
    const read = () => {
      throw new Error('read again');
    };
    expect(simulatedAtTripEntry('arrived', wasInTrip, read)).toBe(false);
    expect(nextTripSimulated(simulated, 'arrived', false)).toBe(true);
  });

  it('is not taken from the native trip for a live one', () => {
    expect(simulatedAtTripEntry('navigating', false, () => false)).toBe(false);
  });

  it('is never set by a live trip', () => {
    expect(nextTripSimulated(false, 'navigating', false)).toBe(false);
    expect(nextTripSimulated(false, 'arrived', false)).toBe(false);
  });

  it('says so on the arrival sheet', () => {
    expect(arrivalTitle(true)).toBe('Simulation finished');
    expect(arrivalTitle(false)).toBe("You've arrived");
  });
});
