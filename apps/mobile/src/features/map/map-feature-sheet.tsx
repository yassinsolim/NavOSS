import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { CommunityReportAction } from '@/features/community/community';
import type { MapFeatureDetail } from '@/features/map/controller/use-map-controller';
import { createThemedStyles, radius, space, typography, useTheme } from '@/theme';
import { Button, type SymbolName } from '@/ui/button';
import { ModalSheet } from '@/ui/sheet/modal-sheet';
import { SheetHeader } from '@/ui/sheet/sheet-header';

/**
 * Details for a tapped overlay feature: an official road event, an enforcement camera, a traffic
 * webcam or a public safety facility. The body is the source's own wording plus NavOSS's
 * statement of what the data is and is not. A driver report adds its own actions: "Still there"
 * and "Not there" when the driver may answer, or "Withdraw" for their own report.
 */
export function MapFeatureSheet({
  busyAction,
  detail,
  onAction,
  onClose,
  onOpenLink,
}: {
  /** The action whose request is in flight; every action is disabled meanwhile. */
  busyAction: CommunityReportAction | undefined;
  detail: MapFeatureDetail | undefined;
  onAction: (action: CommunityReportAction) => void;
  onClose: () => void;
  onOpenLink: (url: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  // Keeps the last detail rendered while the sheet animates away.
  const [lastDetail, setLastDetail] = useState(detail);
  if (detail !== undefined && detail !== lastDetail) setLastDetail(detail);
  const shown = detail ?? lastDetail;

  return (
    <ModalSheet
      accessibilityLabel={shown?.title}
      detents={['content']}
      onClose={onClose}
      visible={detail !== undefined}
    >
      {shown !== undefined && (
        <View style={{ paddingBottom: Math.max(insets.bottom, space.lg) }}>
          <SheetHeader
            closeLabel="Close"
            eyebrow={shown.eyebrow}
            onClose={onClose}
            title={shown.title}
            titleLines={3}
          />
          <View style={styles.body}>
            <View style={styles.iconWell}>
              <SymbolView name={shown.icon} size={22} tintColor={colors.textSecondary} />
            </View>
            <Text selectable style={styles.bodyText}>
              {shown.body}
            </Text>
          </View>
          {shown.actions !== undefined && shown.actions.length > 0 && (
            <View style={styles.actions}>
              {shown.actions.map((action) => (
                <Button
                  disabled={busyAction !== undefined}
                  icon={ACTION_ICONS[action]}
                  key={action}
                  label={ACTION_LABELS[action]}
                  loading={busyAction === action}
                  onPress={() => {
                    onAction(action);
                  }}
                  size="driving"
                  style={styles.action}
                  variant={
                    action === 'withdraw'
                      ? 'dangerTonal'
                      : action === 'present'
                        ? 'primary'
                        : 'secondary'
                  }
                />
              ))}
            </View>
          )}
          {shown.actionHint !== undefined && (
            <Text style={styles.actionHint}>{shown.actionHint}</Text>
          )}
          {shown.link !== undefined && (
            <Button
              accessibilityRole="link"
              icon={{ android: 'open_in_new', ios: 'arrow.up.right' }}
              label={shown.link.label}
              onPress={() => {
                if (shown.link !== undefined) onOpenLink(shown.link.url);
              }}
              style={styles.link}
              variant="tonal"
            />
          )}
        </View>
      )}
    </ModalSheet>
  );
}

const ACTION_LABELS: Readonly<Record<CommunityReportAction, string>> = {
  'not-present': 'Not there',
  present: 'Still there',
  withdraw: 'Withdraw report',
};

const ACTION_ICONS: Readonly<Record<CommunityReportAction, SymbolName>> = {
  'not-present': { android: 'close', ios: 'xmark' },
  present: { android: 'check', ios: 'checkmark' },
  withdraw: { android: 'undo', ios: 'arrow.uturn.backward' },
};

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    action: { flex: 1 },
    actionHint: {
      ...typography.footnote,
      color: colors.textSecondary,
      paddingBottom: space.md,
      paddingHorizontal: space.lg,
    },
    actions: {
      flexDirection: 'row',
      gap: space.sm,
      paddingBottom: space.md,
      paddingHorizontal: space.lg,
    },
    body: {
      flexDirection: 'row',
      gap: space.md,
      paddingBottom: space.lg,
      paddingHorizontal: space.lg,
    },
    bodyText: { ...typography.body, color: colors.text, flex: 1 },
    iconWell: {
      alignItems: 'center',
      backgroundColor: colors.surfaceSunken,
      borderRadius: radius.md,
      height: 44,
      justifyContent: 'center',
      width: 44,
    },
    link: { marginHorizontal: space.lg },
  }),
);
