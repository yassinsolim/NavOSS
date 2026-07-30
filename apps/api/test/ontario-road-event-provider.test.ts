import { describe, expect, it } from 'vitest';

import {
  createOntarioRoadEventProvider,
  OntarioRoadEventProviderError,
} from '../src/ontario-road-event-provider.js';

const activeRoadwork = {
  Description: 'Construction on HWY 401 Eastbound. 1 Alternating Lane.',
  DirectionOfTravel: 'Eastbound',
  EventType: 'roadwork',
  ID: 1963,
  IsFullClosure: false,
  LastUpdated: 1_785_443_400,
  Latitude: 43.63599,
  Longitude: -79.668724,
  PlannedEndDate: 1_788_000_000,
  Reported: 1_785_400_000,
  RoadwayName: 'HWY 401',
  SourceId: '222249',
  StartDate: 1_785_400_000,
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

describe('Ontario road event provider', () => {
  it('normalizes official construction, closures, and incidents', async () => {
    const provider = createOntarioRoadEventProvider({
      clock: () => Date.parse('2026-07-30T20:30:00Z'),
      fetchImplementation: () =>
        Promise.resolve(
          jsonResponse([
            activeRoadwork,
            {
              ...activeRoadwork,
              Description: 'All lanes closed after a collision.',
              EventType: 'accidentsAndIncidents',
              ID: 1964,
              IsFullClosure: true,
              PlannedEndDate: null,
              SourceId: '222250',
            },
            {
              ...activeRoadwork,
              Description: 'Highway closure.',
              EventType: 'closures',
              ID: 1965,
              SourceId: '222251',
            },
          ]),
        ),
    });

    const response = await provider.getRoadEvents();

    expect(response).toMatchObject({ degraded: false, regionId: 'ontario', stale: false });
    expect(response.events.map((event) => event.type)).toEqual([
      'construction',
      'incident',
      'closure',
    ]);
    expect(response.source).toMatchObject({
      confidence: 'official',
      refreshIntervalSeconds: 300,
      sourceId: 'ontario-511-events',
    });
  });

  it('excludes expired and out-of-province events', async () => {
    const provider = createOntarioRoadEventProvider({
      clock: () => Date.parse('2026-07-30T20:30:00Z'),
      fetchImplementation: () =>
        Promise.resolve(
          jsonResponse([
            activeRoadwork,
            { ...activeRoadwork, ID: 1964, PlannedEndDate: 1_700_000_000 },
            { ...activeRoadwork, ID: 1965, Latitude: 51.04, Longitude: -114.07 },
          ]),
        ),
    });

    expect((await provider.getRoadEvents()).events.map((event) => event.id)).toEqual([
      'ontario-511:1963:222249',
    ]);
  });

  it('fails closed when the upstream event taxonomy changes', async () => {
    const provider = createOntarioRoadEventProvider({
      fetchImplementation: () =>
        Promise.resolve(jsonResponse([{ ...activeRoadwork, EventType: 'policeActivity' }])),
    });

    await expect(provider.getRoadEvents()).rejects.toBeInstanceOf(OntarioRoadEventProviderError);
  });

  it('returns a bounded stale snapshot after a transient upstream failure', async () => {
    let now = Date.parse('2026-07-30T20:30:00Z');
    let offline = false;
    const provider = createOntarioRoadEventProvider({
      cacheTtlMs: 1_000,
      clock: () => now,
      fetchImplementation: () =>
        Promise.resolve(offline ? jsonResponse({}, 503) : jsonResponse([activeRoadwork])),
      maximumStaleMs: 10_000,
    });

    await provider.getRoadEvents();
    now += 1_001;
    offline = true;
    expect(await provider.getRoadEvents()).toMatchObject({ degraded: true, stale: true });
    now += 10_001;
    await expect(provider.getRoadEvents()).rejects.toBeInstanceOf(OntarioRoadEventProviderError);
  });
});
