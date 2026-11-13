import type {
  OfficialRoadEventResponse,
  OfficialSafetyCamera,
  RoadEventResponse,
  SafetyCamera,
  SafetyFacility,
  TrafficCamera,
  TrafficFlowResponse,
} from '@navoss/contracts';
import { startTransition, useEffect, useState } from 'react';

import {
  TRAFFIC_FLOW_RETRY_MS,
  trafficFlowRefreshDelayMs,
} from '@/features/community/traffic-flow';

import {
  type MapRoadEvent,
  type RoadEventRegion,
  roadEventRegionForMapRegion,
} from '@/features/map/map-features';
import type { MapRegion } from '@/features/map/map-region';
import { startRoadEventRefresh } from '@/features/map/road-event-refresh';
import {
  fetchOfficialRoadEvents,
  fetchOfficialSafetyCameras,
  fetchRoadEvents,
  fetchSafetyCameras,
  fetchSafetyFacilities,
  fetchTrafficCameras,
  fetchTrafficFlow,
} from '@/lib/api';

const NO_EVENTS: readonly MapRoadEvent[] = [];

export interface OverlayData {
  kelownaSafetyFacilities: readonly SafetyFacility[];
  kelownaTrafficCameras: readonly TrafficCamera[];
  roadEventRefreshDelayed: boolean;
  roadEventRegion: RoadEventRegion | undefined;
  /** Undefined until the active region's first snapshot arrives. */
  roadEventSnapshot: OfficialRoadEventResponse | RoadEventResponse | undefined;
  roadEvents: readonly MapRoadEvent[];
  safetyCameras: readonly SafetyCamera[];
  torontoSafetyCameras: readonly OfficialSafetyCamera[];
  /** The last community traffic-flow snapshot, while the layer is wanted. */
  trafficFlow: TrafficFlowResponse | undefined;
  /** The latest flow request failed (the last snapshot, if any, stays drawn until it expires). */
  trafficFlowFailed: boolean;
}

/**
 * Regional overlay data: official road events, enforcement cameras, traffic webcams and public
 * safety facilities. Each is fetched only for the exact region that publishes it and is dropped
 * when the driver leaves that region, so the map never shows another city's data.
 *
 * Community traffic flow is fetched here too, for the visible grid-aligned box, only while the
 * driver has the traffic layer on and the server declares live traffic, and never sooner than the
 * snapshot's own `validUntil`. Community reports come through the native bridge (`useCommunity`),
 * which shares its cache with CarPlay.
 */
