import { useEffect } from 'react';

const counts = new Map<string, number>();
let reportTimer: ReturnType<typeof setTimeout> | undefined;

function report(): void {
  reportTimer = undefined;
  const summary = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `${name}=${String(count)}`)
    .join(' ');
  // Counts only: never coordinates, search text or anything else about the trip.
  console.log(`[navoss:renders] ${summary}`);
}

/**
 * Development-only commit counter. Opt in by starting Metro with
 * `EXPO_PUBLIC_NAVOSS_RENDER_COUNTS=1`; cumulative totals are then logged at most every two seconds
 * while anything renders. This is how "panning the map does
 * not re-render the screen tree" is measured rather than asserted. It compiles to a no-op hook
 * in release builds.
 */
export function useRenderCounter(name: string): void {
  useEffect(() => {
    if (!__DEV__) return;
    if (process.env.EXPO_PUBLIC_NAVOSS_RENDER_COUNTS !== '1') return;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    // Throttled, not debounced: guidance renders about once a second and must still report.
    reportTimer ??= setTimeout(report, 2_000);
  });
}
