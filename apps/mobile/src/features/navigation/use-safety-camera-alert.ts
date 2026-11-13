import type { RouteAlternative, SafetyCamera } from '@navoss/contracts';
import { useEffect, useRef, useState } from 'react';

import {
  announceSafetyCamera,
  type NativeNavigationSnapshot,
} from '@/features/navigation/native-navigation';
import {
  findUpcomingSafetyCamera,
  type UpcomingSafetyCamera,
} from '@/features/navigation/safety-camera-alert';

const ALERT_VISIBLE_MS = 6_000;

export interface SafetyCameraAlerts {
  /** The camera currently being warned about, cleared a few seconds after it was announced. */
  alert: UpcomingSafetyCamera | undefined;
  /** Alerts announced since the trip started. */
  announcementCount: number;
  /** Clears the banner but keeps the announced set: used when a trip ends or arrives. */
  dismiss: () => void;
  /** Forgets announced cameras and clears the banner: used when a new trip starts or is cancelled. */
  reset: () => void;
}

/**
 * Safety-camera warnings for the active route.
 *
 * This file is the single owner of camera-alert eligibility on the phone. Integration seam
 * (native-core slice): once the navigation snapshot carries `safetyCameraAlert`, replace the
 * effect below with "show the banner when `snapshot.safetyCameraAlert.sequence` changes" and
 * delete the `findUpcomingSafetyCamera`/`announceSafetyCamera` path, which would double-speak.
 */
export function useSafetyCameraAlert({
  cameras,
  route,
  snapshot,
}: {
  cameras: readonly SafetyCamera[];
  /** The route being navigated, or undefined when no trip is active. */
  route: RouteAlternative | undefined;
  snapshot: NativeNavigationSnapshot | undefined;
}): SafetyCameraAlerts {
  const announcedCameraIdsRef = useRef(new Set<string>());
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const camerasRef = useRef(cameras);
  const [alert, setAlert] = useState<UpcomingSafetyCamera>();
  const [announcementCount, setAnnouncementCount] = useState(0);

  useEffect(() => {
    camerasRef.current = cameras;
  }, [cameras]);

  const dismiss = () => {
    clearTimeout(timeoutRef.current);
    timeoutRef.current = undefined;
    setAlert(undefined);
    setAnnouncementCount(0);
  };

  useEffect(() => {
    if (route === undefined || snapshot === undefined) return;
    if (snapshot.phase === 'arrived') {
      clearTimeout(timeoutRef.current);
      setAlert(undefined);
      return;
    }
    if (snapshot.isOffRoute || snapshot.rawCoordinate === undefined) return;
    const upcoming = findUpcomingSafetyCamera(
      camerasRef.current,
      route,
      snapshot.routeProgress,
      announcedCameraIdsRef.current,
    );
    if (upcoming === undefined) return;
    announcedCameraIdsRef.current.add(upcoming.camera.id);
    setAnnouncementCount((count) => count + 1);
    setAlert(upcoming);
    announceSafetyCamera();
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setAlert(undefined);
      timeoutRef.current = undefined;
    }, ALERT_VISIBLE_MS);
  }, [route, snapshot]);

  useEffect(
    () => () => {
      clearTimeout(timeoutRef.current);
    },
    [],
  );

  return {
    alert,
    announcementCount,
    dismiss,
    reset: () => {
      announcedCameraIdsRef.current.clear();
      dismiss();
    },
  };
}
