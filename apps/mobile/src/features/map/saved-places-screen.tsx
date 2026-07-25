import type { SearchResult } from '@navoss/contracts';
import { SymbolView } from 'expo-symbols';
import type { ComponentProps } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { NavOssColors, NavOssFonts } from '@/constants/navoss-theme';
import { APP_TAB_BAR_HEIGHT } from '@/features/map/app-tab-bar';
import type { NativeDestinationCatalog } from '@/features/navigation/native-navigation';
import { nativeDestinationToSearchResult } from '@/features/navigation/native-navigation';

type SymbolName = ComponentProps<typeof SymbolView>['name'];

interface SavedPlacesScreenProps {
  bottomInset: number;
  catalog: NativeDestinationCatalog;
  onChoose: (place: SearchResult) => void;
  onChangeHome: () => void;
  onChangeWork: () => void;
  onClearHistory: () => void;
  onRemoveHome: () => void;
  onRemoveWork: () => void;
  onSetHome: () => void;
  onSetWork: () => void;
  safeAreaTop: number;
}

function SavedRow({
  icon,
  label,
  onPress,
  place,
}: {
  icon: SymbolName;
  label?: string;
  onPress: () => void;
  place: SearchResult;
}) {
  return (
    <Pressable
      accessibilityLabel={`${label === undefined ? '' : `${label}, `}${place.name}, ${place.label}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowIcon}>
        <SymbolView name={icon} size={20} tintColor={NavOssColors.green} />
      </View>
      <View style={styles.rowCopy}>
        {label !== undefined && <Text style={styles.rowLabel}>{label}</Text>}
        <Text numberOfLines={1} style={styles.rowName}>
          {place.name}
        </Text>
        <Text numberOfLines={1} style={styles.rowDetail}>
          {place.label}
        </Text>
      </View>
      <SymbolView
        name={{ android: 'chevron_right', ios: 'chevron.right' }}
        size={16}
        tintColor={NavOssColors.muted}
      />
    </Pressable>
  );
}

function SetupRow({ label, onPress }: { label: 'Home' | 'Work'; onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel={`Set ${label}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowIcon}>
        <SymbolView
          name={
            label === 'Home'
              ? { android: 'home', ios: 'house' }
              : { android: 'work', ios: 'briefcase' }
          }
          size={20}
          tintColor={NavOssColors.green}
        />
      </View>
      <View style={styles.rowCopy}>
        <Text style={styles.rowName}>Set {label}</Text>
        <Text style={styles.rowDetail}>Add a private shortcut on this device</Text>
      </View>
      <SymbolView name={{ android: 'add', ios: 'plus' }} size={18} tintColor={NavOssColors.green} />
    </Pressable>
  );
}

function ShortcutRow({
  label,
  onChange,
  onChoose,
  onRemove,
  place,
}: {
  label: 'Home' | 'Work';
  onChange: () => void;
  onChoose: () => void;
  onRemove: () => void;
  place: SearchResult;
}) {
  const icon: SymbolName =
    label === 'Home'
      ? { android: 'home', ios: 'house.fill' }
      : { android: 'work', ios: 'briefcase.fill' };

  const confirmRemove = () => {
    Alert.alert(`Remove ${label}?`, 'This removes the private shortcut from this device.', [
      { style: 'cancel', text: 'Cancel' },
      { onPress: onRemove, style: 'destructive', text: 'Remove' },
    ]);
  };

  return (
    <View style={styles.shortcutRow}>
      <Pressable
        accessibilityLabel={`${label}, ${place.name}, ${place.label}`}
        onPress={onChoose}
        style={({ pressed }) => [styles.shortcutMain, pressed && styles.rowPressed]}
      >
        <View style={styles.rowIcon}>
          <SymbolView name={icon} size={20} tintColor={NavOssColors.green} />
        </View>
        <View style={styles.rowCopy}>
          <Text style={styles.rowLabel}>{label}</Text>
          <Text numberOfLines={1} style={styles.rowName}>
            {place.name}
          </Text>
          <Text numberOfLines={1} style={styles.rowDetail}>
            {place.label}
          </Text>
        </View>
      </Pressable>
      <View style={styles.shortcutActions}>
        <Pressable
          accessibilityLabel={`Change ${label}`}
          hitSlop={4}
          onPress={onChange}
          style={({ pressed }) => [styles.shortcutAction, pressed && styles.rowPressed]}
        >
          <SymbolView
            name={{ android: 'edit', ios: 'pencil' }}
            size={17}
            tintColor={NavOssColors.green}
          />
        </Pressable>
        <Pressable
          accessibilityLabel={`Remove ${label}`}
          hitSlop={4}
          onPress={confirmRemove}
          style={({ pressed }) => [styles.shortcutAction, pressed && styles.rowPressed]}
        >
          <SymbolView
            name={{ android: 'delete', ios: 'trash' }}
            size={17}
            tintColor={NavOssColors.coral}
          />
        </Pressable>
      </View>
    </View>
  );
}

