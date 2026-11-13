import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * A callback whose identity never changes but which always runs the latest closure. Use it for
 * handlers passed to memoised children or native views, where a new function identity on every
 * render would defeat the memoisation without changing behaviour. Do not call it during render.
 */
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(callback);
  useLayoutEffect(() => {
    latest.current = callback;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}
