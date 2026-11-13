import { RoadEventResponseSchema } from '@navoss/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  CalgaryRoadEventProviderError,
  createCalgaryRoadEventProvider,
} from '../src/calgary-road-event-provider.js';
import recorded from './fixtures/calgary-road-events-2026-11-13.json' with { type: 'json' };
import legacy from './fixtures/calgary-road-events-legacy.json' with { type: 'json' };

const recordedIncident = recorded.incident.rows[0];
if (recordedIncident === undefined) throw new Error('Recorded incident fixture is missing.');

const constructionRows = [
  {
    construction_info: 'Symons Valley Parkway and&#160;Kincora Gate NW',
    description: 'Eastbound right lane closure. Speed reduced to 50km/hr.',
    end_dt: '2026-09-30T15:00:00.000',
    point: { coordinates: [-114.14678846486773, 51.16761895861511], type: 'Point' },
    start_dt: '2026-06-15T09:00:00.000',
  },
];
const incidentRows = [{ incident_info: 'NO TRAFFIC INCIDENTS' }];

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

function upstream(input: Parameters<typeof fetch>[0]): Response {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes('/api/views/w8zq-79bq')) return jsonResponse({ rowsUpdatedAt: 1_785_409_239 });
  if (url.includes('/api/views/4jah-h97u')) return jsonResponse({ rowsUpdatedAt: 1_785_443_461 });
  if (url.includes('/resource/w8zq-79bq')) return jsonResponse(constructionRows);
  if (url.includes('/resource/4jah-h97u')) return jsonResponse(incidentRows);
  return jsonResponse({}, 404);
}

function fixtureFetch(constructions: unknown, incidents: unknown, failed?: string): typeof fetch {
  return (input) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (failed !== undefined && url.includes(failed)) return Promise.resolve(jsonResponse({}, 503));
    if (url.includes('/resource/w8zq-79bq')) return Promise.resolve(jsonResponse(constructions));
    if (url.includes('/resource/4jah-h97u')) return Promise.resolve(jsonResponse(incidents));
    return Promise.resolve(upstream(input));
  };
}