export function SavedPlacesScreen({
  bottomInset,
  catalog,
  onChoose,
  onChangeHome,
  onChangeWork,
  onClearHistory,
  onRemoveHome,
  onRemoveWork,
  onSetHome,
  onSetWork,
  safeAreaTop,
}: SavedPlacesScreenProps) {
  const home =
    catalog.home === undefined ? undefined : nativeDestinationToSearchResult(catalog.home);
  const work =
    catalog.work === undefined ? undefined : nativeDestinationToSearchResult(catalog.work);
  const favorites = catalog.favorites.map(nativeDestinationToSearchResult);
  const recents = catalog.recents.map(nativeDestinationToSearchResult);

  return (
    <View style={[styles.screen, { paddingTop: safeAreaTop }]}>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>YOUR PLACES</Text>
        <Text style={styles.title}>Saved places</Text>
        <Text style={styles.subtitle}>Private shortcuts stored only on this device.</Text>
      </View>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: APP_TAB_BAR_HEIGHT + bottomInset + 28 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Shortcuts</Text>
          <View style={styles.rows}>
            {home === undefined ? (
              <SetupRow label="Home" onPress={onSetHome} />
            ) : (
              <ShortcutRow
                label="Home"
                onChange={onChangeHome}
                onChoose={() => {
                  onChoose(home);
                }}
                onRemove={onRemoveHome}
                place={home}
              />
            )}
            {work === undefined ? (
              <SetupRow label="Work" onPress={onSetWork} />
            ) : (
              <ShortcutRow
                label="Work"
                onChange={onChangeWork}
                onChoose={() => {
                  onChoose(work);
                }}
                onRemove={onRemoveWork}
                place={work}
              />
            )}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Favourites</Text>
          {favorites.length === 0 ? (
            <View style={styles.emptyState}>
              <SymbolView
                name={{ android: 'bookmark_border', ios: 'bookmark' }}
                size={24}
                tintColor={NavOssColors.green}
              />
              <Text style={styles.emptyText}>Places you save from Explore appear here.</Text>
            </View>
          ) : (
            <View style={styles.rows}>
              {favorites.map((place) => (
                <SavedRow
                  icon={{ android: 'bookmark', ios: 'bookmark.fill' }}
                  key={place.id}
                  onPress={() => {
                    onChoose(place);
                  }}
                  place={place}
                />
              ))}
            </View>
          )}
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeadingRow}>
            <Text style={styles.sectionTitle}>Recent</Text>
            {recents.length > 0 && (
              <Pressable accessibilityLabel="Clear recent places" onPress={onClearHistory}>
                <Text style={styles.clearText}>Clear</Text>
              </Pressable>
            )}
          </View>
          {recents.length === 0 ? (
            <Text style={styles.emptyText}>No recent destinations yet.</Text>
          ) : (
            <View style={styles.rows}>
              {recents.map((place) => (
                <SavedRow
                  icon={{ android: 'history', ios: 'clock.arrow.circlepath' }}
                  key={place.id}
                  onPress={() => {
                    onChoose(place);
                  }}
                  place={place}
                />
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  clearText: {
    color: NavOssColors.coral,
    fontFamily: NavOssFonts.semibold,
    fontSize: 14,
    letterSpacing: 0,
  },
  content: {
    gap: 32,
    paddingHorizontal: 18,
    paddingTop: 20,
  },
  emptyState: {
    alignItems: 'center',
    borderColor: NavOssColors.border,
    borderStyle: 'dashed',
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    minHeight: 70,
    paddingHorizontal: 16,
  },
  emptyText: {
    color: NavOssColors.muted,
    flex: 1,
    fontFamily: NavOssFonts.regular,
    fontSize: 15,
    letterSpacing: 0,
    lineHeight: 21,
  },
  eyebrow: {
    color: NavOssColors.green,
    fontFamily: NavOssFonts.bold,
    fontSize: 11,
    letterSpacing: 0,
  },
  header: {
    borderBottomColor: NavOssColors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 3,
    paddingBottom: 18,
    paddingHorizontal: 20,
    paddingTop: 18,
  },
  row: {
    alignItems: 'center',
    backgroundColor: NavOssColors.white,
    borderBottomColor: NavOssColors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 12,
    minHeight: 70,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  rowCopy: {
    flex: 1,
    gap: 1,
    minWidth: 0,
  },
  rowDetail: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 13,
    letterSpacing: 0,
  },
  rowIcon: {
    alignItems: 'center',
    backgroundColor: NavOssColors.sky,
    borderRadius: 20,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  rowLabel: {
    color: NavOssColors.green,
    fontFamily: NavOssFonts.bold,
    fontSize: 11,
    letterSpacing: 0,
    textTransform: 'uppercase',
  },
  rowName: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.semibold,
    fontSize: 16,
    letterSpacing: 0,
  },
  rowPressed: {
    backgroundColor: NavOssColors.fog,
  },
  shortcutAction: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  shortcutActions: {
    flexDirection: 'row',
    paddingRight: 8,
  },
  shortcutMain: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 12,
    minHeight: 70,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  shortcutRow: {
    alignItems: 'center',
    backgroundColor: NavOssColors.white,
    borderBottomColor: NavOssColors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    minHeight: 70,
  },
  rows: {
    borderColor: NavOssColors.border,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  screen: {
    backgroundColor: NavOssColors.paper,
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 40,
  },
  section: {
    gap: 10,
  },
  sectionHeadingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.bold,
    fontSize: 20,
    letterSpacing: 0,
  },
  subtitle: {
    color: NavOssColors.muted,
    fontFamily: NavOssFonts.regular,
    fontSize: 14,
    letterSpacing: 0,
  },
  title: {
    color: NavOssColors.asphalt,
    fontFamily: NavOssFonts.bold,
    fontSize: 30,
    letterSpacing: 0,
    lineHeight: 35,
  },
});
