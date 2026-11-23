import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Platform, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  ReduceMotion,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import {
  CONTROL_MARGIN,
  controlsFollow,
  controlsFollowLimit,
  fitOpacity,
  ridingControlsRoom,
  type ScreenMetrics,
  topControlsRoom,
} from '@/features/map/overlay-layout';
import { mapChromeColors, mapChromeScheme } from '@/features/map/map-chrome';
import { useControlInteractive, useGlassKey } from '@/features/map/use-control-fit';
import type { NavigationMapOrientation } from '@/features/navigation/navigation-camera';
import { useRenderCounter } from '@/lib/render-counter';
import { createSchemeStyles, motion, radius, space, typography } from '@/theme';
import { readoutFocusProps } from '@/ui/focus';
import { IconButton } from '@/ui/icon-button';
import { FocusRingPressable } from '@/ui/pressable-scale';

export interface MapControlsProps {
  attribution: string;
  /** Height of the guidance banners at the top of the screen; the top controls sit below them. */
  bannerStackHeight: number;
  /**
   * Whether the basemap behind the controls is dark. The controls take their glass and glyph
   * colours from the map they sit on, not from the system appearance.
   */
  darkMap: boolean;
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
  /**
   * Android: turns a rotated map back to north. The compass is a button in the top column there,
   * so it never sits on another map control; iOS keeps MapLibre's own compass.
   */
  onResetBearing?: () => void;
  onShowAttribution: () => void;
  /** Opens the road-events list from the road-events status line. */
  onOpenRoadEvents: () => void;
  onToggleOrientation: () => void;
  orientation: NavigationMapOrientation;
  /** Problems the driver must not miss, e.g. no basemap or no location. Joined with ` · `. */
  problems: string;
  roadEventStatus: string | undefined;
  sheetPosition: SharedValue<number>;
  showRecenter: boolean;
  /** Credit and coverage of the community traffic layer while it is on. */
  trafficStatus: { accessibilityLabel: string; text: string } | undefined;
  /** Reports the height of the map-credit labels, so guidance readouts can sit above them. */
  onCreditsHeightChange?: (height: number) => void;
}

/**
 * Controls that float over the map. The bottom group is positioned from the sheet's shared
 * value in an animated style, so it rides the sheet's edge during a drag with no layout pass and
 * no JavaScript; the compass needle is rotated from the camera's bearing the same way.
 */
