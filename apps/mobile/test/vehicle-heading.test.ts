import { describe, expect, it } from 'vitest';

import {
  mapRelativeHeadingDegrees,
  normalizeHeadingDegrees,
} from '../src/features/navigation/vehicle-heading.js';

describe('vehicle heading', () => {
  it('keeps a course-up vehicle pointing forward', () => {
    expect(mapRelativeHeadingDegrees(90, 90)).toBe(0);
  });

  it('rotates a vehicle relative to a north-up map', () => {
    expect(mapRelativeHeadingDegrees(135, 0)).toBe(135);
  });

  it('normalizes angles across geographic north', () => {
    expect(mapRelativeHeadingDegrees(5, 355)).toBe(10);
    expect(mapRelativeHeadingDegrees(350, 10)).toBe(340);
    expect(normalizeHeadingDegrees(Number.NaN)).toBe(0);
  });
});
