import { afterEach, describe, expect, it, vi } from 'vitest';

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

  describe('retention of source fingerprints', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('forgets a source within the window plus a minute on a server that gets no more requests', () => {
      vi.useFakeTimers({ now: 0 });
      const limiter = createContributionRateLimiter({ windowMs: 600_000 });
      limiter.consume('192.0.2.1');
      limiter.consume('2001:db8::1');
      expect(limiter.trackedSources()).toBe(2);

      // Nothing calls consume() again: only the limiter's own timer can expire them.
      vi.advanceTimersByTime(599_000);
      expect(limiter.trackedSources()).toBe(2);
      vi.advanceTimersByTime(61_001);
      expect(limiter.trackedSources()).toBe(0);
      limiter.close();
    });

    it('forgets everything when it is closed', () => {
      const limiter = createContributionRateLimiter({ sourceLimit: 1 });
      limiter.consume('192.0.2.1');
      limiter.close();

      expect(limiter.trackedSources()).toBe(0);
      expect(limiter.consume('192.0.2.1')).toBe(true);
      limiter.close();
    });
  });
});
