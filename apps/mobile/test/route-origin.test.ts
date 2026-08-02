import { describe, expect, it } from 'vitest';

import {
  newestValidRouteOriginSample,
  routeOriginSampleFromLocation,
  routeRequestOriginFromSample,
} from '../src/features/navigation/route-origin.js';

const nowMs = Date.UTC(2026, 7, 1, 12, 0, 0);

function location(
  overrides: Partial<{
    accuracy: number | null;
    heading: number | null;
    speed: number | null;
    timestamp: number;
  }> = {},
) {
  return {
    coords: {
      accuracy: 8,
      heading: 25,
      latitude: 51.0447,
      longitude: -114.0719,
      speed: 8,
      ...overrides,
    },
    timestamp: overrides.timestamp ?? nowMs,
  };
}

describe('route origin correlation', () => {
  it('uses a fresh accurate moving sample with heading', () => {
    const sample = routeOriginSampleFromLocation(location());

    expect(routeRequestOriginFromSample(sample, nowMs)).toEqual({
      origin: { latitude: 51.0447, longitude: -114.0719 },
      originHeadingDegrees: 25,
      originHorizontalAccuracyMeters: 8,
    });
  });

  it('omits heading when the device is stationary', () => {
    const sample = routeOriginSampleFromLocation(location({ speed: 0 }));

    expect(routeRequestOriginFromSample(sample, nowMs)).toEqual({
      origin: { latitude: 51.0447, longitude: -114.0719 },
      originHorizontalAccuracyMeters: 8,
    });
  });

  it('rejects stale, inaccurate, and invalid samples', () => {
    expect(
      routeRequestOriginFromSample(
        routeOriginSampleFromLocation(location({ timestamp: nowMs - 15_001 })),
        nowMs,
      ),
    ).toBeUndefined();
    expect(
      routeRequestOriginFromSample(
        routeOriginSampleFromLocation(location({ accuracy: 100.1 })),
        nowMs,
      ),
    ).toBeUndefined();
    expect(
      routeRequestOriginFromSample(
        routeOriginSampleFromLocation(location({ accuracy: null })),
        nowMs,
      ),
    ).toBeUndefined();
  });

  it('keeps a valid fetched sample when a newer watch sample is inaccurate', () => {
    const fetched = routeOriginSampleFromLocation(location({ timestamp: nowMs }));
    const newerInaccurate = routeOriginSampleFromLocation(
      location({ accuracy: 150, timestamp: nowMs + 1_000 }),
    );

    expect(newestValidRouteOriginSample(fetched, newerInaccurate, nowMs + 1_000)).toBe(fetched);
  });

  it('prefers a newer sample when both are valid', () => {
    const older = routeOriginSampleFromLocation(location({ timestamp: nowMs }));
    const newer = routeOriginSampleFromLocation(location({ timestamp: nowMs + 1_000 }));

    expect(newestValidRouteOriginSample(older, newer, nowMs + 1_000)).toBe(newer);
  });
});
