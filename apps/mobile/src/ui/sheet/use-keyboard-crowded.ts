import { useEffect, useRef, useState } from 'react';
import { Keyboard, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IS_ANDROID } from '@/lib/device-copy';
import { CLOSED_KEYBOARD, isKeyboardCrowded, keyboardShown } from '@/ui/sheet/keyboard-space';

/** `isKeyboardCrowded` for the current window and keyboard, with the inset it opened with. */
export function useKeyboardCrowded(): boolean {
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const topInsetRef = useRef(insets.top);
  topInsetRef.current = insets.top;
  const [keyboard, setKeyboard] = useState(CLOSED_KEYBOARD);

  useEffect(() => {
    if (!IS_ANDROID) return undefined;
    const show = Keyboard.addListener('keyboardDidShow', (event) => {
      setKeyboard((previous) =>
        keyboardShown(previous, event.endCoordinates.height, topInsetRef.current),
      );
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboard(CLOSED_KEYBOARD);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return isKeyboardCrowded({
    android: IS_ANDROID,
    keyboardHeight: keyboard.height,
    topInset: keyboard.topInset,
    windowHeight,
  });
}
