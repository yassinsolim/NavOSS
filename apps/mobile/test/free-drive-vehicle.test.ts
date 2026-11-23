import { describe, expect, it } from 'vitest';

import {
  EMPTY_FREE_DRIVE_TRACK,
  type FreeDriveFix,
  type FreeDriveTrack,
  freeDriveFixFromLocation,
  freeDriveMarker,
  freeDriveMillisecondsUntilStale,
  mapVehicle,
  trackWithFix,
  trackWithTripSnapshot,
} from '../src/features/map/free-drive-vehicle.js';

const NOW = 1_800_000_000_000;
const here = { latitude: 51.0447, longitude: -114.0719 };
const there = { latitude: 51.0452, longitude: -114.0708 };

function fix(overrides: Partial<FreeDriveFix> = {}): FreeDriveFix {
  return { accuracyMeters: 8, capturedAtMs: NOW, coordinate: here, ...overrides };
}

function marker(track: FreeDriveTrack, compassDegrees?: number, nowMs = NOW) {
  return freeDriveMarker({ compassDegrees, locationAvailable: true, nowMs, track });
}

function trackOf(...fixes: FreeDriveFix[]): FreeDriveTrack {
  return fixes.reduce((track, next) => trackWithFix(track, next, NOW), EMPTY_FREE_DRIVE_TRACK);
}

describe('free-drive vehicle direction', () => {
  it('points along the GPS course at 9 km/h and faster', () => {
    expect(marker(trackOf(fix({ courseDegrees: 72, speedMetersPerSecond: 2.5 })))).toEqual({
      coordinate: here,
      headingDegrees: 72,
      headingSource: 'course',
      kind: 'vehicle',
    });
  });

  it('holds the last course while stopped instead of following a wandering course', () => {
    const track = trackOf(
      fix({ capturedAtMs: NOW - 2_000, courseDegrees: 90, speedMetersPerSecond: 12 }),
      fix({ capturedAtMs: NOW - 1_000, courseDegrees: 250, speedMetersPerSecond: 2.4 }),
      fix({ courseDegrees: 10, speedMetersPerSecond: 0 }),
    );
    expect(marker(track, 300)).toMatchObject({ headingDegrees: 90, headingSource: 'last-course' });
  });

  it('uses the compass only before any course has been seen', () => {
    expect(marker(trackOf(fix({ speedMetersPerSecond: 0 })), 140)).toMatchObject({
      headingDegrees: 140,
      headingSource: 'compass',
    });
    const moved = trackOf(
      fix({ capturedAtMs: NOW - 1_000, courseDegrees: 200, speedMetersPerSecond: 5 }),
      fix({ speedMetersPerSecond: 0 }),
    );
    expect(marker(moved, 140)).toMatchObject({ headingDegrees: 200, headingSource: 'last-course' });
  });

  it('shows the location dot, never a north-pointing vehicle, when nothing gives a direction', () => {
    expect(marker(trackOf(fix({ speedMetersPerSecond: 0 })))).toEqual({ kind: 'location-dot' });
    expect(marker(trackOf(fix({ courseDegrees: 45, speedMetersPerSecond: 1 })))).toEqual({
      kind: 'location-dot',
    });
    expect(marker(trackOf(fix()), Number.NaN)).toEqual({ kind: 'location-dot' });
  });

  it('ignores an unknown course or speed reported as -1', () => {
    const parsed = freeDriveFixFromLocation({
      coords: { accuracy: 5, heading: -1, latitude: 51, longitude: -114, speed: -1 },
      timestamp: NOW,
    });
    expect(parsed).toEqual({
      accuracyMeters: 5,
      capturedAtMs: NOW,
      coordinate: { latitude: 51, longitude: -114 },
    });
    expect(marker(trackOf(parsed))).toEqual({ kind: 'location-dot' });
  });

  it('keeps a newer fix when an older one arrives late', () => {
    const track = trackOf(
      fix({ coordinate: there, courseDegrees: 30, speedMetersPerSecond: 10 }),
      fix({ capturedAtMs: NOW - 3_000, courseDegrees: 300, speedMetersPerSecond: 10 }),
    );
    expect(marker(track)).toMatchObject({ coordinate: there, headingDegrees: 30 });
  });
});

