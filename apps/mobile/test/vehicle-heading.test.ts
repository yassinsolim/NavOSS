import { describe, expect, it } from 'vitest';

import {
  mapAlignedHeadingDegrees,
  normalizeHeadingDegrees,
} from '../src/features/navigation/vehicle-heading.js';

describe('vehicle heading', () => {
  it('uses absolute course for a map-aligned symbol', () => {
    expect(mapAlignedHeadingDegrees(90)).toBe(90);
  });

  it('lets MapLibre rotate a course-up vehicle with the map exactly once', () => {
    const course = mapAlignedHeadingDegrees(135);
    const mapBearing = 135;
    expect(normalizeHeadingDegrees(course - mapBearing)).toBe(0);
  });

  it('normalizes angles across geographic north', () => {
    expect(mapAlignedHeadingDegrees(365)).toBe(5);
    expect(mapAlignedHeadingDegrees(-10)).toBe(350);
    expect(normalizeHeadingDegrees(Number.NaN)).toBe(0);
  });
});
