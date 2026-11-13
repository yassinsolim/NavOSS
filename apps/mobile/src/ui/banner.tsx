import { SymbolView } from 'expo-symbols';
import type { ReactNode } from 'react';
import { type StyleProp, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { createThemedStyles, radius, space, typography, useTheme } from '@/theme';
import type { SymbolName } from '@/ui/button';

export type BannerTone = 'danger' | 'info' | 'neutral' | 'warning';

export interface BannerProps {
  /** A trailing control, usually a small button. */
  action?: ReactNode;
  /** Announce changes to assistive tech. Use for states that appear on their own. */
  announce?: boolean;
  icon?: SymbolName;
  message?: string;
  style?: StyleProp<ViewStyle>;
  title?: string;
  tone?: BannerTone;
}

const DEFAULT_ICONS: Readonly<Record<BannerTone, SymbolName>> = {
  danger: { android: 'error', ios: 'exclamationmark.octagon.fill' },
  info: { android: 'info', ios: 'info.circle.fill' },
  neutral: { android: 'info', ios: 'info.circle.fill' },
  warning: { android: 'warning', ios: 'exclamationmark.triangle.fill' },
};

/** Inline notice for degraded, offline, permission and informational states. */
export function Banner({
  action,
  announce = false,
  icon,
  message,
  style,
  title,
  tone = 'info',
}: BannerProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const tint =
    tone === 'danger'
      ? colors.dangerText
      : tone === 'warning'
        ? colors.warningText
        : tone === 'neutral'
          ? colors.textSecondary
          : colors.primaryText;

  return (
    <View
      accessibilityLiveRegion={announce ? 'polite' : 'none'}
      accessibilityRole={tone === 'danger' && announce ? 'alert' : undefined}
      style={[styles.banner, styles[tone], style]}
    >
      <SymbolView name={icon ?? DEFAULT_ICONS[tone]} size={18} tintColor={tint} />
      <View style={styles.copy}>
        {title !== undefined && <Text style={styles.title}>{title}</Text>}
        {message !== undefined && <Text style={styles.message}>{message}</Text>}
      </View>
      {action}
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    banner: {
      alignItems: 'flex-start',
      borderCurve: 'continuous',
      borderRadius: radius.lg,
      flexDirection: 'row',
      gap: space.md,
      padding: space.md,
    },
    copy: { flex: 1, gap: 2 },
    danger: { backgroundColor: colors.dangerSoft },
    info: { backgroundColor: colors.primarySoft },
    message: { ...typography.footnote, color: colors.textSecondary },
    neutral: { backgroundColor: colors.surfaceSunken },
    title: { ...typography.footnoteStrong, color: colors.text, fontSize: 14 },
    warning: { backgroundColor: colors.warningSoft },
  }),
);
