import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EXPLORE_CATEGORY_GROUPS, type ExploreCategory } from '@/features/map/explore-categories';
import { fullSheetHeight, type ScreenMetrics } from '@/features/map/overlay-layout';
import { createThemedStyles, radius, space, touchTarget, typography, useTheme } from '@/theme';
import { BottomSheetScrollView } from '@/ui/sheet/bottom-sheet';
import { ModalSheet } from '@/ui/sheet/modal-sheet';
import { SheetHeader } from '@/ui/sheet/sheet-header';

/** Every nearby-search category, grouped. Choosing one closes the sheet and runs the search. */
export function CategoriesSheet({
  metrics,
  onCategoryPress,
  onClose,
  visible,
}: {
  metrics: ScreenMetrics;
  onCategoryPress: (category: ExploreCategory) => void;
  onClose: () => void;
  visible: boolean;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();

  return (
    <ModalSheet
      accessibilityLabel="More categories"
      detents={[Math.round(metrics.windowHeight * 0.62), fullSheetHeight(metrics)]}
      onClose={onClose}
      visible={visible}
    >
      <SheetHeader
        closeLabel="Close more categories"
        eyebrow="Explore nearby"
        onClose={onClose}
        title="More categories"
      />
      <BottomSheetScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxl }]}
      >
        {EXPLORE_CATEGORY_GROUPS.map((group) => (
          <View key={group.id} style={styles.group}>
            <View style={styles.groupHeading}>
              <SymbolView
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                name={group.icon}
                size={18}
                tintColor={colors.textSecondary}
              />
              <Text accessibilityRole="header" style={styles.groupTitle}>
                {group.label}
              </Text>
            </View>
            <View style={styles.grid}>
              {group.categories.map((category) => (
                <Pressable
                  accessibilityLabel={`Find ${category.label}`}
                  accessibilityRole="button"
                  key={category.id}
                  onPress={() => {
                    onCategoryPress(category);
                  }}
                  style={({ pressed }) => [styles.cell, pressed && styles.cellPressed]}
                >
                  <SymbolView name={category.icon} size={19} tintColor={colors.primaryText} />
                  <Text numberOfLines={2} style={styles.cellLabel}>
                    {category.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        ))}
      </BottomSheetScrollView>
    </ModalSheet>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    cell: {
      alignItems: 'center',
      backgroundColor: colors.surfaceSunken,
      borderCurve: 'continuous',
      borderRadius: radius.md,
      flexBasis: '47%',
      flexDirection: 'row',
      flexGrow: 1,
      gap: space.sm,
      minHeight: touchTarget.min + 6,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
    },
    cellLabel: { ...typography.label, color: colors.text, flex: 1 },
    cellPressed: { backgroundColor: colors.pressed },
    content: { gap: space.xl, paddingHorizontal: space.lg },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
    group: { gap: space.sm },
    groupHeading: { alignItems: 'center', flexDirection: 'row', gap: space.sm },
    groupTitle: { ...typography.eyebrow, color: colors.textSecondary },
  }),
);
