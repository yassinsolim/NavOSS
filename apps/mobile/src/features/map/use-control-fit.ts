import { useCallback, useState } from 'react';
import { type SharedValue, useAnimatedReaction } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import {
  type ControlsShown,
  controlsShown,
  type ControlZone,
  controlZone,
  isControlInteractive,
} from '@/features/map/overlay-layout';

/**
 * Whether a control whose opacity is animated on the UI thread is clearly enough visible to be
 * used (`isControlInteractive`). One that is not must also leave touch and VoiceOver focus, or
 * the driver can press a button they can barely see. Re-renders only when this flips, never per
 * frame.
 */
export function useControlInteractive(opacity: SharedValue<number>): boolean {
  const [interactive, setInteractive] = useState(true);
  useAnimatedReaction(
    () => isControlInteractive(opacity.value),
    (now, before) => {
      if (now !== before) scheduleOnRN(setInteractive, now);
    },
    [opacity],
  );
  return interactive;
}

/**
 * A key that changes each time a group of glass controls comes back after being fully hidden.
 * Glass material is set up once, when its view first lays out, and a view that first lays out
 * inside a group faded to nothing can be left without it for good (bare glyphs where a circle of
 * glass belongs). Keying the glass buttons by this remounts them as the group reappears, when it
 * is visible enough for the material to take. A group that only fades part of the way and
 * returns is left alone (see `controlsShown`).
 */
export function useGlassKey(opacity: SharedValue<number>): number {
  const [shown, setShown] = useState<ControlsShown>({ epoch: 0, wasHidden: false });
  const update = useCallback((zone: ControlZone) => {
    setShown((previous) => controlsShown(previous, zone));
  }, []);
  useAnimatedReaction(
    () => controlZone(opacity.value),
    (now, before) => {
      if (now !== before) scheduleOnRN(update, now);
    },
    [opacity, update],
  );
  return shown.epoch;
}
