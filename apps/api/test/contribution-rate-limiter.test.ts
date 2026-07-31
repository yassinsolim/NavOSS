import { describe, expect, it } from 'vitest';

import { createContributionRateLimiter } from '../src/contribution-rate-limiter.js';

describe('contribution rate limiter', () => {
  it('bounds each transient source without creating a persistent identifier', () => {
    let now = 1_000;
    const limiter = createContributionRateLimiter({
      clock: () => now,
      globalLimit: 3,
      sourceLimit: 2,
      windowMs: 100,
    });

    expect(limiter.consume('192.0.2.1')).toBe(true);
    expect(limiter.consume('192.0.2.1')).toBe(true);
    expect(limiter.consume('192.0.2.1')).toBe(false);
    expect(limiter.consume('192.0.2.2')).toBe(true);
    expect(limiter.consume('192.0.2.3')).toBe(false);
    now += 101;
    expect(limiter.consume('192.0.2.1')).toBe(true);
  });
});
