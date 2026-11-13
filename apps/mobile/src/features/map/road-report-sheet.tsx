import { SymbolView } from 'expo-symbols';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ROAD_REPORT_TYPES, type RoadReportType } from '@/features/map/road-report-drafts';
import { createThemedStyles, radius, space, typography, useTheme } from '@/theme';
import { Banner } from '@/ui/banner';
import { PressableScale } from '@/ui/pressable-scale';
import { ModalSheet } from '@/ui/sheet/modal-sheet';
import { SheetHeader } from '@/ui/sheet/sheet-header';

interface RoadReportSheetProps {
  isSaving: boolean;
  onCancel: () => void;
  onSelect: (type: RoadReportType) => void;
  visible: boolean;
}

/**
 * The report picker: eight large targets, one tap to record. The notice states exactly what
 * happens to a report today.
 *
 * Wave 2 seam: when reports are shared, this picker stays as it is; only the notice copy and
 * `handleSaveRoadReport` in the controller change, together.
 */
export function RoadReportSheet({ isSaving, onCancel, onSelect, visible }: RoadReportSheetProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();

  return (
    <ModalSheet
      accessibilityLabel="Road report"
      detents={['content']}
      onClose={onCancel}
      visible={visible}
    >
      <View style={{ paddingBottom: Math.max(insets.bottom, space.lg) }}>
        <SheetHeader
          closeLabel="Cancel report"
          eyebrow="Road report"
          onClose={onCancel}
          title="What did you pass?"
        />
        <View style={styles.options}>
          {ROAD_REPORT_TYPES.map((type) => (
            <PressableScale
              accessibilityLabel={`Report ${type.label}`}
              accessibilityRole="button"
              disabled={isSaving}
              key={type.id}
              onPress={() => {
                onSelect(type.id);
              }}
              style={[styles.option, isSaving && styles.disabled]}
            >
              <View style={styles.optionIcon}>
                <SymbolView name={type.icon} size={24} tintColor={colors.onSun} />
              </View>
              <Text numberOfLines={2} style={styles.optionLabel}>
                {type.label}
              </Text>
            </PressableScale>
          ))}
        </View>
        <Banner
          icon={{ android: 'science', ios: 'flask.fill' }}
          message="Testing mode: this report expires in two hours, stays on this phone, and is not shown to other drivers yet. Report only while stopped or as a passenger."
          style={styles.notice}
        />
      </View>
    </ModalSheet>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    disabled: { opacity: 0.45 },
    notice: { marginHorizontal: space.lg, marginTop: space.lg },
    option: {
      alignItems: 'center',
      backgroundColor: colors.surfaceSunken,
      borderCurve: 'continuous',
      borderRadius: radius.lg,
      flexBasis: '22%',
      flexGrow: 1,
      gap: space.sm,
      minHeight: 104,
      paddingHorizontal: space.xs,
      paddingVertical: space.md,
    },
    optionIcon: {
      alignItems: 'center',
      backgroundColor: colors.sun,
      borderRadius: radius.pill,
      height: 48,
      justifyContent: 'center',
      width: 48,
    },
    optionLabel: { ...typography.footnoteStrong, color: colors.text, textAlign: 'center' },
    options: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingHorizontal: space.lg },
  }),
);
