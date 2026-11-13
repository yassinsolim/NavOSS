import {
  COMMUNITY_TRAFFIC_ATTRIBUTION,
  type TrafficFlowResponse,
  TrafficFlowResponseSchema,
} from '@navoss/contracts';
import { describe, expect, it } from 'vitest';

import {
  trafficFlowFeatures,
  trafficFlowQuery,
  trafficFlowRefreshDelayMs,
  trafficFlowStatus,
} from '../src/features/community/traffic-flow.js';

const NOW = Date.parse('2026-11-12T18:02:00.000Z');

// Validated against the server contract, so the test cannot drift from what `/v2/traffic/flow`
// actually returns.
const response: TrafficFlowResponse = TrafficFlowResponseSchema.parse({
  coverage: { minimumContributors: 3, truncated: false },
  features: [
    {
      geometry: {
        coordinates: [
          [-114.07, 51.04],
          [-114.06, 51.05],
        ],
        type: 'LineString',
      },
      id: 'w123f-0123456789ab',
      properties: {
        congestion: 'heavy',
        freeFlowKph: 60,
        observedAt: '2026-11-12T18:00:00.000Z',
        speedKph: 15,
      },
      type: 'Feature',
    },
  ],
  generatedAt: '2026-11-12T18:00:00.000Z',
  source: { attribution: COMMUNITY_TRAFFIC_ATTRIBUTION, id: 'navoss-community' },
  type: 'FeatureCollection',
  validUntil: '2026-11-12T18:05:00.000Z',
});

describe('traffic flow request', () => {
  it('asks for a grid-aligned box the server accepts, and nothing for a too-wide view', () => {
    expect(trafficFlowQuery({ east: -114.0, north: 51.1, south: 51.0, west: -114.15 })).toBe(
      '-114.15,51.00,-114.00,51.10',
    );
    expect(trafficFlowQuery({ east: -110, north: 52, south: 50, west: -115 })).toBeUndefined();
    expect(trafficFlowQuery(undefined)).toBeUndefined();
  });

  it('never polls before the snapshot changes', () => {
    // 3 minutes to the epoch boundary plus a small margin.
    expect(trafficFlowRefreshDelayMs(response, NOW)).toBe(3 * 60_000 + 5_000);
    // Already past it: still waits a floor rather than hammering the server.
    expect(trafficFlowRefreshDelayMs(response, NOW + 10 * 60_000)).toBe(30_000);
  });
});

describe('traffic flow layer', () => {
  it('keeps only the congestion level the layer colours by', () => {
    const features = trafficFlowFeatures(response);
    expect(features.features).toHaveLength(1);
    expect(features.features[0]?.properties).toEqual({ congestion: 'heavy' });
    expect(trafficFlowFeatures(undefined).features).toEqual([]);
  });

  it('always credits the source and says the data is limited, with the reason', () => {
    const status = trafficFlowStatus({ failed: false, response, tooWide: false });
    expect(status?.text).toBe(`${COMMUNITY_TRAFFIC_ATTRIBUTION} · Limited data`);
    expect(status?.accessibilityLabel).toContain('at least 3 drivers');

    const empty = trafficFlowStatus({
      failed: false,
      response: {
        ...response,
        coverage: { minimumContributors: 3, truncated: true },
        features: [],
      },
      tooWide: false,
    });
    expect(empty?.text).toBe(
      `${COMMUNITY_TRAFFIC_ATTRIBUTION} · Limited data · None here yet · Zoom in for more`,
    );
  });

  it('tells the driver to zoom in rather than showing an empty map as "no traffic"', () => {
    expect(trafficFlowStatus({ failed: false, response: undefined, tooWide: true })?.text).toBe(
      'Traffic · Zoom in to see traffic',
    );
    expect(trafficFlowStatus({ failed: true, response: undefined, tooWide: false })?.text).toBe(
      'Traffic unavailable right now',
    );
    expect(
      trafficFlowStatus({ failed: false, response: undefined, tooWide: false }),
    ).toBeUndefined();
  });
});
