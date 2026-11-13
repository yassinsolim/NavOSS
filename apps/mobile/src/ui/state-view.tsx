import { SymbolView } from 'expo-symbols';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  type StyleProp,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';

import { createThemedStyles, space, typography, useTheme } from '@/theme';
import type { SymbolName } from '@/ui/button';

export interface StateViewProps {
  action?: ReactNode;
  /** `row` sits inline in a list; `block` centres in the space a list would have used. */
  layout?: 'block' | 'row';
  message?: string;
  style?: StyleProp<ViewStyle>;
  title: string;
  tone?: 'danger' | 'neutral';
  visual: 'loading' | SymbolName;
}

/** Loading, empty and error states share one shape so a surface never just goes blank. */
export function StateView({
  action,
  layout = 'row',
  message,
  style,
  title,
  tone = 'neutral',
  visual,
}: StateViewProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const block = layout === 'block';

  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole={tone === 'danger' ? 'alert' : undefined}
      style={[block ? styles.block : styles.row, style]}
    >
      {visual === 'loading' ? (
        <ActivityIndicator color={colors.primary} size="small" />
      ) : (
        <SymbolView
          name={visual}
          size={block ? 30 : 20}
          tintColor={tone === 'danger' ? colors.dangerText : colors.textTertiary}
        />
      )}
      <View style={block ? styles.blockCopy : styles.rowCopy}>
        <Text maxFontSizeMultiplier={1.5} style={[styles.title, block && styles.centered]}>
          {title}
        </Text>
        {message !== undefined && (
          <Text maxFontSizeMultiplier={1.5} style={[styles.message, block && styles.centered]}>
            {message}
          </Text>
        )}
      </View>
      {action}
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    block: {
      alignItems: 'center',
      gap: space.md,
      paddingHorizontal: space.xxl,
      paddingVertical: space.xxl,
    },
    blockCopy: { alignItems: 'center', gap: space.xs },
    centered: { textAlign: 'center' },
    message: { ...typography.footnote, color: colors.textSecondary },
    row: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: space.md,
      minHeight: 56,
      paddingHorizontal: space.sm,
      paddingVertical: space.sm,
    },
    rowCopy: { flex: 1, gap: 2 },
    title: { ...typography.label, color: colors.text },
  }),
);
