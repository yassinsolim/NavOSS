import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  type MapPreferences,
  type MapStylePreset,
  type NavigationViewMode,
  type RouteColor,
  ROUTE_COLORS,
} from '@/features/map/map-preferences';
import { fullSheetHeight, type ScreenMetrics } from '@/features/map/overlay-layout';
import type { NavigationMapOrientation } from '@/features/navigation/navigation-camera';
import { createThemedStyles, radius, space, touchTarget, typography, useTheme } from '@/theme';
import { haptics } from '@/theme/haptics';
import { ListRow } from '@/ui/list-row';
import { type SegmentOption, SegmentedControl } from '@/ui/segmented-control';
import { BottomSheetScrollView } from '@/ui/sheet/bottom-sheet';
import { ModalSheet } from '@/ui/sheet/modal-sheet';
import { SectionTitle, SheetHeader } from '@/ui/sheet/sheet-header';

const STYLE_OPTIONS: readonly SegmentOption<MapStylePreset>[] = [
  { label: 'Auto', value: 'automatic' },
  { label: 'Day', value: 'day' },
  { label: 'Night', value: 'night' },
  { label: 'Contrast', value: 'contrast' },
  { label: 'Minimal', value: 'minimal' },
];

const ORIENTATION_OPTIONS: readonly SegmentOption<NavigationMapOrientation>[] = [
  { label: 'Heading up', value: 'heading-up' },
  { label: 'North up', value: 'north-up' },
];

const VIEW_OPTIONS: readonly SegmentOption<NavigationViewMode>[] = [
  { label: 'Tilted', value: 'tilted' },
  { label: 'Flat', value: 'flat' },
];

const ROUTE_COLOR_OPTIONS: readonly { label: string; value: RouteColor }[] = [
  { label: 'Green route', value: 'green' },
  { label: 'Blue route', value: 'blue' },
  { label: 'Coral route', value: 'coral' },
  { label: 'Violet route', value: 'violet' },
];

