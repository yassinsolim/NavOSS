import { Pressable, StyleSheet, Text, View } from 'react-native';

import { createThemedStyles, elevation, radius, space, touchTarget, typography } from '@/theme';
import { haptics } from '@/theme/haptics';

export interface SegmentOption<T extends string> {
  /** Spoken name when the visible label is too terse on its own. */
  accessibilityLabel?: string;
  label: string;
  value: T;
}

export function SegmentedControl<T extends string>({
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
  const styles = useStyles();
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="radiogroup"
      style={styles.track}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            accessibilityLabel={option.accessibilityLabel}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected, selected }}
            key={option.value}
            onPress={() => {
              if (selected) return;
              haptics.selection();
              onChange(option.value);
            }}
            style={({ pressed }) => [
              styles.segment,
              selected && styles.segmentSelected,
              pressed && !selected && styles.pressed,
            ]}
          >
            <Text
              maxFontSizeMultiplier={1.3}
              adjustsFontSizeToFit
              minimumFontScale={0.8}
              numberOfLines={1}
              style={[styles.label, selected && styles.labelSelected]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    label: { ...typography.footnoteStrong, color: colors.textSecondary, fontSize: 14 },
    labelSelected: { color: colors.text },
    pressed: { opacity: 0.6 },
    segment: {
      alignItems: 'center',
      borderRadius: radius.md - 2,
      flex: 1,
      justifyContent: 'center',
      minHeight: touchTarget.min - 6,
      paddingHorizontal: space.xs,
    },
    segmentSelected: { backgroundColor: colors.surfaceRaised, ...elevation.low },
    track: {
      backgroundColor: colors.surfaceSunken,
      borderRadius: radius.md,
      flexDirection: 'row',
      gap: 2,
      minHeight: touchTarget.min,
      padding: 3,
    },
  }),
);
