import { describe, expect, it } from 'vitest';

import {
  hasNoRouteGuidance,
  isResumingTrip,
  tripNotice,
  tripStatusLabel,
  vehicleMatchStatus,
} from '../src/features/navigation/trip-status.js';
import type { NativeNavigationSnapshot } from '../src/features/navigation/native-navigation.js';

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
  const guidance = {} as NonNullable<NativeNavigationSnapshot['guidance']>;
  const tracking = { phase: 'tracking' as const };

  it('derives nothing from the route until the core matches it again, in every reroute mode', () => {
    for (const restored of [
      { ...tracking, isOffRoute: true, rerouteMode: 'adaptive', routeStatus: 'rerouting' },
      { ...tracking, isOffRoute: true, rerouteMode: 'adaptive', routeStatus: 'reroute-failed' },
      { ...tracking, isOffRoute: true, rerouteMode: 'ask-first', rerouteProposal: {} },
      { ...tracking, isOffRoute: true, rerouteMode: 'keep-route', routeStatus: 'rerouting' },
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
        guidance,
        isOffRoute: false,
        matchedCoordinate: coordinate,
      }),
    ).toBe(false);
    // A mid-trip departure keeps its guidance and its notice.
    expect(hasNoRouteGuidance({ ...tracking, guidance, isOffRoute: true })).toBe(false);
    expect(
      tripNotice({
        matchStatus: 'off-route',
        positionEstimated: false,
        rerouteCount: 0,
        resuming: false,
      })?.title,
    ).toBe('Off route');
    // A fresh trip before its first match: guidance from the route's start.
    expect(hasNoRouteGuidance({ ...tracking, guidance, isOffRoute: false })).toBe(false);
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
