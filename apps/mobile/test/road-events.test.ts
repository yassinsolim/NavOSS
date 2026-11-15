import {
  OfficialRoadEventResponseSchema,
  type ProvincialRoadEventResponse,
  type RoadEvent,
  type RoadEventResponse,
} from '@navoss/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ProvincialRoadEventRegionSchema, registeredServiceAreas } from '@navoss/contracts';
import { mapRegionForCoordinate } from '../src/features/map/map-region.js';
import { createRoadEventLoader } from '../src/features/map/road-event-refresh.js';
import {
  currentRoadEvents,
  relativeAge,
  nextRoadEventView,
  roadEventAgeLabel,
  roadEventAvailability,
  roadEventCredit,
  roadEventFeedForMapRegion,
  roadEventLayer,
  roadEventMessage,
  roadEventSourceLines,
  roadEventStatusLabel,
} from '../src/features/map/road-events.js';
import { NavOssApiError } from '../src/lib/api.js';

import albertaFixture from './fixtures/road-events/v2-events-alberta-2026-11-15.json' with { type: 'json' };
import ontarioFixture from './fixtures/road-events/v2-events-ontario-2026-11-15.json' with { type: 'json' };

function recorded({ response }: { response: unknown }): ProvincialRoadEventResponse {
  const parsed = OfficialRoadEventResponseSchema.parse(response);
  if (!('sources' in parsed)) throw new Error('expected a provincial response');
  return parsed;
}

const alberta = recorded(albertaFixture);
const ontario = recorded(ontarioFixture);
const CAPTURED = Date.parse(alberta.generatedAt);

const calgaryIncident: RoadEvent = {
  confidence: 'unverified',
  coordinate: { latitude: 51.05, longitude: -114.07 },
  description: 'Two vehicle incident.',
  id: 'incident-1',
  sourceId: 'calgary-current-incidents',
  startsAtLocal: '2026-11-12T08:30:00',
  timeZone: 'America/Edmonton',
  title: 'Macleod Trail at 9 Avenue SE',
  type: 'incident',
};

describe('road-event feed per map region', () => {
  it('reads the province, with the older feed only where an older server had one', () => {
    expect(roadEventFeedForMapRegion('calgary-ab')).toEqual({
      legacy: 'calgary',
      provincial: 'alberta',
    });
    expect(roadEventFeedForMapRegion('alberta')).toEqual({
      legacy: undefined,
      provincial: 'alberta',
    });
    expect(roadEventFeedForMapRegion('kelowna-bc')).toEqual({
      legacy: 'kelowna-bc',
      provincial: 'british-columbia',
    });
    expect(roadEventFeedForMapRegion('ontario')).toEqual({
      legacy: undefined,
      provincial: 'ontario',
    });
    // An unknown or unlocated position never falls back to another region's events.
    expect(roadEventFeedForMapRegion('other')).toEqual({
      legacy: undefined,
      provincial: undefined,
    });
    expect(roadEventFeedForMapRegion(undefined)).toEqual({
      legacy: undefined,
      provincial: undefined,
    });
  });

  it('asks for events by registry province id and names provinces without a feed', () => {
    // Every feed region is a registered province id, so the phone's map region selects it as is.
    const registered = new Set(registeredServiceAreas().map(({ id }) => id));
    for (const region of ProvincialRoadEventRegionSchema.options) {
      expect(registered.has(region), region).toBe(true);
      expect(roadEventFeedForMapRegion(region).provincial).toBe(region);
    }
    for (const area of registeredServiceAreas()) {
      const feed = roadEventFeedForMapRegion(area.id);
      if (ProvincialRoadEventRegionSchema.safeParse(area.id).success) continue;
      expect(feed, area.id).toEqual({
        legacy: undefined,
        noFeedProvince: area.displayName,
        provincial: undefined,
      });
    }
    // Gatineau is in Quebec, not Ontario: its own province's (absent) feed, never Ontario 511.
    expect(
      roadEventFeedForMapRegion(mapRegionForCoordinate({ latitude: 45.4295, longitude: -75.7096 })),
    ).toEqual({
      legacy: undefined,
      noFeedProvince: 'Quebec',
      provincial: undefined,
    });
  });

  it('says a province has no official feed instead of loading or failing', () => {
    expect(
      roadEventStatusLabel({
        hasFeed: false,
        noFeedProvince: 'Quebec',
        now: Date.now(),
        refreshDelayed: false,
        snapshot: undefined,
      }),
    ).toBe('No official road events for Quebec');
    expect(
      roadEventStatusLabel({
        hasFeed: false,
        now: Date.now(),
        refreshDelayed: false,
        snapshot: undefined,
      }),
    ).toBeUndefined();
  });
});

