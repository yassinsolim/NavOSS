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
import { rerouteDeltaLabel, type SpeedReadout } from '@/features/navigation/guidance-settings';
import { audioModeOption } from '@/features/navigation/guidance-settings-sheet';
import { maneuverText } from '@/features/navigation/maneuver-text';
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
import { Banner } from '@/ui/banner';
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
  /**
   * Reports the banner's height including its gap to the status bar. A long instruction wraps to
   * a third line rather than shrinking, so whatever is stacked below follows the real height.
   */
  onHeightChange: (height: number) => void;
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
  onHeightChange,
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
  const text = maneuverText(displayedInstruction, displayedRoadName);
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
      onLayout={(event) => {
        onHeightChange(Math.ceil(event.nativeEvent.layout.height) + space.sm);
      }}
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
            maxFontSizeMultiplier={1.3}
            adjustsFontSizeToFit
            numberOfLines={1}
            style={[guidanceStyles.distance, guidanceStyles.tabular]}
          >
            {displayedDistance}
          </Text>
          {/* The action is never cut off: it wraps to a second line, and only shrinks if a
              second line is still not enough. Where it leads is the smaller line beneath. */}
          <Text
            maxFontSizeMultiplier={1.3}
            adjustsFontSizeToFit
            minimumFontScale={0.75}
            numberOfLines={2}
            style={guidanceStyles.instruction}
          >
            {text.primary}
          </Text>
          {text.secondary.length > 0 && (
            <Text numberOfLines={2} style={guidanceStyles.road}>
              {text.secondary}
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
  top,
}: {
  camera: Pick<SafetyCamera, 'location'>;
  distanceAheadMeters: number;
  top: number;
}) {
  const distance = formatDistance(distanceAheadMeters);
  return (
    <Animated.View
      accessibilityLabel={`Red light and speed camera ahead, ${distance}, ${camera.location}`}
      accessibilityLiveRegion="polite"
      accessible
      entering={FadeInDown.duration(motion.duration.base).reduceMotion(ReduceMotion.System)}
      exiting={FadeOutUp.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
      style={[guidanceStyles.cameraAlert, { top }]}
    >
      <SymbolView
        name={{ android: 'photo_camera', ios: 'camera.fill' }}
        size={26}
        tintColor={palette.ink}
      />
      <View style={guidanceStyles.cameraAlertCopy}>
        <Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={guidanceStyles.cameraAlertTitle}>
          Red light + speed camera
        </Text>
        <Text
          maxFontSizeMultiplier={1.3}
          numberOfLines={1}
          style={[guidanceStyles.cameraAlertMeta, guidanceStyles.tabular]}
        >
          {distance} · {camera.location}
        </Text>
      </View>
    </Animated.View>
  );
}

/**
 * Current speed, the posted limit and the road being driven, riding the trip panel's top edge.
 * All three come from the navigation core; each is shown only when it is known. The speed turns
 * coral only when the core reports it over the limit plus the driver's tolerance.
 */
export function DrivingStatus({
  roadName,
  sheetPosition,
  speed,
}: {
  roadName: string | undefined;
  sheetPosition: SharedValue<number>;
  speed: SpeedReadout | undefined;
}) {
  const style = useAnimatedStyle(() => ({ bottom: sheetPosition.value + CONTROL_MARGIN + 44 }));
  if (speed === undefined && roadName === undefined) return null;
  return (
    <Animated.View pointerEvents="none" style={[guidanceStyles.drivingStatus, style]}>
      {speed !== undefined && (
        <View
          accessibilityLabel={speed.accessibilityLabel}
          accessibilityLiveRegion={speed.overLimit ? 'polite' : 'none'}
          accessible
          style={guidanceStyles.speedGroup}
        >
          {speed.speedKph !== undefined && (
            <View style={[guidanceStyles.speed, speed.overLimit && guidanceStyles.speedOver]}>
              <Text
                maxFontSizeMultiplier={1}
                style={[
                  guidanceStyles.speedValue,
                  guidanceStyles.tabular,
                  speed.overLimit && guidanceStyles.speedValueOver,
                ]}
              >
                {speed.speedKph}
              </Text>
              <Text
                maxFontSizeMultiplier={1}
                style={[guidanceStyles.speedUnit, speed.overLimit && guidanceStyles.speedValueOver]}
              >
                km/h
              </Text>
            </View>
          )}
          {speed.limitKph !== undefined && (
            <View style={guidanceStyles.speedSign}>
              <Text maxFontSizeMultiplier={1} style={guidanceStyles.speedSignCaption}>
                MAX
              </Text>
              <Text
                maxFontSizeMultiplier={1}
                style={[guidanceStyles.speedSignValue, guidanceStyles.tabular]}
              >
                {speed.limitKph}
              </Text>
            </View>
          )}
        </View>
      )}
      {roadName !== undefined && roadName.length > 0 && (
        <View accessibilityLabel={`On ${roadName}`} accessible style={guidanceStyles.roadPill}>
          <Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={guidanceStyles.roadPillText}>
            {roadName}
          </Text>
        </View>
      )}
    </Animated.View>
  );
}

/**
 * The ask-first reroute offer. It states what the new route costs or saves against the route
 * the driver chose and gives two large, equal choices. The navigation core withdraws the offer
 * if the driver returns to the route, and applies it if they stay off route without answering.
 */
export function RerouteProposalCard({
  distanceDeltaMeters,
  distanceMeters,
  durationDeltaSeconds,
  durationSeconds,
  onAccept,
  onKeep,
  top,
}: {
  distanceDeltaMeters: number;
  distanceMeters: number;
  durationDeltaSeconds: number;
  durationSeconds: number;
  onAccept: () => void;
  onKeep: () => void;
  top: number;
}) {
  const summary = `${formatDuration(durationSeconds)} · ${formatDistance(distanceMeters)}`;
  const delta = rerouteDeltaLabel(durationDeltaSeconds, distanceDeltaMeters);
  return (
    <Animated.View
      accessibilityLabel={`You left the route. New route available, ${summary}, ${delta}`}
      accessibilityLiveRegion="assertive"
      accessibilityRole="alert"
      entering={FadeInDown.duration(motion.duration.base).reduceMotion(ReduceMotion.System)}
      exiting={FadeOutUp.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
      style={[guidanceStyles.rerouteCard, { top }]}
    >
      <View style={guidanceStyles.rerouteCopy}>
        <Text maxFontSizeMultiplier={1.3} style={guidanceStyles.rerouteEyebrow}>
          You left the route
        </Text>
        <Text
          maxFontSizeMultiplier={1.3}
          style={[guidanceStyles.rerouteTitle, guidanceStyles.tabular]}
        >
          New route: {summary}
        </Text>
        <Text
          maxFontSizeMultiplier={1.3}
          style={[guidanceStyles.rerouteDelta, guidanceStyles.tabular]}
        >
          {delta} · applies on its own if you stay off route
        </Text>
      </View>
      <View style={guidanceStyles.rerouteActions}>
        <PressableScale
          accessibilityLabel="Keep route"
          accessibilityRole="button"
          onPress={onKeep}
          style={[guidanceStyles.rerouteButton, guidanceStyles.rerouteKeep]}
        >
          <Text maxFontSizeMultiplier={1.3} style={guidanceStyles.rerouteButtonText}>
            Keep route
          </Text>
        </PressableScale>
        <PressableScale
          accessibilityLabel="Accept new route"
          accessibilityRole="button"
          onPress={onAccept}
          style={[guidanceStyles.rerouteButton, guidanceStyles.rerouteAccept]}
        >
          <Text maxFontSizeMultiplier={1.3} style={guidanceStyles.rerouteButtonText}>
            Accept
          </Text>
        </PressableScale>
      </View>
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
      <Text
        maxFontSizeMultiplier={1.3}
        adjustsFontSizeToFit
        numberOfLines={1}
        style={styles.tripActionLabel}
      >
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
  /** The matched position is being extrapolated through a short gap in GPS fixes. */
  positionEstimated: boolean;
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
  positionEstimated,
  rerouteCount,
  routeSource,
  upcomingManeuvers,
}: TripSheetProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const detents = tripSheetDetents(metrics);
  const sound = audioModeOption(audioMode);
  const matchStatusLabel = positionEstimated
    ? 'position estimated, waiting for GPS'
    : matchStatus === 'matched'
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
  // Shown only when the driver should know something: the status line is not a debug readout.
  const tripNotice = positionEstimated
    ? {
        message: 'Your position is being estimated along the route until GPS returns.',
        title: 'Weak GPS signal',
      }
    : matchStatus === 'acquiring'
      ? { message: 'Guidance starts as soon as your position is known.', title: 'Waiting for GPS' }
      : matchStatus === 'off-route'
        ? { message: 'NavOSS is working out how to get you back on track.', title: 'Off route' }
        : rerouteCount > 0
          ? {
              message:
                rerouteCount === 1
                  ? 'Your route was updated once on this trip.'
                  : `Your route was updated ${String(rerouteCount)} times on this trip.`,
              title: 'Route updated',
            }
          : undefined;
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
            maxFontSizeMultiplier={1.3}
            adjustsFontSizeToFit
            minimumFontScale={0.7}
            numberOfLines={1}
            style={[styles.tripArrival, guidanceStyles.tabular]}
          >
            {arrival}
          </Text>
          <Text
            maxFontSizeMultiplier={1.3}
            numberOfLines={1}
            style={[styles.tripRemaining, guidanceStyles.tabular]}
          >
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
          accessibilityHint="Opens guidance settings: sound, rerouting and speed warning"
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
          {tripNotice !== undefined && (
            <Banner announce message={tripNotice.message} title={tripNotice.title} tone="warning" />
          )}
          <Text style={styles.tripDestination}>To {destinationName}</Text>
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
  rerouteAccept: { backgroundColor: guidanceColors.maneuver },
  rerouteActions: { flexDirection: 'row', gap: space.sm },
  rerouteButton: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radius.lg,
    flex: 1,
    justifyContent: 'center',
    minHeight: touchTarget.driving,
  },
  rerouteButtonText: { ...typography.headline, color: guidanceColors.text, fontSize: 19 },
  rerouteCard: {
    backgroundColor: guidanceColors.backgroundRaised,
    borderColor: palette.sun,
    borderCurve: 'continuous',
    borderRadius: radius.xl,
    borderWidth: 2,
    gap: space.md,
    left: space.sm,
    padding: space.md,
    position: 'absolute',
    right: space.sm,
    ...elevation.high,
  },
  rerouteCopy: { gap: 2 },
  rerouteDelta: { ...typography.callout, color: guidanceColors.textSecondary },
  rerouteEyebrow: { ...typography.eyebrow, color: palette.sun },
  rerouteKeep: { backgroundColor: '#3A4A4B' },
  rerouteTitle: { ...typography.title2, color: guidanceColors.text },
  drivingStatus: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: space.sm,
    left: CONTROL_MARGIN,
    position: 'absolute',
    right: 84,
  },
  roadPill: {
    backgroundColor: guidanceColors.background,
    borderRadius: radius.pill,
    flexShrink: 1,
    paddingHorizontal: space.md,
    paddingVertical: space.sm - 2,
    ...elevation.medium,
  },
  roadPillText: { ...typography.label, color: guidanceColors.text },
  speed: {
    alignItems: 'center',
    backgroundColor: guidanceColors.background,
    borderColor: guidanceColors.border,
    borderRadius: radius.pill,
    borderWidth: 2,
    height: 64,
    justifyContent: 'center',
    width: 64,
    ...elevation.medium,
  },
  speedGroup: { alignItems: 'flex-end', flexDirection: 'row', gap: space.xs },
  speedOver: { backgroundColor: palette.coral, borderColor: palette.white },
  speedSign: {
    alignItems: 'center',
    backgroundColor: palette.white,
    borderColor: palette.ink,
    borderCurve: 'continuous',
    borderRadius: radius.md,
    borderWidth: 2.5,
    justifyContent: 'center',
    minHeight: 52,
    minWidth: 46,
    paddingHorizontal: space.xs,
    ...elevation.medium,
  },
  speedSignCaption: { ...typography.caption, color: palette.ink, fontSize: 9, lineHeight: 11 },
  speedSignValue: { ...typography.title2, color: palette.ink, lineHeight: 26 },
  speedUnit: {
    ...typography.caption,
    color: guidanceColors.textSecondary,
    fontSize: 10,
    lineHeight: 11,
  },
  speedValue: { ...typography.title2, color: guidanceColors.text, lineHeight: 26 },
  speedValueOver: { color: palette.white },
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
    tripDestination: {
      ...typography.headline,
      color: colors.text,
      paddingHorizontal: space.sm,
    },
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