describe('Calgary road event provider', () => {
  it('accepts recorded current and legacy shapes without selecting schema-specific columns', async () => {
    const requested: string[] = [];
    const fetchFixture = fixtureFetch(recorded.construction.rows, recorded.incident.rows);
    const response = await createCalgaryRoadEventProvider({
      clock: () => Date.parse('2026-11-13T12:00:00Z'),
      fetchImplementation: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        requested.push(url);
        return fetchFixture(input, init);
      },
    }).getRoadEvents();
    expect(RoadEventResponseSchema.parse(response)).toEqual(response);
    expect(response).toMatchObject({ degraded: false, stale: false });
    expect(response.events).toHaveLength(2);
    expect(response.events.find((event) => event.type === 'incident')).toMatchObject({
      startsAtLocal: '2026-11-12T21:42:51.000',
      coordinate: { longitude: -114.01728120020499, latitude: 51.175837660153775 },
      confidence: 'unverified',
    });
    expect(response.events.find((event) => event.type === 'construction')).toMatchObject({
      startsAtLocal: '2025-06-01T09:00:00.000',
      endsAtLocal: '2026-12-31T15:00:00.000',
    });
    expect(
      requested
        .filter((url) => url.includes('/resource/'))
        .every((url) => !new URL(url).searchParams.has('$select')),
    ).toBe(true);

    const old = await createCalgaryRoadEventProvider({
      clock: () => Date.parse('2026-07-30T20:30:00Z'),
      fetchImplementation: fixtureFetch(legacy.construction, legacy.incident),
    }).getRoadEvents();
    expect(old.events.find((event) => event.type === 'incident')).toMatchObject({
      startsAtLocal: '2026-07-30T14:00:00.000',
      coordinate: { longitude: -114.1, latitude: 51.08 },
    });
    expect(old).toMatchObject({ degraded: false, stale: false });
  });

  it('keeps incident identity stable when the source switches schema', async () => {
    const old = {
      description: recordedIncident.description,
      incident_info: recordedIncident.incident_info,
      start_dt: '2026-11-12T21:42:51.000',
      modified_dt: '2026-11-12T21:44:40.000',
      point: {
        type: 'Point',
        coordinates: [-114.01728120020499, 51.175837660153775],
      },
    };
    const options = { clock: () => Date.parse('2026-11-13T12:00:00Z') };
    const before = await createCalgaryRoadEventProvider({
      ...options,
      fetchImplementation: fixtureFetch([], [old]),
    }).getRoadEvents();
    const after = await createCalgaryRoadEventProvider({
      ...options,
      fetchImplementation: fixtureFetch([], [recordedIncident]),
    }).getRoadEvents();
    expect(after.events[0]?.id).toBe(before.events[0]?.id);
  });

  it.each([
    ['2026-03-08 08:59:59+00:00', '2026-03-08T01:59:59.000'],
    ['2026-03-08 09:00:00+00:00', '2026-03-08T03:00:00.000'],
    ['2026-11-01 07:59:59+00:00', '2026-11-01T01:59:59.000'],
    ['2026-11-01 08:00:00+00:00', '2026-11-01T01:00:00.000'],
    ['2026-11-13 07:00:00+00:00', '2026-11-13T00:00:00.000'],
  ])('converts UTC %s to Edmonton wall time %s across DST', async (utc, local) => {
    const response = await createCalgaryRoadEventProvider({
      clock: () => Date.parse('2026-07-30T20:30:00Z'),
      fetchImplementation: fixtureFetch([], [{ ...recordedIncident, start_dt_utc: utc }]),
    }).getRoadEvents();
    expect(response.events[0]?.startsAtLocal).toBe(local);
    expect(response.events[0]?.timeZone).toBe('America/Edmonton');
  });

  it('accepts separate coordinate columns and UTC construction dates', async () => {
    const incident = { ...recordedIncident, point: undefined };
    const construction = {
      ...recorded.construction.rows[0],
      start_dt: undefined,
      end_dt: undefined,
      start_dt_utc: '2026-03-08 08:59:59+00:00',
      end_dt_utc: '2026-03-08 09:00:00+00:00',
    };
    const response = await createCalgaryRoadEventProvider({
      clock: () => Date.parse('2026-03-08T08:00:00Z'),
      fetchImplementation: fixtureFetch([construction], [incident]),
    }).getRoadEvents();
    expect(response.events.find((event) => event.type === 'incident')?.coordinate).toEqual({
      longitude: -114.01728120020499,
      latitude: 51.175837660153775,
    });
    expect(response.events.find((event) => event.type === 'construction')).toMatchObject({
      startsAtLocal: '2026-03-08T01:59:59.000',
      endsAtLocal: '2026-03-08T03:00:00.000',
    });
  });

  it.each(['/resource/4jah-h97u', '/resource/w8zq-79bq'])(
    'serves the other dataset when %s fails on first load',
    async (failed) => {
      const onFailure = vi.fn();
      const response = await createCalgaryRoadEventProvider({
        clock: () => Date.parse('2026-11-13T12:00:00Z'),
        fetchImplementation: fixtureFetch(
          recorded.construction.rows,
          recorded.incident.rows,
          failed,
        ),
        onFailure,
      }).getRoadEvents();
      expect(response).toMatchObject({ degraded: true, stale: true });
      expect(response.events).toHaveLength(1);
      expect(response.events[0]?.type).toBe(failed.includes('4jah') ? 'construction' : 'incident');
      expect(response.sources).toHaveLength(2);
      expect(onFailure).toHaveBeenCalledWith(
        expect.objectContaining({ errorName: 'CalgaryRoadEventProviderError' }),
      );
      expect(RoadEventResponseSchema.safeParse(response).success).toBe(true);
    },
  );

  it('drops and counts isolated malformed rows but rejects a feed above the threshold', async () => {
    const onFailure = vi.fn();
    const good = recordedIncident;
    const bad = { ...good, point: 'POINT (-114 999)' };
    const provider = createCalgaryRoadEventProvider({
      cacheTtlMs: 0,
      clock: () => Date.parse('2026-11-13T12:00:00Z'),
      fetchImplementation: fixtureFetch(recorded.construction.rows, [good, bad]),
      onFailure,
    });
    const response = await provider.getRoadEvents();
    expect(response.events).toHaveLength(2);
    expect(response).toMatchObject({ stale: true, degraded: true });
    expect(onFailure).toHaveBeenCalledWith({
      datasetId: '4jah-h97u',
      droppedRows: 1,
      errorName: 'RoadEventRowParseError',
    });

    const failed = await createCalgaryRoadEventProvider({
      clock: () => Date.parse('2026-11-13T12:00:00Z'),
      fetchImplementation: fixtureFetch(recorded.construction.rows, [bad, bad]),
      onFailure,
    }).getRoadEvents();
    expect(failed.events.map((event) => event.type)).toEqual(['construction']);
    expect(failed).toMatchObject({ stale: true, degraded: true });
    expect(onFailure).toHaveBeenCalledWith({
      datasetId: '4jah-h97u',
      droppedRows: 2,
      errorName: 'RoadEventRowParseError',
    });
  });

  it('rejects malformed timestamps and out-of-coverage coordinates at row level', async () => {
    const good = recordedIncident;
    const rows = [
      good,
      { ...good, start_dt_utc: '2026-02-30 12:00:00+00:00' },
      { ...good, point: 'POINT (-120 51)' },
    ];
    const onFailure = vi.fn();
    const response = await createCalgaryRoadEventProvider({
      clock: () => Date.parse('2026-11-13T12:00:00Z'),
      fetchImplementation: fixtureFetch(recorded.construction.rows, rows),
      onFailure,
    }).getRoadEvents();
    expect(response.events.map((event) => event.type)).toEqual(['construction']);
    expect(onFailure).toHaveBeenCalledWith({
      datasetId: '4jah-h97u',
      droppedRows: 2,
      errorName: 'RoadEventRowParseError',
    });
  });

  it('uses a bounded previous dataset alongside fresh results without refreshing its age', async () => {
    let now = Date.parse('2026-11-13T12:00:00Z');
    let incidentFailed = false;
    const provider = createCalgaryRoadEventProvider({
      cacheTtlMs: 1,
      maximumStaleMs: 1_000,
      clock: () => now,
      fetchImplementation: (input, init) =>
        fixtureFetch(
          recorded.construction.rows,
          recorded.incident.rows,
          incidentFailed ? '/resource/4jah-h97u' : undefined,
        )(input, init),
    });
    expect((await provider.getRoadEvents()).events).toHaveLength(2);
    incidentFailed = true;
    now += 2;
    const stale = await provider.getRoadEvents();
    expect(stale.stale).toBe(true);
    expect(stale.events.map((event) => event.type).sort()).toEqual(['construction', 'incident']);
    now += 1_000;
    expect((await provider.getRoadEvents()).events.map((event) => event.type)).toEqual([
      'construction',
    ]);
  });

  it('caches partial results but never beyond the age of a retained failed dataset', async () => {
    let now = Date.parse('2026-11-13T12:00:00Z');
    let incidentFailed = false;
    let calls = 0;
    const provider = createCalgaryRoadEventProvider({
      cacheTtlMs: 100,
      maximumStaleMs: 150,
      clock: () => now,
      fetchImplementation: (input, init) => {
        calls += 1;
        return fixtureFetch(
          recorded.construction.rows,
          recorded.incident.rows,
          incidentFailed ? '/resource/4jah-h97u' : undefined,
        )(input, init);
      },
    });
    await provider.getRoadEvents();
    incidentFailed = true;
    now += 100;
    expect((await provider.getRoadEvents()).events).toHaveLength(2);
    now += 20;
    expect((await provider.getRoadEvents()).events).toHaveLength(2);
    expect(calls).toBe(8);
    now += 31;
    expect((await provider.getRoadEvents()).events.map((event) => event.type)).toEqual([
      'construction',
    ]);
    expect(calls).toBe(12);
  });

  it('fails closed when source metadata is unavailable and was never observed', async () => {
    const provider = createCalgaryRoadEventProvider({
      fetchImplementation: fixtureFetch(
        recorded.construction.rows,
        recorded.incident.rows,
        '/api/views/4jah-h97u',
      ),
    });
    await expect(provider.getRoadEvents()).rejects.toBeInstanceOf(CalgaryRoadEventProviderError);
  });

  it('normalizes official construction and keeps empty incidents explicit', async () => {
    const provider = createCalgaryRoadEventProvider({
      clock: () => Date.parse('2026-07-30T20:30:00Z'),
      fetchImplementation: (input) => Promise.resolve(upstream(input)),
    });

    const response = await provider.getRoadEvents();

    expect(response).toMatchObject({ degraded: false, stale: false });
    expect(response.events).toHaveLength(1);
    expect(response.events[0]).toMatchObject({
      confidence: 'official',
      title: 'Symons Valley Parkway and Kincora Gate NW',
      type: 'construction',
    });
    expect(response.sources.map((source) => source.confidence)).toEqual(['official', 'unverified']);
  });

  it('normalizes current incidents as unverified', async () => {
    const provider = createCalgaryRoadEventProvider({
      clock: () => Date.parse('2026-07-30T20:30:00Z'),
      fetchImplementation: (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('/resource/4jah-h97u')) {
          return Promise.resolve(
            jsonResponse([
              {
                description: 'Expect delays.',
                incident_info: 'Stalled vehicle on Crowchild Trail NW',
                modified_dt: '2026-07-30T14:20:00.000',
                point: { coordinates: [-114.1, 51.08], type: 'Point' },
                start_dt: '2026-07-30T14:00:00.000',
              },
            ]),
          );
        }
        return Promise.resolve(upstream(input));
      },
    });

    const response = await provider.getRoadEvents();

    expect(response.events.find((event) => event.type === 'incident')).toMatchObject({
      confidence: 'unverified',
      sourceId: 'calgary-current-incidents',
    });
  });

  it('returns a bounded stale snapshot after a transient upstream failure', async () => {
    let now = Date.parse('2026-07-30T20:30:00Z');
    let offline = false;
    const provider = createCalgaryRoadEventProvider({
      cacheTtlMs: 1_000,
      clock: () => now,
      fetchImplementation: (input) =>
        Promise.resolve(offline ? jsonResponse({}, 503) : upstream(input)),
      maximumStaleMs: 10_000,
    });

    await provider.getRoadEvents();
    now += 1_001;
    offline = true;
    expect(await provider.getRoadEvents()).toMatchObject({ degraded: true, stale: true });
    now += 10_001;
    await expect(provider.getRoadEvents()).rejects.toBeInstanceOf(CalgaryRoadEventProviderError);
  });

  it('refreshes independently of client requests and stops cleanly', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-30T20:30:00Z'));
    let requestCount = 0;
    const provider = createCalgaryRoadEventProvider({
      cacheTtlMs: 0,
      fetchImplementation: (input) => {
        requestCount += 1;
        return Promise.resolve(upstream(input));
      },
      refreshIntervalMs: 1_000,
    });

    try {
      provider.start?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(requestCount).toBe(4);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(requestCount).toBe(8);
      provider.stop?.();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(requestCount).toBe(8);
    } finally {
      provider.stop?.();
      vi.useRealTimers();
    }
  });
});
