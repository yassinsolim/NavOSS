import { Pressable, StyleSheet, Text } from 'react-native';
import Animated, { FadeInUp, FadeOutUp, ReduceMotion } from 'react-native-reanimated';

import type { MapNotice } from '@/features/map/controller/use-map-controller';
import { createThemedStyles, elevation, motion, radius, space, typography } from '@/theme';
import { Banner } from '@/ui/banner';
import { FocusRingPressable } from '@/ui/pressable-scale';

/**
 * A confirmation or failure that appears over the map and leaves on its own. It replaces system
 * alerts for outcomes that need no decision, so a driver is never made to tap "OK". A notice that
 * must not be missed (`untilDismissed`) stays, with a Dismiss button, until it is dismissed.
 */
export function MapNoticeToast({
  notice,
  onDismiss,
  top,
}: {
  notice: MapNotice | undefined;
  onDismiss: () => void;
  /** Distance from the top of the screen: below the status bar, or below the maneuver banner. */
  top: number;
}) {
  const styles = useStyles();
  if (notice === undefined) return null;
  return (
    <Animated.View
      entering={FadeInUp.duration(motion.duration.base).reduceMotion(ReduceMotion.System)}
      exiting={FadeOutUp.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
      key={notice.id}
      style={[styles.host, { top }]}
    >
      {/* Not one accessible element: the title and message are read, and matched, separately. */}
      <Pressable accessible={false} onPress={onDismiss}>
        <Banner
          action={
            notice.untilDismissed === true ? (
              <FocusRingPressable
                accessibilityLabel="Dismiss"
                accessibilityRole="button"
                hitSlop={12}
                onPress={onDismiss}
              >
                <Text style={styles.action}>Dismiss</Text>
              </FocusRingPressable>
            ) : undefined
          }
          announce
          message={notice.message}
          style={styles.banner}
          title={notice.title}
          tone={notice.tone}
        />
      </Pressable>
    </Animated.View>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    action: { ...typography.label, color: colors.primaryText },
    banner: { borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth },
    host: {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      left: space.md,
      position: 'absolute',
      right: space.md,
      ...elevation.high,
    },
  }),
);
