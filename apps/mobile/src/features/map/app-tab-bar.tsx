import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { ReduceMotion, useAnimatedStyle, withTiming } from 'react-native-reanimated';

import { NavOssColors, NavOssFonts } from '@/constants/navoss-theme';
import { Spacing } from '@/constants/theme';

export type AppTab = 'contribute' | 'explore' | 'saved';

const TABS = [
  {
    icon: { android: 'explore', ios: 'safari.fill' },
    id: 'explore',
    label: 'Explore',
  },
  {
    icon: { android: 'bookmark', ios: 'bookmark.fill' },
    id: 'saved',
    label: 'Saved places',
  },
  {
    icon: { android: 'add_circle', ios: 'plus.circle.fill' },
    id: 'contribute',
    label: 'Contribute',
  },
] as const;

export const APP_TAB_BAR_HEIGHT = 62;

function TabButton({
  onPress,
  selected,
  tab,
}: {
  onPress: () => void;
  selected: boolean;
  tab: (typeof TABS)[number];
}) {
  const animatedIconStyle = useAnimatedStyle(
    () => ({
      backgroundColor: withTiming(selected ? NavOssColors.sky : NavOssColors.paper, {
        duration: 160,
        reduceMotion: ReduceMotion.System,
      }),
    }),
    [selected],
  );

  return (
    <Pressable
      accessibilityLabel={tab.label}
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.tab, pressed && styles.pressed]}
    >
      <Animated.View style={[styles.iconWell, animatedIconStyle]}>
        <SymbolView
          name={tab.icon}
          size={21}
          tintColor={selected ? NavOssColors.green : NavOssColors.muted}
        />
      </Animated.View>
      <Text style={[styles.label, selected && styles.labelSelected]}>{tab.label}</Text>
    </Pressable>
  );
}

export function AppTabBar({
  activeTab,
  bottomInset,
  onSelect,
}: {
  activeTab: AppTab;
  bottomInset: number;
  onSelect: (tab: AppTab) => void;
}) {
  return (
    <View
      style={[styles.bar, { height: APP_TAB_BAR_HEIGHT + bottomInset, paddingBottom: bottomInset }]}
    >
      {TABS.map((tab) => {
        const selected = tab.id === activeTab;
        return (
          <TabButton
            key={tab.id}
            onPress={() => {
              onSelect(tab.id);
            }}
            selected={selected}
            tab={tab}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignItems: 'center',
    backgroundColor: NavOssColors.paper,
    borderTopColor: NavOssColors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    bottom: 0,
    flexDirection: 'row',
    left: 0,
    position: 'absolute',
    right: 0,
    shadowColor: NavOssColors.asphalt,
    shadowOffset: { height: -Spacing.half, width: 0 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    zIndex: 50,
  },
  iconWell: {
    alignItems: 'center',
    borderRadius: Spacing.three,
    height: Spacing.five,
    justifyContent: 'center',
    width: 56,
  },
  label: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.medium,
    fontSize: 12,
    letterSpacing: 0,
  },
  labelSelected: {
    color: NavOssColors.green,
    fontFamily: NavOssFonts.bold,
  },
  pressed: {
    backgroundColor: NavOssColors.fog,
  },
  tab: {
    alignItems: 'center',
    flex: 1,
    gap: Spacing.one,
    height: APP_TAB_BAR_HEIGHT,
    justifyContent: 'center',
  },
});
