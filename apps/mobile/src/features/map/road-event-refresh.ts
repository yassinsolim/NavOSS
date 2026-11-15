import type {
  OfficialRoadEventRegion,
  OfficialRoadEventResponse,
  RoadEventResponse,
} from '@navoss/contracts';

import type { RoadEventFeedChoice, RoadEventSnapshot } from '@/features/map/road-events';

import { NavOssApiError } from '../../lib/api';

export const ROAD_EVENT_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

/**
 * Loads a regional road-event feed now and every five minutes until stopped. A failed refresh
 * marks the feed delayed and waits for the next tick: no immediate retry. A server that answers
 * 404 (no endpoint) or 400 (a region it does not know) does not publish the feed at all, so the
 * loop stops without flagging anything; it starts again only when the region or the setting
 * changes.
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
        if (error instanceof NavOssApiError && (error.status === 400 || error.status === 404)) {
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

/**
 * One refresh of a region's road events. The provincial feed comes first; a server older than
 * the provincial regions answers 400 for them (404 without `/v2/events`), and then the region
 * falls back to the feed that server has (`/v1/events` for Calgary, Kelowna's v2 shape) for the
 * life of this loader. Without a fallback the error reaches the refresh loop, which stops quietly.
 */
export function createRoadEventLoader({
  feed,
  fetchCalgary,
  fetchOfficial,
  publish,
}: {
  feed: RoadEventFeedChoice;
  fetchCalgary: (signal: AbortSignal) => Promise<RoadEventResponse>;
  fetchOfficial: (
    region: OfficialRoadEventRegion,
    signal: AbortSignal,
  ) => Promise<OfficialRoadEventResponse>;
  publish: (snapshot: RoadEventSnapshot) => void;
}): (signal: AbortSignal) => Promise<void> {
  let useLegacy = feed.provincial === undefined;
  return async (signal) => {
    if (!useLegacy && feed.provincial !== undefined) {
      try {
        publish(await fetchOfficial(feed.provincial, signal));
        return;
      } catch (error: unknown) {
        const unsupported =
          error instanceof NavOssApiError && (error.status === 400 || error.status === 404);
        if (!unsupported || feed.legacy === undefined) throw error;
        useLegacy = true;
      }
    }
    if (feed.legacy === undefined) return;
    publish(
      feed.legacy === 'calgary'
        ? await fetchCalgary(signal)
        : await fetchOfficial('kelowna-bc', signal),
    );
  };
}
