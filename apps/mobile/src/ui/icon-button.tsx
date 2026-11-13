import { SymbolView } from 'expo-symbols';
import type { ComponentProps, ReactNode } from 'react';
import { type AccessibilityState, type StyleProp, StyleSheet, type ViewStyle } from 'react-native';

import { createThemedStyles, touchTarget, useTheme } from '@/theme';
import type { SymbolName } from '@/ui/button';
import { GlassSurface, supportsLiquidGlass } from '@/ui/glass-surface';
import { PressableScale } from '@/ui/pressable-scale';

export type IconButtonVariant = 'danger' | 'floating' | 'plain' | 'primary' | 'tonal' | 'well';

export interface IconButtonProps {
  accessibilityHint?: string;
  accessibilityLabel: string;
  accessibilityState?: AccessibilityState;
  animationSpec?: ComponentProps<typeof SymbolView>['animationSpec'];
  /** Replaces the symbol, e.g. a rotating compass needle. */
  children?: ReactNode;
  disabled?: boolean;
  icon: SymbolName;
  iconSize?: number;
  onPress: () => void;
  selected?: boolean;
  /** Diameter. Never below the 44pt minimum. */
  size?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  tintColor?: string;
  variant?: IconButtonVariant;
}

export function IconButton({
  accessibilityHint,
  accessibilityLabel,
  accessibilityState,
  animationSpec,
  children,
  disabled = false,
  icon,
  iconSize,
  onPress,
  selected = false,
  size = touchTarget.min,
  style,
  testID,
  tintColor,
  variant = 'well',
}: IconButtonProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const diameter = Math.max(size, touchTarget.min);
  const shape = { borderRadius: diameter / 2, height: diameter, width: diameter };
  const tint =
    tintColor ??
    (selected || variant === 'primary'
      ? colors.onPrimary
      : variant === 'danger'
        ? colors.onDanger
        : variant === 'tonal'
          ? colors.primaryText
          : colors.text);
  const symbol = children ?? (
    <SymbolView
      animationSpec={animationSpec}
      name={icon}
      size={iconSize ?? Math.round(diameter * 0.46)}
      tintColor={tint}
    />
  );
  const floatingGlass = variant === 'floating' && !selected && supportsLiquidGlass();

  return (
    <PressableScale
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ ...accessibilityState, disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      pressedScale={0.92}
      style={[
        styles.base,
        shape,
        !floatingGlass && styles[variant],
        selected && styles.selected,
        disabled && styles.disabled,
        style,
      ]}
      testID={testID}
    >
      {floatingGlass ? (
        <GlassSurface interactive style={[styles.glass, shape]}>
          {symbol}
        </GlassSurface>
      ) : (
        symbol
      )}
    </PressableScale>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    base: { alignItems: 'center', justifyContent: 'center' },
    danger: { backgroundColor: colors.danger },
    disabled: { opacity: 0.45 },
    floating: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: StyleSheet.hairlineWidth,
      shadowColor: '#000000',
      shadowOffset: { height: 3, width: 0 },
      shadowOpacity: 0.16,
      shadowRadius: 10,
    },
    glass: { alignItems: 'center', justifyContent: 'center' },
    plain: { backgroundColor: 'transparent' },
    primary: { backgroundColor: colors.primary },
    selected: { backgroundColor: colors.primary, borderColor: colors.primary },
    tonal: { backgroundColor: colors.primarySoft },
    well: { backgroundColor: colors.surfaceSunken },
  }),
);
