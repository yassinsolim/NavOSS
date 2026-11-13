import { describe, expect, it } from 'vitest';

import { comparison, routeSummary } from '../../../infra/offline/verify/routing.mjs';

describe('measured online/offline route comparison', () => {
  it('reports signed distance/time deltas rather than claiming engine parity', () => {
    expect(comparison({ length: 10, time: 600 }, { length: 10.2, time: 660 })).toEqual({
      distanceMeters: 200,
      timeSeconds: 60,
      distancePercent: 2,
      timePercent: 10,
    });
    expect(comparison({ length: 10, time: 600 }, { length: 9.9, time: 540 })).toMatchObject({
      distanceMeters: -100,
      timeSeconds: -60,
    });
  });

  it('does not turn invalid or missing measurements into zero differences', () => {
    expect(() => comparison({ length: 0, time: 600 }, { length: 1, time: 60 })).toThrow('positive');
    expect(() => comparison({ length: 1, time: 600 }, { length: 1, time: 0 })).toThrow('positive');
  });
  it('does not put route coordinates or unknown upstream fields in verification logs', () => {
    expect(
      routeSummary({ length: 10, time: 600, min_lat: 51, min_lon: -114, route: 'private' }),
    ).toEqual({ length: 10, time: 600 });
    expect(() => routeSummary({ length: 10, time: NaN })).toThrow('positive');
  });
});
