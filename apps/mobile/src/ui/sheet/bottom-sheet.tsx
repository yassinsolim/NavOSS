import {
  createContext,
  type ReactNode,
  type Ref,
  use,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Keyboard,
  Platform,
  type ScrollViewProps,
  type StyleProp,
  StyleSheet,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector, type NativeGesture } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  Extrapolation,
  FadeOut,
  interpolate,
  ReduceMotion,
  type SharedValue,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { createThemedStyles, elevation, motion, radius, space } from '@/theme';
import { haptics } from '@/theme/haptics';
import {
  detentAfterRelease,
  draggedSheetHeight,
  resolveSheetDetents,
  type SheetDetent,
} from '@/ui/sheet/sheet-detents';

export type { SheetDetent };

export interface BottomSheetRef {
  /** Animates the sheet away, then calls `onDismiss`. */
  close: () => void;
  snapTo: (index: number) => void;
}

export interface BottomSheetProps {
  accessibilityLabel?: string;
  /** Lifts the sheet above persistent chrome such as the tab bar. */
  bottomOffset?: number;
  children: ReactNode;
  /**
   * Resting heights in points, or `'content'` for the measured height of the children. Sheets
   * with several detents lay their children out at the tallest one and reveal them by sliding.
   */
  detents: readonly SheetDetent[];
  initialDetent?: number;
  /** Open to the tallest detent and pad the body while the keyboard is up. */
  keyboardAware?: boolean;
  onDetentChange?: (index: number) => void;
  /** Makes the sheet dismissible by dragging it down. Called once it has left the screen. */
  onDismiss?: () => void;
  /**
   * Receives the distance from the bottom of the screen to the top edge of the sheet, on the UI
   * thread, every frame. Floating map controls read it to stay clear of the sheet.
   */
  position?: SharedValue<number>;
  ref?: Ref<BottomSheetRef>;
  /**
   * Skip the entrance animation when no other sheet was on screen. For the sheet that is there
   * at launch: its controls must not move under a finger that is already on its way.
   */
  restsImmediately?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

interface SheetContextValue {
  hasScroll: SharedValue<boolean>;
  height: SharedValue<number>;
  maxHeight: SharedValue<number>;
  nativeGesture: NativeGesture;
  scrollY: SharedValue<number>;
}

const SheetContext = createContext<SheetContextValue | null>(null);

const SPRING = { ...motion.spring.sheet, reduceMotion: ReduceMotion.System } as const;

/**
 * A bottom sheet whose position lives in one shared value. Dragging, flinging, settling, the
 * keyboard inset and everything that follows the sheet run on the UI thread; React only hears
 * about it when the resting detent changes.
 */
export function BottomSheet({
  accessibilityLabel,
  bottomOffset = 0,
  children,
  detents,
  initialDetent = 0,
  keyboardAware = false,
  onDetentChange,
  onDismiss,
  position,
  ref,
  restsImmediately = false,
  style,
  testID,
}: BottomSheetProps) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { fontScale, height: windowHeight } = useWindowDimensions();
  const [contentHeight, setContentHeight] = useState(0);
  const sizedByContent = detents.includes('content');
  const available = windowHeight - insets.top - space.sm - bottomOffset;
  const detentKey = detents.join('|');
  const resolved = useMemo(
    () => resolveSheetDetents(detents, contentHeight, available),
    // Dependencies: `detentKey` is the array's value.
    [available, contentHeight, detentKey],
  );
  const tallest = resolved.at(-1) ?? 0;
  const [detentIndex, setDetentIndex] = useState(initialDetent);

  const height = useSharedValue(0);
  const maxHeight = useSharedValue(0);
  const detentHeights = useSharedValue<number[]>([]);
  const restingHeight = useSharedValue(0);
  const dragStartHeight = useSharedValue(0);
  const dragRebase = useSharedValue(0);
  const scrollY = useSharedValue(0);
  const hasScroll = useSharedValue(false);
  const keyboardInset = useSharedValue(0);
  const closing = useSharedValue(false);
  const hasRestedRef = useRef(false);
  const dismissible = onDismiss !== undefined;

  const settled = (index: number) => {
    setDetentIndex((current) => {
      if (current !== index) haptics.impact();
      return index;
    });
  };
  const dismissed = () => {
    onDismiss?.();
  };

  // Adopt the height the previous sheet published so swapping sheets reads as one surface
  // changing size, and floating controls never dip to the bottom edge in between.
  useEffect(() => {
    if (position !== undefined) {
      height.value = Math.max(0, position.value - bottomOffset);
    }
    return () => {
      if (position !== undefined) position.value = withSpring(0, SPRING);
    };
    // Dependencies: mount and unmount only.
  }, []);

