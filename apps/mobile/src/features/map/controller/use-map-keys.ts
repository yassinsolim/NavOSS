import type { CameraRef, MapRef } from '@maplibre/maplibre-react-native';
import { type RefObject, useEffect, useRef } from 'react';

import { NavOSSInput } from '../../../../modules/navoss-input';
import { keyZoom, paddedCenterPoint, stickPanCenter } from '@/features/map/map-keys';
import type { CameraPadding } from '@/features/map/overlay-layout';
import { useStableCallback } from '@/lib/use-stable-callback';

/** How often a held stick moves the camera. */
const STICK_TICK_MS = 50;

/**
 * Android handhelds: L1 / R1 zoom the map out / in, pressing the right stick recenters (on the
 * vehicle during a trip, on the driver otherwise) and the right stick pans (see `map-keys.ts`).
 * Zooming or panning is a map gesture: it stops the camera following, as a touch does. Nothing
 * runs while the map is hidden, and nothing is subscribed on iOS.
 */
export function useMapKeys({
  cameraRef,
  enabled,
  mapRef,
  onMove,
  onRecenter,
  padding,
  size,
}: {
  cameraRef: RefObject<CameraRef | null>;
  enabled: boolean;
  mapRef: RefObject<MapRef | null>;
  /**
   * The padding a stick pan gives the camera (the side panel's share in landscape). MapLibre
   * Android applies a centred move's padding as given, none counting as zero, so a pan passes one
   * on every step. The camera may hold another padding when the pan starts, so the first step
   * starts from the coordinate under this padding's centre on screen (`paddedCenterPoint`).
   */
  padding: CameraPadding;
  /** The map view's size in dp. */
  size: { height: number; width: number };
  /** The driver moved the map: stop following, as after a touch gesture. */
  onMove: () => void;
  onRecenter: () => void;
}) {
  const stick = useRef({ x: 0, y: 0 });
  const paddingRef = useRef(padding);
  paddingRef.current = padding;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const moved = useStableCallback(onMove);
  const recenter = useStableCallback(onRecenter);

  useEffect(() => {
    if (!enabled || NavOSSInput === null) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    let lastTick = 0;
    let panning = false;
    // The padding this pan has given the camera; `undefined` until its first step.
    let panPadding: CameraPadding | undefined;

    const panStep = async () => {
      if (panning) return;
      const map = mapRef.current;
      if (map === null) return;
      panning = true;
      try {
        const now = Date.now();
        const seconds = Math.min(0.2, (now - lastTick) / 1000);
        lastTick = now;
        const view = await map.getViewState();
        const stepPadding = paddingRef.current;
        const from = samePadding(panPadding, stepPadding)
          ? view.center
          : await map.unproject(paddedCenterPoint(sizeRef.current, stepPadding));
        const center = stickPanCenter({ ...view, center: from }, stick.current, seconds);
        cameraRef.current?.jumpTo({ center, padding: stepPadding });
        panPadding = stepPadding;
      } catch {
        // The map is gone or not ready: the next tick tries again.
      } finally {
        panning = false;
      }
    };

    const commands = NavOSSInput.addListener('onMapCommand', ({ command }) => {
      if (command === 'recenter') {
        recenter();
        return;
      }
      moved();
      void mapRef.current
        ?.getZoom()
        .then((zoom) => {
          // No centre, so the camera keeps the padding it holds and zooms about what it shows.
          cameraRef.current?.zoomTo(keyZoom(zoom, command), { duration: 250 });
        })
        .catch(() => undefined);
    });
    const sticks = NavOSSInput.addListener('onMapStick', (next) => {
      stick.current = next;
      const resting = next.x === 0 && next.y === 0;
      if (resting) {
        clearInterval(timer);
        timer = undefined;
        // Another camera move may change the padding before the next pan.
        panPadding = undefined;
        return;
      }
      if (timer !== undefined) return;
      moved();
      lastTick = Date.now();
      timer = setInterval(() => {
        void panStep();
      }, STICK_TICK_MS);
    });
    return () => {
      commands.remove();
      sticks.remove();
      clearInterval(timer);
      stick.current = { x: 0, y: 0 };
    };
  }, [cameraRef, enabled, mapRef, moved, recenter]);
}

function samePadding(a: CameraPadding | undefined, b: CameraPadding): boolean {
  return a?.bottom === b.bottom && a.left === b.left && a.right === b.right && a.top === b.top;
}