export function useOverlayData({
  inTorontoCameraBounds,
  mapRegion,
  showRoadEvents,
  trafficFlowQuery,
}: {
  inTorontoCameraBounds: boolean;
  mapRegion: MapRegion;
  showRoadEvents: boolean;
  /** `bbox` for `/v2/traffic/flow`; undefined when the layer is off, unavailable or too wide. */
  trafficFlowQuery: string | undefined;
}): OverlayData {
  const [safetyCameras, setSafetyCameras] = useState<readonly SafetyCamera[]>([]);
  const [roadEventResponse, setRoadEventResponse] = useState<RoadEventResponse>();
  const [officialRoadEventResponse, setOfficialRoadEventResponse] =
    useState<OfficialRoadEventResponse>();
  const [roadEventRefreshDelayed, setRoadEventRefreshDelayed] = useState(false);
  const [torontoSafetyCameras, setTorontoSafetyCameras] = useState<readonly OfficialSafetyCamera[]>(
    [],
  );
  const [kelownaTrafficCameras, setKelownaTrafficCameras] = useState<readonly TrafficCamera[]>([]);
  const [kelownaSafetyFacilities, setKelownaSafetyFacilities] = useState<readonly SafetyFacility[]>(
    [],
  );
  const [trafficFlow, setTrafficFlow] = useState<TrafficFlowResponse>();
  const [trafficFlowFailed, setTrafficFlowFailed] = useState(false);
  const roadEventRegion = roadEventRegionForMapRegion(mapRegion);

  useEffect(() => {
    if (trafficFlowQuery === undefined) {
      setTrafficFlow(undefined);
      setTrafficFlowFailed(false);
      return;
    }
    let controller: AbortController | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      controller = new AbortController();
      const { signal } = controller;
      void fetchTrafficFlow({ bbox: trafficFlowQuery, signal })
        .then((response) => {
          startTransition(() => {
            setTrafficFlow(response);
            setTrafficFlowFailed(false);
          });
          timeout = setTimeout(load, trafficFlowRefreshDelayMs(response, Date.now()));
        })
        .catch(() => {
          if (signal.aborted) return;
          setTrafficFlowFailed(true);
          // A published value is never shown after its epoch: drop what has expired.
          setTrafficFlow((current) =>
            current !== undefined && Date.parse(current.validUntil) > Date.now()
              ? current
              : undefined,
          );
          timeout = setTimeout(load, TRAFFIC_FLOW_RETRY_MS);
        });
    };
    load();
    return () => {
      controller?.abort();
      clearTimeout(timeout);
    };
  }, [trafficFlowQuery]);

  useEffect(() => {
    if (!inTorontoCameraBounds) {
      setTorontoSafetyCameras([]);
      return;
    }
    const controller = new AbortController();
    void fetchOfficialSafetyCameras({ region: 'toronto-on', signal: controller.signal })
      .then((response) => {
        startTransition(() => {
          setTorontoSafetyCameras(response.cameras);
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setTorontoSafetyCameras([]);
      });
    return () => {
      controller.abort();
    };
  }, [inTorontoCameraBounds]);

  useEffect(() => {
    if (mapRegion !== 'kelowna-bc') {
      setKelownaTrafficCameras([]);
      setKelownaSafetyFacilities([]);
      return;
    }
    const controller = new AbortController();
    void Promise.all([
      fetchTrafficCameras({ region: 'kelowna-bc', signal: controller.signal }),
      fetchSafetyFacilities({ region: 'kelowna-bc', signal: controller.signal }),
    ])
      .then(([cameraResponse, facilityResponse]) => {
        startTransition(() => {
          setKelownaTrafficCameras(cameraResponse.cameras);
          setKelownaSafetyFacilities(facilityResponse.facilities);
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setKelownaTrafficCameras([]);
          setKelownaSafetyFacilities([]);
        }
      });
    return () => {
      controller.abort();
    };
  }, [mapRegion]);

  useEffect(() => {
    if (mapRegion !== 'calgary-ab') {
      setSafetyCameras([]);
      return;
    }
    const controller = new AbortController();
    void fetchSafetyCameras({ signal: controller.signal })
      .then((response) => {
        startTransition(() => {
          setSafetyCameras(response.cameras);
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setSafetyCameras([]);
      });
    return () => {
      controller.abort();
    };
  }, [mapRegion]);

  useEffect(() => {
    setRoadEventRefreshDelayed(false);
    if (!showRoadEvents || roadEventRegion === undefined) return;

    return startRoadEventRefresh({
      load: (signal) =>
        roadEventRegion === 'calgary'
          ? fetchRoadEvents({ signal }).then((response) => {
              startTransition(() => {
                setRoadEventResponse(response);
              });
            })
          : fetchOfficialRoadEvents({ region: roadEventRegion, signal }).then((response) => {
              startTransition(() => {
                setOfficialRoadEventResponse(response);
              });
            }),
      onDelayedChange: setRoadEventRefreshDelayed,
    });
  }, [roadEventRegion, showRoadEvents]);

  const roadEventSnapshot =
    roadEventRegion === 'calgary'
      ? roadEventResponse
      : roadEventRegion !== undefined && officialRoadEventResponse?.regionId === roadEventRegion
        ? officialRoadEventResponse
        : undefined;

  return {
    kelownaSafetyFacilities,
    kelownaTrafficCameras,
    roadEventRefreshDelayed,
    roadEventRegion,
    roadEventSnapshot,
    roadEvents: roadEventSnapshot?.events ?? NO_EVENTS,
    safetyCameras,
    torontoSafetyCameras,
    trafficFlow,
    trafficFlowFailed,
  };
}
