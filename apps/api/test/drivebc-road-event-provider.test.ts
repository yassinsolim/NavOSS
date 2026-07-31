import { describe, expect, it } from 'vitest';

import {
  createDriveBcRoadEventProvider,
  DriveBcRoadEventProviderError,
} from '../src/drivebc-road-event-provider.js';

const construction = {
  '+ivr_message': 'Highway 97 utility work.',
  '+linear_reference_km': 126.09,
  areas: [{ id: 'drivebc.ca/5', name: 'Okanagan-Shuswap District', url: 'https://example.com/5' }],
  created: '2026-07-21T09:33:36-07:00',
  description: 'Highway 97, in both directions. Bridge maintenance near Kelowna. Lane Closure.',
  event_subtypes: ['ROAD_MAINTENANCE'],
  event_type: 'CONSTRUCTION',
  geography: { coordinates: [-119.421082, 49.889277], type: 'Point' },
  headline: 'CONSTRUCTION',
  id: 'drivebc.ca/DBC-93723',
  jurisdiction_url: 'https://api.open511.gov.bc.ca/jurisdiction',
  roads: [{ direction: 'BOTH', from: 'Highway 33', name: 'Highway 97', to: 'Leathead Rd' }],
  schedule: { intervals: ['2026-07-31T04:00:00Z/2026-07-31T12:00:00Z'] },
  severity: 'MINOR',
  status: 'ACTIVE',
  updated: '2026-07-26T21:00:00-07:00',
  url: 'https://api.open511.gov.bc.ca/events/drivebc.ca/DBC-93723',
};

function payload(events: unknown[]): unknown {
  return {
    events,
    meta: { up_url: '', url: '/events', version: 'v1' },
    pagination: { offset: '0' },
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

describe('DriveBC road event provider', () => {
  it('normalizes Kelowna construction and explicit incident closures', async () => {
    const provider = createDriveBcRoadEventProvider({
      clock: () => Date.parse('2026-07-30T20:30:00Z'),
      fetchImplementation: () =>
        Promise.resolve(
          jsonResponse(
            payload([
              construction,
              {
                ...construction,
                description: 'Highway 97 is closed in both directions after a vehicle incident.',
                event_subtypes: ['COLLISION'],
                event_type: 'INCIDENT',
                geography: {
                  coordinates: [
                    [-119.5, 49.88],
                    [-119.49, 49.89],
                    [-119.48, 49.9],
                  ],
                  type: 'LineString',
                },
                headline: 'INCIDENT',
                id: 'drivebc.ca/DBC-93724',
                roads: [
                  { direction: 'BOTH', from: 'Abbott St', name: 'Highway 97', to: 'Richter St' },
                ],
                url: 'https://api.open511.gov.bc.ca/events/drivebc.ca/DBC-93724',
              },
            ]),
          ),
        ),
    });

    const response = await provider.getRoadEvents();

    expect(response).toMatchObject({ degraded: false, regionId: 'kelowna-bc', stale: false });
    expect(response.events).toEqual([
      expect.objectContaining({
        id: 'drivebc-open511:DBC-93723',
        isFullClosure: false,
        startsAt: '2026-07-31T04:00:00.000Z',
        type: 'construction',
      }),
      expect.objectContaining({
        coordinate: { latitude: 49.88, longitude: -119.5 },
        id: 'drivebc-open511:DBC-93724',
        isFullClosure: true,
        type: 'closure',
      }),
    ]);
  });

  it('interprets offsetless schedule intervals in the DriveBC local time zone', async () => {
    const provider = createDriveBcRoadEventProvider({
      fetchImplementation: () =>
        Promise.resolve(
          jsonResponse(
            payload([
              {
                ...construction,
                schedule: { intervals: ['2026-07-31T04:00:00/2026-07-31T12:00:00'] },
              },
            ]),
          ),
        ),
    });

    expect((await provider.getRoadEvents()).events[0]).toMatchObject({
      endsAt: '2026-07-31T19:00:00.000Z',
      startsAt: '2026-07-31T11:00:00.000Z',
    });
  });

  it('represents recurring DriveBC windows without using record creation time', async () => {
    const provider = createDriveBcRoadEventProvider({
      fetchImplementation: () =>
        Promise.resolve(
          jsonResponse(
            payload([
              {
                ...construction,
                schedule: {
                  recurring_schedules: [
                    {
                      daily_end_time: '05:00',
                      daily_start_time: '21:00',
                      days: [1, 2, 3, 4, 7],
                      end_date: '2026-07-31',
                      start_date: '2026-07-26',
                    },
                  ],
                },
              },
            ]),
          ),
        ),
    });

    const event = (await provider.getRoadEvents()).events[0];
    expect(event?.description).toContain('Recurring daily work window 21:00–05:00');
    expect(event?.endsAt).toBe('2026-07-31T12:00:00.000Z');
    expect(event?.startsAt).toBe('2026-07-27T04:00:00.000Z');
  });

  it('fails closed on changed Open511 fields and out-of-bounds representatives', async () => {
    const changed = createDriveBcRoadEventProvider({
      fetchImplementation: () =>
        Promise.resolve(jsonResponse(payload([{ ...construction, unexpected: true }]))),
    });
    await expect(changed.getRoadEvents()).rejects.toBeInstanceOf(DriveBcRoadEventProviderError);

    const outside = createDriveBcRoadEventProvider({
      fetchImplementation: () =>
        Promise.resolve(
          jsonResponse(
            payload([
              {
                ...construction,
                geography: { coordinates: [-119.8, 49.89], type: 'Point' },
              },
            ]),
          ),
        ),
    });
    expect((await outside.getRoadEvents()).events).toEqual([]);
  });

  it('returns a bounded stale snapshot and then fails closed', async () => {
    let now = Date.parse('2026-07-30T20:30:00Z');
    let offline = false;
    const provider = createDriveBcRoadEventProvider({
      cacheTtlMs: 1_000,
      clock: () => now,
      fetchImplementation: () =>
        Promise.resolve(offline ? jsonResponse({}, 503) : jsonResponse(payload([construction]))),
      maximumStaleMs: 10_000,
    });

    await provider.getRoadEvents();
    now += 1_001;
    offline = true;
    expect(await provider.getRoadEvents()).toMatchObject({ degraded: true, stale: true });
    now += 10_001;
    await expect(provider.getRoadEvents()).rejects.toBeInstanceOf(DriveBcRoadEventProviderError);
  });
});
