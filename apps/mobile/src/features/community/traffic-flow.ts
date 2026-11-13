import {
  snapTrafficFlowBounds,
  type TrafficCongestionLevel,
  type TrafficFlowResponse,
} from '@navoss/contracts';
import type { FeatureCollection, LineString } from 'geojson';

import type { GeographicBox } from '@/features/community/community';

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

export interface TrafficFlowStatus {
  accessibilityLabel: string;
  text: string;
}

/**
 * The credit and coverage line shown while the traffic layer is on. The server publishes a road
 * only once enough drivers have driven it, so most roads show nothing: the line always says the
 * data is limited, and why, rather than letting an empty map read as "no traffic".
 */
export function trafficFlowStatus({
  failed,
  response,
  tooWide,
}: {
  failed: boolean;
  response: TrafficFlowResponse | undefined;
  tooWide: boolean;
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
  const parts = [
    response.source.attribution,
    'Limited data',
    ...(response.features.length === 0 ? ['None here yet'] : []),
    ...(response.coverage.truncated ? ['Zoom in for more'] : []),
  ];
  return {
    accessibilityLabel: `${response.source.attribution}. Limited data: a road is shown only after at least ${String(minimum)} drivers sharing speeds have driven it recently.${response.features.length === 0 ? ' No roads in view have enough data yet.' : ''}${response.coverage.truncated ? ' Zoom in to see every road.' : ''}`,
    text: parts.join(' · '),
  };
}
