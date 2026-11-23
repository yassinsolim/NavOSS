import { type ReactNode, useState } from 'react';
import {
  Pressable,
  type PressableProps,
  type StyleProp,
  type View,
  type ViewStyle,
} from 'react-native';
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { IS_ANDROID } from '@/lib/device-copy';
import { motion, useTheme } from '@/theme';
import { useKeyFocus, useRingVisible } from '@/ui/key-focus';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface PressableScaleProps extends Omit<PressableProps, 'children' | 'style'> {
  children?: ReactNode;
  /** Android: takes keyboard focus for this key while the driver uses keys (`useKeyFocus`). */
  focusKey?: string;
  /** Scale while pressed. Large surfaces want a smaller change than small controls. */
  pressedScale?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * The ring a pressable draws while it holds keyboard focus, on Android only: handhelds and
 * TV-style devices move between controls with a D-pad, and without a ring nothing shows which
 * control the centre button would press. Touch never focuses a pressable, so touch users never
 * see it; on iOS the handlers do nothing. A control under an open modal sheet keeps Android's
 * focus in its own window, so it draws no ring until the sheet closes (`useRingVisible`).
 */
export function useFocusRing(): {
  onBlur: () => void;
  onFocus: () => void;
  style: ViewStyle | undefined;
} {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  const ringVisible = useRingVisible(focused);
  return {
    onBlur: () => {
      if (IS_ANDROID) setFocused(false);
    },
    onFocus: () => {
      if (IS_ANDROID) setFocused(true);
    },
    style: ringVisible
      ? { outlineColor: colors.primary, outlineOffset: 2, outlineStyle: 'solid', outlineWidth: 3 }
      : undefined,
  };
}

/**
 * The one press affordance every control shares: a quick spring to a slightly smaller, dimmer
 * state, driven on the UI thread so it answers a touch even while JS is busy with the map.
 * Draws the focus ring (`useFocusRing`) while it holds keyboard focus.
 */
export function PressableScale({
  children,
  disabled,
  focusKey,
  onBlur,
  onFocus,
  onPressIn,
  onPressOut,
  pressedScale = 0.96,
  style,
  ...rest
}: PressableScaleProps) {
  const focusRing = useFocusRing();
  const focusRef = useKeyFocus<View>(focusKey);
  const pressed = useSharedValue(0);
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: 1 - pressed.value * 0.18,
    transform: [{ scale: 1 - pressed.value * (1 - pressedScale) }],
  }));

  return (
    <AnimatedPressable
      {...rest}
      disabled={disabled}
      ref={focusRef}
      onBlur={(event) => {
        focusRing.onBlur();
        onBlur?.(event);
      }}
      onFocus={(event) => {
        focusRing.onFocus();
        onFocus?.(event);
      }}
      onPressIn={(event) => {
        pressed.value = withSpring(1, {
          ...motion.spring.press,
          reduceMotion: ReduceMotion.System,
        });
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        pressed.value = withSpring(0, {
          ...motion.spring.press,
          reduceMotion: ReduceMotion.System,
        });
        onPressOut?.(event);
      }}
      style={[style, focusRing.style, animatedStyle]}
    >
      {children}
    </AnimatedPressable>
  );
}

/**
 * React Native's `Pressable` with the focus ring (`useFocusRing`), for controls that do not scale
 * on press (segments, tabs, switch rows). On iOS it is a plain `Pressable`.
 */
export function FocusRingPressable({
  focusKey,
  onBlur,
  onFocus,
  style,
  ...rest
}: PressableProps & { focusKey?: string }) {
  const focusRing = useFocusRing();
  const focusRef = useKeyFocus<View>(focusKey);
  return (
    <Pressable
      {...rest}
      ref={focusRef}
      onBlur={(event) => {
        focusRing.onBlur();
        onBlur?.(event);
      }}
      onFocus={(event) => {
        focusRing.onFocus();
        onFocus?.(event);
      }}
      style={(state) => [typeof style === 'function' ? style(state) : style, focusRing.style]}
    />
  );
}