describe('free-drive vehicle confidence', () => {
  const moving = { courseDegrees: 90, speedMetersPerSecond: 10 };

  it('draws the vehicle only for a fix of 100 m or better', () => {
    expect(marker(trackOf(fix({ ...moving, accuracyMeters: 100 }))).kind).toBe('vehicle');
    expect(marker(trackOf(fix({ ...moving, accuracyMeters: 101 })))).toEqual({
      kind: 'location-dot',
    });
    expect(marker(trackOf({ capturedAtMs: NOW, coordinate: here, ...moving }))).toEqual({
      kind: 'location-dot',
    });
  });

  it('a poor fix after a good one shows the dot rather than the old position as a vehicle', () => {
    const track = trackOf(
      fix({ ...moving, capturedAtMs: NOW - 1_000 }),
      fix({ accuracyMeters: 400, coordinate: there }),
    );
    expect(marker(track)).toEqual({ kind: 'location-dot' });
  });

  it('removes the vehicle once the newest fix is more than 15 s old', () => {
    const track = trackOf(fix(moving));
    expect(marker(track, undefined, NOW + 15_000).kind).toBe('vehicle');
    expect(marker(track, undefined, NOW + 15_001)).toEqual({ kind: 'location-dot' });
    expect(marker(trackOf(fix({ ...moving, capturedAtMs: NOW + 5_001 })))).toEqual({
      kind: 'location-dot',
    });
  });

  it('says when to look again so a silent watch cannot leave a confident vehicle behind', () => {
    expect(freeDriveMillisecondsUntilStale(fix({ capturedAtMs: NOW - 4_000 }), NOW)).toBe(11_001);
    expect(freeDriveMillisecondsUntilStale(fix({ capturedAtMs: NOW - 16_000 }), NOW)).toBe(
      undefined,
    );
    expect(freeDriveMillisecondsUntilStale(undefined, NOW)).toBe(undefined);
  });

  it('draws nothing while location is denied, off or not found', () => {
    expect(
      freeDriveMarker({
        compassDegrees: 10,
        locationAvailable: false,
        nowMs: NOW,
        track: trackOf(fix(moving)),
      }),
    ).toEqual({ kind: 'hidden' });
  });
});

describe('free-drive fix provenance and age', () => {
  const moving = { courseDegrees: 90, speedMetersPerSecond: 10 };

  it('measures age from when the fix was captured, not when it arrived', () => {
    const late = trackWithFix(
      EMPTY_FREE_DRIVE_TRACK,
      fix({ ...moving, capturedAtMs: NOW - 14_000 }),
      NOW,
    );
    expect(marker(late).kind).toBe('vehicle');
    expect(marker(late, undefined, NOW + 1_001)).toEqual({ kind: 'location-dot' });
  });

  it('never draws a mocked fix as the vehicle, nor remembers its course', () => {
    const parsed = freeDriveFixFromLocation({
      coords: { accuracy: 5, heading: 90, latitude: 51, longitude: -114, speed: 10 },
      mocked: true,
      timestamp: NOW,
    });
    expect(parsed.mocked).toBe(true);
    const track = trackOf(parsed);
    expect(marker(track)).toEqual({ kind: 'location-dot' });
    expect(
      marker(trackOf(parsed, fix({ capturedAtMs: NOW + 1, speedMetersPerSecond: 0 }))),
    ).toEqual({
      kind: 'location-dot',
    });
  });

  it('remembers a course only from a fix that may be drawn', () => {
    const track = trackOf(
      fix({ capturedAtMs: NOW - 2_000, courseDegrees: 90, speedMetersPerSecond: 10 }),
      fix({
        accuracyMeters: 300,
        capturedAtMs: NOW - 1_000,
        courseDegrees: 200,
        speedMetersPerSecond: 10,
      }),
      fix({ speedMetersPerSecond: 0 }),
    );
    expect(marker(track)).toMatchObject({ headingDegrees: 90, headingSource: 'last-course' });
    const stale = trackWithFix(
      EMPTY_FREE_DRIVE_TRACK,
      fix({ capturedAtMs: NOW - 20_000, courseDegrees: 200, speedMetersPerSecond: 10 }),
      NOW,
    );
    expect(stale.lastCourseDegrees).toBeUndefined();
  });

  it('takes a compass reading rounded up to 360 (or just below 0) as north, not as no direction', () => {
    const parked = trackOf(fix({ speedMetersPerSecond: 0 }));
    expect(marker(parked, 360)).toMatchObject({ headingDegrees: 0, headingSource: 'compass' });
    expect(marker(parked, -0.4)).toMatchObject({ headingDegrees: 359.6, headingSource: 'compass' });
    expect(marker(parked, 725)).toMatchObject({ headingDegrees: 5 });
  });
});

