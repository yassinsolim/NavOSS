export function normalizeHeadingDegrees(heading: number): number {
  if (!Number.isFinite(heading)) {
    return 0;
  }

  return ((heading % 360) + 360) % 360;
}

export function mapRelativeHeadingDegrees(course: number, mapBearing: number): number {
  return normalizeHeadingDegrees(course - mapBearing);
}