  // The resting detent is React state: gestures, the keyboard, `snapTo` and accessibility
  // actions all set it, and this effect is the one place the sheet is sent there.
  useEffect(() => {
    const target = resolved[Math.min(detentIndex, resolved.length - 1)] ?? 0;
    detentHeights.value = resolved;
    maxHeight.value = tallest;
    restingHeight.value = target;
    if (closing.value || tallest <= 0) return;
    if (restsImmediately && !hasRestedRef.current && height.value === 0) {
      // Nothing to morph from: appear in place, so a control inside is where it will stay.
      hasRestedRef.current = true;
      height.value = target;
      return;
    }
    hasRestedRef.current = true;
    height.value = withSpring(target, SPRING);
  }, [
    closing,
    detentHeights,
    detentIndex,
    height,
    maxHeight,
    resolved,
    restingHeight,
    restsImmediately,
    tallest,
  ]);

  const reportedIndex = Math.min(detentIndex, Math.max(0, resolved.length - 1));
  const reportDetent = useEffectEvent((index: number) => {
    onDetentChange?.(index);
  });
  useEffect(() => {
    reportDetent(reportedIndex);
  }, [reportedIndex]);

  useEffect(() => {
    if (!keyboardAware) return undefined;
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, (event) => {
      keyboardInset.value = withTiming(Math.max(0, event.endCoordinates.height - bottomOffset), {
        duration: event.duration > 0 ? event.duration : motion.duration.base,
        reduceMotion: ReduceMotion.System,
      });
      setDetentIndex(Number.MAX_SAFE_INTEGER);
    });
    const hide = Keyboard.addListener(hideEvent, (event) => {
      keyboardInset.value = withTiming(0, {
        duration: event.duration > 0 ? event.duration : motion.duration.base,
        reduceMotion: ReduceMotion.System,
      });
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [bottomOffset, keyboardAware, keyboardInset]);

  useImperativeHandle(ref, () => ({
    close: () => {
      closing.value = true;
      height.value = withSpring(0, SPRING, (finished) => {
        if (finished === true) scheduleOnRN(dismissed);
      });
    },
    snapTo: (index: number) => {
      setDetentIndex(Math.max(0, index));
    },
  }));

  useAnimatedReaction(
    () => height.value,
    (current) => {
      if (position !== undefined) position.value = Math.max(0, current) + bottomOffset;
    },
  );

  const nativeGesture = useMemo(() => Gesture.Native(), []);
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY([-6, 6])
        .failOffsetX([-18, 18])
        .simultaneousWithExternalGesture(nativeGesture)
        .onBegin(() => {
          // Catch the sheet mid-flight: a touch always wins over a running settle.
          cancelAnimation(height);
        })
        .onStart(() => {
          dragStartHeight.value = height.value;
          dragRebase.value = 0;
        })
        .onChange((event) => {
          const max = maxHeight.value;
          if (hasScroll.value && height.value >= max - 0.5 && scrollY.value > 0.5) {
            // The list is scrolled, so the finger belongs to the list. Rebase so the sheet picks
            // the drag up from exactly where the list reaches its top.
            dragRebase.value = event.translationY;
            dragStartHeight.value = max;
            return;
          }
          height.value = draggedSheetHeight({
            dismissible,
            max,
            min: detentHeights.value[0] ?? 0,
            raw: dragStartHeight.value - (event.translationY - dragRebase.value),
            stiffTop: hasScroll.value,
          });
        })
        .onEnd((event) => {
          const max = maxHeight.value;
          if (hasScroll.value && height.value >= max - 0.5 && scrollY.value > 0.5) return;
          const release = detentAfterRelease({
            detents: detentHeights.value,
            dismissible,
            height: height.value,
            velocityY: event.velocityY,
          });
          if (release.dismiss) {
            closing.value = true;
            height.value = withSpring(0, { ...SPRING, velocity: -event.velocityY }, (finished) => {
              if (finished === true) scheduleOnRN(dismissed);
            });
            return;
          }
          const target = detentHeights.value[release.index] ?? max;
          restingHeight.value = target;
          height.value = withSpring(target, { ...SPRING, velocity: -event.velocityY });
          scheduleOnRN(settled, release.index);
        })
        .onFinalize((_event, success) => {
          if (success || closing.value) return;
          // A touch that never became a drag still cancelled the settle in `onBegin`; resume it
          // towards wherever the sheet was headed.
          height.value = withSpring(restingHeight.value, SPRING);
        }),
    // Dependencies: shared values are stable.
    [dismissible, nativeGesture],
  );

  const sheetStyle = useAnimatedStyle(() => ({
    opacity: maxHeight.value > 0 ? 1 : 0,
    transform: [{ translateY: maxHeight.value - height.value }],
  }));
  const bodyStyle = useAnimatedStyle(() => ({ paddingBottom: keyboardInset.value }));
  const context = useMemo<SheetContextValue>(
    () => ({ hasScroll, height, maxHeight, nativeGesture, scrollY }),
    [hasScroll, height, maxHeight, nativeGesture, scrollY],
  );
  const lastIndex = resolved.length - 1;
  const currentIndex = Math.min(detentIndex, lastIndex);

  return (
    <Animated.View
      exiting={FadeOut.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
      pointerEvents="box-none"
      style={[styles.host, { bottom: bottomOffset }]}
    >
      <GestureDetector gesture={pan}>
        <Animated.View
          accessibilityLabel={accessibilityLabel}
          accessibilityViewIsModal={dismissible}
          style={[
            styles.sheet,
            sizedByContent ? undefined : { height: tallest },
            sheetStyle,
            style,
          ]}
          testID={testID}
        >
          <View style={styles.underlay} />
          <View
            accessibilityActions={
              lastIndex > 0 ? [{ name: 'increment' }, { name: 'decrement' }] : undefined
            }
            accessibilityLabel={lastIndex > 0 ? 'Resize sheet' : undefined}
            accessibilityRole={lastIndex > 0 ? 'adjustable' : undefined}
            accessibilityValue={
              lastIndex > 0
                ? { text: `${String(currentIndex + 1)} of ${String(lastIndex + 1)}` }
                : undefined
            }
            accessible={lastIndex > 0}
            onAccessibilityAction={(event) => {
              const step = event.nativeEvent.actionName === 'increment' ? 1 : -1;
              setDetentIndex(Math.max(0, Math.min(lastIndex, currentIndex + step)));
            }}
            style={styles.grabberArea}
          >
            <View style={styles.grabber} />
          </View>
          <SheetContext value={context}>
            {/* Re-measured when Dynamic Type changes while the sheet is open: text drawn at the
                new size in boxes measured at the old one is clipped (see AppTabBar). */}
            <Animated.View
              key={String(fontScale)}
              onLayout={
                sizedByContent
                  ? (event) => {
                      setContentHeight(
                        Math.ceil(event.nativeEvent.layout.height) + GRABBER_AREA_HEIGHT,
                      );
                    }
                  : undefined
              }
              style={[sizedByContent ? undefined : styles.body, bodyStyle]}
            >
              {children}
            </Animated.View>
          </SheetContext>
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
}

export const GRABBER_AREA_HEIGHT = 20;

/**
 * The scrolling region of a sheet. It scrolls only while the sheet rests at its tallest detent;
 * below that, the same drag moves the sheet, and at the top of the list a downward drag hands
 * over to the sheet without lifting the finger.
 */
export function BottomSheetScrollView({ children, ...props }: ScrollViewProps) {
  const sheet = use(SheetContext);
  if (sheet === null) throw new Error('BottomSheetScrollView must be inside a BottomSheet.');
  const { hasScroll, height, maxHeight, nativeGesture, scrollY } = sheet;
  const scrollRef = useAnimatedRef<Animated.ScrollView>();

  useEffect(() => {
    hasScroll.value = true;
    return () => {
      hasScroll.value = false;
      scrollY.value = 0;
    };
  }, [hasScroll, scrollY]);

  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });
  const animatedProps = useAnimatedProps(() => ({
    scrollEnabled: height.value >= maxHeight.value - 0.5,
  }));

  return (
    <GestureDetector gesture={nativeGesture}>
      <Animated.ScrollView
        bounces={false}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        {...props}
        animatedProps={animatedProps}
        onScroll={onScroll}
        ref={scrollRef}
        scrollEventThrottle={16}
      >
        {children}
      </Animated.ScrollView>
    </GestureDetector>
  );
}

/**
 * Content that belongs to a taller detent. It fades in as the sheet rises past `above`, so a
 * sheet at rest never shows a clipped half-row of what lies beyond its edge.
 */
export function BottomSheetReveal({
  above,
  children,
  style,
}: {
  /** Sheet height in points at which this content starts to appear. */
  above: number;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const sheet = use(SheetContext);
  if (sheet === null) throw new Error('BottomSheetReveal must be inside a BottomSheet.');
  const { height } = sheet;
  const revealStyle = useAnimatedStyle(() => ({
    opacity: interpolate(height.value, [above, above + 56], [0, 1], Extrapolation.CLAMP),
  }));
  return <Animated.View style={[style, revealStyle]}>{children}</Animated.View>;
}

const useStyles = createThemedStyles(({ colors, scheme }) =>
  StyleSheet.create({
    body: { flex: 1 },
    grabber: {
      backgroundColor: colors.borderStrong,
      borderRadius: radius.pill,
      height: 5,
      width: 38,
    },
    grabberArea: {
      alignItems: 'center',
      height: GRABBER_AREA_HEIGHT,
      justifyContent: 'center',
    },
    host: { left: 0, position: 'absolute', right: 0 },
    sheet: {
      backgroundColor: colors.surface,
      borderColor: scheme === 'dark' ? colors.border : 'transparent',
      borderCurve: 'continuous',
      borderTopLeftRadius: radius.sheet,
      borderTopRightRadius: radius.sheet,
      borderTopWidth: StyleSheet.hairlineWidth,
      ...elevation.high,
      shadowOffset: { height: -4, width: 0 },
    },
    // Keeps the surface solid when the sheet is rubber-banded above its tallest detent.
    underlay: {
      backgroundColor: colors.surface,
      bottom: -600,
      height: 600,
      left: 0,
      position: 'absolute',
      right: 0,
    },
  }),
);
