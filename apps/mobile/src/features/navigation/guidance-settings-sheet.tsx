import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fullSheetHeight, type ScreenMetrics } from '@/features/map/overlay-layout';
import {
  type GuidanceSettings,
  rerouteModeDescription,
  SPEEDING_TOLERANCES_KPH,
} from '@/features/navigation/guidance-settings';
import type {
  NativeRerouteMode,
  NavigationAudioMode,
} from '@/features/navigation/native-navigation';
import { createThemedStyles, radius, space, typography, useTheme } from '@/theme';
import { haptics } from '@/theme/haptics';
import type { SymbolName } from '@/ui/button';
import { ListRow } from '@/ui/list-row';
import { type SegmentOption, SegmentedControl } from '@/ui/segmented-control';
import { BottomSheetScrollView } from '@/ui/sheet/bottom-sheet';
import { ModalSheet } from '@/ui/sheet/modal-sheet';
import { SectionTitle, SheetHeader } from '@/ui/sheet/sheet-header';

export const AUDIO_MODES: readonly {
  detail: string;
  icon: SymbolName;
  label: string;
  mode: NavigationAudioMode;
}[] = [
  {
    detail: 'Maneuvers and safety alerts',
    icon: { android: 'volume_up', ios: 'speaker.wave.2.fill' },
    label: 'All guidance',
    mode: 'all-guidance',
  },
  {
    detail: 'Safety alerts, no maneuvers',
    icon: { android: 'notifications', ios: 'bell.fill' },
    label: 'Alerts only',
    mode: 'alerts-only',
  },
  {
    detail: 'No spoken guidance',
    icon: { android: 'volume_off', ios: 'speaker.slash.fill' },
    label: 'Muted',
    mode: 'muted',
  },
];

export function audioModeOption(mode: NavigationAudioMode) {
  return AUDIO_MODES.find((option) => option.mode === mode) ?? AUDIO_MODES[0];
}

const REROUTE_OPTIONS: readonly SegmentOption<NativeRerouteMode>[] = [
  { label: 'Automatic', value: 'adaptive' },
  { label: 'Ask first', value: 'ask-first' },
  { label: 'Keep route', value: 'keep-route' },
];

const TOLERANCE_OPTIONS: readonly SegmentOption<string>[] = SPEEDING_TOLERANCES_KPH.map(
  (tolerance) => ({
    accessibilityLabel: `${String(tolerance)} kilometres per hour over the limit`,
    label: tolerance === 0 ? '0' : `+${String(tolerance)}`,
    value: String(tolerance),
  }),
);

/**
 * Guidance settings: what NavOSS speaks, what it does when you leave the route, and when it
 * treats your speed as over the limit. They are stored by the navigation core and shared with
 * CarPlay, so a change here applies in the car too.
 */
export function GuidanceSettingsSheet({
  metrics,
  onChange,
  onClose,
  settings,
  visible,
}: {
  metrics: ScreenMetrics;
  onChange: (settings: GuidanceSettings) => void;
  onClose: () => void;
  settings: GuidanceSettings;
  visible: boolean;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const toggleAudible = () => {
    haptics.selection();
    onChange({ ...settings, speedingAudibleWarning: !settings.speedingAudibleWarning });
  };

  return (
    <ModalSheet
      accessibilityLabel="Guidance settings"
      detents={[Math.round(metrics.windowHeight * 0.66), fullSheetHeight(metrics)]}
      onClose={onClose}
      visible={visible}
    >
      <SheetHeader
        closeLabel="Close guidance settings"
        onClose={onClose}
        subtitle="Shared with CarPlay."
        title="Guidance settings"
      />
      <BottomSheetScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxl }]}
      >
        <View style={styles.section}>
          <SectionTitle>Sound</SectionTitle>
          <View accessibilityRole="radiogroup" style={styles.card}>
            {AUDIO_MODES.map((option) => {
              const selected = option.mode === settings.audioMode;
              return (
                <ListRow
                  accessibilityLabel={`${option.label}, ${option.detail}${selected ? ', selected' : ''}`}
                  accessibilityRole="radio"
                  icon={option.icon}
                  key={option.mode}
                  onPress={() => {
                    if (!selected) haptics.selection();
                    onChange({ ...settings, audioMode: option.mode });
                  }}
                  subtitle={option.detail}
                  title={option.label}
                  trailing={
                    selected ? (
                      <SymbolView
                        name={{ android: 'check', ios: 'checkmark' }}
                        size={18}
                        tintColor={colors.primaryText}
                      />
                    ) : undefined
                  }
                />
              );
            })}
          </View>
        </View>

        <View style={styles.section}>
          <SectionTitle>When you leave the route</SectionTitle>
          <SegmentedControl
            accessibilityLabel="When you leave the route"
            onChange={(rerouteMode) => {
              onChange({ ...settings, rerouteMode });
            }}
            options={REROUTE_OPTIONS}
            value={settings.rerouteMode}
          />
          <Text accessibilityLiveRegion="polite" style={styles.hint}>
            {rerouteModeDescription(settings.rerouteMode)}
          </Text>
        </View>

        <View style={styles.section}>
          <SectionTitle>Speed warning</SectionTitle>
          <Text style={styles.fieldLabel}>Show as over the limit above (km/h)</Text>
          <SegmentedControl
            accessibilityLabel="Speed warning tolerance"
            onChange={(tolerance) => {
              onChange({ ...settings, speedingToleranceKph: Number(tolerance) });
            }}
            options={TOLERANCE_OPTIONS}
            value={String(settings.speedingToleranceKph)}
          />
          <View style={styles.card}>
            <Pressable
              accessibilityHint="Speaks the limit when your speed goes over it by more than the tolerance"
              accessibilityLabel="Audible speed warning"
              accessibilityRole="switch"
              accessibilityState={{ checked: settings.speedingAudibleWarning }}
              onPress={toggleAudible}
              style={styles.switchRow}
            >
              <View style={styles.switchCopy}>
                <Text style={styles.switchLabel}>Audible speed warning</Text>
                <Text style={styles.hint}>
                  Speaks the limit when you go over it by more than the tolerance.
                </Text>
              </View>
              <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                <Switch
                  onValueChange={toggleAudible}
                  trackColor={{ false: colors.borderStrong, true: colors.primary }}
                  value={settings.speedingAudibleWarning}
                />
              </View>
            </Pressable>
          </View>
          <Text style={styles.hint}>
            Limits come from route data and can be missing or out of date. Posted signs always take
            priority.
          </Text>
        </View>
      </BottomSheetScrollView>
    </ModalSheet>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.surfaceSunken,
      borderCurve: 'continuous',
      borderRadius: radius.lg,
      padding: space.xs,
    },
    content: { gap: space.xl, paddingHorizontal: space.lg },
    fieldLabel: { ...typography.label, color: colors.text },
    hint: { ...typography.footnote, color: colors.textSecondary },
    section: { gap: space.sm },
    switchCopy: { flex: 1, gap: 2, paddingRight: space.md },
    switchLabel: { ...typography.bodyStrong, color: colors.text },
    switchRow: {
      alignItems: 'center',
      flexDirection: 'row',
      minHeight: 56,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
    },
  }),
);
