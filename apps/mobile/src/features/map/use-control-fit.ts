import { useState } from 'react';
import { type SharedValue, useAnimatedReaction } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

/**
 * Whether a control whose opacity is animated on the UI thread is still visible at all. A
 * control faded to nothing must also leave touch and VoiceOver focus, or the driver can press a
 * button they cannot see. Re-renders only when visibility flips, never per frame.
 */
export function useControlVisible(opacity: SharedValue<number>): boolean {
  const [visible, setVisible] = useState(true);
  useAnimatedReaction(
    () => opacity.value > 0,
    (now, before) => {
      if (now !== before) scheduleOnRN(setVisible, now);
    },
    [opacity],
  );
  return visible;
}
