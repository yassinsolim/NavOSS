import type { RouteResponse, SafetyCamera, SearchResult } from '@navoss/contracts';
import { SymbolView } from 'expo-symbols';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  FadeInDown,
  FadeInUp,
  FadeOutUp,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
} from 'react-native-reanimated';

import type { NavigationRouteStatus } from '@/features/map/controller/use-navigation-session';
import {
  CONTROL_MARGIN,
  GUIDANCE_BANNER_HEIGHT,
  type ScreenMetrics,
  tripSheetDetents,
} from '@/features/map/overlay-layout';
import { audioModeOption } from '@/features/navigation/audio-mode-sheet';
import {
  maneuverDirection,
  type ManeuverDirection,
} from '@/features/navigation/maneuver-direction';
import type { NavigationAudioMode } from '@/features/navigation/native-navigation';
import {
  formatArrivalTime,
  formatDistance,
  formatDuration,
  type UpcomingManeuver,
} from '@/features/navigation/route-progress';
import type { VehicleMatchStatus } from '@/features/navigation/vehicle-puck';
import {
  createThemedStyles,
  elevation,
  guidanceColors,
  motion,
  radius,
  space,
  touchTarget,
  typography,
  useTheme,
} from '@/theme';
import { palette } from '@/theme/tokens';
import { Button, type SymbolName } from '@/ui/button';
import { ListRow } from '@/ui/list-row';
import { PressableScale } from '@/ui/pressable-scale';
import { BottomSheet, BottomSheetReveal, BottomSheetScrollView } from '@/ui/sheet/bottom-sheet';
import { SectionTitle } from '@/ui/sheet/sheet-header';

export function maneuverSymbol(direction: ManeuverDirection): SymbolName {
  switch (direction) {
    case 'arrive':
      return { android: 'flag', ios: 'flag.checkered' };
    case 'left':
      return { android: 'turn_left', ios: 'arrow.turn.up.left' };
    case 'right':
      return { android: 'turn_right', ios: 'arrow.turn.up.right' };
    case 'roundabout':
      return { android: 'roundabout_right', ios: 'arrow.clockwise' };
    case 'uturn':
      return { android: 'u_turn_left', ios: 'arrow.uturn.backward' };
    case 'straight':
      return { android: 'straight', ios: 'arrow.up' };
  }
}

interface ManeuverBannerProps {
  /**
   * Wave 2 seam: lane guidance. Pass the lane strip for the upcoming maneuver here; it renders
   * as a full-width row under the instruction, inside the banner, so it shares the banner's
   * contrast and is announced with it. Nothing is rendered until the route contract carries
   * lanes, and the app must not describe itself as having lane guidance before then.
   */
  children?: ReactNode;
  distanceMeters: number;
  instruction: string;
  maneuverType: string;
  roadName: string;
  safeAreaTop: number;
  status: NavigationRouteStatus;
}

/**
 * The next maneuver. Always ink with white type, in light and dark: the largest text on screen
 * is the distance, then the instruction, so both read in one glance at arm's length.
 */
