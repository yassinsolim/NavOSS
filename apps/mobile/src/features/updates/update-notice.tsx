import { StyleSheet, View } from 'react-native';
import Animated, { FadeInUp, FadeOutUp, ReduceMotion } from 'react-native-reanimated';

import { CONTROL_MARGIN } from '@/features/map/overlay-layout';
import { createThemedStyles, elevation, motion, radius, space } from '@/theme';

import { UpdateCard } from './update-card';
import { appUpdates, useAppUpdatesState, useAutomaticUpdateChecks } from './use-app-updates';

/**
 * The non-blocking "NavOSS <version> is available" card over the map (Android only). It runs the
 * automatic check and never appears, or checks, while a trip is active.
 */
export function UpdateNotice({ top, tripActive }: { top: number; tripActive: boolean }) {
  const styles = useStyles();
  useAutomaticUpdateChecks(tripActive);
  const state = useAppUpdatesState();
  if (appUpdates === undefined || state === undefined) return null;
  if (!appUpdates.isNoticeVisible(state, tripActive)) return null;
  const { phase } = state;
  if (phase.kind === 'idle' || phase.kind === 'checking') return null;
  return (
    <Animated.View
      entering={FadeInUp.duration(motion.duration.base).reduceMotion(ReduceMotion.System)}
      exiting={FadeOutUp.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
      style={[styles.host, { top }]}
    >
      <View style={styles.body}>
        <UpdateCard phase={phase} showLater updater={appUpdates} />
      </View>
    </Animated.View>
  );
}

/** The map's top-right buttons are 48 wide; the card stops short of them so they stay usable. */
const MAP_BUTTON_ROOM = CONTROL_MARGIN * 2 + 48;

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    body: { padding: space.md },
    host: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      left: space.md,
      position: 'absolute',
      right: MAP_BUTTON_ROOM,
      ...elevation.high,
    },
  }),
);
