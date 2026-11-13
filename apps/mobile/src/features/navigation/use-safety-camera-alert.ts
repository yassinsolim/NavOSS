import { useEffect, useRef, useState } from 'react';

import type { NativeNavigationSnapshot } from '@/features/navigation/native-navigation';

const ALERT_VISIBLE_MS = 6_000;

export interface SafetyCameraAlert {
  camera: { location: string };
  distanceAheadMeters: number;
}

export interface SafetyCameraAlerts {
  /** The camera currently being warned about, cleared a few seconds after it was announced. */
  alert: SafetyCameraAlert | undefined;
  /** Alerts presented since the trip started. */
  announcementCount: number;
  /** Clears the banner and the count: used whenever a trip starts, ends or is cancelled. */
  reset: () => void;
}

/**
 * Presents safety-camera alerts. The navigation core decides which camera to warn about and
 * speaks the warning, so alerts also work with the phone locked or only CarPlay on screen; the
 * phone shows a banner built from the alert's own payload. Each alert has a unique `sequence`,
 * so a repeated snapshot never re-shows a banner that has already timed out.
 */
export function useSafetyCameraAlert(
  snapshot: NativeNavigationSnapshot | undefined,
): SafetyCameraAlerts {
  const presentedSequenceRef = useRef<number | undefined>(undefined);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [alert, setAlert] = useState<SafetyCameraAlert>();
  const [announcementCount, setAnnouncementCount] = useState(0);
  const nativeAlert = snapshot?.phase === 'arrived' ? undefined : snapshot?.safetyCameraAlert;
  const arrived = snapshot?.phase === 'arrived';

  useEffect(() => {
    if (arrived) {
      clearTimeout(timeoutRef.current);
      setAlert(undefined);
      return;
    }
    if (nativeAlert === undefined || presentedSequenceRef.current === nativeAlert.sequence) return;
    presentedSequenceRef.current = nativeAlert.sequence;
    setAnnouncementCount((count) => count + 1);
    setAlert({
      camera: { location: nativeAlert.location },
      distanceAheadMeters: nativeAlert.distanceAheadMeters,
    });
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setAlert(undefined);
      timeoutRef.current = undefined;
    }, ALERT_VISIBLE_MS);
  }, [arrived, nativeAlert]);

  useEffect(
    () => () => {
      clearTimeout(timeoutRef.current);
    },
    [],
  );

  return {
    alert,
    announcementCount,
    reset: () => {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = undefined;
      setAlert(undefined);
      setAnnouncementCount(0);
    },
  };
}
