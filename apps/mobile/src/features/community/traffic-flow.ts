import {
  snapTrafficFlowBounds,
  type TrafficCongestionLevel,
  type TrafficFlowResponse,
} from '@navoss/contracts';
import type { FeatureCollection, LineString } from 'geojson';

import type { GeographicBox } from '@/features/community/community';
import { communityTrafficUpdated } from '../navigation/route-progress';

/** Never ask again sooner than this, even if the server's epoch ends earlier. */
const MINIMUM_REFRESH_MS = 30_000;
/** A failed request is retried after this long. */
export const TRAFFIC_FLOW_RETRY_MS = 120_000;

export const EMPTY_TRAFFIC_FLOW: FeatureCollection<
  LineString,
  { congestion: TrafficCongestionLevel }
> = { features: [], type: 'FeatureCollection' };

/** The `bbox` query for a viewport, or undefined when it is wider than the service allows. */
export function trafficFlowQuery(view: GeographicBox | undefined): string | undefined {
  if (view === undefined) return undefined;
  return snapTrafficFlowBounds(view);
}

export function trafficFlowFeatures(
  response: TrafficFlowResponse | undefined,
): FeatureCollection<LineString, { congestion: TrafficCongestionLevel }> {
  if (response === undefined || response.features.length === 0) return EMPTY_TRAFFIC_FLOW;
  return {
    features: response.features.map((feature) => ({
      geometry: feature.geometry,
      id: feature.id,
      properties: { congestion: feature.properties.congestion },
      type: 'Feature',
    })),
    type: 'FeatureCollection',
  };
}

/**
 * The basemap layer the traffic lines are drawn beneath when no route is shown: the first label
 * layer above the last road line, so traffic sits on top of every road but under road and place
 * names. (The first symbol layer of a style can be a water label drawn before the roads, which
 * would hide the traffic under them.) Undefined when the style has no such layer.
 */
export function trafficFlowAnchorLayerId(
  layers: readonly { id: string; 'source-layer'?: string; type: string }[],
): string | undefined {
  let lastRoad = -1;
  layers.forEach((layer, index) => {
    if (layer.type === 'line' && layer['source-layer'] === 'transportation') lastRoad = index;
  });
  return layers.find((layer, index) => index > lastRoad && layer.type === 'symbol')?.id;
}

/** When to ask again: the snapshot is constant until `validUntil`, so never poll before it. */
export function trafficFlowRefreshDelayMs(
  response: Pick<TrafficFlowResponse, 'validUntil'>,
  nowMs: number,
): number {
  const validUntil = Date.parse(response.validUntil);
  if (!Number.isFinite(validUntil)) return TRAFFIC_FLOW_RETRY_MS;
  // A little after the boundary, so the next epoch is already published.
  return Math.max(MINIMUM_REFRESH_MS, validUntil - nowMs + 5_000);
}

/** Snapshots by `bbox`, kept while the layer is hidden so showing it again asks nothing early. */
export type TrafficFlowCache = Map<string, TrafficFlowResponse>;

/** Boxes remembered at once; panning back and forth across a few boxes reuses their snapshots. */
const TRAFFIC_FLOW_CACHE_LIMIT = 16;

/** The snapshot last received for `bbox`, while it is still valid. */
export function cachedTrafficFlow(
  cache: TrafficFlowCache,
  bbox: string,
  nowMs: number,
): TrafficFlowResponse | undefined {
  const response = cache.get(bbox);
  return response !== undefined && Date.parse(response.validUntil) > nowMs ? response : undefined;
}

