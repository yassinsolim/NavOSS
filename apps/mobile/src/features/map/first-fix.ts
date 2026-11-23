/** Where the map's first position comes from when it becomes visible. */
export interface FirstFixSource<Position> {
  /** A recent position the system already holds, or null. */
  lastKnown: () => Promise<Position | null>;
  /** One lookup. Rejects when the platform gives up without a position. */
  lookup: () => Promise<Position>;
  /**
   * Positions as they arrive, until the subscription is removed. Android only: its lookup waits
   * 30 s and then fails when the provider it asked has nothing (a Balanced request never switches
   * GPS on, so that is every cold start without a network location). The watch runs beside the
   * lookup so the first position from either is used. iOS's lookup waits for a fix itself.
   */
  watch?: (onPosition: (position: Position) => void) => Promise<{ remove: () => void }>;
}

export interface FirstFixListener<Position> {
  /** Called once, with the first position from any source. */
  onFix: (position: Position) => void;
  /** The lookup failed and nothing has arrived yet. A watch, if there is one, keeps waiting. */
  onGaveUp: () => void;
}

/**
 * Finds the first position: the last known one, else whichever of the lookup and the watch
 * answers first. Returns a function that stops the search; nothing is reported after it.
 */
export function findFirstFix<Position>(
  source: FirstFixSource<Position>,
  listener: FirstFixListener<Position>,
): () => void {
  let done = false;
  // Read through a function: `done` flips while the lookups below are awaiting.
  const stopped = () => done;
  let subscription: { remove: () => void } | undefined;

  const finish = () => {
    done = true;
    subscription?.remove();
    subscription = undefined;
  };
  const settle = (position: Position) => {
    if (done) return;
    finish();
    listener.onFix(position);
  };
  const startWatch = () => {
    if (done || source.watch === undefined) return;
    source
      .watch(settle)
      .then((started) => {
        if (done) started.remove();
        else subscription = started;
      })
      .catch(() => undefined);
  };

  void (async () => {
    let lastKnown: Position | null = null;
    let lastKnownFailed = false;
    try {
      lastKnown = await source.lastKnown();
    } catch {
      lastKnownFailed = true;
    }
    if (stopped()) return;
    if (lastKnown !== null) {
      settle(lastKnown);
      return;
    }
    startWatch();
    if (lastKnownFailed) {
      listener.onGaveUp();
      return;
    }
    try {
      settle(await source.lookup());
    } catch {
      if (!stopped()) listener.onGaveUp();
    }
  })();

  return () => {
    if (!done) finish();
  };
}
