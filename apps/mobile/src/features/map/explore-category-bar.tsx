import { SymbolView } from 'expo-symbols';
import { Modal, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';

import { NavOssColors, NavOssFonts } from '@/constants/navoss-theme';
import {
  EXPLORE_CATEGORY_GROUPS,
  type ExploreCategory,
  QUICK_EXPLORE_CATEGORIES,
} from '@/features/map/explore-categories';

interface ExploreCategoryBarProps {
  onCategoryPress: (category: ExploreCategory) => void;
  onCloseMore: () => void;
  onOpenMore: () => void;
  onWorkPress: () => void;
  selectedCategoryId?: string;
  settingWork: boolean;
  showMore: boolean;
  workSaved: boolean;
}

function QuickAction({
  category,
  onPress,
  selected,
}: {
  category: ExploreCategory;
  onPress: () => void;
  selected: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={`Find ${category.label}`}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.quickAction,
        selected && styles.quickActionSelected,
        pressed && styles.pressed,
      ]}
    >
      <SymbolView
        name={category.icon}
        size={17}
        tintColor={selected ? NavOssColors.white : NavOssColors.green}
      />
      <Text style={[styles.quickActionText, selected && styles.quickActionTextSelected]}>
        {category.label}
      </Text>
    </Pressable>
  );
}

export function ExploreCategoryBar({
  onCategoryPress,
  onCloseMore,
  onOpenMore,
  onWorkPress,
  selectedCategoryId,
  settingWork,
  showMore,
  workSaved,
}: ExploreCategoryBarProps) {
  return (
    <>
      <ScrollView
        accessibilityLabel="Explore nearby"
        contentContainerStyle={styles.quickActions}
        horizontal
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
        style={styles.quickScroller}
      >
        <Pressable
          accessibilityHint={workSaved ? 'Opens your saved Work place' : 'Starts Work setup'}
          accessibilityLabel={workSaved ? 'Work' : 'Set up Work'}
          accessibilityState={{ selected: settingWork }}
          onPress={onWorkPress}
          style={({ pressed }) => [
            styles.quickAction,
            settingWork && styles.quickActionSelected,
            pressed && styles.pressed,
          ]}
        >
          <SymbolView
            name={{ android: 'work', ios: workSaved ? 'briefcase.fill' : 'briefcase' }}
            size={17}
            tintColor={settingWork ? NavOssColors.white : NavOssColors.green}
          />
          <Text style={[styles.quickActionText, settingWork && styles.quickActionTextSelected]}>
            Work
          </Text>
        </Pressable>

        {QUICK_EXPLORE_CATEGORIES.map((category) => (
          <QuickAction
            category={category}
            key={category.id}
            onPress={() => {
              onCategoryPress(category);
            }}
            selected={selectedCategoryId === category.id}
          />
        ))}

        <Pressable
          accessibilityLabel="More categories"
          onPress={onOpenMore}
          style={({ pressed }) => [styles.quickAction, pressed && styles.pressed]}
        >
          <SymbolView
            name={{ android: 'more_horiz', ios: 'ellipsis' }}
            size={18}
            tintColor={NavOssColors.green}
          />
          <Text style={styles.quickActionText}>More</Text>
        </Pressable>
      </ScrollView>

      <Modal
        animationType="slide"
        onRequestClose={onCloseMore}
        presentationStyle="pageSheet"
        visible={showMore}
      >
        <SafeAreaView style={styles.moreScreen}>
          <View style={styles.moreHeader}>
            <View>
              <Text style={styles.moreEyebrow}>EXPLORE</Text>
              <Text style={styles.moreTitle}>More categories</Text>
            </View>
            <Pressable
              accessibilityLabel="Close more categories"
              hitSlop={8}
              onPress={onCloseMore}
              style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
            >
              <SymbolView
                name={{ android: 'close', ios: 'xmark' }}
                size={20}
                tintColor={NavOssColors.asphalt}
              />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.moreContent}>
            {EXPLORE_CATEGORY_GROUPS.map((group) => (
              <View key={group.id} style={styles.categoryGroup}>
                <View style={styles.groupHeading}>
                  <SymbolView name={group.icon} size={20} tintColor={NavOssColors.green} />
                  <Text style={styles.groupTitle}>{group.label}</Text>
                </View>
                <View style={styles.categoryGrid}>
                  {group.categories.map((category) => (
                    <Pressable
                      accessibilityLabel={`Find ${category.label}`}
                      key={category.id}
                      onPress={() => {
                        onCategoryPress(category);
                      }}
                      style={({ pressed }) => [
                        styles.categoryRow,
                        pressed && styles.categoryRowPressed,
                      ]}
                    >
                      <SymbolView name={category.icon} size={19} tintColor={NavOssColors.green} />
                      <Text numberOfLines={2} style={styles.categoryLabel}>
                        {category.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ))}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  categoryGrid: {
    borderBottomColor: NavOssColors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  categoryGroup: {
    gap: 8,
  },
  categoryLabel: {
    color: NavOssColors.asphalt,
    flex: 1,
    fontFamily: NavOssFonts.medium,
    fontSize: 15,
    letterSpacing: 0,
    lineHeight: 19,
  },
  categoryRow: {
    alignItems: 'center',
    borderTopColor: NavOssColors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 11,
    minHeight: 58,
    paddingHorizontal: 10,
    width: '50%',
  },
  categoryRowPressed: {
    backgroundColor: NavOssColors.fog,
  },
  closeButton: {
    alignItems: 'center',
    backgroundColor: NavOssColors.fog,
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  groupHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 9,
    paddingHorizontal: 2,
  },
  groupTitle: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.bold,
    fontSize: 20,
    letterSpacing: 0,
  },
  moreContent: {
    gap: 32,
    paddingBottom: 48,
    paddingHorizontal: 18,
    paddingTop: 24,
  },
  moreEyebrow: {
    color: NavOssColors.green,
    fontFamily: NavOssFonts.bold,
    fontSize: 11,
    letterSpacing: 0,
  },
  moreHeader: {
    alignItems: 'center',
    borderBottomColor: NavOssColors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 68,
    paddingHorizontal: 18,
  },
  moreScreen: {
    backgroundColor: NavOssColors.paper,
    flex: 1,
  },
  moreTitle: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.bold,
    fontSize: 24,
    letterSpacing: 0,
  },
  pressed: {
    opacity: 0.72,
    transform: [{ scale: 0.97 }],
  },
  quickAction: {
    alignItems: 'center',
    backgroundColor: NavOssColors.white,
    borderColor: NavOssColors.border,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 7,
    height: 44,
    paddingHorizontal: 14,
  },
  quickActionSelected: {
    backgroundColor: NavOssColors.green,
    borderColor: NavOssColors.green,
  },
  quickActionText: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.semibold,
    fontSize: 14,
    letterSpacing: 0,
  },
  quickActionTextSelected: {
    color: NavOssColors.white,
  },
  quickActions: {
    gap: 8,
    paddingHorizontal: 14,
  },
  quickScroller: {
    flexGrow: 0,
    marginTop: 10,
  },
});
