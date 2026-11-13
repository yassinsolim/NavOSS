import { SymbolView } from 'expo-symbols';
import {
  type AccessibilityRole,
  type AccessibilityState,
  type StyleProp,
  StyleSheet,
  Text,
  type ViewStyle,
} from 'react-native';

import { createThemedStyles, radius, space, touchTarget, typography, useTheme } from '@/theme';
import type { SymbolName } from '@/ui/button';
import { PressableScale } from '@/ui/pressable-scale';

export interface ChipProps {
  accessibilityHint?: string;
  accessibilityLabel?: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
  disabled?: boolean;
  icon?: SymbolName;
  label: string;
  onPress: () => void;
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
}

/** A 44pt-tall pill for filters, categories and toggles. Selection is fill plus weight. */
export function Chip({
  accessibilityHint,
  accessibilityLabel,
  accessibilityRole = 'button',
  accessibilityState,
  disabled = false,
  icon,
  label,
  onPress,
  selected = false,
  style,
}: ChipProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const foreground = selected ? colors.onPrimary : colors.text;

  return (
    <PressableScale
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole={accessibilityRole}
      accessibilityState={{ selected, ...accessibilityState, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.chip, selected && styles.selected, disabled && styles.disabled, style]}
    >
      {icon !== undefined && (
        <SymbolView
          name={icon}
          size={17}
          tintColor={selected ? colors.onPrimary : colors.primaryText}
        />
      )}
      <Text
        maxFontSizeMultiplier={1.3}
        numberOfLines={1}
        style={[styles.label, { color: foreground }]}
      >
        {label}
      </Text>
    </PressableScale>
  );
}

const useStyles = createThemedStyles(({ colors, scheme }) =>
  StyleSheet.create({
    chip: {
      alignItems: 'center',
      // Dark `surfaceSunken` is the page background, so a chip on a page would have no shape.
      backgroundColor: scheme === 'dark' ? colors.surfaceRaised : colors.surfaceSunken,
      borderRadius: radius.pill,
      flexDirection: 'row',
      gap: space.sm - 2,
      height: touchTarget.min,
      justifyContent: 'center',
      paddingHorizontal: space.lg - 2,
    },
    disabled: { opacity: 0.45 },
    label: { ...typography.label },
    selected: { backgroundColor: colors.primary },
  }),
);
