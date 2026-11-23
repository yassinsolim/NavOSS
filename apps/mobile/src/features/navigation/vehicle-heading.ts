export function normalizeHeadingDegrees(heading: number): number {
  if (!Number.isFinite(heading)) {
    return 0;
  }

  return ((heading % 360) + 360) % 360;
}

export function mapAlignedHeadingDegrees(course: number): number {
  return normalizeHeadingDegrees(course);
}

/** A compass bearing in [0, 360), or undefined for anything else (iOS reports unknown as -1). */
export function validBearing(degrees: unknown): number | undefined {
  return typeof degrees === 'number' && Number.isFinite(degrees) && degrees >= 0 && degrees < 360
    ? degrees
    : undefined;
}

/**
 * The course of the trip vehicle: the matched road's course, else the latest fix's own GPS course
 * while it proves the direction of travel (off the route, or before the first match, the core
 * has no matched course). Undefined when neither is known, as when stopped off the route: callers
 * keep the heading they already have. The camera, the vehicle and the held heading all read this
 * one rule, so they cannot disagree.
 */
export function tripVehicleCourseDegrees(
  snapshot: { matchedCourseDegrees?: number; rawCourseDegrees?: number } | undefined,
): number | undefined {
  return validBearing(snapshot?.matchedCourseDegrees) ?? validBearing(snapshot?.rawCourseDegrees);
}
