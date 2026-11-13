import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, FadeOutUp, ReduceMotion } from 'react-native-reanimated';

import {
  type CommunityFeatureState,
  communityReportLabel,
  communityReportSymbol,
  showsReportAhead,
  showsStillThere,
} from '@/features/community/community';
import type {
  NativeCommunityReportType,
  NativeNavigationSnapshot,
} from '@/features/navigation/native-navigation';
import { formatDistance } from '@/features/navigation/route-progress';
import { useStableCallback } from '@/lib/use-stable-callback';
import { elevation, guidanceColors, motion, radius, space, touchTarget, typography } from '@/theme';
import { palette } from '@/theme/tokens';
import { PressableScale } from '@/ui/pressable-scale';

/** The report-ahead banner leaves on its own; the native alert is once per report per trip. */
const REPORT_AHEAD_VISIBLE_MS = 8_000;
/** Unanswered, "Still there?" goes away and sends nothing. */
const STILL_THERE_VISIBLE_MS = 15_000;

export const REPORT_AHEAD_HEIGHT = 76;
export const STILL_THERE_HEIGHT = 168;

export interface ReportAhead {
  distanceAheadMeters: number;
  type: NativeCommunityReportType;
}

export interface StillThere {
  reportId: string;
  type: NativeCommunityReportType;
}

/**
 * Which community prompt the guidance screen shows. The navigation core decides when a report
 * is ahead and when to ask "Still there?" (after passing it, never near a maneuver); the phone
 * adds its own limits: neither shows close to the next maneuver, "Still there?" only when the
 * driver shares reports and nothing else needs a decision, and both leave on their own.
 */
export function useCommunityGuidance({
  competingPrompt,
  distanceToManeuverMeters,
  onDismissStillThere,
  reportSharing,
  sharesRoadReports,
  snapshot,
}: {
  competingPrompt: boolean;
  distanceToManeuverMeters: number | undefined;
  onDismissStillThere: (reportId: string) => void;
  reportSharing: CommunityFeatureState;
  sharesRoadReports: boolean;
  /** The navigating snapshot; undefined outside guidance. */
  snapshot: NativeNavigationSnapshot | undefined;
}) {
  const alert = snapshot?.phase === 'tracking' ? snapshot.communityReportAlert : undefined;
  const prompt = snapshot?.phase === 'tracking' ? snapshot.stillTherePrompt : undefined;
  const [expiredAlertSequence, setExpiredAlertSequence] = useState<number>();
  const [expiredPromptSequence, setExpiredPromptSequence] = useState<number>();
  const dismiss = useStableCallback(onDismissStillThere);

  const alertSequence = alert?.sequence;
  useEffect(() => {
    if (alertSequence === undefined) return;
    const timeout = setTimeout(() => {
      setExpiredAlertSequence(alertSequence);
    }, REPORT_AHEAD_VISIBLE_MS);
    return () => {
      clearTimeout(timeout);
    };
  }, [alertSequence]);

  const promptVisible =
    prompt !== undefined &&
    prompt.sequence !== expiredPromptSequence &&
    showsStillThere({
      competingPrompt,
      distanceToManeuverMeters,
      reportSharing,
      sharesRoadReports,
    });
  const promptSequence = promptVisible ? prompt.sequence : undefined;
  const promptReportId = prompt?.reportId;
  useEffect(() => {
    if (promptSequence === undefined || promptReportId === undefined) return;
    const timeout = setTimeout(() => {
      setExpiredPromptSequence(promptSequence);
      dismiss(promptReportId);
    }, STILL_THERE_VISIBLE_MS);
    return () => {
      clearTimeout(timeout);
    };
  }, [dismiss, promptReportId, promptSequence]);

  const reportAhead: ReportAhead | undefined =
    alert !== undefined &&
    alert.sequence !== expiredAlertSequence &&
    showsReportAhead(distanceToManeuverMeters)
      ? { distanceAheadMeters: alert.distanceAheadMeters, type: alert.type }
      : undefined;
  const stillThere: StillThere | undefined = promptVisible
    ? { reportId: prompt.reportId, type: prompt.type }
    : undefined;

  return {
    /** Hides the prompt at once after an answer, before native withdraws it. */
    resolveStillThere: () => {
      if (prompt !== undefined) setExpiredPromptSequence(prompt.sequence);
    },
    reportAhead,
    stillThere,
  };
}

