import { describe, expect, it, vi } from 'vitest';

import {
  calgaryWallTimeToUtcMs,
  createTravelTimesFeed,
  parseTravelTimes,
  TRAVEL_TIMES_MIN_POLL_MS,
} from '../src/calgary-travel-times/feed.js';

const NOW = Date.parse('2026-11-27T06:30:00Z');
const row = (segment: string, minutes: string, lastUpdate = '2026-11-26T23:03:43.000') => ({
  corridor: 'Deerfoot Trail',
  last_update: lastUpdate,
  road_segment: segment,
  travel_time_mins: minutes,
});

describe('City of Calgary travel-times feed', () => {
  it('converts Calgary wall time to UTC across both daylight-saving changes', () => {
    // Mountain Standard Time (UTC-7), the feed's own example.
    expect(new Date(calgaryWallTimeToUtcMs('2026-11-26T23:03:43.000') ?? 0).toISOString()).toBe(
      '2026-11-27T06:03:43.000Z',
    );
    // Mountain Daylight Time (UTC-6).
    expect(new Date(calgaryWallTimeToUtcMs('2026-07-01T08:00:00') ?? 0).toISOString()).toBe(
      '2026-07-01T14:00:00.000Z',
    );
    // 2026-11-01 01:30 happens twice; the earlier (MDT) instant is taken.
    expect(new Date(calgaryWallTimeToUtcMs('2026-11-01T01:30:00') ?? 0).toISOString()).toBe(
      '2026-11-01T07:30:00.000Z',
    );
    // 2026-03-08 02:30 never happens in Calgary.
    expect(calgaryWallTimeToUtcMs('2026-03-08T02:30:00')).toBeUndefined();
    expect(calgaryWallTimeToUtcMs('2026-11-26 23:03')).toBeUndefined();
  });

  it('keeps valid rows, tolerates extra fields and drops malformed rows', () => {
    const rows = [
      ...Array.from({ length: 19 }, (_, index) => row(`Segment ${String(index)}`, '7')),
      { ...row('Extra', '5'), new_field: 'added by the City' },
      { ...row('Bad', 'seven') },
    ];
    const parsed = parseTravelTimes(rows, NOW);
    expect(parsed.malformed).toBe(1);
    expect(parsed.rows.get('Extra')).toEqual({
      lastUpdateMs: Date.parse('2026-11-27T06:03:43Z'),
      minutes: 5,
    });
    expect(parsed.rows.has('Bad')).toBe(false);
  });

  it('fails closed when more than a tenth of the rows are malformed or none is valid', () => {
    const renamed = Array.from({ length: 10 }, (_, index) => ({
      minutes: '7',
      segment: `Segment ${String(index)}`,
    }));
    expect(() => parseTravelTimes([...renamed, row('Ok', '4')], NOW)).toThrow(
      'too many malformed rows',
    );
    expect(() => parseTravelTimes([], NOW)).toThrow();
    expect(() => parseTravelTimes([row('Future', '4', '2026-11-27T00:00:00')], NOW)).toThrow();
  });

  it('polls politely: conditional, never faster than the minimum interval, keeping the last answer on failure', async () => {
    let now = NOW;
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([row('A', '7')]), {
          headers: { etag: 'W/"one"', 'last-modified': 'Fri, 27 Nov 2026 06:28:07 GMT' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockRejectedValueOnce(new TypeError('network down'));
    const feed = createTravelTimesFeed({ clock: () => now, fetchImplementation });
    await feed.refresh();
    expect(feed.snapshot()?.rows.get('A')?.minutes).toBe(7);
    await feed.refresh();
    expect(fetchImplementation).toHaveBeenCalledTimes(1);

    now += TRAVEL_TIMES_MIN_POLL_MS;
    await feed.refresh();
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const headers = fetchImplementation.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(headers['if-none-match']).toBe('W/"one"');
    expect(headers['if-modified-since']).toBe('Fri, 27 Nov 2026 06:28:07 GMT');
    expect(feed.counters().notModified).toBe(1);

    now += TRAVEL_TIMES_MIN_POLL_MS;
    await feed.refresh();
    expect(feed.counters().fetchFailures).toBe(1);
    expect(feed.snapshot()?.rows.get('A')?.minutes).toBe(7);
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe(
      'https://data.calgary.ca/resource/aeb8-fh2w.json?$limit=200',
    );
  });
});
