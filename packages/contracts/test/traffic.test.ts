import { describe, expect, it } from 'vitest';

import {
  parseTrafficFlowBounds,
  RouteTrafficAnnotationSchema,
  snapTrafficFlowBounds,
  TrafficProbeBatchRequestSchema,
  TrafficStatusResponseSchema,
} from '../src/index.js';

function batch(offsets: number[], capturedAt = '2026-11-12T18:00:00Z'): unknown {
  return {
    capturedAt,
    points: offsets.map((offset, index) => [-114.06 + index * 0.0002, 51.05, offset]),
    schemaVersion: 1,
  };
}

const TEN_OFFSETS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18];

describe('TrafficProbeBatchRequestSchema', () => {
  it('accepts a minute-rounded batch whose clock starts at zero', () => {
    expect(TrafficProbeBatchRequestSchema.safeParse(batch(TEN_OFFSETS)).success).toBe(true);
  });

  it('rejects a start time finer than the minute', () => {
    expect(
      TrafficProbeBatchRequestSchema.safeParse(batch(TEN_OFFSETS, '2026-11-12T18:00:07Z')).success,
    ).toBe(false);
  });

  it('rejects identifiers or any other extra field', () => {
    expect(
      TrafficProbeBatchRequestSchema.safeParse({
        ...(batch(TEN_OFFSETS) as object),
        tripId: 'f3b1',
      }).success,
    ).toBe(false);
    expect(
      TrafficProbeBatchRequestSchema.safeParse({
        ...(batch(TEN_OFFSETS) as object),
        installationId: 'a',
      }).success,
    ).toBe(false);
  });

  it('rejects batches that are too short, do not start at zero, or have time gaps', () => {
    expect(TrafficProbeBatchRequestSchema.safeParse(batch(TEN_OFFSETS.slice(0, 9))).success).toBe(
      false,
    );
    expect(
      TrafficProbeBatchRequestSchema.safeParse(batch(TEN_OFFSETS.map((offset) => offset + 5)))
        .success,
    ).toBe(false);
    expect(
      TrafficProbeBatchRequestSchema.safeParse(batch([0, 2, 4, 6, 8, 10, 12, 14, 16, 40])).success,
    ).toBe(false);
    expect(
      TrafficProbeBatchRequestSchema.safeParse(batch([0, 2, 4, 6, 8, 10, 12, 14, 16, 16])).success,
    ).toBe(false);
  });
});

describe('traffic flow bounds', () => {
  it('expands a viewport outward to the shared grid', () => {
    const bbox = snapTrafficFlowBounds({
      east: -113.98,
      north: 51.09,
      south: 51.02,
      west: -114.13,
    });

    expect(bbox).toBe('-114.15,51.00,-113.95,51.10');
    expect(parseTrafficFlowBounds(bbox ?? '')).toEqual({
      east: -113.95,
      north: 51.1,
      south: 51,
      west: -114.15,
    });
  });

  it('keeps a viewport that already sits on the grid', () => {
    expect(snapTrafficFlowBounds({ east: -114, north: 51.1, south: 51, west: -114.1 })).toBe(
      '-114.10,51.00,-114.00,51.10',
    );
  });

  it('refuses exact viewports, oversized boxes, and malformed values', () => {
    expect(parseTrafficFlowBounds('-114.137,51.021,-113.982,51.094')).toBeUndefined();
    expect(parseTrafficFlowBounds('-116.00,50.00,-113.00,51.00')).toBeUndefined();
    expect(parseTrafficFlowBounds('-114.00,51.00,-114.10,51.10')).toBeUndefined();
    expect(parseTrafficFlowBounds('-114.10,51.00,-114.00')).toBeUndefined();
    expect(parseTrafficFlowBounds('a,b,c,d')).toBeUndefined();
    expect(snapTrafficFlowBounds({ east: -110, north: 53, south: 50, west: -116 })).toBeUndefined();
  });
});

describe('RouteTrafficAnnotationSchema', () => {
  const annotation = {
    congestion: ['free', 'unknown', 'heavy'],
    delaySeconds: 90,
    durationSeconds: 690,
    observedFraction: 0.6,
    stepDurationsSeconds: [400, 290],
    typicalDurationSeconds: 600,
  };

  it('accepts a delay that explains the adjusted duration', () => {
    expect(RouteTrafficAnnotationSchema.safeParse(annotation).success).toBe(true);
  });

  it('rejects an adjusted duration that is not typical plus delay', () => {
    expect(
      RouteTrafficAnnotationSchema.safeParse({ ...annotation, durationSeconds: 700 }).success,
    ).toBe(false);
  });
});

describe('TrafficStatusResponseSchema', () => {
  const status = {
    generatedAt: '2026-11-12T18:00:00Z',
    mode: 'off',
    probes: {
      accepting: false,
      batchTargetMeters: 600,
      batchTargetSeconds: 60,
      endpoint: '/v1/traffic/probes',
      maxBatchSeconds: 300,
      maxGapSeconds: 15,
      maxPoints: 240,
      minPoints: 10,
      sampleIntervalSeconds: 2,
      schemaVersion: 1,
      tripEndTrimMeters: 400,
    },
    publication: { bucketSeconds: 300, minimumContributors: 3, windowSeconds: 1800 },
    source: { attribution: 'Traffic from opted-in NavOSS drivers', id: 'navoss-community' },
  };

  it('cannot say probes are accepted while the pipeline is off', () => {
    expect(TrafficStatusResponseSchema.safeParse(status).success).toBe(true);
    expect(
      TrafficStatusResponseSchema.safeParse({
        ...status,
        probes: { ...status.probes, accepting: true },
      }).success,
    ).toBe(false);
  });

  it('cannot publish a single-contributor threshold', () => {
    expect(
      TrafficStatusResponseSchema.safeParse({
        ...status,
        publication: { ...status.publication, minimumContributors: 1 },
      }).success,
    ).toBe(false);
  });
});
