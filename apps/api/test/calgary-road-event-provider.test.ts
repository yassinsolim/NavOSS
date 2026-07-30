import { describe, expect, it } from 'vitest';

import {
  CalgaryRoadEventProviderError,
  createCalgaryRoadEventProvider,
} from '../src/calgary-road-event-provider.js';

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

describe('Calgary road event provider', () => {
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
});
