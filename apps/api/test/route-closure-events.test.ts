import { describe, expect, it, vi } from 'vitest';

import { createCalgaryConstructionRoadEventFeed } from '../src/calgary-province-road-event-feed.js';
import {
  createDriveBcProvinceRoadEventFeed,
  intervalInstant,
} from '../src/drivebc-province-road-event-feed.js';
import { createProvincial511RoadEventFeed } from '../src/provincial-511-road-event-feed.js';
import { canonicalClosureRoadName, selectClosureEvents } from '../src/route-closures/events.js';
import official from './fixtures/road-events/official-closures-2026-11-27.json' with { type: 'json' };
import alberta from './fixtures/road-events/alberta-511-event-documentation-sample.json' with { type: 'json' };
import ontario from './fixtures/road-events/ontario-511-event-documentation-sample.json' with { type: 'json' };
import { fixtureValue } from '../../../packages/contracts/test/fixture-value.js';

const now = Date.parse(official.retrievedAt);
const jingle = fixtureValue(
  official.driveBc.rows.find((row) => row.id === 'drivebc.ca/RIDE-108168'),
);

async function bcSelection(clock: number, rows: readonly unknown[] = official.driveBc.rows) {
  const feed = createDriveBcProvinceRoadEventFeed({
    clock: () => clock,
    fetchImplementation: () => Promise.resolve(new Response(JSON.stringify({ events: rows }))),
  });
  const snapshot = await feed.getSnapshot();
  expect(snapshot.source.status).toBe('current');
  return selectClosureEvents([snapshot], clock);
}

describe('official closure eligibility, without guessing source meaning', () => {
  it('selects exactly the seven current semantic candidates from the published DriveBC rows', async () => {
    const selected = await bcSelection(now);
    expect(selected.events).toHaveLength(7);
    expect(selected.events.filter((event) => event.geometryType === 'line')).toHaveLength(2);
    expect(selected.events.filter((event) => event.geometryType === 'point')).toHaveLength(5);
    expect(selected.rejected).toMatchObject({
      'not-started': 4,
      'schedule-uncertain': 2,
      'not-a-road': 1,
      'traffic-still-open': 1,
      'not-full-closure': 1,
    });
    expect(selected.events.some((event) => event.roadNames.includes('Jingle Pot Road'))).toBe(true);
  });

  it('uses minute-only UTC intervals rather than rejecting all current Open511 closures', () => {
    expect(intervalInstant('2026-11-27T01:01')).toBe('2026-11-27T01:01:00.000Z');
    expect(intervalInstant('2026-11-27T01:01:00-07:00')).toBe('2026-11-27T08:01:00.000Z');
  });

  it('does not turn lane closures, activity-list advisories or detour geometry into a full 511 closure', async () => {
    for (const [province, fixture] of [
      ['alberta', alberta],
      ['ontario', ontario],
    ] as const) {
      const feed = createProvincial511RoadEventFeed(province, 'fixture-only-key', {
        clock: () => now,
        fetchImplementation: () => Promise.resolve(new Response(JSON.stringify(fixture.rows))),
      });
      const selected = selectClosureEvents([await feed.getSnapshot()], now);
      expect(selected.events).toEqual([]);
      expect(selected.rejected['not-full-closure']).toBe(2);
    }
  });

  it('does not call a keyed feed at all when the server has no key', async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const feed = createProvincial511RoadEventFeed('alberta', undefined, { fetchImplementation });
    const snapshot = await feed.getSnapshot();
    expect(snapshot.source.status).toBe('not-configured');
    expect(selectClosureEvents([snapshot], now).events).toEqual([]);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('rejects a successfully fetched but ten-day-old Calgary publisher snapshot', async () => {
    const feed = createCalgaryConstructionRoadEventFeed({
      clock: () => now,
      fetchImplementation: (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return Promise.resolve(
          new Response(
            JSON.stringify(
              url.includes('/api/views/')
                ? { rowsUpdatedAt: official.calgaryConstruction.rowsUpdatedAt }
                : official.calgaryConstruction.rows,
            ),
          ),
        );
      },
    });
    const snapshot = await feed.getSnapshot();
    expect(snapshot.source.status).toBe('current');
    const selected = selectClosureEvents([snapshot], now);
    expect(selected.events).toEqual([]);
    expect(selected.rejected['source-stale']).toBe(official.calgaryConstruction.rows.length);
  });

  it('rejects a retained stale closure even though the map may still show that bounded copy', async () => {
    let clock = now;
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ events: [jingle] }))),
    );
    const feed = createDriveBcProvinceRoadEventFeed({ clock: () => clock, fetchImplementation });
    expect(selectClosureEvents([await feed.getSnapshot()], clock).events).toHaveLength(1);
    clock += 301_000;
    fetchImplementation.mockRejectedValue(new Error('source unavailable'));
    const stale = await feed.getSnapshot();
    expect(stale.source.status).toBe('stale');
    expect(stale.events).toHaveLength(1);
    expect(selectClosureEvents([stale], clock).events).toEqual([]);
  });

  it('rechecks all intervals and their expiry, not only the source ACTIVE flag', async () => {
    // Deliberately changed schedule fields on recorded geometry test the time boundary, not live data.
    const expired = { ...jingle, schedule: { intervals: ['2026-11-26T00:00/2026-11-27T00:00'] } };
    const selected = await bcSelection(now, [expired]);
    expect(selected.events).toEqual([]);
    expect(selected.rejected.expired).toBe(1);
    const disjoint = {
      ...jingle,
      schedule: {
        intervals: ['2026-11-26T00:00/2026-11-26T01:00', '2026-11-27T06:00/2026-11-27T07:00'],
      },
    };
    expect((await bcSelection(now, [disjoint])).events).toHaveLength(1);
  });

  it('rejects invalid calendar bounds instead of normalising a fictional February date', async () => {
    const invalid = { ...jingle, schedule: { intervals: ['2026-02-30T01:01/'] } };
    const selected = await bcSelection(now, [invalid]);
    expect(selected.events).toEqual([]);
    expect(selected.rejected['schedule-uncertain']).toBe(1);
  });

  it('does not assign one event geometry to several independently directed roads', async () => {
    const multiple = { ...jingle, roads: [jingle.roads[0], jingle.roads[0]] };
    expect((await bcSelection(now, [multiple])).rejected['ambiguous-road']).toBe(1);
  });

  it('accepts additive source fields without changing the chosen closures', async () => {
    const additive = { ...jingle, future_publisher_field: { value: 'ignored metadata' } };
    expect((await bcSelection(now, [additive])).events).toHaveLength(1);
  });

  it('matches road names exactly after known abbreviations, never by a partial highway number', () => {
    expect(canonicalClosureRoadName('34 Av NW')).toBe(canonicalClosureRoadName('34 Avenue NW'));
    expect(canonicalClosureRoadName('HWY-1')).toBe(canonicalClosureRoadName('1'));
    expect(canonicalClosureRoadName('Highway 1')).not.toBe(canonicalClosureRoadName('Highway 11'));
    expect(canonicalClosureRoadName('15 Street Bridge NE')).not.toBe(
      canonicalClosureRoadName('128 Avenue NE'),
    );
  });
});
