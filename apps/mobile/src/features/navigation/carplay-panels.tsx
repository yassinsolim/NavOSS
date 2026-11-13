import { SymbolView } from 'expo-symbols';
import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';

import { maneuverSymbol } from '@/features/navigation/guidance';
import { maneuverDirection } from '@/features/navigation/maneuver-direction';
import {
  formatArrivalTime,
  formatDistance,
  formatDuration,
  type UpcomingManeuver,
} from '@/features/navigation/route-progress';
import { guidanceColors, motion, radius, space, touchTarget, typography } from '@/theme';
import { palette } from '@/theme/tokens';
import { PressableScale } from '@/ui/pressable-scale';

interface CompanionFrameProps {
  bottomInset: number;
  children: ReactNode;
  /** Trip summary shown beside the action at standard text sizes. */
  footerSummary?: ReactNode;
  onAction: () => void;
  phase: 'arrived' | 'navigating';
  safeAreaTop: number;
}

function ConnectionHeader() {
  return (
    <View style={styles.connectionRow}>
      <View style={styles.connectionDot} />
      <Text style={styles.connectionText}>Directions on CarPlay</Text>
    </View>
  );
}

/** Shared chrome of the handset while the car owns guidance: always ink, in both schemes. */
function CompanionFrame({
  bottomInset,
  children,
  footerSummary,
  onAction,
  phase,
  safeAreaTop,
}: CompanionFrameProps) {
  const { fontScale } = useWindowDimensions();
  const arrived = phase === 'arrived';
  return (
    <Animated.View
      entering={FadeIn.duration(motion.duration.base).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
      style={[
        styles.companion,
        {
          paddingBottom: Math.max(bottomInset, space.xl),
          paddingTop: Math.max(safeAreaTop, space.xl),
        },
      ]}
    >
      {children}
      <View style={styles.footer}>
        <View style={styles.tripSummary}>{footerSummary}</View>
        <PressableScale
          accessibilityLabel={arrived ? 'Finish navigation' : 'End navigation'}
          accessibilityRole="button"
          onPress={onAction}
          style={[styles.endButton, arrived && styles.doneButton]}
        >
          <SymbolView
            name={
              arrived ? { android: 'check', ios: 'checkmark' } : { android: 'close', ios: 'xmark' }
            }
            size={24}
            tintColor={palette.white}
          />
          {/* A static native Text can retain its old measured bounds across Dynamic Type changes. */}
          <Text key={fontScale} style={styles.endText}>
            {arrived ? 'Done' : 'End'}
          </Text>
        </PressableScale>
      </View>
    </Animated.View>
  );
}

type CarPlayCompanionPanelProps = {
  bottomInset: number;
  destinationName: string;
  onAction: () => void;
  safeAreaTop: number;
} & (
  | { phase: 'arrived' }
  | {
      durationSeconds: number;
      /** Next maneuver first, then every later one through arrival. */
      maneuvers: readonly UpcomingManeuver[];
      phase: 'navigating';
      remainingDistanceMeters: number;
    }
);

/**
 * The handset while CarPlay drives: the next maneuver on top and every remaining step below it
 * in one scrollable column, so a passenger can read ahead without the car screen.
 */
export function CarPlayCompanionPanel(props: CarPlayCompanionPanelProps) {
  const { bottomInset, destinationName, onAction, safeAreaTop } = props;
  const { fontScale } = useWindowDimensions();
  const expandedText = fontScale >= 1.5;
  const arrived = props.phase === 'arrived';
  const [next, ...later] = arrived ? [] : props.maneuvers;
  const nextDirection =
    next === undefined ? 'arrive' : maneuverDirection(next.maneuverType, next.instruction);
  const nextDistance = next === undefined ? undefined : formatDistance(next.distanceMeters);
  const arrivalTime = arrived ? '' : formatArrivalTime(props.durationSeconds);
  // Intl may bind the day period with a no-break space. At large sizes, wrap before PM/AM,
  // rather than forcing a character break inside it when the complete time cannot fit.
  const displayedArrivalTime = expandedText
    ? arrivalTime.replace(/[\u00a0\u202f]/g, ' ')
    : arrivalTime;
  const nextSummary = arrived
    ? `You've arrived, ${destinationName}`
    : next === undefined
      ? destinationName
      : `Next, in ${String(nextDistance)}, ${next.instruction}${next.roadName.length === 0 ? '' : `, ${next.roadName}`}, arrive ${arrivalTime}`;
  const tripSummary = arrived ? undefined : (
    <View style={expandedText && styles.flowContent}>
      <Text numberOfLines={expandedText ? undefined : 1} style={[styles.eta, styles.tabular]}>
        {displayedArrivalTime}
      </Text>
      <Text numberOfLines={expandedText ? undefined : 1} style={[styles.remaining, styles.tabular]}>
        {formatDuration(props.durationSeconds)} · {formatDistance(props.remainingDistanceMeters)}
      </Text>
      <Text numberOfLines={expandedText ? undefined : 2} style={styles.destination}>
        {destinationName}
      </Text>
    </View>
  );

  return (
    <CompanionFrame
      bottomInset={bottomInset}
      footerSummary={expandedText ? undefined : tripSummary}
      onAction={onAction}
      phase={props.phase}
      safeAreaTop={safeAreaTop}
    >
      {!expandedText && <ConnectionHeader />}
      <ScrollView
        contentContainerStyle={styles.directionsContent}
        showsVerticalScrollIndicator={expandedText}
        style={styles.directions}
      >
        {expandedText && <ConnectionHeader />}
        <View
          accessibilityLabel={nextSummary}
          accessibilityLiveRegion="polite"
          accessible
          style={[styles.next, expandedText && styles.stacked]}
        >
          <View style={styles.nextIcon}>
            <SymbolView name={maneuverSymbol(nextDirection)} size={38} tintColor={palette.white} />
          </View>
          <View style={[styles.nextCopy, expandedText && styles.flowContent]}>
            {nextDistance !== undefined && (
              <Text style={[styles.nextDistance, styles.tabular]}>{nextDistance}</Text>
            )}
            <Text style={styles.nextInstruction}>
              {arrived ? "You've arrived" : (next?.instruction ?? destinationName)}
            </Text>
            {arrived ? (
              <Text style={styles.nextRoad}>{destinationName}</Text>
            ) : (
              next !== undefined &&
              next.roadName.length > 0 && <Text style={styles.nextRoad}>{next.roadName}</Text>
            )}
          </View>
        </View>
        {expandedText && tripSummary}

        {later.length > 0 && (
          <View style={styles.stepList}>
            <Text accessibilityRole="header" style={styles.stepListTitle}>
              Then
            </Text>
            {later.map((maneuver) => {
              const distance = formatDistance(maneuver.distanceMeters);
              return (
                <View
                  accessibilityLabel={`Then after ${distance}, ${maneuver.instruction}${maneuver.roadName.length === 0 ? '' : `, ${maneuver.roadName}`}`}
                  accessible
                  key={maneuver.stepIndex}
                  style={[styles.stepRow, expandedText && styles.stacked]}
                >
                  <SymbolView
                    name={maneuverSymbol(
                      maneuverDirection(maneuver.maneuverType, maneuver.instruction),
                    )}
                    size={22}
                    tintColor={guidanceColors.primary}
                  />
                  <View style={[styles.stepCopy, expandedText && styles.flowContent]}>
                    <Text style={styles.stepInstruction}>{maneuver.instruction}</Text>
                    {maneuver.roadName.length > 0 && (
                      <Text style={styles.stepRoad}>{maneuver.roadName}</Text>
                    )}
                  </View>
                  <Text
                    style={[
                      styles.stepDistance,
                      styles.tabular,
                      expandedText && styles.stepDistanceExpanded,
                    ]}
                  >
                    {distance}
                  </Text>
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </CompanionFrame>
  );
}

/**
 * Shown only while an active CarPlay route has no resolvable maneuver yet. Without CarPlay
 * guidance the connected handset keeps its interactive map instead (see `phoneSurface`).
 */
export function CarPlayIdlePanel({
  bottomInset,
  onEnd,
  safeAreaTop,
}: {
  bottomInset: number;
  onEnd: () => void;
  safeAreaTop: number;
}) {
  return (
    <CompanionFrame
      bottomInset={bottomInset}
      onAction={onEnd}
      phase="navigating"
      safeAreaTop={safeAreaTop}
    >
      <ConnectionHeader />
      <View
        accessibilityLabel="Your route is on your car's display. Directions will appear here once the next turn is ready."
        accessible
        style={styles.idleBody}
      >
        <SymbolView
          name={{ android: 'directions_car', ios: 'car.fill' }}
          size={64}
          tintColor={guidanceColors.primary}
        />
        <Text style={styles.idleTitle}>Your route is on your car's display</Text>
        <Text style={styles.idleSubtitle}>
          Directions will appear here once the next turn is ready.
        </Text>
      </View>
    </CompanionFrame>
  );
}

const styles = StyleSheet.create({
  companion: {
    backgroundColor: guidanceColors.background,
    flex: 1,
    gap: space.lg,
    paddingHorizontal: space.xl,
  },
  connectionDot: {
    backgroundColor: guidanceColors.primary,
    borderRadius: radius.pill,
    height: 10,
    width: 10,
  },
  connectionRow: { alignItems: 'center', flexDirection: 'row', gap: space.sm },
  connectionText: { ...typography.eyebrow, color: guidanceColors.primary },
  destination: { ...typography.callout, color: guidanceColors.textSecondary },
  directions: { flex: 1 },
  directionsContent: { gap: space.xl, paddingBottom: space.lg },
  doneButton: { backgroundColor: palette.tealLight },
  endButton: {
    alignItems: 'center',
    backgroundColor: palette.coral,
    borderCurve: 'continuous',
    borderRadius: radius.xl,
    flexDirection: 'row',
    gap: space.sm,
    justifyContent: 'center',
    minHeight: touchTarget.driving + 8,
    minWidth: 132,
    paddingHorizontal: space.xl,
  },
  endText: { ...typography.title3, color: palette.white },
  eta: { ...typography.title1, color: guidanceColors.text },
  flowContent: { flex: 0, width: '100%' },
  footer: { alignItems: 'flex-end', flexDirection: 'row', gap: space.lg },
  idleBody: { alignItems: 'center', flex: 1, gap: space.md, justifyContent: 'center' },
  idleSubtitle: {
    ...typography.body,
    color: guidanceColors.textSecondary,
    textAlign: 'center',
  },
  idleTitle: { ...typography.title2, color: guidanceColors.text, textAlign: 'center' },
  next: {
    alignItems: 'center',
    backgroundColor: guidanceColors.backgroundRaised,
    borderCurve: 'continuous',
    borderRadius: radius.xl,
    flexDirection: 'row',
    gap: space.lg,
    padding: space.lg,
  },
  nextCopy: { flex: 1 },
  nextDistance: { ...typography.guidanceDistance, color: guidanceColors.text },
  nextIcon: {
    alignItems: 'center',
    backgroundColor: guidanceColors.maneuver,
    borderCurve: 'continuous',
    borderRadius: radius.lg,
    height: 76,
    justifyContent: 'center',
    width: 76,
  },
  nextInstruction: { ...typography.guidanceInstruction, color: guidanceColors.text },
  nextRoad: { ...typography.guidanceRoad, color: guidanceColors.textSecondary },
  remaining: { ...typography.headline, color: guidanceColors.textSecondary },
  stacked: { alignItems: 'flex-start', flexDirection: 'column' },
  stepCopy: { flex: 1 },
  stepDistance: { ...typography.label, color: guidanceColors.textSecondary },
  stepDistanceExpanded: { alignSelf: 'flex-start' },
  stepInstruction: { ...typography.headline, color: guidanceColors.text },
  stepList: { gap: space.xs },
  stepListTitle: { ...typography.eyebrow, color: guidanceColors.textSecondary },
  stepRoad: { ...typography.callout, color: guidanceColors.textSecondary },
  stepRow: {
    alignItems: 'center',
    borderBottomColor: guidanceColors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: space.md,
    minHeight: touchTarget.min + 12,
    paddingVertical: space.sm,
  },
  tabular: { fontVariant: ['tabular-nums'] },
  tripSummary: { flex: 1 },
});
