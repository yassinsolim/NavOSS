import { createHash, randomBytes } from 'node:crypto';

const DEFAULT_GLOBAL_LIMIT = 500;
const DEFAULT_SOURCE_LIMIT = 10;
const DEFAULT_WINDOW_MS = 60 * 60 * 1_000;

export interface ContributionRateLimiter {
  consume(sourceAddress: string): boolean;
}

interface ContributionRateLimiterOptions {
  clock?: () => number;
  globalLimit?: number;
  sourceLimit?: number;
  windowMs?: number;
}

export function createContributionRateLimiter(
  options: ContributionRateLimiterOptions = {},
): ContributionRateLimiter {
  const clock = options.clock ?? Date.now;
  const globalLimit = options.globalLimit ?? DEFAULT_GLOBAL_LIMIT;
  const sourceLimit = options.sourceLimit ?? DEFAULT_SOURCE_LIMIT;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const salt = randomBytes(32);
  const globalRequests: number[] = [];
  const sourceRequests = new Map<string, number[]>();

  const removeExpired = (timestamps: number[], cutoff: number): void => {
    while (timestamps[0] !== undefined && timestamps[0] <= cutoff) timestamps.shift();
  };

  return {
    consume(sourceAddress) {
      const now = clock();
      const cutoff = now - windowMs;
      removeExpired(globalRequests, cutoff);
      for (const [fingerprint, timestamps] of sourceRequests) {
        removeExpired(timestamps, cutoff);
        if (timestamps.length === 0) sourceRequests.delete(fingerprint);
      }

      const fingerprint = createHash('sha256')
        .update(salt)
        .update(sourceAddress)
        .digest('base64url');
      const requests = sourceRequests.get(fingerprint) ?? [];
      if (requests.length >= sourceLimit || globalRequests.length >= globalLimit) return false;
      requests.push(now);
      globalRequests.push(now);
      sourceRequests.set(fingerprint, requests);
      return true;
    },
  };
}
