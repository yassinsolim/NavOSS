/**
 * Where the map's first position comes from when it becomes visible. On Android the phone watch
 * (`shouldWatchPhoneIdleLocation`) runs beside this search from the moment permission is granted,
 * since the lookup waits 30 s and then fails when the provider it asked has nothing.
 */
export interface FirstFixSource<Position> {
  /** A recent position the system already holds, or null. */
  lastKnown: () => Promise<Position | null>;
  /** One lookup. Rejects when the platform gives up without a position. */
  lookup: () => Promise<Position>;
}

export interface FirstFixListener<Position> {
  /** Called once, with the first position found. */
  onFix: (position: Position) => void;
  /** No position: the last known one could not be read, or the lookup failed. */
  onGaveUp: () => void;
}

/**
 * Finds the first position: the last known one, else one lookup. Returns a function that stops
 * the search; nothing is reported after it.
 */
export function findFirstFix<Position>(
  source: FirstFixSource<Position>,
  listener: FirstFixListener<Position>,
): () => void {
  let done = false;
  // Read through a function: `done` flips while the lookups below are awaiting.
  const stopped = () => done;

  void (async () => {
    let lastKnown: Position | null;
    try {
      lastKnown = await source.lastKnown();
    } catch {
      if (!stopped()) listener.onGaveUp();
      return;
    }
    if (stopped()) return;
    if (lastKnown !== null) {
      listener.onFix(lastKnown);
      return;
    }
    let position: Position;
    try {
      position = await source.lookup();
    } catch {
      if (!stopped()) listener.onGaveUp();
      return;
    }
    if (!stopped()) listener.onFix(position);
  })();

  return () => {
    done = true;
  };
}
