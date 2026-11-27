import { describe, expect, it } from 'vitest';

import { fixtureValue } from '../../../packages/contracts/test/fixture-value.js';
import { createDriveBcProvinceRoadEventFeed } from '../src/drivebc-province-road-event-feed.js';
import { createProvincial511RoadEventFeed } from '../src/provincial-511-road-event-feed.js';
import { selectClosureEvents } from '../src/route-closures/events.js';
import official from './fixtures/road-events/official-closures-2026-11-27.json' with { type: 'json' };
import alberta from './fixtures/road-events/alberta-511-event-documentation-sample.json' with { type: 'json' };

const jingle = fixtureValue(
  official.driveBc.rows.find((row) => row.id === 'drivebc.ca/RIDE-108168'),
);
const sample = fixtureValue(alberta.rows[0]);
const schedules = sample.RecurrenceSchedules;
if (!Array.isArray(schedules)) throw new Error('Missing documented 511 schedule sample.');
const documented = fixtureValue(schedules[0]);

async function selectBc(clock: string, schedule: unknown) {
  const now = Date.parse(clock);
  // Changed schedule fields on a recorded road are parser vectors, never published closure data.
  const feed = createDriveBcProvinceRoadEventFeed({
    clock: () => now,
    fetchImplementation: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            events: [{ ...jingle, schedule }],
          }),
        ),
      ),
  });
  const snapshot = await feed.getSnapshot();
  expect(snapshot.source.status).toBe('current');
  return selectClosureEvents([snapshot], now);
}

async function selectAlberta(clock: string, row: unknown) {
  const now = Date.parse(clock);
  const feed = createProvincial511RoadEventFeed('alberta', 'fixture-only-key', {
    clock: () => now,
    fetchImplementation: () => Promise.resolve(new Response(JSON.stringify([row]))),
  });
  const snapshot = await feed.getSnapshot();
  expect(snapshot.source.status).toBe('current');
  return selectClosureEvents([snapshot], now);
}

describe('recurring official closure windows in the source time zone', () => {
  it('uses Open511 daily hours and ISO weekdays in Vancouver time, not UTC', async () => {
    const schedule = {
      recurring_schedules: [
        {
          start_date: '2026-11-27',
          end_date: '2026-11-30',
          daily_start_time: '10:00',
          daily_end_time: '11:00',
          days: [5],
        },
      ],
    };
    // British Columbia remains UTC-07 in November 2026; 17:30 UTC is Friday 10:30 Pacific.
    expect((await selectBc('2026-11-27T17:30:00Z', schedule)).events).toHaveLength(1);
    expect((await selectBc('2026-11-27T18:01:00Z', schedule)).rejected['outside-window']).toBe(1);
    expect((await selectBc('2026-11-28T17:30:00Z', schedule)).events).toEqual([]);
  });

  it('applies whole-day exceptions and replacement time windows instead of widening a recurring closure', async () => {
    const recurring_schedules = [
      {
        start_date: '2026-11-27',
        end_date: '2026-11-30',
        daily_start_time: '10:00',
        daily_end_time: '11:00',
        days: [5],
      },
    ];
    expect(
      (await selectBc('2026-11-27T17:30:00Z', { recurring_schedules, exceptions: ['2026-11-27'] }))
        .events,
    ).toEqual([]);
    const exception = { recurring_schedules, exceptions: ['2026-11-27 12:00-13:00'] };
    expect((await selectBc('2026-11-27T17:30:00Z', exception)).events).toEqual([]);
    expect((await selectBc('2026-11-27T19:30:00Z', exception)).events).toHaveLength(1);
  });

  it('rejects an incomplete daily time pair and an unknown additional recurrence constraint', async () => {
    const incomplete = {
      recurring_schedules: [{ start_date: '2026-11-27', daily_start_time: '10:00' }],
    };
    expect(
      (await selectBc('2026-11-27T17:30:00Z', incomplete)).rejected['schedule-uncertain'],
    ).toBe(1);
    const unknown = {
      recurring_schedules: [
        {
          start_date: '2026-11-27',
          daily_start_time: '10:00',
          daily_end_time: '11:00',
          special_restriction: true,
        },
      ],
    };
    expect((await selectBc('2026-11-27T17:30:00Z', unknown)).events).toEqual([]);
  });

  it('evaluates the official 511 schedule grammar and five-decimal affected-road polyline', async () => {
    // The documentation example is not a full closure; this deliberate flag/time mutation tests
    // its documented schedule grammar without claiming a live Alberta event or inventing a road.
    const row = {
      ...sample,
      IsFullClosure: true,
      RecurrenceSchedules: [
        {
          ...documented,
          Times: [{ StartTime: '12:00:00-06:00:00', EndTime: '13:00:00-06:00:00' }],
        },
      ],
    };
    const selected = await selectAlberta('2023-10-19T18:20:00Z', row);
    expect(selected.events).toHaveLength(1);
    const event = fixtureValue(selected.events[0]);
    expect(event.direction).toBe('west');
    expect(event.geometryType).toBe('line');
    expect(event.geometry[0]?.[0]).toBeCloseTo(sample.Longitude, 4);
    expect(event.geometry[0]?.[1]).toBeCloseTo(sample.Latitude, 4);
    expect((await selectAlberta('2023-10-19T19:15:00Z', row)).rejected['outside-window']).toBe(1);
  });

  it('anchors an overnight 511 window to the preceding local weekday', async () => {
    const row = {
      ...sample,
      IsFullClosure: true,
      PlannedEndDate: Date.parse('2023-10-20T08:00:00Z') / 1_000,
      RecurrenceSchedules: [
        {
          ...documented,
          EndDate: '10/20/2023 2:00:00 AM-06:00:00',
          Times: [{ StartTime: '23:00:00-06:00:00', EndTime: '01:00:00-06:00:00' }],
        },
      ],
    };
    expect((await selectAlberta('2023-10-20T06:30:00Z', row)).events).toHaveLength(1);
    expect((await selectAlberta('2023-10-20T07:15:00Z', row)).events).toEqual([]);
  });

  it('uses the next local date for an overnight end crossing Edmonton fall-back', async () => {
    const row = {
      ...sample,
      IsFullClosure: true,
      StartDate: Date.parse('2026-10-31T18:00:00Z') / 1_000,
      PlannedEndDate: Date.parse('2026-11-02T09:00:00Z') / 1_000,
      RecurrenceSchedules: [
        {
          StartDate: '10/31/2026 12:00:00 PM-06:00:00',
          EndDate: '11/02/2026 2:00:00 AM-07:00:00',
          DaysOfWeek: ['Saturday'],
          Times: [{ StartTime: '23:00:00-06:00:00', EndTime: '02:00:00-07:00:00' }],
        },
      ],
    };
    expect((await selectAlberta('2026-11-01T05:30:00Z', row)).events).toHaveLength(1);
    expect((await selectAlberta('2026-11-01T07:30:00Z', row)).events).toHaveLength(1);
    expect((await selectAlberta('2026-11-01T08:30:00Z', row)).events).toHaveLength(1);
    expect((await selectAlberta('2026-11-01T09:01:00Z', row)).events).toEqual([]);
  });
});