describe('road-event loader against server generations', () => {
  const calgary = { events: [], stale: false } as unknown as RoadEventResponse;

  it('falls back to /v1/events in Calgary when the server does not know the province', async () => {
    const fetchOfficial = vi.fn(() => Promise.reject(new NavOssApiError('Bad request', 400)));
    const fetchCalgary = vi.fn(() => Promise.resolve(calgary));
    const published: unknown[] = [];
    const load = createRoadEventLoader({
      feed: roadEventFeedForMapRegion('calgary-ab'),
      fetchCalgary,
      fetchOfficial,
      publish: (snapshot) => published.push(snapshot),
    });
    await load(new AbortController().signal);
    await load(new AbortController().signal);
    expect(fetchOfficial).toHaveBeenCalledOnce();
    expect(fetchCalgary).toHaveBeenCalledTimes(2);
    expect(published).toEqual([calgary, calgary]);
  });

  it('lets an older server outside the legacy areas stop the loop quietly', async () => {
    const load = createRoadEventLoader({
      feed: roadEventFeedForMapRegion('alberta'),
      fetchCalgary: () => Promise.reject(new Error('not requested')),
      fetchOfficial: () => Promise.reject(new NavOssApiError('Bad request', 400)),
      publish: () => undefined,
    });
    await expect(load(new AbortController().signal)).rejects.toMatchObject({ status: 400 });
  });

  it('keeps an outage an outage: no fallback on 503', async () => {
    const fetchCalgary = vi.fn();
    const load = createRoadEventLoader({
      feed: roadEventFeedForMapRegion('calgary-ab'),
      fetchCalgary,
      fetchOfficial: () => Promise.reject(new NavOssApiError('Unavailable', 503)),
      publish: () => undefined,
    });
    await expect(load(new AbortController().signal)).rejects.toMatchObject({ status: 503 });
    expect(fetchCalgary).not.toHaveBeenCalled();
  });
});

describe('events in effect, newest first (recorded 2026-11-15)', () => {
  it('orders by the source time and keeps every served source', () => {
    const events = currentRoadEvents(alberta, CAPTURED);
    expect(events.length).toBe(alberta.events.length);
    const times = events.flatMap((event) =>
      'updatedAt' in event && event.updatedAt !== undefined ? [Date.parse(event.updatedAt)] : [],
    );
    expect([...times].sort((left, right) => right - left)).toEqual(times);
  });

  it('orders instants and calendar dates on one key, report before start, as the server does', () => {
    const edmonton = alberta.events.find(
      (event) => event.sourceId === 'edmonton-traffic-disruptions',
    );
    const construction = alberta.events.find(
      (event) => event.sourceId === 'calgary-construction-detours',
    );
    if (edmonton === undefined || construction === undefined) throw new Error('fixture events');
    const old = { ...construction, id: 'old', startsAt: '2025-06-01T15:00:00.000Z' };
    const thisWeek = {
      ...edmonton,
      id: 'this-week',
      reportedOn: '2026-11-13',
      startsOn: '2026-11-01',
    };
    const startedLater = {
      ...edmonton,
      id: 'started-later',
      reportedOn: '2026-11-02',
      startsOn: '2026-11-14',
    };
    const snapshot = { ...alberta, events: [old, startedLater, thisWeek] };
    expect(currentRoadEvents(snapshot, CAPTURED).map((event) => event.id)).toEqual([
      'this-week',
      'started-later',
      'old',
    ]);
  });

  it('never lets a future source timestamp pin an event to the top', () => {
    const [first, second] = ontario.events;
    if (first === undefined || second === undefined) throw new Error('fixture events');
    const toronto = ontario.sources.find(
      (source) => source.sourceId === 'toronto-road-restrictions',
    );
    const checkedAt = Date.parse(toronto?.checkedAt ?? '');
    const snapshot = {
      ...ontario,
      events: [
        { ...first, id: 'z-clock-skew', updatedAt: new Date(checkedAt + 86_400_000).toISOString() },
        { ...second, id: 'a-updated-at-fetch', updatedAt: new Date(checkedAt).toISOString() },
      ],
    };
    // A day-ahead time counts as the fetch time: it ties with an update made at fetch time.
    expect(currentRoadEvents(snapshot, checkedAt + 120_000).map((event) => event.id)).toEqual([
      'a-updated-at-fetch',
      'z-clock-skew',
    ]);
  });

  it('keeps the same view on a clock tick that changes nothing, and a new one when an event ends', () => {
    const ending = ontario.events[0];
    if (ending === undefined) throw new Error('fixture has events');
    const snapshot = {
      ...ontario,
      events: [
        ...ontario.events.slice(1),
        { ...ending, endsAt: new Date(CAPTURED + 90_000).toISOString() },
      ],
    };
    const first = nextRoadEventView(undefined, snapshot, CAPTURED);
    const quietTick = nextRoadEventView(first, snapshot, CAPTURED + 60_000);
    expect(quietTick).toBe(first);
    expect(quietTick.events).toBe(first.events);
    const expiringTick = nextRoadEventView(quietTick, snapshot, CAPTURED + 120_000);
    expect(expiringTick).not.toBe(first);
    expect(expiringTick.events).toHaveLength(first.events.length - 1);
    expect(expiringTick.available).toBe(true);
  });

  it('drops a source past its maximum age and events past their planned end', () => {
    const toronto = ontario.sources.find(
      (source) => source.sourceId === 'toronto-road-restrictions',
    );
    const checkedAt = Date.parse(toronto?.checkedAt ?? '');
    expect(currentRoadEvents(ontario, checkedAt + 3_599_000).length).toBeGreaterThan(0);
    expect(currentRoadEvents(ontario, checkedAt + 3_601_000)).toEqual([]);

    const ending = ontario.events[0];
    if (ending === undefined) throw new Error('fixture has events');
    const snapshot = {
      ...ontario,
      events: [{ ...ending, endsAt: new Date(CAPTURED + 60_000).toISOString() }],
    };
    expect(currentRoadEvents(snapshot, CAPTURED)).toHaveLength(1);
    expect(currentRoadEvents(snapshot, CAPTURED + 61_000)).toHaveLength(0);
  });

  it('drops a date-only event after its last local day', () => {
    const edmonton = alberta.events.find(
      (event) => event.sourceId === 'edmonton-traffic-disruptions',
    );
    if (edmonton === undefined) throw new Error('fixture has an Edmonton event');
    const snapshot = { ...alberta, events: [{ ...edmonton, endsOn: '2026-11-15' }] };
    // 23:30 in Edmonton on the 15th, then 00:30 on the 16th.
    expect(currentRoadEvents(snapshot, Date.parse('2026-11-16T06:30:00Z'))).toHaveLength(1);
    expect(currentRoadEvents(snapshot, Date.parse('2026-11-16T07:30:00Z'))).toHaveLength(0);
  });
});

