import { useEffect, useState } from 'react';
import { Keyboard, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IS_ANDROID } from '@/lib/device-copy';
import { CLOSED_KEYBOARD, isKeyboardCrowded, keyboardSession } from '@/ui/sheet/keyboard-space';

/** `isKeyboardCrowded` for the current window and keyboard, with that window's stable top inset. */
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
    height: keyboardHeight,
    topInset: insets.top,
    windowHeight,
    windowWidth,
  });
  if (next !== session) setSession(next);

  return isKeyboardCrowded({
    android: IS_ANDROID,
    keyboardHeight: next.height,
    topInset: next.topInset,
    windowHeight,
  });
}
