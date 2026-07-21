import { SymbolView } from 'expo-symbols';
import {
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';

import { NavOssColors, NavOssFonts } from '@/constants/navoss-theme';
import {
  type MapPreferences,
  type MapStylePreset,
  type NavigationViewMode,
  type RouteColor,
  ROUTE_COLORS,
} from '@/features/map/map-preferences';
import type { NavigationMapOrientation } from '@/features/navigation/navigation-camera';

interface MapPreferencesPanelProps {
  onChange: (preferences: MapPreferences) => void;
  onClose: () => void;
  preferences: MapPreferences;
  visible: boolean;
}

interface SegmentOption<T extends string> {
  label: string;
  value: T;
}

function SegmentedControl<T extends string>({
  accessibilityLabel,
  onChange,
  options,
  value,
}: {
  accessibilityLabel: string;
  onChange: (value: T) => void;
  options: readonly SegmentOption<T>[];
  value: T;
}) {
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="radiogroup"
      style={styles.segmentedControl}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ checked: selected, selected }}
            key={option.value}
            onPress={() => {
              onChange(option.value);
            }}
            style={({ pressed }) => [
              styles.segment,
              selected && styles.segmentSelected,
              pressed && styles.controlPressed,
            ]}
          >
            <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function PreferenceSwitch({
  label,
  onValueChange,
  value,
}: {
  label: string;
  onValueChange: (value: boolean) => void;
  value: boolean;
}) {
  return (
    <View style={styles.switchRow}>
      <Text style={styles.switchLabel}>{label}</Text>
      <Switch
        accessibilityLabel={label}
        onValueChange={onValueChange}
        trackColor={{ false: NavOssColors.border, true: NavOssColors.green }}
        value={value}
      />
    </View>
  );
}

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

export function MapPreferencesPanel({
  onChange,
  onClose,
  preferences,
  visible,
}: MapPreferencesPanelProps) {
  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Map appearance</Text>
          <Pressable
            accessibilityLabel="Close map appearance"
            hitSlop={8}
            onPress={onClose}
            style={({ pressed }) => [styles.closeButton, pressed && styles.controlPressed]}
          >
            <SymbolView
              name={{ android: 'close', ios: 'xmark' }}
              size={20}
              tintColor={NavOssColors.asphalt}
            />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Map style</Text>
            <SegmentedControl
              accessibilityLabel="Map style"
              onChange={(stylePreset) => {
                onChange({ ...preferences, stylePreset });
              }}
              options={STYLE_OPTIONS}
              value={preferences.stylePreset}
            />
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Navigation orientation</Text>
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
            <Text style={styles.sectionTitle}>Map content</Text>
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
              label="Camera markers"
              onValueChange={(showSafetyCameras) => {
                onChange({ ...preferences, showSafetyCameras });
              }}
              value={preferences.showSafetyCameras}
            />
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Route color</Text>
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
                      onChange({ ...preferences, routeColor: option.value });
                    }}
                    style={({ pressed }) => [
                      styles.swatchButton,
                      selected && styles.swatchButtonSelected,
                      pressed && styles.controlPressed,
                    ]}
                  >
                    <View
                      style={[styles.swatch, { backgroundColor: ROUTE_COLORS[option.value] }]}
                    />
                  </Pressable>
                );
              })}
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  closeButton: {
    alignItems: 'center',
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  content: {
    gap: 30,
    paddingBottom: 44,
    paddingHorizontal: 20,
    paddingTop: 28,
  },
  controlPressed: {
    opacity: 0.72,
  },
  header: {
    alignItems: 'center',
    borderBottomColor: NavOssColors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    height: 56,
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  headerTitle: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.bold,
    fontSize: 18,
    letterSpacing: 0,
  },
  screen: {
    backgroundColor: NavOssColors.paper,
    flex: 1,
  },
  section: {
    borderTopColor: NavOssColors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 14,
    paddingTop: 20,
  },
  sectionTitle: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.bold,
    fontSize: 19,
    letterSpacing: 0,
  },
  segment: {
    alignItems: 'center',
    borderRadius: 6,
    flex: 1,
    justifyContent: 'center',
    minHeight: 42,
    minWidth: 68,
    paddingHorizontal: 10,
  },
  segmentSelected: {
    backgroundColor: NavOssColors.white,
    borderColor: NavOssColors.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  segmentText: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.medium,
    fontSize: 14,
    letterSpacing: 0,
    textAlign: 'center',
  },
  segmentTextSelected: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.semibold,
  },
  segmentedControl: {
    backgroundColor: NavOssColors.fog,
    borderRadius: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 3,
    padding: 3,
  },
  swatch: {
    borderColor: NavOssColors.white,
    borderRadius: 16,
    borderWidth: 2,
    height: 32,
    width: 32,
  },
  swatchButton: {
    alignItems: 'center',
    borderColor: 'transparent',
    borderRadius: 23,
    borderWidth: 2,
    height: 46,
    justifyContent: 'center',
    width: 46,
  },
  swatchButtonSelected: {
    borderColor: NavOssColors.asphalt,
  },
  swatchRow: {
    flexDirection: 'row',
    gap: 14,
  },
  switchLabel: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.regular,
    fontSize: 17,
    letterSpacing: 0,
  },
  switchRow: {
    alignItems: 'center',
    borderBottomColor: NavOssColors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 50,
  },
});