function rememberTrafficFlow(
  cache: TrafficFlowCache,
  bbox: string,
  response: TrafficFlowResponse,
  nowMs: number,
): void {
  for (const [key, value] of cache) {
    if (!(Date.parse(value.validUntil) > nowMs)) cache.delete(key);
  }
  cache.delete(bbox);
  cache.set(bbox, response);
  while (cache.size > TRAFFIC_FLOW_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Keeps the flow layer for `bbox` current until stopped, never asking before the last snapshot's
 * `validUntil` (it cannot change before then). A snapshot still valid in `cache` is shown at once
 * and refreshed at its boundary, so hiding and showing the layer, or panning back to a box, asks
 * nothing new. A failed request keeps showing that box's snapshot until it expires and is retried
 * after `TRAFFIC_FLOW_RETRY_MS`.
 */
export function startTrafficFlowRefresh({
  bbox,
  cache,
  load,
  now = Date.now,
  onFailure,
  onResponse,
}: {
  bbox: string;
  cache: TrafficFlowCache;
  load: (bbox: string, signal: AbortSignal) => Promise<TrafficFlowResponse>;
  now?: () => number;
  /** The request failed; `cached` is the box's snapshot while it is still valid. */
  onFailure: (cached: TrafficFlowResponse | undefined) => void;
  onResponse: (response: TrafficFlowResponse) => void;
}): () => void {
  let controller: AbortController | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => {
    const requestController = new AbortController();
    controller = requestController;
    const { signal } = requestController;
    void load(bbox, signal)
      .then((response) => {
        if (signal.aborted) return;
        rememberTrafficFlow(cache, bbox, response, now());
        onResponse(response);
        timeout = setTimeout(refresh, trafficFlowRefreshDelayMs(response, now()));
      })
      .catch(() => {
        if (signal.aborted) return;
        onFailure(cachedTrafficFlow(cache, bbox, now()));
        timeout = setTimeout(refresh, TRAFFIC_FLOW_RETRY_MS);
      });
  };
  const cached = cachedTrafficFlow(cache, bbox, now());
  if (cached === undefined) {
    refresh();
  } else {
    onResponse(cached);
    timeout = setTimeout(refresh, trafficFlowRefreshDelayMs(cached, now()));
  }
  return () => {
    controller?.abort();
    clearTimeout(timeout);
  };
}

export interface TrafficFlowStatus {
  accessibilityLabel: string;
  text: string;
}

/**
 * The credit and coverage line shown while the traffic layer is on. The server publishes a road
 * only once enough drivers have driven it, so most roads show nothing: the line always says the
 * data is limited, and why, rather than letting an empty map read as "no traffic". When roads are
 * shown in view, it says when they were updated: the oldest publication boundary among them, as
 * each road's `observedAt` states it, never when the layer was fetched.
 */
export function trafficFlowStatus({
  failed,
  response,
  tooWide,
  view,
}: {
  failed: boolean;
  response: TrafficFlowResponse | undefined;
  tooWide: boolean;
  /** The map's visible box: the response covers a grid-snapped box around it. */
  view: GeographicBox | undefined;
}): TrafficFlowStatus | undefined {
  if (tooWide) {
    return {
      accessibilityLabel: 'Community traffic: zoom in to see traffic',
      text: 'Traffic · Zoom in to see traffic',
    };
  }
  if (response === undefined) {
    return failed
      ? {
          accessibilityLabel: 'Community traffic is unavailable right now',
          text: 'Traffic unavailable right now',
        }
      : undefined;
  }
  const minimum = response.coverage.minimumContributors;
  // Only roads that reach into the visible box: the response also holds roads up to a grid cell
  // beyond it, which the driver cannot see.
  const visible =
    view === undefined
      ? []
      : response.features.filter(({ geometry }) => {
          const longitudes = geometry.coordinates.map(([longitude]) => longitude);
          const latitudes = geometry.coordinates.map(([, latitude]) => latitude);
          return (
            Math.min(...longitudes) <= view.east &&
            Math.max(...longitudes) >= view.west &&
            Math.min(...latitudes) <= view.north &&
            Math.max(...latitudes) >= view.south
          );
        });
  const updated = communityTrafficUpdated(visible.map((feature) => feature.properties.observedAt));
  const parts = [
    response.source.attribution,
    ...(updated === undefined ? [] : [updated]),
    'Limited data',
    ...(visible.length === 0 ? ['None here yet'] : []),
    ...(response.coverage.truncated ? ['Zoom in for more'] : []),
  ];
  return {
    accessibilityLabel: `${response.source.attribution}${updated === undefined ? '' : `, ${updated}`}. Limited data: a road is shown only after at least ${String(minimum)} drivers sharing speeds have driven it recently.${visible.length === 0 ? ' No roads in view have enough data yet.' : ''}${response.coverage.truncated ? ' Zoom in to see every road.' : ''}`,
    text: parts.join(' · '),
  };
}
