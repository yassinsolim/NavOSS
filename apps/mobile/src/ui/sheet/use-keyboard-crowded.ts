import { useEffect, useState } from 'react';
import { Keyboard, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IS_ANDROID } from '@/lib/device-copy';
import { CLOSED_KEYBOARD, keyboardSession } from '@/ui/sheet/keyboard-space';

/** Whether the open keyboard crowds a search sheet; holds while it stays open in the same window. */
export function useKeyboardCrowded(): boolean {
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [session, setSession] = useState(CLOSED_KEYBOARD);

  useEffect(() => {
    if (!IS_ANDROID) return undefined;
    const show = Keyboard.addListener('keyboardDidShow', (event) => {
      setKeyboardHeight(event.endCoordinates.height);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardHeight(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const next = keyboardSession(session, {
    android: IS_ANDROID,
    keyboardHeight,
    topInset: insets.top,
    windowHeight,
    windowWidth,
  });
  if (next !== session) setSession(next);
  return next.crowded;
}
