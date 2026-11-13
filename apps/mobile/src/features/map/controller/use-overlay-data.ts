import type {
  OfficialRoadEventResponse,
  OfficialSafetyCamera,
  RoadEventResponse,
  SafetyCamera,
  SafetyFacility,
  TrafficCamera,
} from '@navoss/contracts';
import { startTransition, useEffect, useState } from 'react';

import {
  type MapRoadEvent,
  type RoadEventRegion,
  roadEventRegionForMapRegion,
} from '@/features/map/map-features';
import type { MapRegion } from '@/features/map/map-region';
import {
  fetchOfficialRoadEvents,
  fetchOfficialSafetyCameras,
  fetchRoadEvents,
  fetchSafetyCameras,
  fetchSafetyFacilities,
  fetchTrafficCameras,
} from '@/lib/api';

const ROAD_EVENT_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
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
}

/**
 * Regional overlay data: official road events, enforcement cameras, traffic webcams and public
 * safety facilities. Each is fetched only for the exact region that publishes it and is dropped
 * when the driver leaves that region, so the map never shows another city's data.
 *
 * Wave 2 seam: community reports and the traffic-flow snapshot are regional overlays too. Add
 * their fetch-and-refresh effects here and return them alongside `roadEvents`; `MapOverlayLayers`
 * draws whatever this hook returns.
 */
export function useOverlayData({
  inTorontoCameraBounds,
  mapRegion,
  showRoadEvents,
}: {
  inTorontoCameraBounds: boolean;
  mapRegion: MapRegion;
  showRoadEvents: boolean;
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
  const roadEventRegion = roadEventRegionForMapRegion(mapRegion);

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

    let controller: AbortController | undefined;
    const refresh = () => {
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      const request =
        roadEventRegion === 'calgary'
          ? fetchRoadEvents({ signal: requestController.signal }).then((response) => {
              startTransition(() => {
                setRoadEventResponse(response);
              });
            })
          : fetchOfficialRoadEvents({
              region: roadEventRegion,
              signal: requestController.signal,
            }).then((response) => {
              startTransition(() => {
                setOfficialRoadEventResponse(response);
              });
            });
      void request
        .then(() => {
          setRoadEventRefreshDelayed(false);
        })
        .catch(() => {
          if (!requestController.signal.aborted) setRoadEventRefreshDelayed(true);
        });
    };

    refresh();
    const interval = setInterval(refresh, ROAD_EVENT_REFRESH_INTERVAL_MS);
    return () => {
      clearInterval(interval);
      controller?.abort();
    };
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
  };
}
