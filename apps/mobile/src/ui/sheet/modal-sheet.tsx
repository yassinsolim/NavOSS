import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';

import { createThemedStyles } from '@/theme';
import { BottomSheet, type BottomSheetRef, type SheetDetent } from '@/ui/sheet/bottom-sheet';

export interface ModalSheetProps {
  accessibilityLabel?: string;
  children: ReactNode;
  detents: readonly SheetDetent[];
  initialDetent?: number;
  keyboardAware?: boolean;
  onClose: () => void;
  visible: boolean;
}

/**
 * A sheet that takes over the screen: scrim, swipe-down or scrim-tap to dismiss, and a system
 * modal underneath so VoiceOver and hardware back treat it as one. The scrim's opacity is derived
 * from the sheet's position, so it tracks a drag instead of running its own animation.
 */
export function ModalSheet({
  accessibilityLabel,
  children,
  detents,
  initialDetent,
  keyboardAware,
  onClose,
  visible,
}: ModalSheetProps) {
  const styles = useStyles();
  const [rendered, setRendered] = useState(visible);
  const sheetRef = useRef<BottomSheetRef>(null);
  const position = useSharedValue(0);
  if (visible && !rendered) setRendered(true);

  useEffect(() => {
    if (!visible && rendered) sheetRef.current?.close();
  }, [rendered, visible]);

  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(position.value, [0, 220], [0, 1], Extrapolation.CLAMP),
  }));

  return (
    <Modal
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
      transparent
      visible={rendered}
    >
      <GestureHandlerRootView style={styles.root}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, scrimStyle]}>
          <Pressable
            accessibilityElementsHidden
            importantForAccessibility="no"
            onPress={onClose}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
        <BottomSheet
          accessibilityLabel={accessibilityLabel}
          detents={detents}
          initialDetent={initialDetent}
          keyboardAware={keyboardAware}
          onDismiss={() => {
            setRendered(false);
            if (visible) onClose();
          }}
          position={position}
          ref={sheetRef}
        >
          {children}
        </BottomSheet>
      </GestureHandlerRootView>
    </Modal>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    root: { flex: 1 },
    scrim: { backgroundColor: colors.scrim },
  }),
);
