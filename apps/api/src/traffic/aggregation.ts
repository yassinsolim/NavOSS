import type { TrafficCongestionLevel } from '@navoss/contracts';

import type { TrafficSettings } from './settings.js';

export const HISTOGRAM_BIN_KPH = 2;
export const HISTOGRAM_BINS = 90;

/** Index of the histogram bin holding a speed; everything above the last bin lands in it. */
export function speedBin(speedKph: number): number {
  return Math.min(HISTOGRAM_BINS - 1, Math.max(0, Math.floor(speedKph / HISTOGRAM_BIN_KPH)));
}

export interface FlowBucket {
  bucketStartMs: number;
  /** Count of samples per `HISTOGRAM_BIN_KPH`-wide speed bin. */
  histogram: readonly number[];
  sampleCount: number;
}

export interface SpeedEstimate {
  /** End of the newest contributing bucket, capped at now. Bucket-coarse by construction. */
  observedAtMs: number;
  sampleCount: number;
  speedKph: number;
}

/**
 * Robust current speed for one segment: the median of all samples in the window, where a sample's
 * weight halves every `halfLifeSeconds` of bucket age. A median ignores the odd slow or fast
 * outlier, and the decay lets a clearing jam fade before its buckets expire.
 */
export function estimateSpeed(
  buckets: readonly FlowBucket[],
  nowMs: number,
  settings: Pick<TrafficSettings, 'bucketSeconds' | 'halfLifeSeconds' | 'windowSeconds'>,
): SpeedEstimate | undefined {
  const bucketMs = settings.bucketSeconds * 1_000;
  const weights = new Array<number>(HISTOGRAM_BINS).fill(0);
  let totalWeight = 0;
  let sampleCount = 0;
  let newestStartMs = -Infinity;
  for (const bucket of buckets) {
    if (bucket.bucketStartMs < nowMs - settings.windowSeconds * 1_000) continue;
    const ageSeconds = Math.max(0, nowMs - (bucket.bucketStartMs + bucketMs / 2)) / 1_000;
    const weight = 0.5 ** (ageSeconds / settings.halfLifeSeconds);
    bucket.histogram.forEach((count, bin) => {
      if (bin < HISTOGRAM_BINS && count > 0) {
        weights[bin] = (weights[bin] ?? 0) + count * weight;
        totalWeight += count * weight;
      }
    });
    sampleCount += bucket.sampleCount;
    newestStartMs = Math.max(newestStartMs, bucket.bucketStartMs);
  }
  if (totalWeight <= 0 || sampleCount <= 0) return undefined;
  let cumulative = 0;
  const medianBin = weights.findIndex((weight) => {
    cumulative += weight;
    return cumulative >= totalWeight / 2;
  });
  return {
    observedAtMs: Math.min(nowMs, newestStartMs + bucketMs),
    sampleCount,
    speedKph: medianBin * HISTOGRAM_BIN_KPH + HISTOGRAM_BIN_KPH / 2,
  };
}

export function classifyCongestion(
  speedKph: number,
  freeFlowKph: number,
  thresholds: Pick<TrafficSettings, 'freeRatio' | 'heavyRatio' | 'slowRatio'>,
): TrafficCongestionLevel {
  const ratio = freeFlowKph > 0 ? speedKph / freeFlowKph : 1;
  if (ratio >= thresholds.freeRatio) return 'free';
  if (ratio >= thresholds.slowRatio) return 'slow';
  if (ratio >= thresholds.heavyRatio) return 'heavy';
  return 'stopped';
}
