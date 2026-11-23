import { describe, expect, it, vi } from 'vitest';

import {
  currentLocationFix,
  LOCATION_FIX_TIMEOUT_MS,
  newestValidRouteOriginSample,
  routeOriginFailureMessage,
  routeOriginSampleFromLocation,
  routeRequestOriginFromSample,
  withinLocationTimeout,
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

describe('route origin without a location', () => {
  it('names a missing fix and location turned off without blaming the connection', () => {
    for (const failure of ['no-fix', 'no-gps', 'services-off'] as const) {
      const message = routeOriginFailureMessage(failure);
      expect(message).not.toMatch(/connection/i);
      expect(message).toMatch(/choose where the route starts/i);
    }
    expect(routeOriginFailureMessage('services-off')).toMatch(/turned off/);
    // A device with no GPS (the Retroid handhelds) says so rather than suggesting a retry.
    expect(routeOriginFailureMessage('no-gps')).toMatch(/has no GPS/);
    expect(routeOriginFailureMessage('no-gps')).not.toMatch(/try again/i);
    expect(routeOriginFailureMessage('stale-fix')).toBe(
      'A fresh, accurate location fix is needed. Wait for GPS to update, then try again.',
    );
  });

  it('gives up on a lookup that never answers instead of waiting forever', async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<number>(() => undefined);
      const result = withinLocationTimeout(never, 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(result).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes a fix through and treats a failed lookup as no fix', async () => {
    await expect(withinLocationTimeout(Promise.resolve(7), 1_000)).resolves.toBe(7);
    await expect(
      withinLocationTimeout(Promise.reject(new Error('no provider')), 1_000),
    ).resolves.toBeUndefined();
  });
});

describe('one-shot location fix by platform', () => {
  const never = () => new Promise<number>(() => undefined);

  it('on iOS waits for a slow fix with no services probe and no timeout', async () => {
    vi.useFakeTimers();
    try {
      const servicesEnabled = vi.fn(() => Promise.resolve(false));
      let deliver: (fix: number) => void = () => undefined;
      const slowFix = new Promise<number>((resolve) => {
        deliver = resolve;
      });
      const result = currentLocationFix({ currentPosition: () => slowFix, servicesEnabled }, false);
      let settled = false;
      void result.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(LOCATION_FIX_TIMEOUT_MS * 10);
      expect(settled).toBe(false);
      deliver(42);
      await expect(result).resolves.toBe(42);
      expect(servicesEnabled).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('on iOS lets a failed lookup throw as before', async () => {
    await expect(
      currentLocationFix(
        {
          currentPosition: () => Promise.reject(new Error('denied')),
          servicesEnabled: () => Promise.resolve(true),
        },
        false,
      ),
    ).rejects.toThrow('denied');
  });

  it('on Android stops before the lookup when location services are off', async () => {
    const currentPosition = vi.fn(never);
    await expect(
      currentLocationFix({ currentPosition, servicesEnabled: () => Promise.resolve(false) }, true),
    ).resolves.toBe('services-off');
    expect(currentPosition).not.toHaveBeenCalled();
  });

  it('on Android gives up after the timeout and passes a fix through', async () => {
    vi.useFakeTimers();
    try {
      const result = currentLocationFix(
        { currentPosition: never, servicesEnabled: () => Promise.resolve(true) },
        true,
      );
      await vi.advanceTimersByTimeAsync(LOCATION_FIX_TIMEOUT_MS);
      await expect(result).resolves.toBe('no-fix');
    } finally {
      vi.useRealTimers();
    }
    await expect(
      currentLocationFix(
        { currentPosition: () => Promise.resolve(7), servicesEnabled: () => Promise.resolve(true) },
        true,
      ),
    ).resolves.toBe(7);
  });
});
