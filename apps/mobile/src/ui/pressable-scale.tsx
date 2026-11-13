import type { ReactNode } from 'react';
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { motion } from '@/theme';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface PressableScaleProps extends Omit<PressableProps, 'children' | 'style'> {
  children?: ReactNode;
  /** Scale while pressed. Large surfaces want a smaller change than small controls. */
  pressedScale?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * The one press affordance every control shares: a quick spring to a slightly smaller, dimmer
 * state, driven on the UI thread so it answers a touch even while JS is busy with the map.
 */
export function PressableScale({
  children,
  disabled,
  onPressIn,
  onPressOut,
  pressedScale = 0.96,
  style,
  ...rest
}: PressableScaleProps) {
  const pressed = useSharedValue(0);
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: 1 - pressed.value * 0.18,
    transform: [{ scale: 1 - pressed.value * (1 - pressedScale) }],
  }));

  return (
    <AnimatedPressable
      {...rest}
      disabled={disabled}
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
      style={[style, animatedStyle]}
    >
      {children}
    </AnimatedPressable>
  );
}