describe('vehicle hand-over between free drive and a trip', () => {
  it('at Start the trip owns the one vehicle and keeps the drawn heading until it has a course', () => {
    const idle = marker(trackOf(fix({ speedMetersPerSecond: 0 })), 140);
    expect(
      mapVehicle({ freeDrive: idle, previousHeadingDegrees: undefined, trip: undefined }),
    ).toEqual({
      coordinate: here,
      headingDegrees: 140,
      kind: 'vehicle',
    });
    const trip = { coordinate: there, courseDegrees: undefined, fallbackHeadingDegrees: 0 };
    expect(mapVehicle({ freeDrive: idle, previousHeadingDegrees: 140, trip })).toEqual({
      coordinate: there,
      headingDegrees: 140,
      kind: 'vehicle',
    });
    expect(
      mapVehicle({
        freeDrive: idle,
        previousHeadingDegrees: 140,
        trip: { ...trip, courseDegrees: 95 },
      }),
    ).toMatchObject({ headingDegrees: 95 });
  });

  it('a trip draws its vehicle even where free drive would show the dot or nothing', () => {
    const trip = { coordinate: there, courseDegrees: 95, fallbackHeadingDegrees: 0 };
    for (const freeDrive of [{ kind: 'location-dot' }, { kind: 'hidden' }] as const) {
      expect(mapVehicle({ freeDrive, previousHeadingDegrees: undefined, trip })).toEqual({
        coordinate: there,
        headingDegrees: 95,
        kind: 'vehicle',
      });
    }
  });

  it('the trip snapshot gives the trip its course but never a free-drive position or course', () => {
    const during = trackWithTripSnapshot(EMPTY_FREE_DRIVE_TRACK, {
      matchedCourseDegrees: 270,
      trip: {},
    });
    expect(during.tripCourseDegrees).toBe(270);
    expect(during.fix).toBeUndefined();
    expect(during.lastCourseDegrees).toBeUndefined();
    expect(trackWithTripSnapshot(during, { trip: undefined }).tripCourseDegrees).toBeUndefined();
  });

  it('at End the vehicle carries on from the phone’s own fixes recorded during the trip', () => {
    const during = trackWithFix(
      trackWithTripSnapshot(EMPTY_FREE_DRIVE_TRACK, { matchedCourseDegrees: 270, trip: {} }),
      fix({
        capturedAtMs: NOW - 1_000,
        coordinate: there,
        courseDegrees: 180,
        speedMetersPerSecond: 9,
      }),
      NOW - 1_000,
    );
    const ended = trackWithTripSnapshot(during, { trip: undefined });
    const idle = marker(ended);
    expect(idle).toEqual({
      coordinate: there,
      headingDegrees: 180,
      headingSource: 'course',
      kind: 'vehicle',
    });
    expect(mapVehicle({ freeDrive: idle, previousHeadingDegrees: 270, trip: undefined })).toEqual({
      coordinate: there,
      headingDegrees: 180,
      kind: 'vehicle',
    });
  });
});
