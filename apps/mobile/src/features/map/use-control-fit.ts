import { useState } from 'react';
import { type SharedValue, useAnimatedReaction } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { isControlInteractive } from '@/features/map/overlay-layout';

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
