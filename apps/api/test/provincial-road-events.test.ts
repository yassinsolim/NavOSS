import { readFileSync } from 'node:fs';

import { ProvincialRoadEventResponseSchema } from '@navoss/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  createCalgaryConstructionRoadEventFeed,
  createCalgaryIncidentRoadEventFeed,
  normalizeCalgaryConstruction,
} from '../src/calgary-province-road-event-feed.js';
import { createDriveBcProvinceRoadEventFeed } from '../src/drivebc-province-road-event-feed.js';
import { createEdmontonRoadEventFeed } from '../src/edmonton-road-event-feed.js';
import {
  createRoadEventFeed,
  parseLocalDateTime,
  zonedTimeToInstant,
} from '../src/official-road-event-feed.js';
import {
  createProvincial511RoadEventFeed,
  normalize511Event,
} from '../src/provincial-511-road-event-feed.js';
import {
  createProvincialRoadEventService,
  ProvincialRoadEventsUnavailableError,
  roadEventKeysFromEnvironment,
} from '../src/provincial-road-events.js';
import { createTorontoRoadEventFeed } from '../src/toronto-road-event-feed.js';

function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/road-events/${name}`, import.meta.url), 'utf8'),
  ) as T;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

const driveBc = fixture<{ payload: { events: Record<string, unknown>[] } }>(
  'drivebc-open511-2026-11-15.json',
);
const edmonton = fixture<{ metadata: { rowsUpdatedAt: number }; rows: Record<string, unknown>[] }>(
  'edmonton-traffic-disruptions-2026-11-15.json',
);
const toronto = fixture<{ payload: { Closure: Record<string, unknown>[] } }>(
  'toronto-road-restrictions-2026-11-15.json',
);
const calgary = fixture<{
  construction: { metadata: { rowsUpdatedAt: number }; rows: Record<string, unknown>[] };
  incident: { metadata: { rowsUpdatedAt: number }; rows: Record<string, unknown>[] };
}>('calgary-open-data-2026-11-15.json');
const ontario511 = fixture<{ rows: Record<string, unknown>[] }>(
  'ontario-511-event-documentation-sample.json',
);
const alberta511 = fixture<{ rows: Record<string, unknown>[] }>(
  'alberta-511-event-documentation-sample.json',
);
const invalidKey = readFileSync(
  new URL('./fixtures/road-events/511-invalid-key-2026-11-15.xml', import.meta.url),
  'utf8',
);

const CAPTURED = Date.parse('2026-11-15T09:30:00Z');

describe('local times', () => {
  it('converts wall time on both sides of daylight-saving transitions', () => {
    // Mountain: MDT (UTC-6) in July, MST (UTC-7) in December.
    expect(new Date(parseLocalDateTime('2026-07-01T09:00:00.000', 'America/Edmonton') ?? 0).toISOString()).toBe(
      '2026-07-01T15:00:00.000Z',
    );
    expect(new Date(parseLocalDateTime('2026-12-01T09:00:00', 'America/Edmonton') ?? 0).toISOString()).toBe(
      '2026-12-01T16:00:00.000Z',
    );
    // Repeated 01:30 on 2026-11-01 resolves to the first (daylight) occurrence.
    expect(
      new Date(
        zonedTimeToInstant({ day: 1, hour: 1, minute: 30, month: 11, year: 2026 }, 'America/Toronto'),
      ).toISOString(),
    ).toBe('2026-11-01T05:30:00.000Z');
    // 02:30 on 2026-03-08 does not exist in Edmonton; it resolves past the gap.
    expect(
      new Date(
        zonedTimeToInstant({ day: 8, hour: 2, minute: 30, month: 3, year: 2026 }, 'America/Edmonton'),
      ).toISOString(),
    ).toBe('2026-03-08T09:30:00.000Z');
    expect(parseLocalDateTime('2026-02-31', 'America/Edmonton')).toBeUndefined();
    expect(parseLocalDateTime('not a date', 'America/Edmonton')).toBeUndefined();
  });
});

describe('DriveBC province-wide events (recorded 2026-11-15)', () => {
  it('keeps every recorded event, maps closures and road conditions, and reads intervals as UTC', async () => {
    const urls: string[] = [];
    const feed = createDriveBcProvinceRoadEventFeed({
      clock: () => CAPTURED,
      fetchImplementation: (url) => {
        urls.push(String(url));
        return Promise.resolve(jsonResponse(driveBc.payload));
      },
    });
    const { events, source } = await feed.getSnapshot();

    expect(urls).toEqual([
      'https://api.open511.gov.bc.ca/events?format=json&status=ACTIVE&limit=500&offset=0',
    ]);
    expect(source).toMatchObject({ incomplete: false, sourceId: 'drivebc-open511-events', status: 'current' });
    expect(events.length).toBeGreaterThan(0);
    const types = new Set(events.map((event) => event.type));
    expect(types.has('closure')).toBe(true);
    expect(types.has('road-condition')).toBe(true);
    const redgrave = driveBc.payload.events.find((event) => event.id === 'drivebc.ca/RIDE-100481');
    if (redgrave !== undefined) {
      // created 2026-07-14T14:44:12-07:00, interval "2026-07-14T21:44/".
      expect(events.find((event) => event.id === 'drivebc-open511:RIDE-100481')?.startsAt).toBe(
        '2026-07-14T21:44:00.000Z',
      );
    }
    for (const event of events) {
      expect(event.updatedAt).toBeDefined();
      expect(event.regionId).toBe('british-columbia');
      if (event.isFullClosure === true) expect(['closure', 'collision']).toContain(event.type);
    }
  });

  it('pages until a short page and drops isolated malformed rows as incomplete', async () => {
    const page = (offset: number) =>
      offset === 0
        ? Array.from({ length: 500 }, (_, index) => ({
            ...driveBc.payload.events[index % driveBc.payload.events.length],
            id: `drivebc.ca/PAGE-${String(index)}`,
          }))
        : [{ ...driveBc.payload.events[0], geography: { type: 'Polygon' } }];
    const feed = createDriveBcProvinceRoadEventFeed({
      clock: () => CAPTURED,
      fetchImplementation: (url) =>
        Promise.resolve(
          jsonResponse({ events: page(Number(new URL(String(url)).searchParams.get('offset'))) }),
        ),
    });
    const { source } = await feed.getSnapshot();
    expect(source).toMatchObject({ incomplete: true, status: 'current' });
  });

  it('fails the refresh when more than 10% of rows drift from the documented shape', async () => {
    const feed = createDriveBcProvinceRoadEventFeed({
      clock: () => CAPTURED,
      fetchImplementation: () =>
        Promise.resolve(
          jsonResponse({
            events: driveBc.payload.events.map(({ updated: _updated, ...event }) => event),
          }),
        ),
    });
    expect((await feed.getSnapshot()).source.status).toBe('unavailable');
  });
});

describe('City of Edmonton traffic disruptions (recorded 2026-11-15)', () => {
  function edmontonFeed(now: number, metadata: unknown) {
    return createEdmontonRoadEventFeed({
      clock: () => now,
      fetchImplementation: (url) =>
        Promise.resolve(
          String(url).includes('/api/views/')
            ? metadata === undefined
              ? jsonResponse({}, 503)
              : jsonResponse(metadata)
            : jsonResponse(edmonton.rows),
        ),
    });
  }

  it('keeps calendar dates as dates and uses the dataset update time', async () => {
    const { events, source } = await edmontonFeed(CAPTURED, edmonton.metadata).getSnapshot();
    expect(source).toMatchObject({
      status: 'current',
      updatedAt: new Date(edmonton.metadata.rowsUpdatedAt * 1_000).toISOString(),
    });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.startsAt).toBeUndefined();
      expect(event.startsOn).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(event.updatedAt).toBeUndefined();
    }
    expect(events.some((event) => event.type === 'special-event' || event.type === 'closure')).toBe(true);
  });

  it('keeps an event through its last local day and drops it the next Edmonton day', async () => {
    const row = { ...edmonton.rows[0], finish_date: '2026-11-15T00:00:00.000', start_date: '2026-11-01T00:00:00.000' };
    const feedAt = (now: number) =>
      createEdmontonRoadEventFeed({
        clock: () => now,
        fetchImplementation: (url) =>
          Promise.resolve(String(url).includes('/api/views/') ? jsonResponse(edmonton.metadata) : jsonResponse([row])),
      });
    // 23:30 MST on 2026-11-15 is 06:30Z on the 16th: still the last day locally.
    expect((await feedAt(Date.parse('2026-11-16T06:30:00Z')).getSnapshot()).events).toHaveLength(1);
    expect((await feedAt(Date.parse('2026-11-16T07:30:00Z')).getSnapshot()).events).toHaveLength(0);
  });

  it('still serves rows when only the dataset metadata fails', async () => {
    const { source } = await edmontonFeed(CAPTURED, undefined).getSnapshot();
    expect(source.status).toBe('current');
    expect(source.updatedAt).toBeUndefined();
  });
});

describe('City of Toronto road restrictions (recorded 2026-11-15)', () => {
  it('keeps only rows the City says affect traffic now, with millisecond timestamps', async () => {
    const feed = createTorontoRoadEventFeed({
      clock: () => Date.parse('2026-11-15T10:00:00Z'),
      fetchImplementation: () => Promise.resolve(jsonResponse(toronto.payload)),
    });
    const { events, source } = await feed.getSnapshot();
    const affecting = toronto.payload.Closure.filter((row) => row.currImpact !== 'None');
    expect(events.length).toBeLessThanOrEqual(affecting.length);
    expect(events.length).toBeGreaterThan(0);
    expect(source.status).toBe('current');
    for (const event of events) {
      const row = toronto.payload.Closure.find((candidate) => `toronto-restriction:${String(candidate.id)}` === event.id);
      expect(row?.currImpact).not.toBe('None');
      expect(event.updatedAt).toBe(new Date(Number(row?.lastUpdated)).toISOString());
    }
    expect(events.filter((event) => event.type === 'closure').every((event) => event.isFullClosure)).toBe(true);
  });
});

describe('City of Calgary datasets in the Alberta response (recorded 2026-11-15)', () => {
  it('keeps current incidents unverified with the City update time', async () => {
    const feed = createCalgaryIncidentRoadEventFeed({
      clock: () => CAPTURED,
      fetchImplementation: (url) =>
        Promise.resolve(
          jsonResponse(String(url).includes('/api/views/') ? calgary.incident.metadata : calgary.incident.rows),
        ),
    });
    const { events, source } = await feed.getSnapshot();
    expect(source).toMatchObject({ confidence: 'unverified', status: 'current' });
    expect(events[0]).toMatchObject({
      confidence: 'unverified',
      startsAt: '2026-11-15T07:24:34.000Z',
      type: 'incident',
      updatedAt: '2026-11-15T08:12:28.000Z',
    });
  });

  it('treats an explicit no-incidents row as an empty, complete feed', async () => {
    const feed = createCalgaryIncidentRoadEventFeed({
      clock: () => CAPTURED,
      fetchImplementation: (url) =>
        Promise.resolve(
          jsonResponse(
            String(url).includes('/api/views/')
              ? calgary.incident.metadata
              : [{ incident_info: 'NO TRAFFIC INCIDENTS' }],
          ),
        ),
    });
    expect((await feed.getSnapshot()).source).toMatchObject({ eventCount: 0, incomplete: false, status: 'current' });
  });

  it('reads construction wall times in Calgary time across daylight saving', () => {
    const row = calgary.construction.rows[0];
    const summer = normalizeCalgaryConstruction({ ...row, end_dt: '2026-12-31T15:00:00.000', start_dt: '2026-07-01T09:00:00.000' });
    expect(summer.startsAt).toBe('2026-07-01T15:00:00.000Z');
    expect(summer.endsAt).toBe('2026-12-31T22:00:00.000Z');
  });

  it('serves recorded construction rows as official', async () => {
    const feed = createCalgaryConstructionRoadEventFeed({
      clock: () => CAPTURED,
      fetchImplementation: (url) =>
        Promise.resolve(
          jsonResponse(String(url).includes('/api/views/') ? calgary.construction.metadata : calgary.construction.rows),
        ),
    });
    const { events, source } = await feed.getSnapshot();
    expect(source).toMatchObject({ confidence: 'official', status: 'current' });
    expect(events.every((event) => event.confidence === 'official' && event.type === 'construction')).toBe(true);
  });
});

describe('511 Alberta and Ontario 511', () => {
  it('is inert without a key: no request, not-configured', async () => {
    const fetchImplementation = vi.fn(() => Promise.resolve(jsonResponse([])));
    for (const province of ['alberta', 'ontario'] as const) {
      const feed = createProvincial511RoadEventFeed(province, '  ', { fetchImplementation });
      feed.start();
      expect((await feed.getSnapshot()).source).toMatchObject({ eventCount: 0, status: 'not-configured' });
      feed.stop();
    }
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(roadEventKeysFromEnvironment({ ALBERTA_511_API_KEY: '', ONTARIO_511_API_KEY: ' k ' })).toEqual({
      ontario511ApiKey: 'k',
    });
  });

  it('normalizes the documented Ontario sample and sends the key as a query parameter', async () => {
    const urls: string[] = [];
    const feed = createProvincial511RoadEventFeed('ontario', 'test-key', {
      // Inside both documented events' planned windows.
      clock: () => Date.parse('2025-05-01T12:00:00Z'),
      fetchImplementation: (url) => {
        urls.push(String(url));
        return Promise.resolve(jsonResponse(ontario511.rows));
      },
    });
    const { events, source } = await feed.getSnapshot();
    expect(new URL(urls[0] ?? '').searchParams.get('key')).toBe('test-key');
    expect(source.status).toBe('current');
    expect(events[0]).toMatchObject({
      direction: 'Eastbound',
      roadwayName: 'HWY 401',
      sourceId: 'ontario-511-events',
      startsAt: new Date(1_744_084_740_000).toISOString(),
      type: 'construction',
      updatedAt: new Date(1_742_491_980_000).toISOString(),
    });
    expect(events[0]?.severity).toBeUndefined();
  });

  it('maps the documented Alberta sample types and severity', () => {
    expect(
      alberta511.rows.map((row) => {
        const event = normalize511Event(row, 'alberta');
        return [event?.type, event?.severity, event?.direction];
      }),
    ).toEqual([
      ['special-event', undefined, 'West'],
      ['incident', 'major', 'South'],
    ]);
  });

  it('reports the recorded Invalid Key answer as unavailable', async () => {
    const feed = createProvincial511RoadEventFeed('ontario', 'revoked', {
      fetchImplementation: () =>
        Promise.resolve(new Response(invalidKey, { headers: { 'content-type': 'application/xml' }, status: 400 })),
    });
    expect((await feed.getSnapshot()).source.status).toBe('unavailable');
  });
});

describe('feed freshness', () => {
  it('serves the last valid snapshot as stale within its bound, then unavailable', async () => {
    let now = CAPTURED;
    let offline = false;
    const feed = createTorontoRoadEventFeed({
      clock: () => now,
      fetchImplementation: () =>
        Promise.resolve(offline ? jsonResponse({}, 503) : jsonResponse(toronto.payload)),
    });
    const first = await feed.getSnapshot();
    expect(first.source.status).toBe('current');
    offline = true;
    now += 301_000;
    const stale = await feed.getSnapshot();
    expect(stale.source).toMatchObject({ checkedAt: first.source.checkedAt, status: 'stale' });
    expect(stale.events).toEqual(first.events);
    now += 3_600_000;
    expect(await feed.getSnapshot()).toMatchObject({ events: [], source: { status: 'unavailable' } });
  });

  it('shares one request between concurrent callers', async () => {
    const fetchImplementation = vi.fn(() => Promise.resolve(jsonResponse(toronto.payload)));
    const feed = createTorontoRoadEventFeed({ clock: () => CAPTURED, fetchImplementation });
    await Promise.all([feed.getSnapshot(), feed.getSnapshot(), feed.getSnapshot()]);
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('reports a failure by name only, never the URL', async () => {
    const failures: unknown[] = [];
    const feed = createProvincial511RoadEventFeed('alberta', 'secret-key', {
      fetchImplementation: () => Promise.reject(new TypeError('fetch failed')),
      onFailure: (failure) => failures.push(failure),
    });
    await feed.getSnapshot();
    expect(JSON.stringify(failures)).not.toContain('secret-key');
    expect(failures).toEqual([{ errorName: 'TypeError', sourceId: 'alberta-511-events' }]);
  });
});

describe('provincial road-event service', () => {
  const descriptor = {
    attribution: 'Test',
    confidence: 'official',
    documentationUrl: 'https://example.ca/doc',
    licenseUrl: 'https://example.ca/licence',
    maximumAgeSeconds: 3_600,
    name: 'Test',
    refreshIntervalSeconds: 300,
    timeZone: 'America/Toronto',
  } as const;

  it('merges sources newest first and summarises their states', async () => {
    const toronto511 = createTorontoRoadEventFeed({
      clock: () => Date.parse('2026-11-15T10:00:00Z'),
      fetchImplementation: () => Promise.resolve(jsonResponse(toronto.payload)),
    });
    const service = createProvincialRoadEventService(
      {
        alberta: [],
        'british-columbia': [],
        ontario: [createProvincial511RoadEventFeed('ontario', undefined), toronto511],
      },
      () => Date.parse('2026-11-15T10:00:00Z'),
    );
    const response = await service.getRoadEvents('ontario');
    expect(ProvincialRoadEventResponseSchema.parse(response)).toEqual(response);
    expect(response).toMatchObject({ degraded: true, regionId: 'ontario', stale: false });
    expect(response.sources.map((source) => [source.sourceId, source.status])).toEqual([
      ['ontario-511-events', 'not-configured'],
      ['toronto-road-restrictions', 'current'],
    ]);
    const times = response.events.map((event) => Date.parse(event.updatedAt ?? ''));
    expect([...times].sort((left, right) => right - left)).toEqual(times);
  });

  it('fails closed when no source of the region has data', async () => {
    const dead = createRoadEventFeed(
      { ...descriptor, sourceId: 'toronto-road-restrictions' },
      () => Promise.reject(new Error('dead')),
    );
    const service = createProvincialRoadEventService({
      alberta: [],
      'british-columbia': [],
      ontario: [createProvincial511RoadEventFeed('ontario', undefined), dead],
    });
    await expect(service.getRoadEvents('ontario')).rejects.toBeInstanceOf(
      ProvincialRoadEventsUnavailableError,
    );
  });
});