describe('road-event wording', () => {
  it('states age from the source time, never the fetch time', () => {
    expect(relativeAge(CAPTURED - 30_000, CAPTURED)).toBe('just now');
    expect(relativeAge(CAPTURED - 12 * 60_000, CAPTURED)).toBe('12 min ago');
    expect(relativeAge(CAPTURED - 3 * 3_600_000, CAPTURED)).toBe('3 h ago');
    expect(relativeAge(CAPTURED - 49 * 3_600_000, CAPTURED)).toBe('2 days ago');
    const event = ontario.events[0];
    if (event === undefined) throw new Error('fixture has events');
    expect(
      roadEventAgeLabel(
        { ...event, updatedAt: new Date(CAPTURED - 5 * 60_000).toISOString() },
        CAPTURED,
      ),
    ).toBe('Updated 5 min ago');
    const edmonton = alberta.events.find((candidate) => candidate.startsOn !== undefined);
    expect(edmonton === undefined ? undefined : roadEventAgeLabel(edmonton, CAPTURED)).toMatch(
      /^Since /u,
    );
  });

  it('labels each source official or unverified and names a missing key plainly', () => {
    const lines = roadEventSourceLines(alberta, CAPTURED).map((line) => line.text);
    expect(lines[0]).toBe('511 Alberta · Not connected on this server');
    expect(lines.find((line) => line.startsWith('City of Calgary incidents'))).toMatch(
      /^City of Calgary incidents · Unverified/u,
    );
    expect(lines.find((line) => line.startsWith('City of Edmonton'))).toMatch(
      /^City of Edmonton · Official/u,
    );
  });

  it("carries each source's required attribution and licence link", () => {
    const lines = roadEventSourceLines(alberta, CAPTURED);
    const edmonton = lines.find((line) => line.sourceId === 'edmonton-traffic-disruptions');
    expect(edmonton).toMatchObject({
      attribution:
        'Contains information licensed under the Open Government Licence \u2013 City of Edmonton.',
      licenseUrl: 'https://data.edmonton.ca/stories/s/Open-Government-Licence-Edmonton/msh8-if28',
    });
    for (const line of lines) {
      const source = alberta.sources.find((candidate) => candidate.sourceId === line.sourceId);
      expect(line.attribution).toBe(source?.attribution);
      expect(line.licenseUrl).toBe(source?.licenseUrl);
    }
  });

  it('says when a feed is not refreshing or unavailable rather than showing it as current', () => {
    const stale: ProvincialRoadEventResponse = {
      ...ontario,
      degraded: true,
      sources: ontario.sources.map((source) =>
        source.status === 'current' ? { ...source, status: 'stale' } : source,
      ),
      stale: true,
    };
    expect(roadEventSourceLines(stale, CAPTURED)[1]?.text).toContain(
      'Not refreshing, showing the last copy',
    );
    expect(
      roadEventStatusLabel({
        hasFeed: true,
        now: CAPTURED,
        refreshDelayed: false,
        snapshot: stale,
      }),
    ).toContain('Some not refreshing');
    const expired = Date.parse(ontario.sources[1]?.checkedAt ?? '') + 2 * 3_600_000;
    expect(roadEventSourceLines(ontario, expired)[1]?.text).toBe(
      'City of Toronto · Unavailable right now',
    );
    expect(
      roadEventStatusLabel({
        hasFeed: true,
        now: expired,
        refreshDelayed: true,
        snapshot: ontario,
      }),
    ).toBe('Road events unavailable');
  });

  it('treats a held snapshot whose sources all expired as unavailable, not as no events', () => {
    const empty: ProvincialRoadEventResponse = { ...ontario, events: [] };
    const checkedAt = Date.parse(
      ontario.sources.find((source) => source.checkedAt !== undefined)?.checkedAt ?? '',
    );
    expect(roadEventAvailability(empty, checkedAt + 60_000)).toBe('available');
    expect(
      roadEventStatusLabel({
        hasFeed: true,
        now: checkedAt + 60_000,
        refreshDelayed: false,
        snapshot: empty,
      }),
    ).toBe('Road events · 0 · Official');
    const expired = checkedAt + 2 * 3_600_000;
    expect(roadEventAvailability(empty, expired)).toBe('unavailable');
    expect(
      roadEventStatusLabel({ hasFeed: true, now: expired, refreshDelayed: true, snapshot: empty }),
    ).toBe('Road events unavailable');
    expect(roadEventAvailability(undefined, expired)).toBe('unavailable');
  });

  it('keeps the pill honest before anything loads and for older feeds', () => {
    expect(
      roadEventStatusLabel({
        hasFeed: true,
        now: CAPTURED,
        refreshDelayed: true,
        snapshot: undefined,
      }),
    ).toBe('Road events unavailable');
    expect(
      roadEventStatusLabel({
        hasFeed: true,
        now: CAPTURED,
        refreshDelayed: false,
        snapshot: undefined,
      }),
    ).toBeUndefined();
    expect(
      roadEventStatusLabel({
        hasFeed: true,
        now: CAPTURED,
        refreshDelayed: false,
        snapshot: alberta,
      }),
    ).toBe(`Road events · ${String(alberta.events.length)} · Some unverified`);
  });

  it('describes provincial and Calgary v1 events with their trust posture', () => {
    const unverified = alberta.events.find((event) => event.confidence === 'unverified');
    if (unverified !== undefined) {
      expect(roadEventMessage(unverified, alberta, CAPTURED)).toMatch(
        /^Unverified City of Calgary incidents information/u,
      );
    }
    const official = ontario.events[0];
    if (official === undefined) throw new Error('fixture has events');
    expect(roadEventMessage(official, ontario, CAPTURED)).toMatch(
      /^Official City of Toronto road information/u,
    );
    expect(roadEventMessage(calgaryIncident, undefined, CAPTURED)).toContain(
      'Unverified current incident information',
    );
  });

  it('names the year of a start or planned end outside the current year', () => {
    const official = ontario.events[0];
    if (official === undefined) throw new Error('fixture has events');
    const now = Date.parse('2026-11-15T21:00:00.000Z');
    // 511 Alberta's Anthony Henday bridge work, as served on 2026-11-15.
    const longWork = {
      ...official,
      endsAt: '2028-07-16T01:00:00.000Z',
      startsAt: '2026-06-30T20:00:00.000Z',
    };
    const message = roadEventMessage(longWork, ontario, now);
    expect(message).toMatch(/^Starts: Jun 30(,| at) \d/mu);
    expect(message).toMatch(/^Planned end: Jul 1[56], 2028/mu);
    const lastYear = { ...longWork, endsAt: undefined, startsAt: '2025-12-31T18:00:00.000Z' };
    expect(roadEventMessage(lastYear, ontario, now)).toMatch(/^Starts: Dec 31, 2025/mu);
    const { endsAt: _instant, ...dated } = longWork;
    expect(
      roadEventMessage({ ...dated, endsOn: '2028-07-15', startsOn: '2026-06-30' }, ontario, now),
    ).toMatch(/^Planned end: Jul 15, 2028$/mu);
  });

  it('draws every type on one of the three symbol layers and credits drawn sources', () => {
    expect(roadEventLayer({ ...calgaryIncident })).toBe('incident');
    const collision = {
      ...ontario.events[0],
      type: 'collision',
    } as (typeof ontario.events)[number];
    expect(roadEventLayer(collision)).toBe('incident');
    expect(roadEventCredit(alberta, CAPTURED)).toBe('City of Calgary · City of Edmonton');
    expect(roadEventCredit(ontario, CAPTURED)).toBe('City of Toronto');
  });
});
