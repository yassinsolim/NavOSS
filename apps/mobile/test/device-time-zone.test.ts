import { OfficialRoadEventResponseSchema } from '@navoss/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { roadEventMessage } from '../src/features/map/road-events.js';
import {
  communityTrafficUpdated,
  formatArrivalTime,
} from '../src/features/navigation/route-progress.js';

import ontarioFixture from './fixtures/road-events/v2-events-ontario-2026-11-15.json' with { type: 'json' };

// The app starts in Alberta: set before the module under test loads, so anything it builds at
// import time is built under this zone, as on a phone that launched in Alberta.
const originalZone = vi.hoisted(() => {
  const original = process.env.TZ;
  process.env.TZ = 'America/Edmonton';
  return original;
});

// These tests move the process's time zone with `process.env.TZ` while the module stays loaded,
// as a phone does when a driver crosses a boundary with the app running. An
// `Intl.DateTimeFormat` resolves the default zone when it is constructed, so one built before the
// move keeps the old zone.
function moveDeviceTo(zone: string): void {
  process.env.TZ = zone;
  // Fail loudly if the runtime ignored the change (a worker thread, say): a test that cannot move
  // the zone would otherwise pass for the wrong reason.
  expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone);
}

const clockPattern = (time: string) => new RegExp(`^${time}\\s?[ap]\\.?m\\.?$`, 'iu');
const july = Date.UTC(2026, 6, 15, 18, 0); // 12:00 in Alberta, 11:00 in British Columbia

describe('device-local times follow the device time zone', () => {
  beforeEach(() => {
    moveDeviceTo('America/Edmonton');
  });

  afterEach(() => {
    if (originalZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalZone;
  });

  it('shows the arrival time in the new zone after the device crosses from Alberta into British Columbia', () => {
    const now = new Date(july);
    expect(formatArrivalTime(20 * 60, now)).toMatch(clockPattern('12:20'));

    moveDeviceTo('America/Vancouver');
    expect(formatArrivalTime(20 * 60, now)).toMatch(clockPattern('11:20'));

    moveDeviceTo('America/Edmonton');
    expect(formatArrivalTime(20 * 60, now)).toMatch(clockPattern('12:20'));
  });

  it('shows the "updated" time of community traffic in the new zone', () => {
    const boundary = new Date(july).toISOString();
    expect(communityTrafficUpdated([boundary])).toMatch(/^updated 12:00\s?[ap]\.?m\.?$/iu);

    moveDeviceTo('America/Vancouver');
    expect(communityTrafficUpdated([boundary])).toMatch(/^updated 11:00\s?[ap]\.?m\.?$/iu);
  });

  it('formats an arrival after the spring-forward boundary with the post-change offset', () => {
    // 2026-03-08 08:00 UTC is 01:00 MST; Alberta springs forward at 02:00 local (09:00 UTC).
    const beforeChange = new Date(Date.UTC(2026, 2, 8, 8, 0));
    expect(formatArrivalTime(30 * 60, beforeChange)).toMatch(clockPattern('1:30'));
    expect(formatArrivalTime(2 * 3_600, beforeChange)).toMatch(clockPattern('4:00'));
  });

  it('shows a road event start time in the new zone', () => {
    const parsed = OfficialRoadEventResponseSchema.parse(ontarioFixture.response);
    if (!('sources' in parsed)) throw new Error('expected a provincial response');
    const event = parsed.events[0];
    if (event === undefined) throw new Error('fixture has events');
    const started = { ...event, startsAt: new Date(july).toISOString() };
    const now = july + 3_600_000;
    expect(roadEventMessage(started, parsed, now)).toMatch(/^Starts: Jul 15(,| at) 12:00\s?p/mu);

    moveDeviceTo('America/Vancouver');
    expect(roadEventMessage(started, parsed, now)).toMatch(/^Starts: Jul 15(,| at) 11:00\s?a/mu);
  });
});
