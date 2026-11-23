import { describe, expect, it } from 'vitest';

import {
  createTripEndNoticeMemory,
  tripEndToReport,
} from '../src/features/map/controller/trip-end-notice-memory.js';

const reason = 'restored-trip-off-route' as const;

describe('trip end notice across map remounts', () => {
  it('reports an end the driver never dismissed again after a remount', () => {
    const memory = createTripEndNoticeMemory();
    expect(tripEndToReport(reason, { reportedThisMount: false }, memory)).toBe(reason);
    // Same mount, next snapshot: not again.
    expect(tripEndToReport(reason, { reportedThisMount: true }, memory)).toBeUndefined();
    // Remounted without a dismissal: shown again.
    expect(tripEndToReport(reason, { reportedThisMount: false }, memory)).toBe(reason);
  });

  it('never reports an end again once it was dismissed or (iOS) timed out', () => {
    const memory = createTripEndNoticeMemory();
    expect(tripEndToReport(reason, { reportedThisMount: false }, memory)).toBe(reason);
    memory.settle();
    expect(tripEndToReport(reason, { reportedThisMount: false }, memory)).toBeUndefined();
  });

  it('reports the end of a later trip after an earlier one was dismissed', () => {
    const memory = createTripEndNoticeMemory();
    memory.settle();
    memory.tripActive();
    expect(tripEndToReport(reason, { reportedThisMount: false }, memory)).toBe(reason);
  });

  it('reports nothing for a snapshot without an end reason', () => {
    expect(
      tripEndToReport(undefined, { reportedThisMount: false }, createTripEndNoticeMemory()),
    ).toBeUndefined();
  });
});
