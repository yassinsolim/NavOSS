import { SymbolView } from 'expo-symbols';
import type { ComponentProps } from 'react';
import {
  ActivityIndicator,
  type AccessibilityRole,
  type AccessibilityState,
  type StyleProp,
  StyleSheet,
  Text,
  type ViewStyle,
} from 'react-native';

import { createThemedStyles, radius, space, touchTarget, typography, useTheme } from '@/theme';
import { PressableScale } from '@/ui/pressable-scale';

export type SymbolName = ComponentProps<typeof SymbolView>['name'];

export type ButtonVariant = 'danger' | 'dangerTonal' | 'ghost' | 'primary' | 'secondary' | 'tonal';

export interface ButtonProps {
  accessibilityHint?: string;
  accessibilityLabel?: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
  disabled?: boolean;
  icon?: SymbolName;
  label: string;
  loading?: boolean;
  onPress: () => void;
  /** `driving` is for controls reached while guidance runs. */
  size?: 'driving' | 'md' | 'sm';
  style?: StyleProp<ViewStyle>;
  testID?: string;
  variant?: ButtonVariant;
}

export function Button({
  accessibilityHint,
  accessibilityLabel,
  accessibilityRole = 'button',
  accessibilityState,
  disabled = false,
  icon,
  label,
  loading = false,
  onPress,
  size = 'md',
  style,
  testID,
  variant = 'primary',
}: ButtonProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const foreground =
    variant === 'primary'
      ? colors.onPrimary
      : variant === 'danger'
        ? colors.onDanger
        : variant === 'dangerTonal'
          ? colors.dangerText
          : variant === 'secondary'
            ? colors.text
            : colors.primaryText;

  return (
    <PressableScale
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole={accessibilityRole}
      accessibilityState={{ ...accessibilityState, busy: loading, disabled }}
      disabled={disabled || loading}
      onPress={onPress}
      pressedScale={0.97}
      style={[
        styles.base,
        size === 'driving' && styles.driving,
        size === 'sm' && styles.small,
        styles[variant],
        disabled && styles.disabled,
        style,
      ]}
      testID={testID}
    >
      {loading ? (
        <ActivityIndicator color={foreground} size="small" />
      ) : (
        icon !== undefined && (
          <SymbolView name={icon} size={size === 'driving' ? 22 : 18} tintColor={foreground} />
        )
      )}
      <Text
        numberOfLines={1}
        style={[size === 'driving' ? styles.labelDriving : styles.label, { color: foreground }]}
      >
        {label}
      </Text>
    </PressableScale>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    base: {
      alignItems: 'center',
      borderCurve: 'continuous',
      borderRadius: radius.lg,
      flexDirection: 'row',
      gap: space.sm,
      justifyContent: 'center',
      minHeight: 50,
      paddingHorizontal: space.xl,
    },
    danger: { backgroundColor: colors.danger },
    dangerTonal: { backgroundColor: colors.dangerSoft },
    disabled: { opacity: 0.45 },
    driving: {
      borderRadius: radius.xl,
      minHeight: touchTarget.driving,
      paddingHorizontal: space.xxl,
    },
    ghost: { backgroundColor: 'transparent' },
    label: { ...typography.label, fontSize: 16 },
    labelDriving: { ...typography.headline, fontSize: 19 },
    primary: { backgroundColor: colors.primary },
    secondary: {
      backgroundColor: colors.surface,
      borderColor: colors.borderStrong,
      borderWidth: StyleSheet.hairlineWidth,
    },
    small: { minHeight: touchTarget.min, paddingHorizontal: space.lg },
    tonal: { backgroundColor: colors.primarySoft },
  }),
);
