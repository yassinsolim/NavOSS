import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { NavOssColors, NavOssFonts } from '@/constants/navoss-theme';

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
          <Pressable
            accessibilityLabel={tab.label}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            key={tab.id}
            onPress={() => {
              onSelect(tab.id);
            }}
            style={({ pressed }) => [styles.tab, pressed && styles.pressed]}
          >
            <View style={[styles.iconWell, selected && styles.iconWellSelected]}>
              <SymbolView
                name={tab.icon}
                size={21}
                tintColor={selected ? NavOssColors.green : NavOssColors.muted}
              />
            </View>
            <Text style={[styles.label, selected && styles.labelSelected]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignItems: 'center',
    backgroundColor: NavOssColors.white,
    borderTopColor: NavOssColors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    bottom: 0,
    flexDirection: 'row',
    left: 0,
    position: 'absolute',
    right: 0,
    shadowColor: '#000000',
    shadowOffset: { height: -2, width: 0 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    zIndex: 50,
  },
  iconWell: {
    alignItems: 'center',
    borderRadius: 18,
    height: 30,
    justifyContent: 'center',
    width: 50,
  },
  iconWellSelected: {
    backgroundColor: NavOssColors.sky,
  },
  label: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.medium,
    fontSize: 11,
    letterSpacing: 0,
  },
  labelSelected: {
    color: NavOssColors.green,
    fontFamily: NavOssFonts.bold,
  },
  pressed: {
    opacity: 0.7,
  },
  tab: {
    alignItems: 'center',
    flex: 1,
    gap: 2,
    height: APP_TAB_BAR_HEIGHT,
    justifyContent: 'center',
  },
});