export function ManeuverBanner({
  children,
  distanceMeters,
  instruction,
  maneuverType,
  roadName,
  safeAreaTop,
  status,
}: ManeuverBannerProps) {
  const rerouting = status === 'rerouting';
  const failed = status === 'reroute-failed';
  const displayedInstruction = rerouting
    ? 'Finding a new route'
    : failed
      ? 'Route update unavailable'
      : instruction;
  const displayedRoadName = rerouting
    ? 'Using your current location'
    : failed
      ? 'Check your connection'
      : roadName;
  const displayedDistance = rerouting
    ? 'Rerouting'
    : failed
      ? 'Route paused'
      : formatDistance(distanceMeters);

  return (
    <Animated.View
      accessibilityLabel={`${displayedDistance}, ${displayedInstruction}${displayedRoadName.length === 0 ? '' : `, ${displayedRoadName}`}`}
      accessibilityLiveRegion="polite"
      accessible
      entering={FadeInDown.duration(motion.duration.base).reduceMotion(ReduceMotion.System)}
      exiting={FadeOutUp.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
      style={[guidanceStyles.banner, { top: safeAreaTop + space.sm }]}
    >
      <View style={guidanceStyles.bannerRow}>
        <View style={[guidanceStyles.maneuverTile, failed && guidanceStyles.maneuverTileFailed]}>
          <SymbolView
            name={
              rerouting
                ? { android: 'sync', ios: 'arrow.triangle.2.circlepath' }
                : failed
                  ? { android: 'wifi_off', ios: 'wifi.slash' }
                  : maneuverSymbol(maneuverDirection(maneuverType, instruction))
            }
            size={42}
            tintColor={palette.white}
          />
        </View>
        <View style={guidanceStyles.bannerCopy}>
          <Text
            adjustsFontSizeToFit
            numberOfLines={1}
            style={[guidanceStyles.distance, guidanceStyles.tabular]}
          >
            {displayedDistance}
          </Text>
          <Text
            adjustsFontSizeToFit
            minimumFontScale={0.8}
            numberOfLines={2}
            style={guidanceStyles.instruction}
          >
            {displayedInstruction}
          </Text>
          {displayedRoadName.length > 0 && (
            <Text numberOfLines={1} style={guidanceStyles.road}>
              {displayedRoadName}
            </Text>
          )}
        </View>
      </View>
      {children}
    </Animated.View>
  );
}

/** A safety camera on the route ahead. Sun on ink: distinct from the maneuver banner above it. */
export function SafetyCameraAlertBanner({
  camera,
  distanceAheadMeters,
  safeAreaTop,
}: {
  camera: Pick<SafetyCamera, 'location'>;
  distanceAheadMeters: number;
  safeAreaTop: number;
}) {
  const distance = formatDistance(distanceAheadMeters);
  return (
    <Animated.View
      accessibilityLabel={`Red light and speed camera ahead, ${distance}, ${camera.location}`}
      accessibilityLiveRegion="polite"
      accessible
      entering={FadeInDown.duration(motion.duration.base).reduceMotion(ReduceMotion.System)}
      exiting={FadeOutUp.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
      style={[guidanceStyles.cameraAlert, { top: safeAreaTop + GUIDANCE_BANNER_HEIGHT + space.sm }]}
    >
      <SymbolView
        name={{ android: 'photo_camera', ios: 'camera.fill' }}
        size={26}
        tintColor={palette.ink}
      />
      <View style={guidanceStyles.cameraAlertCopy}>
        <Text numberOfLines={1} style={guidanceStyles.cameraAlertTitle}>
          Red light + speed camera
        </Text>
        <Text numberOfLines={1} style={[guidanceStyles.cameraAlertMeta, guidanceStyles.tabular]}>
          {distance} · {camera.location}
        </Text>
      </View>
    </Animated.View>
  );
}

/**
 * The posted limit for the road being driven, as a sign. It rides the trip panel's top edge.
 * Only limits present in the route data are shown; the phone has no current-speed reading.
 *
 * Wave 2 seam: when the navigation snapshot reports current speed, show it beside this sign.
 */
export function SpeedLimitSign({
  limitKph,
  sheetPosition,
}: {
  limitKph: number | undefined;
  sheetPosition: SharedValue<number>;
}) {
  const style = useAnimatedStyle(() => ({ bottom: sheetPosition.value + CONTROL_MARGIN + 44 }));
  if (limitKph === undefined) return null;
  return (
    <Animated.View
      accessibilityLabel={`Speed limit ${String(limitKph)} kilometres per hour`}
      accessible
      style={[guidanceStyles.speedSign, style]}
    >
      <Text style={guidanceStyles.speedSignCaption}>MAX</Text>
      <Text style={[guidanceStyles.speedSignValue, guidanceStyles.tabular]}>{limitKph}</Text>
      <Text style={guidanceStyles.speedSignCaption}>km/h</Text>
    </Animated.View>
  );
}

function TripAction({
  accessibilityHint,
  accessibilityLabel,
  icon,
  label,
  onPress,
}: {
  accessibilityHint: string;
  accessibilityLabel: string;
  icon: SymbolName;
  label: string;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  return (
    <PressableScale
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={onPress}
      style={styles.tripAction}
    >
      <SymbolView name={icon} size={20} tintColor={colors.primaryText} />
      <Text adjustsFontSizeToFit numberOfLines={1} style={styles.tripActionLabel}>
        {label}
      </Text>
    </PressableScale>
  );
}

interface TripSheetProps {
  audioMode: NavigationAudioMode;
  cameraAnnouncementCount: number;
  destinationName: string;
  distanceMeters: number;
  durationSeconds: number;
  matchStatus: VehicleMatchStatus;
  metrics: ScreenMetrics;
  onEnd: () => void;
  onReport: () => void;
  onShare: () => void;
  onSound: () => void;
  position: SharedValue<number>;
  rerouteCount: number;
  routeSource: RouteResponse['source'] | undefined;
  upcomingManeuvers: readonly UpcomingManeuver[];
}

/**
 * The trip panel. At rest: arrival time, time and distance remaining, and the four controls a
 * driver uses, none smaller than 52pt. Dragged up: the remaining maneuvers and the trip's status.
 */
export function TripSheet({
  audioMode,
  cameraAnnouncementCount,
  destinationName,
  distanceMeters,
  durationSeconds,
  matchStatus,
  metrics,
  onEnd,
  onReport,
  onShare,
  onSound,
  position,
  rerouteCount,
  routeSource,
  upcomingManeuvers,
}: TripSheetProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const detents = tripSheetDetents(metrics);
  const sound = audioModeOption(audioMode);
  const matchStatusLabel =
    matchStatus === 'matched'
      ? 'on route'
      : matchStatus === 'off-route'
        ? 'off route'
        : 'acquiring route position';
  const rerouteDetail =
    rerouteCount === 0
      ? 'original route'
      : rerouteCount === 1
        ? 'route updated once'
        : `route updated ${String(rerouteCount)} times`;
  const cameraDetail =
    cameraAnnouncementCount === 0
      ? 'no camera alerts announced'
      : cameraAnnouncementCount === 1
        ? 'one camera alert announced'
        : `${String(cameraAnnouncementCount)} camera alerts announced`;
  const arrival = formatArrivalTime(durationSeconds);

  return (
    <BottomSheet
      accessibilityLabel="Trip"
      detents={detents.values}
      initialDetent={detents.initial}
      position={position}
    >
      <View style={styles.tripSummary}>
        <View
          accessibilityLabel={`Navigation status, ${matchStatusLabel}, ${rerouteDetail}, ${cameraDetail}, arrive ${arrival}, ${formatDuration(durationSeconds)}, ${formatDistance(distanceMeters)}`}
          accessible
          style={styles.tripMetrics}
        >
          <Text
            adjustsFontSizeToFit
            minimumFontScale={0.7}
            numberOfLines={1}
            style={[styles.tripArrival, guidanceStyles.tabular]}
          >
            {arrival}
          </Text>
          <Text numberOfLines={1} style={[styles.tripRemaining, guidanceStyles.tabular]}>
            {formatDuration(durationSeconds)} · {formatDistance(distanceMeters)}
          </Text>
        </View>
        <Button
          accessibilityLabel="End navigation"
          icon={{ android: 'close', ios: 'xmark' }}
          label="End"
          onPress={onEnd}
          size="driving"
          variant="danger"
        />
      </View>
      <View style={styles.tripActions}>
        <TripAction
          accessibilityHint="Choose maneuver and safety-alert speech"
          accessibilityLabel={`Guidance sound, ${sound.label}`}
          icon={sound.icon}
          label={sound.label}
          onPress={onSound}
        />
        <TripAction
          accessibilityHint="Choose a road condition to record at your current location"
          accessibilityLabel="Report road condition"
          icon={{ android: 'add_alert', ios: 'exclamationmark.bubble.fill' }}
          label="Report"
          onPress={onReport}
        />
        <TripAction
          accessibilityHint="Opens the system share sheet without reading your contacts"
          accessibilityLabel="Share ETA"
          icon={{ android: 'share', ios: 'square.and.arrow.up' }}
          label="Share ETA"
          onPress={onShare}
        />
      </View>

      <BottomSheetReveal above={detents.values[0] ?? 0} style={styles.tripReveal}>
        <BottomSheetScrollView
          contentContainerStyle={[
            styles.tripDetails,
            { paddingBottom: metrics.bottomInset + space.xl },
          ]}
        >
          <View style={styles.tripStatus}>
            <SymbolView
              name={
                matchStatus === 'matched'
                  ? { android: 'check_circle', ios: 'checkmark.circle.fill' }
                  : matchStatus === 'off-route'
                    ? { android: 'error', ios: 'exclamationmark.triangle.fill' }
                    : { android: 'gps_not_fixed', ios: 'location.slash' }
              }
              size={18}
              tintColor={
                matchStatus === 'matched'
                  ? colors.success
                  : matchStatus === 'off-route'
                    ? colors.warningText
                    : colors.textTertiary
              }
            />
            <Text style={styles.tripStatusText}>
              To {destinationName} · {matchStatusLabel} · {rerouteDetail}
            </Text>
          </View>
          {upcomingManeuvers.length > 0 && (
            <View>
              <SectionTitle>Next</SectionTitle>
              {upcomingManeuvers.map((maneuver) => {
                const distance = formatDistance(maneuver.distanceMeters);
                return (
                  <ListRow
                    accessibilityLabel={`After ${distance}, ${maneuver.instruction}${maneuver.roadName.length === 0 ? '' : `, ${maneuver.roadName}`}`}
                    icon={maneuverSymbol(
                      maneuverDirection(maneuver.maneuverType, maneuver.instruction),
                    )}
                    iconTint={colors.text}
                    key={maneuver.stepIndex}
                    subtitle={maneuver.roadName}
                    title={maneuver.instruction}
                    titleLines={2}
                    trailing={
                      <Text style={[styles.tripStepDistance, guidanceStyles.tabular]}>
                        {distance}
                      </Text>
                    }
                  />
                );
              })}
            </View>
          )}
          <Text style={styles.tripSource}>
            {routeSource?.attribution ?? 'Routing source unavailable'} ·{' '}
            {routeSource?.traffic === 'live' ? 'Live traffic' : 'No live traffic'}
          </Text>
        </BottomSheetScrollView>
      </BottomSheetReveal>
    </BottomSheet>
  );
}

/** Arrival. One statement and one action. */
export function ArrivalSheet({
  bottomInset,
  destination,
  onDone,
  position,
}: {
  bottomInset: number;
  destination: SearchResult;
  onDone: () => void;
  position: SharedValue<number>;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  return (
    <BottomSheet accessibilityLabel="Arrived" detents={['content']} position={position}>
      <Animated.View
        entering={FadeInUp.duration(motion.duration.slow).reduceMotion(ReduceMotion.System)}
        style={[styles.arrival, { paddingBottom: Math.max(bottomInset, space.lg) }]}
      >
        <View style={styles.arrivalSummary}>
          <View style={styles.arrivalIcon}>
            <SymbolView
              name={{ android: 'flag', ios: 'flag.checkered' }}
              size={28}
              tintColor={colors.primaryText}
            />
          </View>
          <View style={styles.arrivalCopy}>
            <Text style={styles.arrivalTitle}>You've arrived</Text>
            <Text accessibilityRole="header" numberOfLines={2} style={styles.arrivalDestination}>
              {destination.name}
            </Text>
          </View>
        </View>
        <Button
          accessibilityLabel="Finish navigation"
          label="Done"
          onPress={onDone}
          size="driving"
        />
      </Animated.View>
    </BottomSheet>
  );
}

// Guidance chrome uses the fixed guidance palette, so these styles do not vary with the scheme.
const guidanceStyles = StyleSheet.create({
  banner: {
    backgroundColor: guidanceColors.background,
    borderColor: guidanceColors.border,
    borderCurve: 'continuous',
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    gap: space.sm,
    left: space.sm,
    minHeight: GUIDANCE_BANNER_HEIGHT - space.md,
    padding: space.md,
    position: 'absolute',
    right: space.sm,
    ...elevation.high,
  },
  bannerCopy: { flex: 1, justifyContent: 'center' },
  bannerRow: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: space.md },
  cameraAlert: {
    alignItems: 'center',
    backgroundColor: palette.sun,
    borderCurve: 'continuous',
    borderRadius: radius.lg,
    flexDirection: 'row',
    gap: space.md,
    left: space.sm,
    minHeight: 64,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    position: 'absolute',
    right: space.sm,
    ...elevation.medium,
  },
  cameraAlertCopy: { flex: 1 },
  cameraAlertMeta: { ...typography.callout, color: palette.ink },
  cameraAlertTitle: { ...typography.title3, color: palette.ink },
  distance: { ...typography.guidanceDistance, color: guidanceColors.text },
  instruction: { ...typography.guidanceInstruction, color: guidanceColors.text },
  maneuverTile: {
    alignItems: 'center',
    backgroundColor: guidanceColors.maneuver,
    borderCurve: 'continuous',
    borderRadius: radius.lg,
    height: 76,
    justifyContent: 'center',
    width: 76,
  },
  maneuverTileFailed: { backgroundColor: palette.coral },
  road: { ...typography.guidanceRoad, color: guidanceColors.textSecondary },
  speedSign: {
    alignItems: 'center',
    backgroundColor: palette.white,
    borderColor: palette.ink,
    borderCurve: 'continuous',
    borderRadius: radius.md,
    borderWidth: 2.5,
    left: CONTROL_MARGIN,
    minWidth: 58,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    position: 'absolute',
    ...elevation.medium,
  },
  speedSignCaption: { ...typography.caption, color: palette.ink, fontSize: 10, lineHeight: 12 },
  speedSignValue: { ...typography.title1, color: palette.ink, lineHeight: 30 },
  tabular: { fontVariant: ['tabular-nums'] },
});

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    arrival: { gap: space.lg, paddingHorizontal: space.lg, paddingTop: space.xs },
    arrivalCopy: { flex: 1, gap: 2 },
    arrivalDestination: { ...typography.title2, color: colors.text },
    arrivalIcon: {
      alignItems: 'center',
      backgroundColor: colors.primarySoft,
      borderRadius: radius.pill,
      height: 56,
      justifyContent: 'center',
      width: 56,
    },
    arrivalSummary: { alignItems: 'center', flexDirection: 'row', gap: space.md },
    arrivalTitle: { ...typography.eyebrow, color: colors.primaryText },
    tripAction: {
      alignItems: 'center',
      backgroundColor: colors.surfaceSunken,
      borderCurve: 'continuous',
      borderRadius: radius.lg,
      flex: 1,
      flexDirection: 'row',
      gap: space.sm - 2,
      height: touchTarget.min + 8,
      justifyContent: 'center',
      paddingHorizontal: space.sm,
    },
    tripActionLabel: { ...typography.label, color: colors.text, flexShrink: 1 },
    tripActions: {
      flexDirection: 'row',
      gap: space.sm,
      paddingBottom: space.lg,
      paddingHorizontal: space.lg,
    },
    tripArrival: { ...typography.largeTitle, color: colors.text },
    tripDetails: { gap: space.lg, paddingHorizontal: space.md },
    tripMetrics: { flex: 1 },
    tripReveal: { flex: 1 },
    tripRemaining: { ...typography.headline, color: colors.textSecondary },
    tripSource: { ...typography.caption, color: colors.textTertiary, paddingHorizontal: space.sm },
    tripStatus: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: space.sm,
      paddingHorizontal: space.sm,
    },
    tripStatusText: { ...typography.callout, color: colors.textSecondary, flex: 1 },
    tripStepDistance: { ...typography.label, color: colors.textSecondary },
    tripSummary: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: space.md,
      paddingBottom: space.md,
      paddingHorizontal: space.lg,
      paddingTop: space.xs,
    },
  }),
);