/** A driver report on the route ahead. Information only: nothing to tap while driving. */
export function ReportAheadBanner({ report, top }: { report: ReportAhead; top: number }) {
  const label = communityReportLabel(report.type);
  const distance = formatDistance(report.distanceAheadMeters);
  return (
    <Animated.View
      accessibilityLabel={`${label} reported ahead, ${distance}. Reported by NavOSS drivers.`}
      accessibilityLiveRegion="polite"
      accessible
      entering={FadeInDown.duration(motion.duration.base).reduceMotion(ReduceMotion.System)}
      exiting={FadeOutUp.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
      pointerEvents="none"
      style={[styles.reportAhead, { top }]}
    >
      <View style={styles.reportIcon}>
        <SymbolView name={communityReportSymbol(report.type)} size={24} tintColor={palette.ink} />
      </View>
      <View style={styles.copy}>
        <Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={styles.title}>
          {label} ahead
        </Text>
        <Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={styles.meta}>
          {distance} · reported by drivers
        </Text>
      </View>
    </Animated.View>
  );
}

/** "Still there?" after passing a report: two large answers, and it leaves on its own. */
export function StillTherePrompt({
  busy,
  onAnswer,
  onDismiss,
  prompt,
  top,
}: {
  busy: boolean;
  onAnswer: (vote: 'not-present' | 'present') => void;
  onDismiss: () => void;
  prompt: StillThere;
  top: number;
}) {
  const label = communityReportLabel(prompt.type);
  return (
    <Animated.View
      accessibilityLabel={`Still there? The ${label.toLocaleLowerCase('en-CA')} you just passed`}
      accessibilityLiveRegion="polite"
      entering={FadeInDown.duration(motion.duration.base).reduceMotion(ReduceMotion.System)}
      exiting={FadeOutUp.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
      style={[styles.prompt, { top }]}
    >
      <View style={styles.promptHeader}>
        <View style={styles.copy}>
          <Text maxFontSizeMultiplier={1.3} style={styles.eyebrow}>
            Still there?
          </Text>
          <Text maxFontSizeMultiplier={1.3} numberOfLines={2} style={styles.title}>
            The {label.toLocaleLowerCase('en-CA')} you just passed
          </Text>
        </View>
        <PressableScale
          accessibilityHint="Sends nothing"
          accessibilityLabel="Dismiss"
          accessibilityRole="button"
          hitSlop={8}
          onPress={onDismiss}
          style={styles.dismiss}
        >
          <SymbolView
            name={{ android: 'close', ios: 'xmark' }}
            size={20}
            tintColor={palette.white}
          />
        </PressableScale>
      </View>
      <View style={styles.answers}>
        <PressableScale
          accessibilityLabel="Not there"
          accessibilityRole="button"
          disabled={busy}
          onPress={() => {
            onAnswer('not-present');
          }}
          style={[styles.answer, styles.answerNo, busy && styles.busy]}
        >
          <Text maxFontSizeMultiplier={1.3} style={styles.answerText}>
            Not there
          </Text>
        </PressableScale>
        <PressableScale
          accessibilityLabel="Still there"
          accessibilityRole="button"
          disabled={busy}
          onPress={() => {
            onAnswer('present');
          }}
          style={[styles.answer, styles.answerYes, busy && styles.busy]}
        >
          <Text maxFontSizeMultiplier={1.3} style={styles.answerText}>
            Still there
          </Text>
        </PressableScale>
      </View>
    </Animated.View>
  );
}

// Guidance chrome uses the fixed guidance palette in both schemes, like the maneuver banner.
const styles = StyleSheet.create({
  answer: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radius.lg,
    flex: 1,
    justifyContent: 'center',
    minHeight: touchTarget.driving,
  },
  answerNo: { backgroundColor: '#3A4A4B' },
  answerText: { ...typography.headline, color: guidanceColors.text, fontSize: 19 },
  answerYes: { backgroundColor: guidanceColors.maneuver },
  answers: { flexDirection: 'row', gap: space.sm },
  busy: { opacity: 0.6 },
  copy: { flex: 1 },
  dismiss: {
    alignItems: 'center',
    backgroundColor: '#3A4A4B',
    borderRadius: radius.pill,
    height: touchTarget.min,
    justifyContent: 'center',
    width: touchTarget.min,
  },
  eyebrow: { ...typography.eyebrow, color: palette.sun },
  meta: { ...typography.callout, color: guidanceColors.textSecondary },
  prompt: {
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
  promptHeader: { alignItems: 'center', flexDirection: 'row', gap: space.md },
  reportAhead: {
    alignItems: 'center',
    backgroundColor: guidanceColors.backgroundRaised,
    borderColor: guidanceColors.border,
    borderCurve: 'continuous',
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: space.md,
    left: space.sm,
    minHeight: REPORT_AHEAD_HEIGHT - space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    position: 'absolute',
    right: space.sm,
    ...elevation.medium,
  },
  reportIcon: {
    alignItems: 'center',
    backgroundColor: palette.sun,
    borderRadius: radius.pill,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  title: { ...typography.title3, color: guidanceColors.text },
});
