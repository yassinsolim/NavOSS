/** Pure sheet geometry. The release and drag functions are worklets: they run on the UI thread. */

export type SheetDetent = number | 'content';

/**
 * Turns declared detents into ascending, distinct heights that fit the space above the sheet's
 * bottom edge. A sheet can never rest taller than `available`, whatever its content measures.
 */
export function resolveSheetDetents(
  detents: readonly SheetDetent[],
  contentHeight: number,
  available: number,
): number[] {
  const ceiling = Math.max(0, available);
  const heights = detents
    .map((detent) => Math.min(detent === 'content' ? contentHeight : detent, ceiling))
    .filter((height) => Number.isFinite(height) && height > 0)
    .sort((left, right) => left - right);
  return heights.filter((height, index) => index === 0 || height - (heights[index - 1] ?? 0) > 1);
}

export interface SheetRelease {
  dismiss: boolean;
  index: number;
}

/** How far ahead a fling is projected, in seconds of travel at release velocity. */
const FLING_PROJECTION_SECONDS = 0.18;

/**
 * Where a released sheet comes to rest. The finger's velocity is projected forward so a short
 * fast flick reaches the next detent and a slow drag settles on the nearest one. A dismissible
 * sheet leaves once that projection is under half of its lowest detent.
 */
export function detentAfterRelease({
  detents,
  dismissible,
  height,
  velocityY,
}: {
  detents: readonly number[];
  dismissible: boolean;
  height: number;
  /** Points per second, positive downwards (the gesture convention). */
  velocityY: number;
}): SheetRelease {
  'worklet';
  const projected = height - velocityY * FLING_PROJECTION_SECONDS;
  const lowest = detents[0] ?? 0;
  if (dismissible && projected < lowest * 0.5) {
    return { dismiss: true, index: 0 };
  }
  let index = 0;
  let nearest = Number.POSITIVE_INFINITY;
  for (let candidate = 0; candidate < detents.length; candidate += 1) {
    const distance = Math.abs((detents[candidate] ?? 0) - projected);
    if (distance < nearest) {
      nearest = distance;
      index = candidate;
    }
  }
  return { dismiss: false, index };
}

/**
 * The height a sheet shows while a finger holds it. Inside its range it tracks the finger
 * exactly; past either end it resists, so the limits are felt rather than hit.
 */
export function draggedSheetHeight({
  dismissible,
  max,
  min,
  raw,
  stiffTop,
}: {
  dismissible: boolean;
  max: number;
  min: number;
  raw: number;
  /** A sheet with a scrolling list stops dead at its top: the overscroll belongs to the list. */
  stiffTop: boolean;
}): number {
  'worklet';
  if (raw > max) {
    return stiffTop ? max : max + (raw - max) * 0.12;
  }
  const floor = dismissible ? 0 : min;
  if (raw < floor) {
    return Math.max(0, floor - (floor - raw) * 0.25);
  }
  return raw;
}
