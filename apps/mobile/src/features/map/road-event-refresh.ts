import { NavOssApiError } from '../../lib/api';

export const ROAD_EVENT_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

/**
 * Loads a regional road-event feed now and every five minutes until stopped. A failed refresh
 * marks the feed delayed and waits for the next tick: no immediate retry. A server that answers
 * 404 does not publish the feed at all, so the loop stops without flagging anything; it starts
 * again only when the region or the setting changes.
 */
export function startRoadEventRefresh({
  load,
  onDelayedChange,
}: {
  load: (signal: AbortSignal) => Promise<void>;
  onDelayedChange: (delayed: boolean) => void;
}): () => void {
  let controller: AbortController | undefined;
  const refresh = () => {
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    void load(requestController.signal)
      .then(() => {
        onDelayedChange(false);
      })
      .catch((error: unknown) => {
        if (requestController.signal.aborted) return;
        if (error instanceof NavOssApiError && error.status === 404) {
          stop();
          onDelayedChange(false);
          return;
        }
        onDelayedChange(true);
      });
  };
  const interval = setInterval(refresh, ROAD_EVENT_REFRESH_INTERVAL_MS);
  const stop = () => {
    clearInterval(interval);
    controller?.abort();
  };
  refresh();
  return stop;
}
