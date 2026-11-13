import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { createThemedStyles, space, typography, useTheme } from '@/theme';
import { haptics } from '@/theme/haptics';

/**
 * A settings row whose whole width is the switch: one accessible element and a target as wide as
 * the sheet. A disabled row shows its state in `detail` and cannot be toggled.
 */
export function SwitchRow({
  detail,
  disabled = false,
  label,
  onValueChange,
  value,
}: {
  detail?: string;
  disabled?: boolean;
  label: string;
  onValueChange: (value: boolean) => void;
  value: boolean;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const toggle = () => {
    if (disabled) return;
    haptics.selection();
    onValueChange(!value);
  };
  return (
    <Pressable
      accessibilityHint={detail}
      accessibilityLabel={label}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={toggle}
      style={styles.row}
    >
      <View style={styles.copy}>
        <Text style={[styles.label, disabled && styles.labelDisabled]}>{label}</Text>
        {detail !== undefined && <Text style={styles.detail}>{detail}</Text>}
      </View>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Switch
          disabled={disabled}
          onValueChange={toggle}
          trackColor={{ false: colors.borderStrong, true: colors.primary }}
          value={value}
        />
      </View>
    </Pressable>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    copy: { flex: 1, gap: 2, paddingRight: space.md },
    detail: { ...typography.footnote, color: colors.textSecondary },
    label: { ...typography.bodyStrong, color: colors.text },
    labelDisabled: { color: colors.textSecondary },
    row: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      minHeight: 52,
      paddingVertical: space.sm,
    },
  }),
);
