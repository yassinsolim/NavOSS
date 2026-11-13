/** A route is at most eight stops and a destination. */
export const MAX_ROUTE_DESTINATIONS = 9;

/**
 * Swaps a stop with its neighbour. Moving past either end returns the same array, so callers
 * can use identity to tell that nothing changed.
 */
export function moveRouteStop<T>(stops: readonly T[], index: number, offset: -1 | 1): readonly T[] {
  const target = index + offset;
  if (index < 0 || index >= stops.length || target < 0 || target >= stops.length) return stops;
  const next = [...stops];
  const moved = next[index];
  next[index] = next[target];
  next[target] = moved;
  return next;
}

/** The role a position plays in the ordered list: the last entry is always the destination. */
export function routeStopRole(
  index: number,
  count: number,
): { kind: 'destination' | 'stop'; label: string; marker: string } {
  return index === count - 1
    ? { kind: 'destination', label: 'Destination', marker: 'B' }
    : { kind: 'stop', label: `Stop ${String(index + 1)}`, marker: String(index + 1) };
}
