import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { createThemedStyles, space, typography } from '@/theme';
import { IconButton } from '@/ui/icon-button';

export interface SheetHeaderProps {
  /** Accessibility label of the close button. Omit both to render no close button. */
  closeLabel?: string;
  eyebrow?: string;
  onClose?: () => void;
  subtitle?: string;
  title: string;
  titleLines?: number;
  trailing?: ReactNode;
}

/** Title block shared by every sheet: optional eyebrow, a header-role title, and one close. */
export function SheetHeader({
  closeLabel,
  eyebrow,
  onClose,
  subtitle,
  title,
  titleLines = 2,
  trailing,
}: SheetHeaderProps) {
  const styles = useStyles();
  return (
    <View style={styles.header}>
      <View style={styles.copy}>
        {eyebrow !== undefined && (
          <Text numberOfLines={1} style={styles.eyebrow}>
            {eyebrow}
          </Text>
        )}
        <Text accessibilityRole="header" numberOfLines={titleLines} style={styles.title}>
          {title}
        </Text>
        {subtitle !== undefined && subtitle.length > 0 && (
          <Text numberOfLines={2} style={styles.subtitle}>
            {subtitle}
          </Text>
        )}
      </View>
      {trailing}
      {onClose !== undefined && closeLabel !== undefined && (
        <IconButton
          accessibilityLabel={closeLabel}
          icon={{ android: 'close', ios: 'xmark' }}
          iconSize={16}
          onPress={onClose}
          size={44}
        />
      )}
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    copy: { flex: 1, gap: 2, minWidth: 0 },
    eyebrow: { ...typography.eyebrow, color: colors.primaryText },
    header: {
      alignItems: 'flex-start',
      flexDirection: 'row',
      gap: space.md,
      paddingBottom: space.md,
      paddingHorizontal: space.lg,
      paddingTop: space.xs,
    },
    subtitle: { ...typography.callout, color: colors.textSecondary },
    title: { ...typography.title2, color: colors.text },
  }),
);

export function SectionTitle({ children, trailing }: { children: string; trailing?: ReactNode }) {
  const styles = useSectionStyles();
  return (
    <View style={styles.row}>
      <Text accessibilityRole="header" style={styles.title}>
        {children}
      </Text>
      {trailing}
    </View>
  );
}

const useSectionStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    row: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      minHeight: 28,
    },
    title: { ...typography.eyebrow, color: colors.textSecondary },
  }),
);
