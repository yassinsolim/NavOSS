import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
} from 'react-native-reanimated';

import { CONTROL_MARGIN, controlsFollow, type ScreenMetrics } from '@/features/map/overlay-layout';
import type { NavigationMapOrientation } from '@/features/navigation/navigation-camera';
import { useRenderCounter } from '@/lib/render-counter';
import { createThemedStyles, motion, radius, space, typography, useTheme } from '@/theme';
import { IconButton } from '@/ui/icon-button';

export interface MapControlsProps {
  attribution: string;
  /** Height of the guidance banners at the top of the screen; the top controls sit below them. */
  bannerStackHeight: number;
  locating: boolean;
  mapBearing: SharedValue<number>;
  metrics: ScreenMetrics;
  /** `planning` covers the place sheet and route preview; `guidance` covers an active trip. */
  mode: 'arrived' | 'explore' | 'guidance' | 'planning';
  onLocate: () => void;
  onOpenAbout: () => void;
  onOpenMapPreferences: () => void;
  onOpenReport: () => void;
  onRecenter: () => void;
  onShowAttribution: () => void;
  onToggleOrientation: () => void;
  orientation: NavigationMapOrientation;
  /** Problems the driver must not miss, e.g. no basemap or no location. Joined with ` · `. */
  problems: string;
  roadEventStatus: string | undefined;
  sheetPosition: SharedValue<number>;
  showRecenter: boolean;
  /** Credit and coverage of the community traffic layer while it is on. */
  trafficStatus: { accessibilityLabel: string; text: string } | undefined;
}

/**
 * Controls that float over the map. The bottom group is positioned from the sheet's shared
 * value in an animated style, so it rides the sheet's edge during a drag with no layout pass and
 * no JavaScript; the compass needle is rotated from the camera's bearing the same way.
 */
