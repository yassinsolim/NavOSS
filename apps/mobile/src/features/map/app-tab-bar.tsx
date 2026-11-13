import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { ReduceMotion, useAnimatedStyle, withTiming } from 'react-native-reanimated';

import { TAB_BAR_HEIGHT } from '@/features/map/overlay-layout';
import { createThemedStyles, motion, radius, space, typography, useTheme } from '@/theme';
import { haptics } from '@/theme/haptics';

export type AppTab = 'contribute' | 'explore' | 'saved';

const TABS = [
  { icon: { android: 'explore', ios: 'safari.fill' }, id: 'explore', label: 'Explore' },
  { icon: { android: 'bookmark', ios: 'bookmark.fill' }, id: 'saved', label: 'Saved places' },
  {
    icon: { android: 'add_circle', ios: 'plus.circle.fill' },
    id: 'contribute',
    label: 'Contribute',
  },
] as const;

function TabButton({
  onPress,
  selected,
  tab,
}: {
  onPress: () => void;
  selected: boolean;
  tab: (typeof TABS)[number];
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const selectedFill = colors.primarySoft;
  const wellStyle = useAnimatedStyle(
    () => ({
      backgroundColor: withTiming(selected ? selectedFill : 'transparent', {
        duration: motion.duration.fast,
        reduceMotion: ReduceMotion.System,
      }),
    }),
    [selected, selectedFill],
  );

  return (
    <Pressable
      accessibilityLabel={tab.label}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={styles.tab}
    >
      <Animated.View style={[styles.iconWell, wellStyle]}>
        <SymbolView
          name={tab.icon}
          size={20}
          tintColor={selected ? colors.primaryText : colors.textTertiary}
        />
      </Animated.View>
      <Text style={[styles.label, selected && styles.labelSelected]}>{tab.label}</Text>
    </Pressable>
  );
}

/** The three top-level destinations. It sits under the explore sheet, which rests on it. */
export function AppTabBar({
  activeTab,
  bottomInset,
  onSelect,
}: {
  activeTab: AppTab;
  bottomInset: number;
  onSelect: (tab: AppTab) => void;
}) {
  const styles = useStyles();
  return (
    <View
      accessibilityRole="tablist"
      style={[styles.bar, { height: TAB_BAR_HEIGHT + bottomInset, paddingBottom: bottomInset }]}
    >
      {TABS.map((tab) => (
        <TabButton
          key={tab.id}
          onPress={() => {
            if (tab.id !== activeTab) haptics.selection();
            onSelect(tab.id);
          }}
          selected={tab.id === activeTab}
          tab={tab}
        />
      ))}
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) =>
  StyleSheet.create({
    bar: {
      backgroundColor: colors.surface,
      borderTopColor: colors.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      bottom: 0,
      flexDirection: 'row',
      left: 0,
      position: 'absolute',
      right: 0,
    },
    iconWell: {
      alignItems: 'center',
      borderRadius: radius.pill,
      height: 30,
      justifyContent: 'center',
      width: 60,
    },
    label: { ...typography.caption, color: colors.textTertiary, fontSize: 11 },
    labelSelected: { color: colors.primaryText },
    tab: {
      alignItems: 'center',
      flex: 1,
      gap: space.xxs,
      height: TAB_BAR_HEIGHT,
      justifyContent: 'center',
    },
  }),
);
