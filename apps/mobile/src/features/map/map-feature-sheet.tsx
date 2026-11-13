import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { MapFeatureDetail } from '@/features/map/controller/use-map-controller';
import { createThemedStyles, radius, space, typography, useTheme } from '@/theme';
import { Button } from '@/ui/button';
import { ModalSheet } from '@/ui/sheet/modal-sheet';
import { SheetHeader } from '@/ui/sheet/sheet-header';

/**
 * Details for a tapped overlay feature: an official road event, an enforcement camera, a traffic
 * webcam or a public safety facility. The body is the source's own wording plus NavOSS's
 * statement of what the data is and is not.
 *
 * Wave 2 seam: a community report opens this same sheet. Give `MapFeatureDetail` an optional
 * `actions` list (still there / not there) and render it above the link button.
 */
export function MapFeatureSheet({
  detail,
  onClose,
  onOpenLink,
}: {
  detail: MapFeatureDetail | undefined;
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

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
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