export function MapControls({
  attribution,
  bannerStackHeight,
  locating,
  mapBearing,
  metrics,
  mode,
  onLocate,
  onOpenAbout,
  onOpenMapPreferences,
  onOpenReport,
  onRecenter,
  onShowAttribution,
  onToggleOrientation,
  orientation,
  problems,
  roadEventStatus,
  sheetPosition,
  showRecenter,
  trafficStatus,
}: MapControlsProps) {
  useRenderCounter('MapControls');
  const { colors } = useTheme();
  const styles = useStyles();
  const guidance = mode === 'guidance';
  const followLimit = Math.round(metrics.windowHeight * 0.56);
  const minimumBottom = metrics.bottomInset + CONTROL_MARGIN;

  const bottomGroupStyle = useAnimatedStyle(() => {
    const follow = controlsFollow(sheetPosition.value, followLimit);
    return { bottom: Math.max(follow.bottom, minimumBottom), opacity: follow.opacity };
  });
  const needleStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${String(-mapBearing.value)}deg` }],
  }));

  const topOffset = metrics.topInset + (guidance ? bannerStackHeight + space.md : space.sm);

  return (
    <>
      <View pointerEvents="box-none" style={[styles.topGroup, { top: topOffset }]}>
        {guidance ? (
          <IconButton
            accessibilityHint="Toggles between keeping the road ahead at the top and keeping north at the top"
            accessibilityLabel={
              orientation === 'heading-up' ? 'Switch map to north up' : 'Switch map to heading up'
            }
            icon={{ android: 'navigation', ios: 'location.north.line.fill' }}
            onPress={onToggleOrientation}
            selected={orientation === 'north-up'}
            size={48}
            variant="floating"
          >
            <Animated.View style={needleStyle}>
              <SymbolView
                name={{ android: 'navigation', ios: 'location.north.line.fill' }}
                size={22}
                tintColor={orientation === 'north-up' ? colors.onPrimary : colors.text}
              />
            </Animated.View>
          </IconButton>
        ) : (
          mode !== 'arrived' && (
            <IconButton
              accessibilityLabel="About and privacy"
              icon={{ android: 'info', ios: 'info.circle' }}
              onPress={onOpenAbout}
              size={48}
              variant="floating"
            />
          )
        )}
        <IconButton
          accessibilityLabel="Map appearance"
          icon={{ android: 'layers', ios: 'square.3.layers.3d' }}
          onPress={onOpenMapPreferences}
          size={48}
          variant="floating"
        />
      </View>

      <Animated.View pointerEvents="box-none" style={[styles.bottomGroup, bottomGroupStyle]}>
        <View pointerEvents="box-none" style={styles.credits}>
          {problems.length > 0 && (
            <View accessibilityLiveRegion="polite" style={[styles.creditPill, styles.problemPill]}>
              <SymbolView
                name={{ android: 'warning', ios: 'exclamationmark.triangle.fill' }}
                size={13}
                tintColor={colors.warningText}
              />
              <Text maxFontSizeMultiplier={1.2} style={styles.problemText}>
                {problems}
              </Text>
            </View>
          )}
          {roadEventStatus !== undefined && (
            <View style={styles.creditPill}>
              <Text maxFontSizeMultiplier={1.2} style={styles.statusText}>
                {roadEventStatus}
              </Text>
            </View>
          )}
          {trafficStatus !== undefined && (
            <View
              accessibilityLabel={trafficStatus.accessibilityLabel}
              accessible
              style={styles.creditPill}
            >
              <Text maxFontSizeMultiplier={1.2} style={styles.statusText}>
                {trafficStatus.text}
              </Text>
            </View>
          )}
          <Pressable
            accessibilityLabel="Map attribution"
            accessibilityRole="button"
            hitSlop={12}
            onPress={onShowAttribution}
            style={styles.creditPill}
          >
            <Text maxFontSizeMultiplier={1.2} numberOfLines={2} style={styles.creditText}>
              {attribution}
            </Text>
          </Pressable>
        </View>
        <View pointerEvents="box-none" style={styles.actions}>
          {!guidance && (
            <IconButton
              accessibilityHint="Opens the road report sheet for hazards, closures, and other road conditions"
              accessibilityLabel="Report a road condition"
              icon={{ android: 'report_problem', ios: 'exclamationmark.bubble.fill' }}
              onPress={onOpenReport}
              size={48}
              variant="floating"
            />
          )}
          {mode !== 'guidance' && mode !== 'arrived' && (
            <IconButton
              accessibilityLabel="Center map on my location"
              animationSpec={locating ? { effect: { type: 'pulse' } } : undefined}
              disabled={locating}
              icon={{ android: 'my_location', ios: 'location.fill' }}
              onPress={onLocate}
              size={56}
              tintColor={colors.primaryText}
              variant="floating"
            />
          )}
          {guidance && showRecenter && (
            <Animated.View
              entering={FadeIn.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
              exiting={FadeOut.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
            >
              <IconButton
                accessibilityLabel="Recenter map on vehicle"
                icon={{ android: 'my_location', ios: 'location.fill' }}
                onPress={onRecenter}
                size={56}
                variant="primary"
              />
            </Animated.View>
          )}
        </View>
      </Animated.View>
    </>
  );
}

const useStyles = createThemedStyles(({ colors, scheme }) =>
  StyleSheet.create({
    actions: { alignItems: 'flex-end', gap: space.md - 2 },
    bottomGroup: {
      alignItems: 'flex-end',
      flexDirection: 'row',
      justifyContent: 'space-between',
      left: CONTROL_MARGIN,
      position: 'absolute',
      right: CONTROL_MARGIN,
    },
    creditPill: {
      alignSelf: 'flex-start',
      backgroundColor: scheme === 'dark' ? 'rgba(21,31,32,0.86)' : 'rgba(255,255,255,0.88)',
      borderRadius: radius.sm,
      paddingHorizontal: space.sm,
      paddingVertical: 3,
    },
    creditText: {
      ...typography.caption,
      color: colors.textSecondary,
      fontSize: 10,
      lineHeight: 13,
    },
    problemPill: {
      alignItems: 'center',
      backgroundColor: colors.warningSoft,
      flexDirection: 'row',
      gap: space.xs,
      paddingVertical: space.xs,
    },
    problemText: { ...typography.footnoteStrong, color: colors.warningText },
    credits: { flex: 1, gap: space.xs, paddingRight: space.md },
    statusText: { ...typography.caption, color: colors.text, fontSize: 10, lineHeight: 13 },
    topGroup: { gap: space.md - 2, position: 'absolute', right: CONTROL_MARGIN },
  }),
);