export function MapControls({
  attribution,
  bannerStackHeight,
  darkMap,
  locating,
  mapBearing,
  metrics,
  mode,
  onLocate,
  onCreditsHeightChange,
  onOpenAbout,
  onOpenMapPreferences,
  onOpenReport,
  onRecenter,
  onResetBearing,
  onShowAttribution,
  onOpenRoadEvents,
  onToggleOrientation,
  orientation,
  problems,
  roadEventStatus,
  sheetPosition,
  showRecenter,
  trafficStatus,
}: MapControlsProps) {
  useRenderCounter('MapControls');
  const colors = mapChromeColors(darkMap);
  const scheme = mapChromeScheme(darkMap);
  const styles = stylesFor(scheme);
  const { fontScale } = useWindowDimensions();
  const guidance = mode === 'guidance';
  const { windowHeight } = metrics;
  const followLimit = controlsFollowLimit(windowHeight);
  const minimumBottom = metrics.bottomInset + CONTROL_MARGIN;
  const topOffset = metrics.topInset + (guidance ? bannerStackHeight + space.md : space.sm);
  // Where the guidance banners end; controls that ride the sheet must stay clear of it.
  const bannerBottom = metrics.topInset + bannerStackHeight;
  // Measured, not assumed: both groups grow with their buttons and credit labels.
  const topGroupHeight = useSharedValue(0);
  const bottomGroupHeight = useSharedValue(0);

  // The top controls hang under the banners. With the trip sheet raised there is no room left
  // between banner and sheet, so they fade out instead of sliding under the sheet.
  const topOpacity = useDerivedValue(() =>
    guidance
      ? fitOpacity(
          topControlsRoom({
            controlsBottom: topOffset + topGroupHeight.value,
            sheetHeight: sheetPosition.value,
            windowHeight,
          }),
        )
      : 1,
  );
  // The bottom group rides the sheet's edge (see `controlsFollow`); during guidance it also
  // fades before it would reach the banners.
  const bottomPlacement = useDerivedValue(() => {
    const follow = controlsFollow(sheetPosition.value, followLimit);
    const bottom = Math.max(follow.bottom, minimumBottom);
    const room = guidance
      ? ridingControlsRoom({ bannerBottom, bottom, height: bottomGroupHeight.value, windowHeight })
      : Number.POSITIVE_INFINITY;
    return { bottom, opacity: Math.min(follow.opacity, fitOpacity(room)) };
  });
  const bottomOpacity = useDerivedValue(() => bottomPlacement.value.opacity);
  const topInteractive = useControlInteractive(topOpacity);
  const bottomInteractive = useControlInteractive(bottomOpacity);
  // Glass buttons mounted while their group is fully hidden can be left without material for
  // good; they are remounted as the group comes back (see `useGlassKey`).
  const topGlassKey = useGlassKey(topOpacity);
  const bottomGlassKey = useGlassKey(bottomOpacity);

  const topGroupStyle = useAnimatedStyle(() => ({ opacity: topOpacity.value }));
  const bottomGroupStyle = useAnimatedStyle(() => ({
    bottom: bottomPlacement.value.bottom,
    opacity: bottomPlacement.value.opacity,
  }));
  const needleStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${String(-mapBearing.value)}deg` }],
  }));
  // Shown while the map is turned away from north (beyond half a degree), outside guidance,
  // whose orientation button already carries a needle.
  const [rotated, setRotated] = useState(false);
  useAnimatedReaction(
    () => Math.abs((((mapBearing.value % 360) + 360) % 360) - 180) < 179.5,
    (next, previous) => {
      if (next !== previous) scheduleOnRN(setRotated, next);
    },
  );
  const showCompass = onResetBearing !== undefined && rotated && !guidance;

  return (
    <>
      <Animated.View
        accessibilityElementsHidden={!topInteractive}
        importantForAccessibility={topInteractive ? 'auto' : 'no-hide-descendants'}
        onLayout={(event) => {
          topGroupHeight.value = event.nativeEvent.layout.height;
        }}
        pointerEvents={topInteractive ? 'box-none' : 'none'}
        style={[styles.topGroup, { top: topOffset }, topGroupStyle]}
      >
        {guidance ? (
          <IconButton
            key={`top-${String(topGlassKey)}-1`}
            accessibilityHint="Toggles between keeping the road ahead at the top and keeping north at the top"
            accessibilityLabel={
              orientation === 'heading-up' ? 'Switch map to north up' : 'Switch map to heading up'
            }
            icon={{ android: 'navigation', ios: 'location.north.line.fill' }}
            onPress={onToggleOrientation}
            selected={orientation === 'north-up'}
            scheme={scheme}
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
              key={`top-${String(topGlassKey)}-2`}
              accessibilityLabel="About and privacy"
              icon={{ android: 'info', ios: 'info.circle' }}
              onPress={onOpenAbout}
              scheme={scheme}
              size={48}
              variant="floating"
            />
          )
        )}
        <IconButton
          key={`top-${String(topGlassKey)}-3`}
          accessibilityLabel="Map appearance"
          icon={{ android: 'layers', ios: 'square.3.layers.3d' }}
          onPress={onOpenMapPreferences}
          scheme={scheme}
          size={48}
          variant="floating"
        />
        {showCompass && (
          <IconButton
            key={`top-${String(topGlassKey)}-4`}
            accessibilityLabel="Map compass. Turns the map back to north."
            icon={{ android: 'navigation', ios: 'location.north.line.fill' }}
            onPress={onResetBearing}
            scheme={scheme}
            size={48}
            variant="floating"
          >
            <Animated.View style={needleStyle}>
              <SymbolView
                name={{ android: 'navigation', ios: 'location.north.line.fill' }}
                size={22}
                tintColor={colors.danger}
              />
            </Animated.View>
          </IconButton>
        )}
      </Animated.View>

      <Animated.View
        accessibilityElementsHidden={!bottomInteractive}
        importantForAccessibility={bottomInteractive ? 'auto' : 'no-hide-descendants'}
        onLayout={(event) => {
          bottomGroupHeight.value = event.nativeEvent.layout.height;
        }}
        pointerEvents={bottomInteractive ? 'box-none' : 'none'}
        style={[styles.bottomGroup, bottomGroupStyle]}
      >
        <View
          // Re-measure the credit labels when Dynamic Type changes while the app is open.
          key={String(fontScale)}
          onLayout={(event) => {
            onCreditsHeightChange?.(Math.ceil(event.nativeEvent.layout.height));
          }}
          pointerEvents="box-none"
          style={styles.credits}
        >
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
            <FocusRingPressable
              accessibilityHint="Opens the list of road events, newest first"
              accessibilityLabel={roadEventStatus}
              accessibilityRole="button"
              hitSlop={12}
              onPress={onOpenRoadEvents}
              style={styles.creditPill}
            >
              <Text maxFontSizeMultiplier={1.2} style={styles.statusText}>
                {roadEventStatus}
              </Text>
            </FocusRingPressable>
          )}
          {trafficStatus !== undefined && (
            <View
              accessibilityLabel={trafficStatus.accessibilityLabel}
              accessible
              {...readoutFocusProps(Platform.OS)}
              style={styles.creditPill}
            >
              <Text maxFontSizeMultiplier={1.2} style={styles.statusText}>
                {trafficStatus.text}
              </Text>
            </View>
          )}
          <FocusRingPressable
            accessibilityLabel="Map attribution"
            accessibilityRole="button"
            hitSlop={12}
            onPress={onShowAttribution}
            style={styles.creditPill}
          >
            <Text maxFontSizeMultiplier={1.2} numberOfLines={2} style={styles.creditText}>
              {attribution}
            </Text>
          </FocusRingPressable>
        </View>
        <View pointerEvents="box-none" style={styles.actions}>
          {!guidance && (
            <IconButton
              key={`bottom-${String(bottomGlassKey)}-2`}
              accessibilityHint="Opens the road report sheet for hazards, closures, and other road conditions"
              accessibilityLabel="Report a road condition"
              icon={{ android: 'report_problem', ios: 'exclamationmark.bubble.fill' }}
              onPress={onOpenReport}
              scheme={scheme}
              size={48}
              variant="floating"
            />
          )}
          {mode !== 'guidance' && mode !== 'arrived' && (
            <IconButton
              key={`bottom-${String(bottomGlassKey)}-3`}
              accessibilityLabel="Center map on my location"
              animationSpec={locating ? { effect: { type: 'pulse' } } : undefined}
              disabled={locating}
              icon={{ android: 'my_location', ios: 'location.fill' }}
              onPress={onLocate}
              scheme={scheme}
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
                key={`bottom-${String(bottomGlassKey)}-4`}
                accessibilityLabel="Recenter map on vehicle"
                icon={{ android: 'my_location', ios: 'location.fill' }}
                onPress={onRecenter}
                scheme={scheme}
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

const stylesFor = createSchemeStyles(({ colors, scheme }) =>
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
