import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deviceDateTimeFormat } from '../src/lib/device-time-format.js';

const originalZone = process.env.TZ;

function moveDeviceTo(zone: string): void {
  process.env.TZ = zone;
  expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone);
}

const clock = { hour: 'numeric', minute: '2-digit' } as const;
const clockPattern = (time: string) => new RegExp(`^${time}\\s?[ap]\\.?m\\.?$`, 'iu');
const july = Date.UTC(2026, 6, 15, 18, 0); // 12:00 in Alberta, 11:00 in British Columbia

describe('deviceDateTimeFormat', () => {
  beforeEach(() => {
    moveDeviceTo('America/Edmonton');
  });

  afterEach(() => {
    if (originalZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalZone;
  });

  it('reuses one formatter while the zone is unchanged, across dates with different offsets', () => {
    const winter = Date.UTC(2026, 0, 15, 18, 0);
    const first = deviceDateTimeFormat('en-CA', clock);
    expect(deviceDateTimeFormat('en-CA', clock)).toBe(first);
    expect(deviceDateTimeFormat('en-CA', { ...clock })).toBe(first);
    // Winter and summer instants (UTC-7 and UTC-6 in Alberta) share the formatter: it is bound to
    // the zone, which applies each instant's own offset. Rebuilding per offset would cost a list of
    // events that spans a clock change the Android construction time for every row.
    expect(first.format(winter)).toMatch(clockPattern('11:00'));
    expect(first.format(july)).toMatch(clockPattern('12:00'));
    expect(deviceDateTimeFormat('en-CA', clock)).toBe(first);
  });

  it('keeps distinct formatters for distinct options and locales', () => {
    const base = deviceDateTimeFormat('en-CA', clock);
    expect(deviceDateTimeFormat('en-CA', { weekday: 'short' })).not.toBe(base);
    expect(deviceDateTimeFormat('en-US', clock)).not.toBe(base);
  });

  it('rebuilds its formatters when the device zone changes', () => {
    const before = deviceDateTimeFormat('en-CA', clock);
    moveDeviceTo('America/Vancouver');
    const after = deviceDateTimeFormat('en-CA', clock);
    expect(after).not.toBe(before);
    expect(after.format(july)).toMatch(clockPattern('11:00'));
    expect(deviceDateTimeFormat('en-CA', clock)).toBe(after);
  });
});