function PreferenceSwitch({
  detail,
  label,
  onValueChange,
  value,
}: {
  detail?: string;
  label: string;
  onValueChange: (value: boolean) => void;
  value: boolean;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const toggle = () => {
    haptics.selection();
    onValueChange(!value);
  };
  // The whole row is the switch: one accessible element, and a target as wide as the sheet.
  return (
    <Pressable
      accessibilityHint={detail}
      accessibilityLabel={label}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      onPress={toggle}
      style={styles.switchRow}
    >
      <View style={styles.switchCopy}>
        <Text style={styles.switchLabel}>{label}</Text>
        {detail !== undefined && <Text style={styles.switchDetail}>{detail}</Text>}
      </View>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Switch
          onValueChange={toggle}
          trackColor={{ false: colors.borderStrong, true: colors.primary }}
          value={value}
        />
      </View>
    </Pressable>
  );
}

/**
 * Map appearance. Every control applies immediately. Only the map style and the three basemap
 * layer switches rebuild the style; route colour, orientation, view and the overlay switches
 * repaint NavOSS's own layers and leave the basemap alone.
 *
 * Wave 2 seam: the opt-in "Traffic" overlay switch belongs in "Map content" (it needs a
 * `showTraffic` flag in `MapPreferences` and `normalizeMapPreferences`).
 */
export function MapPreferencesSheet({
  metrics,
  onChange,
  onClose,
  onClosed,
  onOpenGuidanceSettings,
  onOpenOfflineMaps,
  preferences,
  visible,
}: {
  metrics: ScreenMetrics;
  onChange: (preferences: MapPreferences) => void;
  onClose: () => void;
  /** Called after the sheet has left the screen, when another sheet may be presented. */
  onClosed: () => void;
  onOpenGuidanceSettings: () => void;
  onOpenOfflineMaps: () => void;
  preferences: MapPreferences;
  visible: boolean;
}) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();

  return (
    <ModalSheet
      accessibilityLabel="Map appearance"
      detents={[Math.round(metrics.windowHeight * 0.64), fullSheetHeight(metrics)]}
      onClose={onClose}
      onClosed={onClosed}
      visible={visible}
    >
      <SheetHeader closeLabel="Close map appearance" onClose={onClose} title="Map appearance" />
      <BottomSheetScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxl }]}
      >
        <View style={styles.section}>
          <SectionTitle>Map style</SectionTitle>
          <SegmentedControl
            accessibilityLabel="Map style"
            onChange={(stylePreset) => {
              onChange({ ...preferences, stylePreset });
            }}
            options={STYLE_OPTIONS}
            value={preferences.stylePreset}
          />
          <Text style={styles.hint}>Auto follows the system light or dark appearance.</Text>
        </View>

        <View style={styles.section}>
          <SectionTitle>Navigation view</SectionTitle>
          <SegmentedControl
            accessibilityLabel="Navigation orientation"
            onChange={(navigationOrientation) => {
              onChange({ ...preferences, navigationOrientation });
            }}
            options={ORIENTATION_OPTIONS}
            value={preferences.navigationOrientation}
          />
          <SegmentedControl
            accessibilityLabel="Navigation view"
            onChange={(navigationView) => {
              onChange({ ...preferences, navigationView });
            }}
            options={VIEW_OPTIONS}
            value={preferences.navigationView}
          />
        </View>

        <View style={styles.section}>
          <SectionTitle>Map content</SectionTitle>
          <View style={styles.card}>
            <PreferenceSwitch
              label="Places"
              onValueChange={(showPlaces) => {
                onChange({ ...preferences, showPlaces });
              }}
              value={preferences.showPlaces}
            />
            <PreferenceSwitch
              label="Buildings"
              onValueChange={(showBuildings) => {
                onChange({ ...preferences, showBuildings });
              }}
              value={preferences.showBuildings}
            />
            <PreferenceSwitch
              label="Transit"
              onValueChange={(showTransit) => {
                onChange({ ...preferences, showTransit });
              }}
              value={preferences.showTransit}
            />
            <PreferenceSwitch
              detail="Closures, construction and incidents published by regional road authorities"
              label="Road events"
              onValueChange={(showRoadEvents) => {
                onChange({ ...preferences, showRoadEvents });
              }}
              value={preferences.showRoadEvents}
            />
            <PreferenceSwitch
              detail="Official enforcement cameras and traffic webcams"
              label="Camera markers"
              onValueChange={(showSafetyCameras) => {
                onChange({ ...preferences, showSafetyCameras });
              }}
              value={preferences.showSafetyCameras}
            />
          </View>
        </View>

        <View style={styles.section}>
          <SectionTitle>Route colour</SectionTitle>
          <View
            accessibilityLabel="Route color"
            accessibilityRole="radiogroup"
            style={styles.swatchRow}
          >
            {ROUTE_COLOR_OPTIONS.map((option) => {
              const selected = option.value === preferences.routeColor;
              return (
                <Pressable
                  accessibilityLabel={option.label}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected, selected }}
                  key={option.value}
                  onPress={() => {
                    if (!selected) haptics.selection();
                    onChange({ ...preferences, routeColor: option.value });
                  }}
                  style={({ pressed }) => [
                    styles.swatchButton,
                    selected && styles.swatchButtonSelected,
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={[styles.swatch, { backgroundColor: ROUTE_COLORS[option.value] }]} />
                </Pressable>
              );
            })}
          </View>
        </View>
        <View style={styles.section}>
          <SectionTitle>Guidance</SectionTitle>
          <View style={styles.linkCard}>
            <ListRow
              accessibilityLabel="Guidance settings"
              icon={{ android: 'tune', ios: 'slider.horizontal.3' }}
              onPress={onOpenGuidanceSettings}
              subtitle="Sound, rerouting and speed warning"
              title="Guidance settings"
              trailing="chevron"
            />
          </View>
        </View>
        <View style={styles.section}>
          <SectionTitle>Offline</SectionTitle>
          <View style={styles.linkCard}>
            <ListRow
              accessibilityLabel="Offline maps"
              icon={{ android: 'download_for_offline', ios: 'arrow.down.circle' }}
              onPress={onOpenOfflineMaps}
              subtitle="Download regions for use without a connection"
              title="Offline maps"
              trailing="chevron"
            />
          </View>
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
      paddingHorizontal: space.lg,
    },
    content: { gap: space.xl, paddingHorizontal: space.lg },
    linkCard: {
      backgroundColor: colors.surfaceSunken,
      borderCurve: 'continuous',
      borderRadius: radius.lg,
      padding: space.xs,
    },
    hint: { ...typography.footnote, color: colors.textTertiary },
    pressed: { opacity: 0.7 },
    section: { gap: space.sm },
    swatch: { borderRadius: radius.pill, height: 30, width: 30 },
    swatchButton: {
      alignItems: 'center',
      borderColor: 'transparent',
      borderRadius: radius.pill,
      borderWidth: 3,
      height: touchTarget.min + 4,
      justifyContent: 'center',
      width: touchTarget.min + 4,
    },
    swatchButtonSelected: { borderColor: colors.text },
    swatchRow: { flexDirection: 'row', gap: space.md },
    switchCopy: { flex: 1, gap: 2, paddingRight: space.md },
    switchDetail: { ...typography.footnote, color: colors.textSecondary },
    switchLabel: { ...typography.bodyStrong, color: colors.text },
    switchRow: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      minHeight: 52,
      paddingVertical: space.sm,
    },
  }),
);
