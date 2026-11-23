import { useEffect, useState } from 'react';
import { Keyboard, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IS_ANDROID } from '@/lib/device-copy';
import { isKeyboardCrowded } from '@/ui/sheet/keyboard-space';

/** `isKeyboardCrowded` for the current window and keyboard. */
export function useKeyboardCrowded(): boolean {
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [keyboardHeight, setKeyboardHeight] = useState(0);

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

  return isKeyboardCrowded({
    android: IS_ANDROID,
    keyboardHeight,
    topInset: insets.top,
    windowHeight,
  });
}
