import { SymbolView } from 'expo-symbols';
import type { ReactNode } from 'react';
import {
  type AccessibilityRole,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';

import { createThemedStyles, radius, space, touchTarget, typography, useTheme } from '@/theme';
import type { SymbolName } from '@/ui/button';

export interface ListRowProps {
  accessibilityHint?: string;
  accessibilityLabel?: string;
  accessibilityRole?: AccessibilityRole;
  /** Small line above the title, e.g. "Home". */
  eyebrow?: string;
  icon?: SymbolName;
  iconTint?: string;
  /** Text under the leading icon, e.g. a distance. */
  leadingCaption?: string;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  subtitle?: string;
  subtitleLines?: number;
  title: string;
  titleLines?: number;
  /** `chevron` and `external` are the two standard affordances; anything else is passed in. */
  trailing?: 'chevron' | 'external' | ReactNode;
}

/** One row shape for results, saved places, details and settings links. */
export function ListRow({
  accessibilityHint,
  accessibilityLabel,
  accessibilityRole,
  eyebrow,
  icon,
  iconTint,
  leadingCaption,
  onPress,
  style,
  subtitle,
  subtitleLines = 2,
  title,
  titleLines = 1,
  trailing,
}: ListRowProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const content = (
    <>
      {icon !== undefined && (
        <View style={styles.leading}>
          <View style={styles.iconWell}>
            <SymbolView name={icon} size={19} tintColor={iconTint ?? colors.primaryText} />
          </View>
          {leadingCaption !== undefined && (
            <Text maxFontSizeMultiplier={1.5} numberOfLines={1} style={styles.leadingCaption}>
              {leadingCaption}
            </Text>
          )}
        </View>
      )}
      <View style={styles.copy}>
        {eyebrow !== undefined && (
          <Text maxFontSizeMultiplier={1.5} style={styles.eyebrow}>
            {eyebrow}
          </Text>
        )}
        <Text maxFontSizeMultiplier={1.5} numberOfLines={titleLines} style={styles.title}>
          {title}
        </Text>
        {subtitle !== undefined && subtitle.length > 0 && (
          <Text maxFontSizeMultiplier={1.5} numberOfLines={subtitleLines} style={styles.subtitle}>
            {subtitle}
          </Text>
        )}
      </View>
      {trailing === 'chevron' ? (
        <SymbolView
          name={{ android: 'chevron_right', ios: 'chevron.right' }}
          size={14}
          tintColor={colors.textTertiary}
        />
      ) : trailing === 'external' ? (
        <SymbolView
          name={{ android: 'open_in_new', ios: 'arrow.up.right' }}
          size={14}
          tintColor={colors.primaryText}
        />
      ) : (
        trailing
      )}
    </>
  );

  if (onPress === undefined) {
    return (
      <View accessibilityLabel={accessibilityLabel} style={[styles.row, style]}>
        {content}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole ?? 'button'}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed, style]}
    >
      {content}
    </Pressable>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    copy: { flex: 1, gap: 1, minWidth: 0 },
    eyebrow: { ...typography.caption, color: colors.primaryText },
    iconWell: {
      alignItems: 'center',
      backgroundColor: colors.surfaceSunken,
      borderRadius: radius.md,
      height: 38,
      justifyContent: 'center',
      width: 38,
    },
    leading: { alignItems: 'center', gap: 2, width: 46 },
    leadingCaption: { ...typography.caption, color: colors.textSecondary, fontSize: 11 },
    pressed: { backgroundColor: colors.pressed },
    row: {
      alignItems: 'center',
      borderRadius: radius.md,
      flexDirection: 'row',
      gap: space.md,
      minHeight: touchTarget.min + 12,
      paddingHorizontal: space.sm,
      paddingVertical: space.sm,
    },
    subtitle: { ...typography.footnote, color: colors.textSecondary },
    title: { ...typography.bodyStrong, color: colors.text },
  }),
);
